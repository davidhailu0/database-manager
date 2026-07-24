#!/usr/bin/env bash
# =============================================================================
# backup_db.sh — Create a pg_dump baseline for a single database
# =============================================================================
# Produces a custom-format (-Fc) dump with a timestamped filename, then
# verifies integrity via pg_restore --list.
#
# Usage: backup_db.sh <dbname>
#
# Environment (via pg-cdc.env):
#   PGCDC_CONNECTION_STRING  — connection URI (used to derive per-DB URI)
#   PGCDC_BACKUP_DIR         — base backup directory
#   PGCDC_ALERT_COMMAND      — alert hook script
# =============================================================================
set -euo pipefail

DB="${1:?Usage: $0 <dbname>}"
BACKUP_DIR="${PGCDC_BACKUP_DIR:-/var/backups/pg}/${DB}"
ALERT_CMD="${PGCDC_ALERT_COMMAND:-/etc/pg-cdc/alert.sh}"
TIMESTAMP=$(date -u '+%Y%m%d_%H%M%S')
DUMP_FILE="${BACKUP_DIR}/${DB}-${TIMESTAMP}.dump"
LOG_FILE="${BACKUP_DIR}/${DB}-${TIMESTAMP}.log"

mkdir -p "${BACKUP_DIR}"

echo "[BACKUP] [${DB}] Starting baseline dump → ${DUMP_FILE}"

# ---- 1. pg_dump ----
# Derive connection string for the target DB from the management connection
# by replacing the database name in the URI.
if echo "${PGCDC_CONNECTION_STRING}" | grep -q '/[^/]*$'; then
  BASE_CONN=$(echo "${PGCDC_CONNECTION_STRING}" | sed 's|/[^/]*$|/|')
else
  BASE_CONN="${PGCDC_CONNECTION_STRING}"
fi
DB_CONN="${BASE_CONN}${DB}"

if ! pg_dump "${DB_CONN}" --format=custom --file="${DUMP_FILE}" > "${LOG_FILE}" 2>&1; then
  echo "[BACKUP] [${DB}] ❌ pg_dump FAILED"
  cat "${LOG_FILE}"
  "${ALERT_CMD}" "backup-failed" "${DB}" "pg_dump failed — see ${LOG_FILE}"
  exit 1
fi

echo "[BACKUP] [${DB}] pg_dump completed"

# ---- 2. Verify integrity ---
if ! pg_restore --list "${DUMP_FILE}" > /dev/null 2>> "${LOG_FILE}"; then
  echo "[BACKUP] [${DB}] ❌ Integrity check FAILED — dump file is corrupt"
  "${ALERT_CMD}" "backup-corrupt" "${DB}" "Dump file ${DUMP_FILE} failed pg_restore --list"
  rm -f "${DUMP_FILE}"
  exit 1
fi

DUMP_SIZE=$(stat --format=%s "${DUMP_FILE}" 2>/dev/null || echo 0)
echo "[BACKUP] [${DB}] ✅ Baseline complete: ${DUMP_FILE} ($(( DUMP_SIZE / 1048576 )) MB)"

# ---- 3. Remove old backup data (superseded by this baseline) ----
# The new baseline is a full snapshot — it already contains all data up to now.
# Old baselines and stream files before this baseline are redundant.
# NOTE: On-disk dump retention is managed by the API's enforceRetention()
# function based on the keepLatest config. Do NOT hard-prune here —
# otherwise older backups listed in the UI become un-restorable.

# 3a. (removed — enforceRetention handles dump retention via keepLatest)

# 3b. (removed — enforceRetention handles log retention via keepLatest)

# 3c. Remove rotated stream files older than this baseline.
# Their WAL records are already captured in the new baseline dump.
# Keep stream_current.jsonl (actively written by the CDC daemon).
CAPTURE_DB_DIR="${PGCDC_CAPTURE_DIR:-/var/pg-cdc}/${DB}"
if [ -d "${CAPTURE_DB_DIR}" ]; then
  echo "[BACKUP] [${DB}] Pruning old stream files (before baseline)"
  find "${CAPTURE_DB_DIR}" \
    -name 'stream_*.jsonl' \
    -not -name 'stream_current.jsonl' \
    -not -newer "${DUMP_FILE}" \
    -print -delete 2>/dev/null || true
fi

# ---- 4. Apply age-based retention (safety net for non-backup cleanup paths) ----
RETENTION_DAYS="${PGCDC_RETENTION_DAYS:-30}"
if [ "${RETENTION_DAYS}" -gt 0 ]; then
  find "${BACKUP_DIR}" -name "${DB}-*.dump" -type f -mtime "+${RETENTION_DAYS}" -print -delete 2>/dev/null || true
  find "${BACKUP_DIR}" -name "${DB}-*.log" -type f -mtime "+${RETENTION_DAYS}" -print -delete 2>/dev/null || true
fi

exit 0
