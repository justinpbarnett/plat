import json
import shlex
import subprocess
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from plat import render, store

HOST = "127.0.0.1"
PORT_ATTEMPTS = 11
POLL_SECONDS = 0.5
KEEPALIVE_SECONDS = 15
EDITOR_TIMEOUT_SECONDS = 10
BOARD_MISSING = "the board is not built yet: plat/board/index.html is missing"


def fresh_config(root: Path) -> dict:
    try:
        config = json.loads(store.config_path(root).read_text())
    except FileNotFoundError:
        config = {}
    return store.merged(store.DEFAULT_CONFIG, config)


def watched_mtimes(root: Path) -> tuple:
    mtimes = []
    for path in (store.model_path(root), store.config_path(root)):
        try:
            mtimes.append(path.stat().st_mtime_ns)
        except OSError:
            mtimes.append(None)
    return tuple(mtimes)


def contained_file(root: Path, requested: str) -> Path | None:
    real_root = root.resolve()
    resolved = (real_root / requested).resolve()
    if not resolved.is_relative_to(real_root):
        return None
    return root / resolved.relative_to(real_root)


def handler_for(root: Path):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format, *args):
            pass

        def reply(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def reply_json(self, status: int, data: dict) -> None:
            self.reply(status, json.dumps(data).encode(), "application/json; charset=utf-8")

        def reply_text(self, status: int, text: str) -> None:
            self.reply(status, (text + "\n").encode(), "text/plain; charset=utf-8")

        def do_GET(self) -> None:
            route = self.path.split("?", 1)[0]
            if route == "/":
                self.board()
            elif route == "/model":
                self.reply_json(200, {"model": store.load_model(root), "config": fresh_config(root)})
            elif route == "/events":
                self.events()
            else:
                self.reply_text(404, "not found")

        def board(self) -> None:
            if not (render.BOARD / "index.html").exists():
                self.reply_text(500, BOARD_MISSING)
                return
            page = render.html(root, store.load_model(root), fresh_config(root), "serve")
            self.reply(200, page.encode(), "text/html; charset=utf-8")

        def events(self) -> None:
            self.close_connection = True
            seen = watched_mtimes(root)
            next_keepalive = time.monotonic() + KEEPALIVE_SECONDS
            try:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.flush()
                while True:
                    time.sleep(POLL_SECONDS)
                    current = watched_mtimes(root)
                    if current != seen:
                        seen = current
                        self.wfile.write(b"data: changed\n\n")
                        self.wfile.flush()
                    if time.monotonic() >= next_keepalive:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                        next_keepalive = time.monotonic() + KEEPALIVE_SECONDS
            except OSError:
                return

        def do_POST(self) -> None:
            if self.path.split("?", 1)[0] != "/open":
                self.reply_text(404, "not found")
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                request = json.loads(self.rfile.read(length) or b"{}")
                requested = request["path"]
                line = int(request.get("line") or 1)
                if not isinstance(requested, str):
                    raise TypeError
            except (ValueError, KeyError, TypeError):
                self.reply_json(400, {"error": "expected JSON with a string path and an integer line"})
                return
            target = contained_file(root, requested)
            if target is None:
                self.reply_json(403, {"error": f"{requested} is outside the repo"})
                return
            editor = fresh_config(root).get("editor") or "code"
            try:
                command = shlex.split(editor)
                subprocess.run(
                    [*command, str(root), "-g", f"{target}:{line}"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=EDITOR_TIMEOUT_SECONDS,
                )
            except subprocess.TimeoutExpired:
                pass
            except (OSError, ValueError, IndexError) as problem:
                self.reply_json(500, {"error": f"could not run editor '{editor}': {problem}"})
                return
            self.reply_json(200, {"ok": True})

    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads = True


def bind(root: Path, port: int) -> Server | None:
    for candidate in range(port, port + PORT_ATTEMPTS):
        try:
            return Server((HOST, candidate), handler_for(root))
        except OSError:
            continue
    return None


def run(root: Path, port: int, open_browser: bool) -> int:
    server = bind(root, port)
    if server is None:
        print(f"no free port from {port} to {port + PORT_ATTEMPTS - 1}")
        return 1
    url = f"http://{HOST}:{server.server_address[1]}/"
    print(f"serving {root} at {url}", flush=True)
    if open_browser:
        threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0
