#!/usr/bin/env bash
# =============================================================================
# health_check.sh — Run a CDC health check and record a checkpoint
# =============================================================================
# Calls the API endpoint which verifies DB connectivity, replication slot
# health, and records a timestamped checkpoint in the database.
#
# Usage: health_check.sh
#
# Environment:
#   HEALTH_CHECK_URL  — API base URL (default: http://localhost:3000)
# =============================================================================
set -euo pipefail

API="${HEALTH_CHECK_URL:-http://localhost:3000}"
ENDPOINT="${API}/api/cdc/health-check"

echo "[HEALTH-CHECK] Running CDC health check via ${ENDPOINT}..."

RESPONSE=$(curl -s -X POST "${ENDPOINT}" -H "Content-Type: application/json" 2>&1)

if echo "${RESPONSE}" | grep -q '"success":true'; then
  echo "[HEALTH-CHECK] Checkpoint recorded successfully"
  echo "${RESPONSE}" | python3 -m json.tool 2>/dev/null || echo "${RESPONSE}"
  exit 0
else
  echo "[HEALTH-CHECK] Health check failed"
  echo "${RESPONSE}" | python3 -m json.tool 2>/dev/null || echo "${RESPONSE}"
  exit 1
fi
