import json
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import yt_dlp

POOL_SIZE = int(os.environ.get("YT_DLP_POOL_SIZE", "5"))
PORT = int(os.environ.get("YT_DLP_PORT", "3001"))
VIDEO_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{11}$")

YDL_OPTS = {
    "quiet": True,
    "no_warnings": False,
    "extractor_args": {"youtube": {"player_client": ["web"]}},
    "js_runtimes": "node",
}

# Pool of YoutubeDL instances with individual locks
pool = []
for _ in range(POOL_SIZE):
    pool.append({
        "ydl": yt_dlp.YoutubeDL(YDL_OPTS),
        "lock": threading.Lock(),
    })

pool_index = 0
pool_index_lock = threading.Lock()


def acquire_instance():
    global pool_index
    with pool_index_lock:
        idx = pool_index
        pool_index = (pool_index + 1) % POOL_SIZE
    entry = pool[idx]
    entry["lock"].acquire()
    return entry


def release_instance(entry):
    entry["lock"].release()


def extract(video_id):
    entry = acquire_instance()
    try:
        info = entry["ydl"].extract_info(
            f"https://www.youtube.com/watch?v={video_id}", download=False
        )
        return {
            "title": info.get("title"),
            "channel": info.get("channel"),
            "duration": info.get("duration"),
            "formats": [
                {
                    "format_id": f.get("format_id"),
                    "ext": f.get("ext"),
                    "vcodec": f.get("vcodec"),
                    "acodec": f.get("acodec"),
                    "height": f.get("height"),
                    "width": f.get("width"),
                    "url": f.get("url"),
                    "tbr": f.get("tbr"),
                }
                for f in info.get("formats", [])
                if f.get("url")
            ],
        }
    finally:
        release_instance(entry)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        parts = self.path.strip("/").split("/")
        if parts == ["health"]:
            self._json(200, {"status": "ok", "pool_size": POOL_SIZE})
            return

        if len(parts) != 2 or parts[0] != "extract":
            self._json(400, {"error": "Use /extract/<videoId>"})
            return

        video_id = parts[1]
        if not VIDEO_ID_RE.match(video_id):
            self._json(400, {"error": "Invalid videoId"})
            return

        try:
            result = extract(video_id)
            self._json(200, result)
        except Exception as e:
            self._json(500, {"error": str(e)})

    def _json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if self.path and "/health" not in self.path:
            print(f"{args[0]} {args[1]} {args[2]}")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"yt-dlp sidecar listening on port {PORT} (pool_size={POOL_SIZE})")
    server.serve_forever()
