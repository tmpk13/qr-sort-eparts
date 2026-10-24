"""The print bridge against a fake printer and a fake LED board: JSON API, image fitting, static files, origins."""
import http.client
import importlib.util
import io
import os
import threading
import time
import types
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bridge", ROOT / "bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class FakePrinter:
    jobs: list = []
    label = (40, 30)
    fail = None

    def __init__(self, *args, **kwargs):
        pass

    def status(self):
        if FakePrinter.fail:
            raise RuntimeError(FakePrinter.fail)
        return {"buf_full": False, "busy": False, "printing": False}

    def label_mm(self):
        return FakePrinter.label

    def print_image(self, img, density=4):
        FakePrinter.jobs.append((img, density))


FAKE_TPRINT = types.SimpleNamespace(UsbPrinter=FakePrinter, BtPrinter=FakePrinter, HEAD_DOTS=384)


def png(w, h, color=255, mark=1):
    """A blank image with a black square of mark pixels in its top left corner."""
    img = Image.new("L", (w, h), color)
    img.paste(0, (0, 0, mark, mark))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def serve(tmp_path, cors=None, led=None):
    dist = tmp_path / "dist"
    dist.mkdir(exist_ok=True)
    (dist / "index.html").write_text("<h1>hi</h1>")
    (dist / "a.wasm").write_bytes(b"\0asm")
    srv = bridge.make_server("127.0.0.1", 0, dist, bridge.PrinterLink(FAKE_TPRINT), cors, led=led)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


@pytest.fixture(autouse=True)
def reset_printer():
    FakePrinter.jobs.clear()
    FakePrinter.fail = None
    FakePrinter.label = (40, 30)


@pytest.fixture
def addr(tmp_path):
    srv = serve(tmp_path)
    yield srv.server_address
    srv.shutdown()
    srv.server_close()


def req(addr, method, path, body=None, headers=None):
    c = http.client.HTTPConnection(addr[0], addr[1], timeout=5)
    c.request(method, path, body, headers or {})
    r = c.getresponse()
    data = r.read()
    c.close()
    return r, data


def test_printer_info(addr):
    r, data = req(addr, "GET", "/api/printer")
    assert r.status == 200
    j = bridge.json.loads(data)
    assert j["ok"] and j["label_mm"] == [40, 30] and j["transport"] == "usb" and j["busy"] is False


def test_printer_error_is_reported(addr):
    FakePrinter.fail = "cover open"
    r, data = req(addr, "GET", "/api/printer")
    assert r.status == 503
    j = bridge.json.loads(data)
    assert not j["ok"] and "cover open" in j["error"]


def test_label_size_is_clamped_to_the_head():
    FakePrinter.label = (0, 0)
    assert bridge.PrinterLink(FAKE_TPRINT).info()["label_mm"] == [40, 30]
    FakePrinter.label = (60, 50)
    assert bridge.PrinterLink(FAKE_TPRINT).info()["label_mm"] == [48, 50]


def test_print_exact_size(addr):
    r, data = req(addr, "POST", "/api/print?density=7", png(320, 240), {"Content-Type": "image/png"})
    assert r.status == 200 and bridge.json.loads(data) == {"ok": True, "label_mm": [40, 30]}
    (img, density), = FakePrinter.jobs
    assert img.mode == "1" and img.size == (320, 240) and density == 7
    assert img.getpixel((0, 0)) == 0 and img.getpixel((10, 10)) == 255


def test_print_fits_a_larger_image(addr):
    req(addr, "POST", "/api/print", png(640, 480, mark=40))
    (img, density), = FakePrinter.jobs
    assert img.size == (320, 240) and density == 4
    assert img.getpixel((5, 5)) == 0 and img.getpixel((30, 30)) == 255


def test_small_image_is_centered_not_scaled():
    img = bridge.to_label(png(100, 100, color=0), 40, 30)
    assert img.size == (320, 240)
    assert img.getpixel((0, 0)) == 255 and img.getpixel((160, 120)) == 0
    assert img.getpixel((110, 70)) == 0 and img.getpixel((109, 69)) == 255


def test_print_rejects_empty_and_bad_bodies(addr):
    r, data = req(addr, "POST", "/api/print")
    assert r.status == 400
    r, data = req(addr, "POST", "/api/print", b"not a png")
    assert r.status == 503 and "error" in bridge.json.loads(data)
    assert FakePrinter.jobs == []


def test_foreign_origin_cannot_print(addr, tmp_path):
    r, _ = req(addr, "POST", "/api/print", png(320, 240), {"Origin": "http://evil.example"})
    assert r.status == 403 and FakePrinter.jobs == []
    host = "%s:%d" % addr
    r, _ = req(addr, "POST", "/api/print", png(320, 240), {"Origin": f"http://{host}", "Host": host})
    assert r.status == 200 and len(FakePrinter.jobs) == 1
    r, _ = req(addr, "OPTIONS", "/api/print")
    assert r.status == 404
    open_srv = serve(tmp_path, cors="*")
    try:
        r, _ = req(open_srv.server_address, "POST", "/api/print", png(320, 240), {"Origin": "http://evil.example"})
        assert r.status == 200 and r.getheader("Access-Control-Allow-Origin") == "*"
        r, _ = req(open_srv.server_address, "OPTIONS", "/api/print")
        assert r.status == 204
    finally:
        open_srv.shutdown()
        open_srv.server_close()


