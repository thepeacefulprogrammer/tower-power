#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import struct

ROOT_DIR = Path(__file__).resolve().parent
DEBUG_DIR = ROOT_DIR / "debug"
EDGE_DEBUG_SCRIPT = ROOT_DIR / "scripts" / "towerpower-edge-debug.ps1"
CDP_CLICK_SCRIPT = ROOT_DIR / "scripts" / "towerpower-cdp-click.ps1"
CDP_RUN_ACTION_SCRIPT = ROOT_DIR / "scripts" / "towerpower-cdp-run-action.ps1"
CDP_CAPTURE_SCRIPT = ROOT_DIR / "scripts" / "towerpower-cdp-capture-pane.ps1"
TEMPLATE_DETECTOR_SCRIPT = ROOT_DIR / "scripts" / "detect_template.py"
GEM_TEMPLATE = ROOT_DIR / "templates" / "gem_button.png"
DEFAULT_TEMPLATE_PYTHON = (
    Path.home() / "old_local" / "local" / "tower_automation" / ".venv" / "bin" / "python"
)
PANE_VIEWPORTS = {
    "pane-a": "pane-a-viewport",
    "pane-b": "pane-b-viewport",
}
GEM_DETECTION_ENABLED = os.environ.get("GEM_DETECTION_ENABLED", "1") != "0"
GEM_DETECTION_INTERVAL_MS = max(int(os.environ.get("GEM_DETECTION_INTERVAL_MS", "30000")), 1000)
GEM_DETECTION_THRESHOLD = float(os.environ.get("GEM_DETECTION_THRESHOLD", "0.72"))
LATEST_CAPTURE: dict[str, dict] = {}
GEM_DETECTION_LOCK = threading.Lock()
GEM_DETECTION_STATE: dict[str, object] = {
    "ok": True,
    "enabled": GEM_DETECTION_ENABLED,
    "intervalMs": GEM_DETECTION_INTERVAL_MS,
    "threshold": GEM_DETECTION_THRESHOLD,
    "results": {},
    "lastUpdatedAt": None,
    "startedAt": datetime.now().isoformat(timespec="seconds"),
}


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


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
CDP_CAPTURE_SCRIPT_WIN = to_windows_path(CDP_CAPTURE_SCRIPT)


def should_retry_browser(stdout: str, stderr: str) -> bool:
    combined = f"{stdout}\n{stderr}"
    retry_markers = (
        "Could not find open Tower Power tab on Edge remote debugger",
        "Unable to connect to the remote server",
        "Failed to connect to the remote server",
        "actively refused",
        "No connection could be made",
        "Connection refused",
    )
    return any(marker in combined for marker in retry_markers)


def path_to_url(path: Path) -> str:
    try:
        relative = path.resolve().relative_to(ROOT_DIR)
    except ValueError:
        return str(path)
    return f"/{relative.as_posix()}"


def make_timestamp() -> str:
    return datetime.now().strftime("%Y-%m-%d-%H-%M-%S-%f")[:-3]


def build_scale_list(base_scale: float) -> list[float]:
    candidates = [
        base_scale * 0.85,
        base_scale * 0.925,
        base_scale,
        base_scale * 1.075,
        base_scale * 1.15,
        1.0,
    ]
    unique: list[float] = []
    for value in candidates:
        rounded = round(value, 3)
        if rounded > 0.2 and rounded not in unique:
            unique.append(rounded)
    return sorted(unique)


def resolve_template_python() -> str:
    candidates = [
        os.environ.get("TEMPLATE_PYTHON", "").strip(),
        str(DEFAULT_TEMPLATE_PYTHON),
        sys.executable,
        "python3",
    ]
    for candidate in candidates:
        if not candidate:
            continue
        if Path(candidate).exists():
            return candidate
        if shutil.which(candidate):
            return candidate
    return "python3"


def run_command(command: list[str], timeout: int = 90) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=ROOT_DIR,
        env=os.environ.copy(),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def ensure_edge_debug_window() -> None:
    try:
        run_command(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                EDGE_DEBUG_SCRIPT_WIN,
                "-Mode",
                "ensure",
            ],
            timeout=20,
        )
    except Exception:  # noqa: BLE001
        pass


