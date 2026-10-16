#!/usr/bin/env -S uv run -q --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow", "segno"]
# [tool.uv]
# python-preference = "only-system"  # uv-managed Pythons lack Bluetooth sockets
# ///
"""Serve the built qr-sort app and print its labels on the Supvan printer through tprint.

GET  /api/printer           printer status and the loaded label size in mm
POST /api/print?density=4   body: a PNG at 8 dots per mm, fitted onto the label and printed
anything else               a file from dist/
"""
import argparse
import importlib.util
import io
import json
import os
import ssl
import sys
import threading
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from PIL import Image

HERE = Path(__file__).resolve().parent
DOTS_PER_MM = 8
MAX_BODY = 4 << 20


def load_tprint(path: Path):
    """Import tprint.py from the thermal-printer checkout as a module."""
    spec = importlib.util.spec_from_file_location("tprint", path)
    if spec is None or spec.loader is None:
        raise FileNotFoundError(path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def to_label(png: bytes, w_mm: int, h_mm: int) -> Image.Image:
    """The image centered on a label of that size, shrunk if it does not fit, as 1-bit."""
    w, h = w_mm * DOTS_PER_MM, h_mm * DOTS_PER_MM
    src = Image.open(io.BytesIO(png)).convert("L")
    if src.width > w or src.height > h:
        src.thumbnail((w, h))
    img = Image.new("L", (w, h), 255)
    img.paste(src, ((w - src.width) // 2, (h - src.height) // 2))
    return img.convert("1")


class PrinterLink:
    """Opens the printer for each job and closes it afterwards; one job at a time."""

    def __init__(self, tprint, bt: str | None = None):
        self.tprint = tprint
        self.bt = bt
        self.lock = threading.Lock()
        self.transport = "bluetooth" if bt else "usb"

    def _open(self):
        return self.tprint.BtPrinter(self.bt) if self.bt else self.tprint.UsbPrinter()

    @staticmethod
    def _close(printer):
        fd = getattr(printer, "fd", None)
        if fd is not None:
            os.close(fd)
        sock = getattr(printer, "sock", None)
        if sock is not None:
            sock.close()

    def _label_mm(self, printer) -> tuple[int, int]:
        w, h = printer.label_mm()
        return min(w or 40, self.tprint.HEAD_DOTS // DOTS_PER_MM), h or 30

    def info(self) -> dict:
        with self.lock:
            p = self._open()
            try:
                status = p.status()
                w, h = self._label_mm(p)
            finally:
                self._close(p)
        return {"ok": True, "transport": self.transport, "label_mm": [w, h], **status}

    def print_png(self, png: bytes, density: int) -> dict:
        with self.lock:
            p = self._open()
            try:
                w, h = self._label_mm(p)
                p.print_image(to_label(png, w, h), density)
            finally:
                self._close(p)
        return {"ok": True, "label_mm": [w, h]}


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".wasm": "application/wasm",
                      ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json"}

    def __init__(self, *args, link: PrinterLink, cors: str | None = None, **kwargs):
        self.link = link
        self.cors = cors
        super().__init__(*args, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        if self.cors:
            self.send_header("Access-Control-Allow-Origin", self.cors)
        super().end_headers()

    def _reply(self, obj: dict, status: int | None = None):
        body = json.dumps(obj).encode()
        self.send_response(status or (HTTPStatus.OK if obj.get("ok") else HTTPStatus.SERVICE_UNAVAILABLE))
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _call(self, fn) -> dict:
        try:
            return fn()
        except Exception as e:  # the printer's own errors go back to the page
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    def _origin_ok(self) -> bool:
        """Cross-origin pages may not print unless --cors-origin names them."""
        origin = self.headers.get("Origin")
        if not origin or origin == "null":
            return True
        host = self.headers.get("Host", "")
        if origin.split("://", 1)[-1] == host:
            return True
        return self.cors is not None and (self.cors == "*" or self.cors == origin)

    def do_OPTIONS(self):
        if not self.cors:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/api/printer":
            self._reply(self._call(self.link.info))
        elif path.startswith("/api/"):
            self.send_error(HTTPStatus.NOT_FOUND)
        else:
            super().do_GET()

    def do_POST(self):
        url = urlsplit(self.path)
        if url.path != "/api/print":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not self._origin_ok():
            self._reply({"ok": False, "error": "origin not allowed"}, HTTPStatus.FORBIDDEN)
            return
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY:
            self._reply({"ok": False, "error": "expected a PNG body under 4 MB"}, HTTPStatus.BAD_REQUEST)
            return
        png = self.rfile.read(length)
        try:
            density = min(15, max(0, int(parse_qs(url.query).get("density", ["4"])[0])))
        except ValueError:
            density = 4
        self._reply(self._call(partial(self.link.print_png, png, density)))

    def log_message(self, fmt, *args):
        if not str(args[0]).startswith("GET /api/printer") or "api/print " in str(args[0]):
            super().log_message(fmt, *args)


def make_server(bind: str, port: int, dist: Path, link: PrinterLink, cors: str | None = None,
                tls: tuple[str, str] | None = None) -> ThreadingHTTPServer:
    handler = partial(Handler, directory=str(dist), link=link, cors=cors)
    srv = ThreadingHTTPServer((bind, port), handler)
    if tls:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(tls[0], tls[1])
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    return srv


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bind", default="127.0.0.1", help="address to listen on (127.0.0.1)")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--dist", default=str(HERE / "dist"), help="built app directory (dist/)")
    ap.add_argument("--tprint", default=os.environ.get("TPRINT", str(Path.home() / "thermal-printer" / "tprint.py")),
                    help="path to tprint.py (env TPRINT)")
    ap.add_argument("--bt", metavar="ADDR", default=os.environ.get("TPRINT_BT"),
                    help="print over Bluetooth to this address (env TPRINT_BT) instead of USB")
    ap.add_argument("--cors-origin", metavar="ORIGIN", help="also let pages from this origin print ('*' for any)")
    ap.add_argument("--tls", nargs=2, metavar=("CERT", "KEY"), help="serve HTTPS with this certificate")
    a = ap.parse_args()

    dist = Path(a.dist)
    if not (dist / "index.html").exists():
        print(f"{dist} has no index.html; run 'mise run build' first", file=sys.stderr)
    try:
        tprint = load_tprint(Path(a.tprint))
    except Exception as e:
        print(f"cannot load {a.tprint}: {e}; printing is off", file=sys.stderr)
        tprint = None
    link = PrinterLink(tprint, a.bt) if tprint else None

    class NoPrinter:
        def info(self):
            raise RuntimeError("tprint.py not found; see --tprint")

        print_png = info

    srv = make_server(a.bind, a.port, dist, link or NoPrinter(), a.cors_origin, tuple(a.tls) if a.tls else None)
    scheme = "https" if a.tls else "http"
    host = "localhost" if a.bind in ("127.0.0.1", "0.0.0.0") else a.bind
    print(f"qr-sort at {scheme}://{host}:{a.port}/  (printer over {link.transport if link else 'nothing'})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
