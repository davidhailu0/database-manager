#!/usr/bin/env bash
# =============================================================================
# Thin wrapper — PostgreSQL CDC setup is part of install.sh
# =============================================================================
# Prefer:
#   sudo ./scripts/install.sh
#
# This script re-runs only the host install (including Postgres CDC config).
# Pass-through flags: --dry-run --no-restart --pg-version N
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "NOTE: Postgres CDC configuration is included in install.sh."
echo "      Delegating to: sudo ${SCRIPT_DIR}/install.sh $*"
echo ""

if [ "$(id -u)" -ne 0 ]; then
  exec sudo "${SCRIPT_DIR}/install.sh" "$@"
else
  exec "${SCRIPT_DIR}/install.sh" "$@"
fi