def test_static_files(addr):
    r, data = req(addr, "GET", "/")
    assert r.status == 200 and b"hi" in data and r.getheader("Cache-Control") == "no-cache"
    r, _ = req(addr, "GET", "/a.wasm")
    assert r.status == 200 and r.getheader("Content-Type") == "application/wasm"
    r, _ = req(addr, "GET", "/api/nope")
    assert r.status == 404
    r, _ = req(addr, "GET", "/../bridge.py")
    assert r.status == 404
    r, _ = req(addr, "POST", "/index.html")
    assert r.status == 404


class FakeLed:
    """What the handler needs from LedLink, with a switch for the board being plugged in."""

    def __init__(self, attached=True):
        self.attached = attached
        self.colors = []

    def status(self):
        return {"attached": self.attached, "port": "/dev/ttyACM9" if self.attached else None}

    def set_color(self, color):
        if self.attached:
            self.colors.append(color)
        return self.attached


@pytest.fixture
def led():
    return FakeLed()


@pytest.fixture
def led_addr(tmp_path, led):
    srv = serve(tmp_path, led=led)
    yield srv.server_address
    srv.shutdown()
    srv.server_close()


def post_color(addr, body, headers=None):
    if not isinstance(body, bytes):
        body = bridge.json.dumps(body).encode()
    r, data = req(addr, "POST", "/api/led", body, {"Content-Type": "application/json", **(headers or {})})
    return r.status, bridge.json.loads(data)


def test_led_absent_is_not_an_error(addr):
    r, data = req(addr, "GET", "/api/led")
    assert r.status == 200 and bridge.json.loads(data) == {"ok": True, "attached": False, "port": None}
    assert post_color(addr, {"color": "#00ff00"}) == (200, {"ok": True, "attached": False})


def test_led_unplugged_board(led_addr, led):
    led.attached = False
    r, data = req(led_addr, "GET", "/api/led")
    assert r.status == 200 and bridge.json.loads(data)["attached"] is False
    assert post_color(led_addr, {"color": "#00ff00"}) == (200, {"ok": True, "attached": False})
    assert led.colors == []


def test_led_color_is_forwarded(led_addr, led):
    r, data = req(led_addr, "GET", "/api/led")
    assert bridge.json.loads(data) == {"ok": True, "attached": True, "port": "/dev/ttyACM9"}
    assert post_color(led_addr, {"color": "#FF8000"}) == (200, {"ok": True, "attached": True})
    assert post_color(led_addr, {"color": "#000000", "extra": 1}) == (200, {"ok": True, "attached": True})
    assert led.colors == ["#FF8000", "#000000"]


BAD_LED_BODIES = [
    b"", b"not json", b"[1]", b'"#ff8000"', b"{}", {"color": "red"}, {"color": "#12345"}, {"color": "#1234567"},
    {"color": "#ff800g"}, {"color": 0xff8000}, {"color": " #ff8000"}, {"color": "#ff8000\n"},
    {"color": "#ff8000\n?"}, {"color": "#ff8000", "pad": "x" * 2000},
]


def test_led_rejects_malformed_bodies(led_addr, led):
    for body in BAD_LED_BODIES:
        status, j = post_color(led_addr, body)
        assert status == 400 and j["ok"] is False, body
    assert led.colors == []


def test_foreign_origin_cannot_set_the_led(led_addr, led):
    status, _ = post_color(led_addr, {"color": "#ff0000"}, {"Origin": "http://evil.example"})
    assert status == 403 and led.colors == []
    host = "%s:%d" % led_addr
    status, _ = post_color(led_addr, {"color": "#ff0000"}, {"Origin": f"http://{host}", "Host": host})
    assert status == 200 and led.colors == ["#ff0000"]


def test_led_requests_are_not_logged(led_addr, capsys):
    post_color(led_addr, {"color": "#ff0000"})
    req(led_addr, "GET", "/api/led")
    post_color(led_addr, {"color": "red"})
    err = capsys.readouterr().err
    assert '"POST /api/led HTTP/1.1" 400' in err and " 200 " not in err


class FakeSerial:
    """A serial port that records writes and can be unplugged."""

    def __init__(self, device):
        self.device = device
        self.written = []
        self.inbox = b""
        self.unplugged = False
        self.closed = False

    def _check(self):
        if self.unplugged:
            raise bridge.serial.SerialException("device reports readiness to read but returned no data")

    @property
    def in_waiting(self):
        self._check()
        return len(self.inbox)

    def read(self, n):
        self._check()
        data, self.inbox = self.inbox[:n], self.inbox[n:]
        return data

    def write(self, data):
        self._check()
        self.written.append(data)
        self.inbox += b"ok\n" if data.startswith(b"#") else b""
        return len(data)

    def reset_input_buffer(self):
        self.inbox = b""

    def close(self):
        self.closed = True