def read_png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as handle:
        header = handle.read(24)
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError(f"Unsupported PNG file: {path}")
    width, height = struct.unpack(">II", header[16:24])
    return int(width), int(height)


GEM_TEMPLATE_WIDTH, GEM_TEMPLATE_HEIGHT = read_png_size(GEM_TEMPLATE)


def run_json_command(command: list[str], timeout: int = 90, retry_browser: bool = False) -> dict:
    completed = run_command(command, timeout=timeout)
    if completed.returncode != 0 and retry_browser and should_retry_browser(completed.stdout, completed.stderr):
        ensure_edge_debug_window()
        completed = run_command(command, timeout=timeout)

    if completed.returncode != 0:
        details = (completed.stderr or completed.stdout or "unknown error").strip()
        raise RuntimeError(details or f"Command failed with exit code {completed.returncode}")

    stdout = completed.stdout.strip()
    if not stdout:
        return {}

    try:
        return json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Command returned invalid JSON: {stdout[:500]}") from exc


def capture_pane_screenshot(
    pane: str,
    output_path: Path,
    *,
    center_point: dict[str, int] | None = None,
) -> dict:
    viewport_id = PANE_VIEWPORTS[pane]
    command = [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        CDP_CAPTURE_SCRIPT_WIN,
        "-ViewportId",
        viewport_id,
        "-OutputPath",
        to_windows_path(output_path),
    ]
    if center_point:
        command.extend(
            [
                "-StageCenterX",
                str(int(center_point["x"])),
                "-StageCenterY",
                str(int(center_point["y"])),
                "-StageWidth",
                str(GEM_TEMPLATE_WIDTH),
                "-StageHeight",
                str(GEM_TEMPLATE_HEIGHT),
            ]
        )
    return run_json_command(
        command,
        timeout=40,
        retry_browser=True,
    )


def run_template_detector(screenshot_path: Path, annotated_path: Path, scales: list[float]) -> dict:
    return run_json_command(
        [
            resolve_template_python(),
            str(TEMPLATE_DETECTOR_SCRIPT),
            "--screenshot",
            str(screenshot_path),
            "--template",
            str(GEM_TEMPLATE),
            "--annotated",
            str(annotated_path),
            "--threshold",
            str(GEM_DETECTION_THRESHOLD),
            "--scales",
            ",".join(str(scale) for scale in scales),
        ],
        timeout=90,
    )


def normalize_stage_point(point: object) -> dict[str, int] | None:
    if not isinstance(point, dict):
        return None
    x = point.get("x")
    y = point.get("y")
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return None
    return {"x": int(round(x)), "y": int(round(y))}


def detect_claim_button_for_pane(pane: str, center_point: dict[str, int] | None = None) -> dict:
    checked_at = now_iso()
    screenshot_path = DEBUG_DIR / f"{pane}-{make_timestamp()}.png"
    annotated_path = DEBUG_DIR / f"{pane}-{make_timestamp()}-gem-detected.png"
    DEBUG_DIR.mkdir(parents=True, exist_ok=True)

    result: dict[str, object] = {
        "pane": pane,
        "viewportId": PANE_VIEWPORTS[pane],
        "checkedAt": checked_at,
        "state": "not-found",
        "found": False,
        "error": None,
    }

    try:
        capture_payload = capture_pane_screenshot(
            pane,
            screenshot_path,
            center_point=center_point,
        )
        stage_scale = float(capture_payload.get("stageScale") or 1.0)
        detection_payload = run_template_detector(
            screenshot_path,
            annotated_path,
            build_scale_list(stage_scale),
        )

        result.update(
            {
                "screenshot": str(screenshot_path),
                "screenshotUrl": path_to_url(screenshot_path),
                "annotated": str(annotated_path),
                "annotatedUrl": path_to_url(annotated_path),
                "lockedSize": {
                    "width": capture_payload.get("lockedWidth"),
                    "height": capture_payload.get("lockedHeight"),
                },
                "renderedSize": {
                    "width": capture_payload.get("renderedWidth"),
                    "height": capture_payload.get("renderedHeight"),
                },
                "stageScale": capture_payload.get("stageScale"),
                "detection": detection_payload,
            }
        )

        if detection_payload.get("found") and detection_payload.get("match"):
            match = detection_payload["match"]
            image = detection_payload.get("image") or {}
            image_width = float(image.get("width") or 0)
            image_height = float(image.get("height") or 0)
            locked_width = float(capture_payload.get("lockedWidth") or 0)
            locked_height = float(capture_payload.get("lockedHeight") or 0)
            center_x, center_y = match["center"]
            if center_point:
                result["wouldClickStagePoint"] = {
                    "x": center_point["x"],
                    "y": center_point["y"],
                }
            elif image_width > 0 and image_height > 0 and locked_width > 0 and locked_height > 0:
                result["wouldClickStagePoint"] = {
                    "x": round((float(center_x) * locked_width) / image_width),
                    "y": round((float(center_y) * locked_height) / image_height),
                }
            result["wouldClickImagePoint"] = {
                "x": round(float(center_x)),
                "y": round(float(center_y)),
            }
            result["found"] = True
            result["state"] = "found"
        else:
            result["found"] = False
            result["state"] = "not-found"
    except Exception as exc:  # noqa: BLE001
        result.update(
            {
                "found": False,
                "state": "error",
                "error": str(exc),
                "screenshot": str(screenshot_path),
                "screenshotUrl": path_to_url(screenshot_path),
                "annotated": str(annotated_path),
                "annotatedUrl": path_to_url(annotated_path),
            }
        )

    return result


