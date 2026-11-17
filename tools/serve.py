#!/usr/bin/env python3
"""Local preview that mimics nginx.conf: clean URLs (/x -> x.html) and the 404 page.
    python3 tools/serve.py   ->  http://127.0.0.1:8765/
"""
import http.server, os, functools
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "landing")

class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".webp": "image/webp"}
    def send_head(self):
        path = self.path.split("?")[0].split("#")[0]
        fs = self.translate_path(path)
        if not os.path.isfile(fs) and os.path.isfile(fs + ".html"):
            self.path = path + ".html"
        elif not os.path.exists(fs):
            body = open(os.path.join(ROOT, "404.html"), "rb").read()
            self.send_response(404); self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body))); self.end_headers()
            import io; return io.BytesIO(body)
        return super().send_head()

if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", 8765), functools.partial(H, directory=ROOT)).serve_forever()
