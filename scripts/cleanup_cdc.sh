#!/usr/bin/env bash
# =============================================================================
# cleanup_cdc.sh — Retention-based cleanup for CDC stream files & backup logs
# =============================================================================
# Deletes stream (JSONL) and backup log files older than the retention period.
# Designed to be called from cron or systemd timer.
#
# Environment (via /etc/pg-cdc/pg-cdc.env or explicit):
#   PGCDC_CAPTURE_DIR    — base capture directory (default /var/pg-cdc)
#   PGCDC_BACKUP_DIR     — base backup directory  (default /var/backups/pg)
#   PGCDC_RETENTION_DAYS — how many days to keep  (default 30)
# =============================================================================
set -euo pipefail

ENV_FILE="/etc/pg-cdc/pg-cdc.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

CAPTURE_DIR="${PGCDC_CAPTURE_DIR:-/var/pg-cdc}"
BACKUP_DIR="${PGCDC_BACKUP_DIR:-/var/backups/pg}"
RETENTION_DAYS="${PGCDC_RETENTION_DAYS:-30}"

echo "[CLEANUP] Retention: ${RETENTION_DAYS} days"
echo "[CLEANUP] Capture dir: ${CAPTURE_DIR}"
echo "[CLEANUP] Backup dir: ${BACKUP_DIR}"

# ---- 1. CDC stream files (rotated JSONL archives) ----
if [ -d "${CAPTURE_DIR}" ]; then
  for db_dir in "${CAPTURE_DIR}"/*/; do
    [ -d "${db_dir}" ] || continue
    db_name=$(basename "${db_dir}")
    echo "[CLEANUP] [${db_name}] Cleaning stream files in ${db_dir}"

    # Try per-db retention from config, else use global default
    db_retention="$RETENTION_DAYS"
    config_file="/etc/pg-cdc/protected_dbs.yaml"
    if [ -f "$config_file" ]; then
      per_db=$(awk -v db="$db_name" '
        /^- name:/ { current=$0; if ($NF != db) current="" }
        /retention_days:/ && current != "" { print $NF }
      ' "$config_file")
      if [ -n "$per_db" ]; then
        db_retention="$per_db"
      fi
    fi

    echo "[CLEANUP] [${db_name}] Retention: ${db_retention} days"
    find "${db_dir}" -name 'stream_*.jsonl' -type f -mtime "+${db_retention}" -print -delete 2>/dev/null || true
  done
else
  echo "[CLEANUP] Capture dir ${CAPTURE_DIR} not found — skipping stream cleanup"
fi

# ---- 2. CDC backup logs ----
if [ -d "${BACKUP_DIR}" ]; then
  for db_dir in "${BACKUP_DIR}"/*/; do
    [ -d "${db_dir}" ] || continue
    db_name=$(basename "${db_dir}")

    # Use same per-db retention if available
    db_retention="$RETENTION_DAYS"
    config_file="/etc/pg-cdc/protected_dbs.yaml"
    if [ -f "$config_file" ]; then
      per_db=$(awk -v db="$db_name" '
        /^- name:/ { current=$0; if ($NF != db) current="" }
        /retention_days:/ && current != "" { print $NF }
      ' "$config_file")
      if [ -n "$per_db" ]; then
        db_retention="$per_db"
      fi
    fi

    echo "[CLEANUP] [${db_name}] Cleaning backup logs (retention: ${db_retention} days)"
    find "${db_dir}" -name "${db_name}-*.log" -type f -mtime "+${db_retention}" -print -delete 2>/dev/null || true
  done
else
  echo "[CLEANUP] Backup dir ${BACKUP_DIR} not found — skipping backup log cleanup"
fi

# ---- 3. pgBackRest log directory — rotate-oldest logic via logrotate not possible here;
#        instead, delete logs older than 90 days (reasonable for debugging history)
# PGBACKREST_LOG_DIR="/var/log/pgbackrest"
# if [ -d "${PGBACKREST_LOG_DIR}" ]; then
#   echo "[CLEANUP] Cleaning pgBackRest logs older than 90 days"
#   find "${PGBACKREST_LOG_DIR}" -name '*.log' -type f -mtime +90 -print -delete 2>/dev/null || true
# fi

echo "[CLEANUP] Done"