def refresh_claim_detection() -> None:
    if not GEM_DETECTION_ENABLED:
        return

    results = {pane: detect_claim_button_for_pane(pane) for pane in PANE_VIEWPORTS}
    with GEM_DETECTION_LOCK:
        GEM_DETECTION_STATE["results"] = results
        GEM_DETECTION_STATE["lastUpdatedAt"] = now_iso()


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
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)

        if parsed.path == "/__gem-detection":
            with GEM_DETECTION_LOCK:
                state = json.loads(json.dumps(GEM_DETECTION_STATE))
            pane = query.get("pane", [""])[0]
            if pane in PANE_VIEWPORTS:
                pane_result = (state.get("results") or {}).get(pane)
                self.send_json(200, {"ok": True, "result": pane_result, "pane": pane})
                return
            self.send_json(200, state)
            return

        if parsed.path == "/__capture-stage-point":
            viewport_id = query.get("viewportId", [""])[0]
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

        if self.path == "/__gem-detection/run-now":
            pane = payload.get("pane")
            if pane and pane not in PANE_VIEWPORTS:
                self.send_json(400, {"ok": False, "error": "pane must be pane-a or pane-b"})
                return
            center_point = normalize_stage_point(payload.get("centerPoint"))
            if pane:
                result = detect_claim_button_for_pane(pane, center_point=center_point)
                with GEM_DETECTION_LOCK:
                    current_results = GEM_DETECTION_STATE.get("results")
                    results: dict[str, object] = {}
                    if isinstance(current_results, dict):
                        results.update(current_results)
                    results[pane] = result
                    GEM_DETECTION_STATE["results"] = results
                    GEM_DETECTION_STATE["lastUpdatedAt"] = now_iso()
                self.send_json(200, {"ok": True, "result": result})
                return
            refresh_claim_detection()
            with GEM_DETECTION_LOCK:
                state = json.loads(json.dumps(GEM_DETECTION_STATE))
            self.send_json(200, state)
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

        if action in {"menuButton", "stagePoint"}:
            if not isinstance(viewport_id, str) or not isinstance(point, dict):
                self.send_json(400, {"ok": False, "error": f"{action} requires viewportId and point"})
                return
            x = point.get("x")
            y = point.get("y")
            if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
                self.send_json(400, {"ok": False, "error": f"{action} requires numeric point.x and point.y"})
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

            if action in {"menuButton", "stagePoint"} and completed.returncode != 0:
                stdout = completed.stdout.strip()
                stderr = completed.stderr.strip()
                if should_retry_browser(stdout, stderr):
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
    if GEM_DETECTION_ENABLED:
        print(
            f"CLAIM detection available on demand at threshold {GEM_DETECTION_THRESHOLD} (frontend requests checks for enabled panes)",
            flush=True,
        )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
