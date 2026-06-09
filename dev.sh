#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8080}"
HOST="${HOST:-127.0.0.1}"
URL="http://${HOST}:${PORT}"
PID_FILE="$ROOT_DIR/.dev-server.pid"
LOG_FILE="$ROOT_DIR/.dev-server.log"
CONFIG_FILE="$ROOT_DIR/config.toml"
CONFIG_JS_FILE="$ROOT_DIR/config.js"

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

trim() {
	local value="$1"
	value="${value#${value%%[![:space:]]*}}"
	value="${value%${value##*[![:space:]]}}"
	printf '%s' "$value"
}

read_config_value() {
	local key="$1"
	local raw

	raw="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$CONFIG_FILE" | tail -n 1 || true)"
	raw="${raw#*=}"
	raw="${raw%%#*}"
	raw="$(trim "$raw")"
	raw="${raw%\"}"
	raw="${raw#\"}"
	raw="${raw%\'}"
	raw="${raw#\'}"
	printf '%s' "$raw"
}

ensure_config_file() {
	if [[ -f "$CONFIG_FILE" ]]; then
		return 0
	fi

	if [[ ! -f "$ROOT_DIR/config.toml.example" ]]; then
		echo "Error: missing $CONFIG_FILE and config.toml.example" >&2
		exit 1
	fi

	cp "$ROOT_DIR/config.toml.example" "$CONFIG_FILE"
	echo "Created $CONFIG_FILE from config.toml.example"
	echo "Edit config.toml with your LD Cloud device IDs, then run ./dev.sh again."
	exit 0
}

generate_config_js() {
	ensure_config_file

	local device_a device_b
	device_a="$(read_config_value DEVICE_A)"
	device_b="$(read_config_value DEVICE_B)"

	if [[ -z "$device_a" || -z "$device_b" ]]; then
		echo "Error: config.toml must define DEVICE_A and DEVICE_B" >&2
		exit 1
	fi

	if [[ "$device_a" == YOUR_* || "$device_b" == YOUR_* ]]; then
		echo "Error: config.toml still contains placeholder values. Update DEVICE_A and DEVICE_B, then run ./dev.sh again." >&2
		exit 1
	fi

	cat >"$CONFIG_JS_FILE" <<EOF
window.TOWER_POWER_CONFIG = {
  DEVICE_A: "${device_a}",
  DEVICE_B: "${device_b}",
};
EOF
}

cd "$ROOT_DIR"
generate_config_js
free_port

echo "Starting Tower Power at ${URL}"
nohup python3 -m http.server "$PORT" --bind "$HOST" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" >"$PID_FILE"
disown "$SERVER_PID" 2>/dev/null || true

sleep 1

if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
	echo "Error: failed to start local server. Check $LOG_FILE" >&2
	rm -f "$PID_FILE"
	exit 1
fi

if [[ "${NO_BROWSER:-0}" != "1" ]]; then
	if command -v xdg-open >/dev/null 2>&1; then
		xdg-open "$URL" >/dev/null 2>&1 || true
	elif command -v open >/dev/null 2>&1; then
		open "$URL" >/dev/null 2>&1 || true
	fi
fi

echo "Serving ${ROOT_DIR}"
echo "URL: $URL"
echo "PID: $SERVER_PID"
echo "Log: $LOG_FILE"
