#!/usr/bin/env bash
# =============================================================================
# pg-cdc Install Script
# =============================================================================
# Deploys pg-cdc components to their system locations.
#
# Usage: sudo ./install.sh [--dry-run]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=true
  echo "[DRY RUN]"
fi

echo "=== pg-cdc Install ==="
echo "  Script dir:  ${SCRIPT_DIR}"
echo "  Project dir: ${PROJECT_DIR}"
echo ""

# ---- Config ----
CONFIG_DEST="/etc/pg-cdc"
SYSTEMD_DEST="/etc/systemd/system"
LOCAL_BIN="/usr/local/bin"

mkdir -p "${CONFIG_DEST}" 2>/dev/null || true

# ---- 1. Config files ----
echo "--- Config files → ${CONFIG_DEST} ---"
if [ -f "${PROJECT_DIR}/pg-cdc/protected_dbs.yaml" ]; then
  install -m 0644 "${PROJECT_DIR}/pg-cdc/protected_dbs.yaml" "${CONFIG_DEST}/protected_dbs.yaml"
  echo "  protected_dbs.yaml"
fi
if [ -f "${PROJECT_DIR}/pg-cdc/pg-cdc.env" ]; then
  install -m 0644 "${PROJECT_DIR}/pg-cdc/pg-cdc.env" "${CONFIG_DEST}/pg-cdc.env"
  echo "  pg-cdc.env"
fi

# ---- 2. Scripts ----
echo "--- Scripts → ${CONFIG_DEST} ---"
for script in capture-daemon.mjs rotate_stream.sh backup_db.sh alert.sh cleanup_cdc.sh; do
  if [ -f "${SCRIPT_DIR}/${script}" ]; then
    install -m 0755 "${SCRIPT_DIR}/${script}" "${CONFIG_DEST}/${script}"
    echo "  ${script}"
  fi
done

# ---- 3. Systemd units ----
echo "--- Systemd units → ${SYSTEMD_DEST} ---"
for unit in pg-cdc@.service pg-cdc-rotate@.service pg-cdc-rotate@.timer pg-cdc-backup@.service pg-cdc-backup@.timer pg-cdc-monitor.service pg-cdc-monitor.timer; do
  if [ -f "${SCRIPT_DIR}/${unit}" ]; then
    install -m 0644 "${SCRIPT_DIR}/${unit}" "${SYSTEMD_DEST}/${unit}"
    echo "  ${unit}"
  fi
done

# ---- 4. CLI tool ----
echo "--- CLI tool → ${LOCAL_BIN} ---"
if [ -f "${PROJECT_DIR}/pg-cdc/dist/cli.js" ]; then
  install -m 0755 "${PROJECT_DIR}/pg-cdc/dist/cli.js" "${LOCAL_BIN}/pg-cdc"
  echo "  pg-cdc CLI installed to ${LOCAL_BIN}/pg-cdc"
else
  echo "  WARNING: dist/cli.js not found. Run 'pnpm build' in pg-cdc/ first."
fi

# ---- 5. Data directories ----
echo "--- Data directories ---"
mkdir -p /var/pg-cdc
mkdir -p /var/backups/pg
mkdir -p /var/log/pg-cdc
echo "  /var/pg-cdc"
echo "  /var/backups/pg"
echo "  /var/log/pg-cdc"

# ---- 6. Reload systemd ----
echo "--- Reloading systemd ---"
systemctl daemon-reload
echo "  Done."

echo ""
echo "=== Install complete ==="
echo "Next steps:"
echo "  1. Edit ${CONFIG_DEST}/protected_dbs.yaml with your databases"
echo "  2. Run: pg-cdc preflight"
echo "  3. Run: pg-cdc setup <dbname> for each database"
echo "  4. Enable systemd timers:"
echo "     systemctl enable --now pg-cdc-monitor.timer"
echo ""
