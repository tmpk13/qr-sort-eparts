//! qr-sort status LED: an RGB LED on GP2 (red), GP3 (green) and GP4 (blue) of
//! an RP2040, set by the host over USB CDC-ACM with the line protocol in the
//! library (`#RRGGBB`, `?`).
//!
//! The LED turns off when the host goes away. embassy-rp's endpoint reads never
//! fail on an unplug, so departure is taken from the USB device state (bus
//! reset, suspend, configuration dropped) and from DTR falling, which is what
//! the host's serial driver does when the last program closes the port.
#![no_std]
#![no_main]

use defmt::info;
use embassy_executor::Spawner;
use embassy_futures::join::join;
use embassy_futures::select::{select3, Either3};
use embassy_rp::bind_interrupts;
use embassy_rp::flash::{Blocking, Flash};
use embassy_rp::peripherals::{FLASH, USB};
use embassy_rp::pwm::{Config as PwmConfig, Pwm};
use embassy_rp::usb::{Driver, InterruptHandler};
use embassy_sync::blocking_mutex::raw::CriticalSectionRawMutex;
use embassy_sync::signal::Signal;
use embassy_time::{with_timeout, Duration, Timer};
use embassy_usb::class::cdc_acm::{CdcAcmClass, Sender, State};
use embassy_usb::{Builder, Config, Handler};
use qr_sort_led::{duty, Command, LineAssembler, Rgb, TOP};
use {defmt_rtt as _, panic_probe as _};

/// false: common cathode wired to GND; true: common anode wired to 3V3.
const ACTIVE_LOW: bool = false;

/// pid.codes open-source vendor ID and its shared test product ID.
const USB_VID: u16 = 0x1209;
const USB_PID: u16 = 0x0001;

/// Shown for a moment at power-up so the wiring can be checked without a host.
const BOOT_BLINK: Rgb = Rgb { r: 48, g: 48, b: 48 };
const BOOT_BLINK_MS: u64 = 200;

/// Full-speed bulk packet size. Replies are sent in packets shorter than this
/// so every transfer ends on a short packet and the host delivers it at once.
const PACKET: usize = 64;

/// A reply the host has not collected within this time is dropped, so a port
/// nobody reads cannot stall command handling.
const REPLY_TIMEOUT: Duration = Duration::from_millis(100);

const FLASH_SIZE: usize = 2 * 1024 * 1024;

bind_interrupts!(struct Irqs {
    USBCTRL_IRQ => InterruptHandler<USB>;
});

/// Raised from the USB device-state callbacks when the host is gone.
static HOST_GONE: Signal<CriticalSectionRawMutex, ()> = Signal::new();

/// Device-state callbacks. They run inside the USB device task, so they only
/// raise a signal and never block.
struct DeviceEvents;

impl Handler for DeviceEvents {
    fn enabled(&mut self, enabled: bool) {
        if !enabled {
            HOST_GONE.signal(());
        }
    }

    fn reset(&mut self) {
        HOST_GONE.signal(());
    }

    fn configured(&mut self, configured: bool) {
        if !configured {
            HOST_GONE.signal(());
        }
    }

    // Without VBUS sensing a pulled cable is only ever seen as a suspend.
    fn suspended(&mut self, suspended: bool) {
        if suspended {
            HOST_GONE.signal(());
        }
    }
}

/// The three PWM channels: red and green on slice 1 (A, B), blue on slice 2 (A).
struct Led<'d> {
    rg: Pwm<'d>,
    b: Pwm<'d>,
    rg_cfg: PwmConfig,
    b_cfg: PwmConfig,
}

impl<'d> Led<'d> {
    fn set(&mut self, c: Rgb) {
        self.rg_cfg.compare_a = duty(c.r);
        self.rg_cfg.compare_b = duty(c.g);
        self.b_cfg.compare_a = duty(c.b);
        self.rg.set_config(&self.rg_cfg);
        self.b.set_config(&self.b_cfg);
    }
}

/// Replies of one received packet, gathered so a burst of commands costs few
/// USB packets.
struct Replies {
    buf: [u8; PACKET - 1],
    len: usize,
}

impl Replies {
    const fn new() -> Self {
        Self { buf: [0; PACKET - 1], len: 0 }
    }

