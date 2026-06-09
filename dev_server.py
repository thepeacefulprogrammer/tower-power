#!/usr/bin/env python3
from __future__ import annotations

import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, format: str, *args) -> None:
        sys.stdout.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))
        sys.stdout.flush()


def main() -> int:
    host = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("HOST", "127.0.0.1")
    port = int(sys.argv[2] if len(sys.argv) > 2 else os.environ.get("PORT", "8080"))

    handler = partial(NoCacheHandler, directory=str(ROOT_DIR))
    server = ThreadingHTTPServer((host, port), handler)
    server.allow_reuse_address = True

    print(f"Serving {ROOT_DIR} at http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
