#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8080}"
PS_SCRIPT="$ROOT_DIR/scripts/towerpower-enable-phone-access.ps1"

if ! command -v powershell.exe >/dev/null 2>&1; then
	echo "Error: powershell.exe is required for Windows LAN setup." >&2
	exit 1
fi

if ! command -v wslpath >/dev/null 2>&1; then
	echo "Error: wslpath is required to launch the Windows helper script." >&2
	exit 1
fi

PS_SCRIPT_WIN="$(wslpath -w "$PS_SCRIPT")"

if [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
	powershell.exe \
		-NoProfile \
		-ExecutionPolicy Bypass \
		-File "$PS_SCRIPT_WIN" \
		-Port "$PORT" \
		-DistroName "$WSL_DISTRO_NAME"
else
	powershell.exe \
		-NoProfile \
		-ExecutionPolicy Bypass \
		-File "$PS_SCRIPT_WIN" \
		-Port "$PORT"
fi
