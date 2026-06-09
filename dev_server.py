#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent
EDGE_DEBUG_SCRIPT = ROOT_DIR / "scripts" / "towerpower-edge-debug.ps1"
CDP_CLICK_SCRIPT = ROOT_DIR / "scripts" / "towerpower-cdp-click.ps1"
CDP_RUN_ACTION_SCRIPT = ROOT_DIR / "scripts" / "towerpower-cdp-run-action.ps1"
LATEST_CAPTURE: dict[str, dict] = {}


def to_windows_path(path: Path) -> str:
    try:
        completed = subprocess.run(
            ["wslpath", "-w", str(path)],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if completed.returncode == 0:
            return completed.stdout.strip()
    except Exception:  # noqa: BLE001
        pass
    return str(path)


EDGE_DEBUG_SCRIPT_WIN = to_windows_path(EDGE_DEBUG_SCRIPT)
CDP_CLICK_SCRIPT_WIN = to_windows_path(CDP_CLICK_SCRIPT)
CDP_RUN_ACTION_SCRIPT_WIN = to_windows_path(CDP_RUN_ACTION_SCRIPT)


def should_retry_menubutton(stdout: str, stderr: str) -> bool:
    combined = f"{stdout}\n{stderr}"
    retry_markers = (
        "Could not find open Tower Power tab on Edge remote debugger",
        "Unable to connect to the remote server",
        "Failed to connect to the remote server",
        "actively refused",
        "No connection could be made",
    )
    return any(marker in combined for marker in retry_markers)


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, format: str, *args) -> None:
        sys.stdout.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))
        sys.stdout.flush()

    def send_json(self, status: int, payload: dict) -> None:
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path.startswith("/__capture-stage-point"):
            viewport_id = self.path.split("viewportId=", 1)[1] if "viewportId=" in self.path else ""
            payload = LATEST_CAPTURE.get(viewport_id)
            self.send_json(200, {"ok": True, "capture": payload})
            return

        super().do_GET()

    def do_POST(self) -> None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:  # noqa: BLE001
            self.send_json(400, {"ok": False, "error": f"Invalid JSON: {exc}"})
            return

        if self.path == "/__capture-stage-point":
            viewport_id = payload.get("viewportId")
            if not isinstance(viewport_id, str) or not viewport_id:
                self.send_json(400, {"ok": False, "error": "capture requires viewportId"})
                return
            LATEST_CAPTURE[viewport_id] = payload
            self.send_json(200, {"ok": True})
            return

        if self.path != "/__automation":
            self.send_error(404, "Not Found")
            return

        pane = payload.get("pane")
        action = payload.get("action")
        viewport_id = payload.get("viewportId")
        point = payload.get("point") or {}
        sequence = payload.get("sequence") or {}
        if pane not in {"pane-a", "pane-b"} or not isinstance(action, str) or not action:
            self.send_json(400, {"ok": False, "error": "Expected pane-a|pane-b and action string"})
            return

        if action == "menuButton":
            if not isinstance(viewport_id, str) or not isinstance(point, dict):
                self.send_json(400, {"ok": False, "error": "menuButton requires viewportId and point"})
                return
            x = point.get("x")
            y = point.get("y")
            if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                self.send_json(400, {"ok": False, "error": "menuButton requires numeric point.x and point.y"})
                return
            command = [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                CDP_CLICK_SCRIPT_WIN,
                "-ViewportId",
                viewport_id,
                "-StageX",
                str(round(x)),
                "-StageY",
                str(round(y)),
            ]
        elif action.startswith("actions."):
            if not isinstance(viewport_id, str) or not isinstance(sequence, dict):
                self.send_json(400, {"ok": False, "error": "actions.* requires viewportId and sequence"})
                return
            menu_point = sequence.get("menuButton") or {}
            action_points = sequence.get("actionPoints") or []
            close_point = sequence.get("closeMenu") or {}
            menu_values = [menu_point.get("x"), menu_point.get("y")]
            close_values = [close_point.get("x"), close_point.get("y")]
            if not all(isinstance(value, (int, float)) for value in [*menu_values, *close_values]):
                self.send_json(400, {"ok": False, "error": "actions.* requires numeric menu/close points"})
                return
            if not isinstance(action_points, list) or not action_points:
                self.send_json(400, {"ok": False, "error": "actions.* requires one or more actionPoints"})
                return
            normalized_action_points = []
            for action_point in action_points:
                if not isinstance(action_point, dict):
                    self.send_json(400, {"ok": False, "error": "each actionPoint must be an object"})
                    return
                x = action_point.get("x")
                y = action_point.get("y")
                if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                    self.send_json(400, {"ok": False, "error": "each actionPoint requires numeric x and y"})
                    return
                normalized_action_points.append({"x": round(x), "y": round(y)})
            command = [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                CDP_RUN_ACTION_SCRIPT_WIN,
                "-ViewportId",
                viewport_id,
                "-MenuX",
                str(round(menu_point["x"])),
                "-MenuY",
                str(round(menu_point["y"])),
                "-ActionPointsJson",
                json.dumps(normalized_action_points, separators=(",", ":")),
                "-CloseX",
                str(round(close_point["x"])),
                "-CloseY",
                str(round(close_point["y"])),
            ]
        else:
            command = ["node", "automation.js", "run-action", pane, action]
        env = os.environ.copy()
        env.setdefault("HEADLESS", env.get("HEADLESS", "1"))

        try:
            completed = subprocess.run(
                command,
                cwd=ROOT_DIR,
                env=env,
                capture_output=True,
                text=True,
                timeout=90,
                check=False,
            )

            if action == "menuButton" and completed.returncode != 0:
                stdout = completed.stdout.strip()
                stderr = completed.stderr.strip()
                if should_retry_menubutton(stdout, stderr):
                    subprocess.run(
                        [
                            "powershell.exe",
                            "-NoProfile",
                            "-ExecutionPolicy",
                            "Bypass",
                            "-File",
                            EDGE_DEBUG_SCRIPT_WIN,
                        ],
                        cwd=ROOT_DIR,
                        env=env,
                        capture_output=True,
                        text=True,
                        timeout=20,
                        check=False,
                    )

                    completed = subprocess.run(
                        command,
                        cwd=ROOT_DIR,
                        env=env,
                        capture_output=True,
                        text=True,
                        timeout=90,
                        check=False,
                    )
        except subprocess.TimeoutExpired as exc:
            self.send_json(504, {"ok": False, "error": f"Automation timed out: {exc}"})
            return
        except Exception as exc:  # noqa: BLE001
            self.send_json(500, {"ok": False, "error": f"Automation failed to start: {exc}"})
            return

        stdout = completed.stdout.strip()
        stderr = completed.stderr.strip()
        ok = completed.returncode == 0
        status = 200 if ok else 500
        self.send_json(
            status,
            {
                "ok": ok,
                "returncode": completed.returncode,
                "stdout": stdout,
                "stderr": stderr,
                "command": command,
            },
        )


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
