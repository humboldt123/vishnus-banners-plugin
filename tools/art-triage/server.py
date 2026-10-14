#!/usr/bin/env python3
"""Art triage: sort bookmarked images into banner candidates.

Serves index.html, the images from the two Desktop bookmark folders, and
reads/writes triage.json (your bins + comments) next to this file.
Usage: python3 server.py [port]
"""
import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
DESKTOP = Path.home() / "Desktop"
ALLOWED = [DESKTOP / "Bookmarks" / "Art", DESKTOP / "NEW_BOOKMARKS" / "Art"]
STATE = HERE / "triage.json"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/img":
            rel = unquote(parse_qs(url.query).get("p", [""])[0])
            path = (DESKTOP / rel).resolve()
            if not any(path.is_relative_to(a) for a in ALLOWED) or not path.is_file():
                return self.send_error(404)
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(str(path)))
            self.send_header("Cache-Control", "max-age=86400")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif url.path == "/state":
            self.send_json(json.loads(STATE.read_text()) if STATE.exists() else None)
        else:
            super().do_GET()

    def do_POST(self):
        if urlparse(self.path).path != "/state":
            return self.send_error(404)
        data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        STATE.write_text(json.dumps(data, indent=1, ensure_ascii=False))
        self.send_json({"ok": True})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f"Art triage on http://localhost:{port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
