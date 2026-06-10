#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8080}"
HOST="${HOST:-127.0.0.1}"
URL="http://${HOST}:${PORT}"
PID_FILE="$ROOT_DIR/.dev-server.pid"
LOG_FILE="$ROOT_DIR/.dev-server.log"
CONFIG_JS_FILE="$ROOT_DIR/config.js"
CONFIG_JS_EXAMPLE_FILE="$ROOT_DIR/config.js.example"
SERVER_SCRIPT="$ROOT_DIR/dev_server.py"
EDGE_DEBUG_SCRIPT="$ROOT_DIR/scripts/towerpower-edge-debug.ps1"

if ! command -v python3 >/dev/null 2>&1; then
	echo "Error: python3 is required to serve this app." >&2
	exit 1
fi

kill_pid() {
	local pid="$1"

	if [[ -z "$pid" ]] || ! [[ "$pid" =~ ^[0-9]+$ ]]; then
		return 0
	fi

	if kill -0 "$pid" >/dev/null 2>&1; then
		kill "$pid" >/dev/null 2>&1 || true

		for _ in {1..20}; do
			if ! kill -0 "$pid" >/dev/null 2>&1; then
				return 0
			fi
			sleep 0.1
		done

		kill -9 "$pid" >/dev/null 2>&1 || true
	fi
}

free_port() {
	local pids=""

	if [[ -f "$PID_FILE" ]]; then
		kill_pid "$(<"$PID_FILE")"
		rm -f "$PID_FILE"
	fi

	if command -v lsof >/dev/null 2>&1; then
		pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
	elif command -v fuser >/dev/null 2>&1; then
		pids="$(fuser -n tcp "$PORT" 2>/dev/null || true)"
	fi

	if [[ -n "$pids" ]]; then
		echo "Closing existing process(es) on port $PORT: $pids"
		for pid in $pids; do
			kill_pid "$pid"
		done
	fi
}

ensure_config_js() {
	if [[ -f "$CONFIG_JS_FILE" ]]; then
		return 0
	fi

	if [[ ! -f "$CONFIG_JS_EXAMPLE_FILE" ]]; then
		echo "Error: missing $CONFIG_JS_FILE and $CONFIG_JS_EXAMPLE_FILE" >&2
		exit 1
	fi

	cp "$CONFIG_JS_EXAMPLE_FILE" "$CONFIG_JS_FILE"
	echo "Created $CONFIG_JS_FILE from config.js.example"
	echo "Edit config.js with your LD Cloud device IDs, then run ./dev.sh again."
	exit 0
}

cd "$ROOT_DIR"
ensure_config_js
free_port

echo "Starting Tower Power at ${URL}"
nohup python3 "$SERVER_SCRIPT" "$HOST" "$PORT" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" >"$PID_FILE"

sleep 1

if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
	echo "Error: failed to start local server. Check $LOG_FILE" >&2
	rm -f "$PID_FILE"
	exit 1
fi

if [[ "${NO_BROWSER:-0}" != "1" ]]; then
	if [[ -n "${WSL_DISTRO_NAME:-}" ]] && command -v powershell.exe >/dev/null 2>&1 && command -v wslpath >/dev/null 2>&1; then
		EDGE_DEBUG_SCRIPT_WIN="$(wslpath -w "$EDGE_DEBUG_SCRIPT")"
		powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$EDGE_DEBUG_SCRIPT_WIN" -Mode reset >/dev/null 2>&1 || true
	elif command -v xdg-open >/dev/null 2>&1; then
		xdg-open "$URL" >/dev/null 2>&1 || true
	elif command -v open >/dev/null 2>&1; then
		open "$URL" >/dev/null 2>&1 || true
	fi
fi

echo "Serving ${ROOT_DIR}"
echo "URL: $URL"
echo "PID: $SERVER_PID"
echo "Log: $LOG_FILE"
echo "Collect gems now uses timer-based clicks from the frontend when enabled in the pane menu."
if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
	echo "For phone/LAN access from Windows, run ./enable-phone-access.sh once and allow the admin prompt."
fi
echo "Edit config.js to update crop values live."
