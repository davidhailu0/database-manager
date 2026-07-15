#!/usr/bin/env bash
# =============================================================================
# alert.sh — Alert hook for pg-cdc
# =============================================================================
# This is the pluggable alert interface. By default it logs to syslog and a
# file. To integrate with Slack, email, PagerDuty, etc., replace or extend
# this script.
#
# Usage: alert.sh <alert_type> <dbname> <message>
#
# Alert types:
#   lag-warn         — replication lag exceeds threshold
#   slot-inactive    — slot not advancing
#   stream-stale     — capture file not being written
#   backup-failed    — baseline dump failed
#   backup-corrupt   — baseline dump failed integrity check
#   safety-valve     — slot dropped due to safety valve
#   setup-failed     — DB setup failed
#
# Environment:
#   PGCDC_ALERT_LOG  — log file path (default: /var/log/pg-cdc/alert.log)
# =============================================================================
set -euo pipefail

ALERT_TYPE="${1:?Usage: $0 <type> <db> <msg>}"
DB="${2:?}"
MESSAGE="${3:?}"
TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%S%z')
ALERT_LOG="${PGCDC_ALERT_LOG:-/var/log/pg-cdc/alert.log}"

mkdir -p "$(dirname "${ALERT_LOG}")"

# Log to file
echo "[${TIMESTAMP}] [${ALERT_TYPE}] [${DB}] ${MESSAGE}" >> "${ALERT_LOG}"

# Log to syslog
logger -t "pg-cdc[${DB}]" -p user.warning "${ALERT_TYPE}: ${MESSAGE}"

echo "[ALERT] [${DB}] ${ALERT_TYPE}: ${MESSAGE}"
