"""The print bridge against a fake printer: JSON API, image fitting, static files, origins."""
import http.client
import importlib.util
import io
import threading
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


def serve(tmp_path, cors=None):
    dist = tmp_path / "dist"
    dist.mkdir(exist_ok=True)
    (dist / "index.html").write_text("<h1>hi</h1>")
    (dist / "a.wasm").write_bytes(b"\0asm")
    srv = bridge.make_server("127.0.0.1", 0, dist, bridge.PrinterLink(FAKE_TPRINT), cors)
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