    async fn push<'d>(&mut self, tx: &mut Sender<'d, Driver<'d, USB>>, reply: &[u8]) {
        if self.len + reply.len() > self.buf.len() {
            self.flush(tx).await;
        }
        self.buf[self.len..self.len + reply.len()].copy_from_slice(reply);
        self.len += reply.len();
    }

    async fn flush<'d>(&mut self, tx: &mut Sender<'d, Driver<'d, USB>>) {
        if self.len > 0 {
            let _ = with_timeout(REPLY_TIMEOUT, tx.write_packet(&self.buf[..self.len])).await;
            self.len = 0;
        }
    }
}

/// The flash chip's 64-bit unique ID in hex, so each board gets its own USB
/// serial number (and a stable /dev/serial/by-id name).
fn serial_number<'a>(flash: embassy_rp::Peri<'_, FLASH>, out: &'a mut [u8; 16]) -> &'a str {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut uid = [0u8; 8];
    let mut flash = Flash::<_, Blocking, FLASH_SIZE>::new_blocking(flash);
    if flash.blocking_unique_id(&mut uid).is_err() {
        return "0";
    }
    for (i, b) in uid.iter().enumerate() {
        out[2 * i] = HEX[(b >> 4) as usize];
        out[2 * i + 1] = HEX[(b & 15) as usize];
    }
    core::str::from_utf8(out).unwrap_or("0")
}

#[embassy_executor::main]
async fn main(_spawner: Spawner) {
    let p = embassy_rp::init(Default::default());

    let mut pwm = PwmConfig::default();
    pwm.top = TOP;
    pwm.invert_a = ACTIVE_LOW;
    pwm.invert_b = ACTIVE_LOW;
    pwm.compare_a = 0;
    pwm.compare_b = 0;
    let mut led = Led {
        rg: Pwm::new_output_ab(p.PWM_SLICE1, p.PIN_2, p.PIN_3, pwm.clone()),
        b: Pwm::new_output_a(p.PWM_SLICE2, p.PIN_4, pwm.clone()),
        rg_cfg: pwm.clone(),
        b_cfg: pwm,
    };

    let mut serial_buf = [0u8; 16];
    let serial = serial_number(p.FLASH, &mut serial_buf);
    info!("qr-sort status LED, serial {}", serial);

    let mut config = Config::new(USB_VID, USB_PID);
    config.manufacturer = Some("qr-sort");
    config.product = Some("qr-sort status LED");
    config.serial_number = Some(serial);
    config.max_power = 100;
    config.max_packet_size_0 = 64;

    let mut config_descriptor = [0; 256];
    let mut bos_descriptor = [0; 256];
    let mut msos_descriptor = [0; 0];
    let mut control_buf = [0; 64];
    let mut state = State::new();
    let mut events = DeviceEvents;

    let mut builder = Builder::new(
        Driver::new(p.USB, Irqs),
        config,
        &mut config_descriptor,
        &mut bos_descriptor,
        &mut msos_descriptor,
        &mut control_buf,
    );
    builder.handler(&mut events);
    let class = CdcAcmClass::new(&mut builder, &mut state, PACKET as u16);
    let mut usb = builder.build();
    let (mut tx, mut rx, control) = class.split_with_control();

    let serve = async {
        led.set(BOOT_BLINK);
        Timer::after_millis(BOOT_BLINK_MS).await;
        led.set(Rgb::OFF);

        let mut lines = LineAssembler::new();
        let mut packet = [0u8; PACKET];
        loop {
            rx.wait_connection().await;
            // A departure raised before this configuration belongs to the old host.
            HOST_GONE.reset();
            lines.clear();
            let mut dtr = control.dtr();
            info!("host connected");
            loop {
                match select3(rx.read_packet(&mut packet), HOST_GONE.wait(), control.control_changed()).await {
                    Either3::First(Ok(n)) => {
                        let mut replies = Replies::new();
                        for &byte in &packet[..n] {
                            if let Some(cmd) = lines.push(byte) {
                                if let Command::Color(c) = cmd {
                                    led.set(c);
                                }
                                replies.push(&mut tx, cmd.reply()).await;
                            }
                        }
                        replies.flush(&mut tx).await;
                    }
                    Either3::First(Err(_)) | Either3::Second(()) => break,
                    Either3::Third(()) => {
                        // The program that had the port open closed it.
                        let now = control.dtr();
                        if dtr && !now {
                            led.set(Rgb::OFF);
                            lines.clear();
                            info!("port closed");
                        }
                        dtr = now;
                    }
                }
            }
            led.set(Rgb::OFF);
            info!("host gone");
        }
    };

    join(usb.run(), serve).await;
}