class Bench:
    """LedLink wired to a fake clock, a fake port list and a fake opener."""

    def __init__(self, port=None):
        self.now = 0.0
        self.ports = []
        self.scans = 0
        self.opened = []
        self.link = bridge.LedLink(port, opener=self.open, lister=self.list, clock=lambda: self.now)

    def plug(self, device="/dev/ttyACM0", vid=bridge.LED_VID, pid=bridge.LED_PID):
        self.ports.append(types.SimpleNamespace(device=device, vid=vid, pid=pid))

    def list(self):
        self.scans += 1
        return list(self.ports)

    def open(self, device):
        if not any(p.device == device for p in self.ports):
            raise FileNotFoundError(device)
        self.opened.append(FakeSerial(device))
        return self.opened[-1]


def test_ledlink_rescans_at_most_every_two_seconds():
    b = Bench()
    assert b.link.set_color("#ff0000") is False and b.scans == 1
    b.now = 1.9
    b.plug()
    assert b.link.status() == {"attached": False, "port": None} and b.scans == 1
    b.now = 2.0
    assert b.link.status() == {"attached": True, "port": "/dev/ttyACM0"} and b.scans == 2
    assert b.link.set_color("#FF0000") is True and b.scans == 2
    port, = b.opened
    assert port.written == [b"\n", b"#ff0000\n"]


def test_ledlink_picks_the_board_by_vid_pid():
    b = Bench()
    b.plug("/dev/ttyUSB0", vid=0x0403, pid=0x6001)
    b.plug("/dev/ttyACM3")
    assert b.link.status()["port"] == "/dev/ttyACM3"


def test_ledlink_drops_the_port_on_a_write_error_and_finds_it_again():
    b = Bench()
    b.plug()
    assert b.link.set_color("#00ff00")
    first = b.opened[0]
    first.unplugged = True
    b.now = 10.0
    assert b.link.set_color("#0000ff") is False
    assert first.closed and b.link.port is None and b.scans == 1
    # Plugged back in: the next call scans again and opens a fresh port.
    assert b.link.set_color("#0000ff") is True
    assert b.scans == 2 and len(b.opened) == 2 and b.opened[1].written == [b"\n", b"#0000ff\n"]


def test_ledlink_notices_an_unplug_on_status_and_throttles_the_rescan():
    b = Bench()
    b.plug()
    assert b.link.status()["attached"] and b.scans == 1
    b.opened[0].unplugged = True
    b.ports.clear()
    b.now = 0.5
    assert b.link.status() == {"attached": False, "port": None} and b.opened[0].closed
    b.now = 1.0
    b.plug("/dev/ttyACM1")
    assert b.link.status()["attached"] is False and b.scans == 1
    b.now = 2.0
    assert b.link.status() == {"attached": True, "port": "/dev/ttyACM1"} and b.scans == 2


def test_ledlink_discards_replies_so_they_do_not_pile_up():
    b = Bench()
    b.plug()
    for _ in range(50):
        b.link.set_color("#010203")
    assert b.opened[0].inbox == b"ok\n"
    b.link.status()
    assert b.opened[0].inbox == b""


def test_ledlink_fixed_port_skips_the_scan():
    b = Bench("/dev/ttyACM7")
    assert b.link.status()["attached"] is False and b.scans == 0
    b.plug("/dev/ttyACM7")
    b.now = 2.0
    assert b.link.set_color("#ffffff") and b.scans == 0 and b.opened[0].device == "/dev/ttyACM7"


def test_no_led_is_inert():
    assert bridge.NoLed().status() == {"attached": False, "port": None}
    assert bridge.NoLed().set_color("#ffffff") is False


def test_ledlink_over_a_real_tty():
    """A pty plays the board: the real opener must hand over raw bytes and drain the replies."""
    board, slave = os.openpty()
    path = os.ttyname(slave)
    link = bridge.LedLink(path)
    try:
        assert link.status() == {"attached": True, "port": path}
        assert link.set_color("#AbCdEf")
        seen = b""
        deadline = time.monotonic() + 2
        while not seen.endswith(b"#abcdef\n") and time.monotonic() < deadline:
            seen += os.read(board, 64)
        assert seen == b"\n#abcdef\n"  # no \r added: output processing is off
        os.write(board, b"ok\n")
        deadline = time.monotonic() + 2
        while link.ser.in_waiting < 3 and time.monotonic() < deadline:
            time.sleep(0.01)
        link.status()
        assert link.ser.in_waiting == 0
    finally:
        link._drop()
        os.close(board)
        os.close(slave)
