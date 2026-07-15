#!/usr/bin/env bash
# =============================================================================
# rotate_stream.sh — Rotate the pg-cdc capture stream file for a database
# =============================================================================
# Called by systemd timer pg-cdc-rotate@<db>.timer
# Sends SIGHUP to the capture daemon to trigger a rotation.
#
# Usage: rotate_stream.sh <dbname>
# =============================================================================
set -euo pipefail

DB="${1:?Usage: $0 <dbname>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CAPTURE_DIR="${PGCDC_CAPTURE_DIR:-/var/pg-cdc}"
UNIT="pg-cdc@${DB}.service"

# Check if the unit is running
if ! systemctl is-active --quiet "${UNIT}" 2>/dev/null; then
  echo "[ROTATE] [${DB}] Unit ${UNIT} is not active — skipping rotation"
  exit 0
fi

# Get the main PID of the unit and send SIGHUP
MAIN_PID=$(systemctl show --property MainPID --value "${UNIT}" 2>/dev/null || echo "0")
if [ "${MAIN_PID}" = "0" ] || [ "${MAIN_PID}" = "" ]; then
  echo "[ROTATE] [${DB}] Could not determine PID — skipping"
  exit 1
fi

if kill -HUP "${MAIN_PID}" 2>/dev/null; then
  echo "[ROTATE] [${DB}] SIGHUP sent to PID ${MAIN_PID}"
else
  echo "[ROTATE] [${DB}] Failed to send SIGHUP to PID ${MAIN_PID}"
  exit 1
fi
