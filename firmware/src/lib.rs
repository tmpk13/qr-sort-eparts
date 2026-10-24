//! Line protocol and color math of the qr-sort status LED.
//!
//! One ASCII command per line, `\n` terminated, `\r` ignored:
//! `#RRGGBB` sets the color (reply `ok`), `?` identifies the board
//! (reply `qr-sort-led 1`), anything else replies `err`. Empty lines are
//! skipped without a reply so a host can send a bare `\n` to resynchronize.
#![cfg_attr(not(test), no_std)]

/// Reply to `?`: the board's name and protocol version.
pub const IDENT: &[u8] = b"qr-sort-led 1\n";
pub const OK: &[u8] = b"ok\n";
pub const ERR: &[u8] = b"err\n";

/// Longest line kept; the longest valid command is 7 bytes.
pub const LINE_MAX: usize = 16;

/// PWM wrap value. Duty is `level * level` counts out of `TOP + 1 = 255 * 255`,
/// a gamma of 2 that is exact in integers, and level 255 gives a compare above
/// TOP, which holds the output on for the whole period.
pub const TOP: u16 = 255 * 255 - 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const OFF: Rgb = Rgb { r: 0, g: 0, b: 0 };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Color(Rgb),
    Identify,
    Invalid,
}

impl Command {
    pub fn reply(&self) -> &'static [u8] {
        match self {
            Command::Color(_) => OK,
            Command::Identify => IDENT,
            Command::Invalid => ERR,
        }
    }
}

/// PWM compare value for an 8-bit channel level, gamma corrected.
pub const fn duty(level: u8) -> u16 {
    level as u16 * level as u16
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn hex_byte(hi: u8, lo: u8) -> Option<u8> {
    Some(hex(hi)? << 4 | hex(lo)?)
}

/// The command a complete line (without its terminator) asks for.
pub fn parse(line: &[u8]) -> Command {
    match line {
        b"?" => Command::Identify,
        [b'#', r1, r0, g1, g0, b1, b0] => match (hex_byte(*r1, *r0), hex_byte(*g1, *g0), hex_byte(*b1, *b0)) {
            (Some(r), Some(g), Some(b)) => Command::Color(Rgb { r, g, b }),
            _ => Command::Invalid,
        },
        _ => Command::Invalid,
    }
}

/// Collects bytes into lines across USB packet boundaries.
///
/// A line longer than `LINE_MAX` is dropped up to its newline and answered
/// with a single `Invalid`, so garbage cannot shift later commands.
pub struct LineAssembler {
    buf: [u8; LINE_MAX],
    len: usize,
    overlong: bool,
}

impl Default for LineAssembler {
    fn default() -> Self {
        Self::new()
    }
}

impl LineAssembler {
    pub const fn new() -> Self {
        Self { buf: [0; LINE_MAX], len: 0, overlong: false }
    }

    /// Forget a partial line, e.g. when the host that was sending it is gone.
    pub fn clear(&mut self) {
        self.len = 0;
        self.overlong = false;
    }

    /// Feed one byte; returns the command when it completes a non-empty line.
    pub fn push(&mut self, byte: u8) -> Option<Command> {
        match byte {
            b'\r' => None,
            b'\n' => {
                let cmd = if self.overlong {
                    Some(Command::Invalid)
                } else if self.len == 0 {
                    None
                } else {
                    Some(parse(&self.buf[..self.len]))
                };
                self.clear();
                cmd
            }
            _ if self.overlong => None,
            _ if self.len == LINE_MAX => {
                self.overlong = true;
                None
            }
            _ => {
                self.buf[self.len] = byte;
                self.len += 1;
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(a: &mut LineAssembler, bytes: &[u8]) -> Vec<Command> {
        bytes.iter().filter_map(|&b| a.push(b)).collect()
    }

    const ORANGE: Command = Command::Color(Rgb { r: 0xff, g: 0x80, b: 0x00 });

    #[test]
    fn parses_colors_in_either_case() {
        assert_eq!(parse(b"#ff8000"), ORANGE);
        assert_eq!(parse(b"#FF8000"), ORANGE);
        assert_eq!(parse(b"#000000"), Command::Color(Rgb::OFF));
    }

    #[test]
    fn identifies() {
        assert_eq!(parse(b"?"), Command::Identify);
        assert_eq!(Command::Identify.reply(), b"qr-sort-led 1\n");
    }

    #[test]
    fn rejects_everything_else() {
        for bad in [&b"#ff800"[..], b"#ff80000", b"ff8000", b"#gg8000", b"# f8000", b"??", b"AT", b"#ff 8000"] {
            assert_eq!(parse(bad), Command::Invalid, "{:?}", core::str::from_utf8(bad));
        }
        assert_eq!(Command::Invalid.reply(), b"err\n");
    }

    #[test]
    fn lines_split_across_packets_and_cr_ignored() {
        let mut a = LineAssembler::new();
        assert_eq!(feed(&mut a, b"#ff"), vec![]);
        assert_eq!(feed(&mut a, b"80"), vec![]);
        assert_eq!(feed(&mut a, b"00\r\n?\n#00"), vec![ORANGE, Command::Identify]);
        assert_eq!(feed(&mut a, b"0000\n"), vec![Command::Color(Rgb::OFF)]);
    }

    #[test]
    fn empty_lines_get_no_reply() {
        let mut a = LineAssembler::new();
        assert_eq!(feed(&mut a, b"\n\r\n\n"), vec![]);
    }

    #[test]
    fn overlong_line_is_one_error_and_does_not_leak() {
        let mut a = LineAssembler::new();
        let mut long = vec![b'x'; 100];
        long.extend_from_slice(b"#ff8000\n#ff8000\n");
        assert_eq!(feed(&mut a, &long), vec![Command::Invalid, ORANGE]);
        let mut edge = vec![b'#'; LINE_MAX + 1];
        edge.push(b'\n');
        assert_eq!(feed(&mut a, &edge), vec![Command::Invalid]);
        assert_eq!(feed(&mut a, b"?\n"), vec![Command::Identify]);
    }

    #[test]
    fn clear_drops_a_partial_line() {
        let mut a = LineAssembler::new();
        feed(&mut a, b"#ff80");
        a.clear();
        assert_eq!(feed(&mut a, b"?\n"), vec![Command::Identify]);
    }

    #[test]
    fn duty_is_monotonic_and_full_scale_stays_on() {
        assert_eq!(duty(0), 0);
        assert!((1..=255).all(|l| duty(l) > duty(l - 1)));
        assert!(duty(255) > TOP);
        assert_eq!(duty(128), 16384);
    }
}
