#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
REMOTE_CONFIG_FILE=${REMOTE_CONFIG_FILE:-$REPO_ROOT/.remote-publish.env}

if [[ -f "$REMOTE_CONFIG_FILE" ]]; then
	# shellcheck disable=SC1090
	source "$REMOTE_CONFIG_FILE"
fi

DEPLOY_HOST=${DEPLOY_HOST:-}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/id_ed25519}
LOCAL_PORT=${LOCAL_PORT:-8080}
REMOTE_SOCKET=${REMOTE_SOCKET:-}
PUBLIC_HOST=${PUBLIC_HOST:-}
PID_FILE=${PID_FILE:-$REPO_ROOT/.remote-publish.pid}
LOG_FILE=${LOG_FILE:-$REPO_ROOT/.remote-publish.log}
BACKGROUND=1

usage() {
	cat <<'EOF'
Publish local Tower Power through the remote VM using an SSH reverse tunnel.

This keeps Tower Power and Edge/LD Cloud automation on your laptop while
making the UI reachable through a public hostname on the VM.

Usage:
  ./scripts/publish-vm.sh [options]

Options:
  --host <user@host>       Remote SSH target (default: DEPLOY_HOST from config)
  --ssh-key <path>         SSH private key (default: ~/.ssh/id_ed25519)
  --local-port <port>      Local Tower Power port (default: 8080)
  --remote-socket <path>   Remote Unix socket path on the remote host
  --public-host <host>     Public HTTPS hostname to print after connect
  --foreground             Keep ssh in the foreground instead of daemonizing
  --help                   Show this help

Configuration:
  Copy .remote-publish.env.example to .remote-publish.env and set DEPLOY_HOST,
  REMOTE_SOCKET, and optionally PUBLIC_HOST.
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--host)
		DEPLOY_HOST=${2:?missing value for --host}
		shift 2
		;;
	--ssh-key)
		SSH_KEY=${2:?missing value for --ssh-key}
		shift 2
		;;
	--local-port)
		LOCAL_PORT=${2:?missing value for --local-port}
		shift 2
		;;
	--remote-socket)
		REMOTE_SOCKET=${2:?missing value for --remote-socket}
		shift 2
		;;
	--public-host)
		PUBLIC_HOST=${2:?missing value for --public-host}
		shift 2
		;;
	--foreground)
		BACKGROUND=0
		shift
		;;
	--help | -h)
		usage
		exit 0
		;;
	*)
		echo "Unknown argument: $1" >&2
		usage >&2
		exit 1
		;;
	esac
done

if [[ -z "$DEPLOY_HOST" ]]; then
	echo "DEPLOY_HOST is required. Set it in .remote-publish.env or pass --host." >&2
	exit 1
fi

if [[ -z "$REMOTE_SOCKET" ]]; then
	echo "REMOTE_SOCKET is required. Set it in .remote-publish.env or pass --remote-socket." >&2
	exit 1
fi

if [[ ! -f "$SSH_KEY" ]]; then
	echo "SSH key not found: $SSH_KEY" >&2
	exit 1
fi

python3 - <<PY
import socket, sys
s = socket.socket()
s.settimeout(2)
try:
    s.connect(("127.0.0.1", int(${LOCAL_PORT})))
except Exception as exc:
    print(f"Local Tower Power is not reachable on 127.0.0.1:${LOCAL_PORT}: {exc}", file=sys.stderr)
    sys.exit(1)
finally:
    s.close()
PY

if [[ -f "$PID_FILE" ]]; then
	old_pid=$(<"$PID_FILE")
	if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
		echo "Stopping existing remote publish tunnel PID $old_pid"
		kill "$old_pid" 2>/dev/null || true
	else
		echo "Removing stale remote publish PID file ($old_pid)"
	fi
	rm -f "$PID_FILE"
fi

remote_socket_dir=$(dirname "$REMOTE_SOCKET")
ssh -i "$SSH_KEY" -o BatchMode=yes "$DEPLOY_HOST" "mkdir -p '$remote_socket_dir' && rm -f '$REMOTE_SOCKET'" >/dev/null

SSH_OPTS=(
	-i "$SSH_KEY"
	-o ExitOnForwardFailure=yes
	-o ServerAliveInterval=30
	-o ServerAliveCountMax=3
	-o BatchMode=yes
	-o TCPKeepAlive=yes
	-o StreamLocalBindUnlink=yes
	-o StreamLocalBindMask=0111
	-N
	-R "${REMOTE_SOCKET}:127.0.0.1:${LOCAL_PORT}"
)

if ((BACKGROUND == 0)); then
	echo "Publishing local 127.0.0.1:${LOCAL_PORT} to ${DEPLOY_HOST} socket ${REMOTE_SOCKET}"
	if [[ -n "$PUBLIC_HOST" ]]; then
		echo "Expected public URL: https://${PUBLIC_HOST}"
	fi
	exec ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST"
fi

mkdir -p "$(dirname "$PID_FILE")"
: >"$LOG_FILE"
nohup ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" >>"$LOG_FILE" 2>&1 &
TUNNEL_PID=$!
echo "$TUNNEL_PID" >"$PID_FILE"

sleep 1
if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
	echo "Remote publish tunnel failed to start. Check $LOG_FILE" >&2
	rm -f "$PID_FILE"
	exit 1
fi

ssh -i "$SSH_KEY" -o BatchMode=yes "$DEPLOY_HOST" "chmod 666 '$REMOTE_SOCKET'" >/dev/null 2>&1 || true

echo "Remote publish tunnel running."
echo "Local source: 127.0.0.1:${LOCAL_PORT}"
echo "Remote SSH target: ${DEPLOY_HOST} socket ${REMOTE_SOCKET}"
echo "PID: $TUNNEL_PID"
echo "Log: $LOG_FILE"
if [[ -n "$PUBLIC_HOST" ]]; then
	echo "Public URL: https://${PUBLIC_HOST}"
else
	echo "Set --public-host or PUBLIC_HOST to print the public HTTPS URL."
fi
