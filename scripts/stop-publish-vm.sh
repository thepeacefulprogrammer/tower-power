#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
REMOTE_CONFIG_FILE=${REMOTE_CONFIG_FILE:-$REPO_ROOT/.remote-publish.env}

if [[ -f "$REMOTE_CONFIG_FILE" ]]; then
	# shellcheck disable=SC1090
	source "$REMOTE_CONFIG_FILE"
fi

PID_FILE=${PID_FILE:-$REPO_ROOT/.remote-publish.pid}
DEPLOY_HOST=${DEPLOY_HOST:-}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519}
REMOTE_SOCKET=${REMOTE_SOCKET:-}

if [[ ! -f "$PID_FILE" ]]; then
	echo "No remote publish PID file found."
	exit 0
fi

pid=$(<"$PID_FILE")
if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
	kill "$pid" 2>/dev/null || true
	echo "Stopped remote publish tunnel PID $pid"
else
	echo "Remote publish tunnel PID $pid is not running."
fi

rm -f "$PID_FILE"

if [[ -n "$DEPLOY_HOST" && -n "$REMOTE_SOCKET" && -f "$SSH_KEY" ]]; then
	ssh -i "$SSH_KEY" -o BatchMode=yes "$DEPLOY_HOST" "rm -f '$REMOTE_SOCKET'" || true
fi
