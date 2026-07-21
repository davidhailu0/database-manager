#!/usr/bin/env bash
# =============================================================================
# database-manager / pg-cdc Install Script
# =============================================================================
# One-shot host setup for the web UI + CDC + pgBackRest helpers:
#
#   • Passwordless sudo rules for the app user
#   • /etc/pg-cdc, /etc/pgbackrest, data dirs, scripts, systemd units
#   • Local PostgreSQL ready for CDC (wal2json package, wal_level=logical)
#
# This script sets up the LOCAL app server only. For remote PostgreSQL servers,
# the app handles remote setup via SSH automatically when you add the server
# in the Settings page (provide the SSH username if the host is remote).
#
# Usage:
#   sudo ./scripts/install.sh
#   sudo ./scripts/install.sh --dry-run
#   sudo ./scripts/install.sh --skip-postgres
#   sudo ./scripts/install.sh --pg-version 18
#   sudo ./scripts/install.sh --no-restart   # write GUCs but do not restart PG
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

DRY_RUN=false
SKIP_POSTGRES=false
NO_RESTART=false
PG_VERSION=""

usage() {
  sed -n '2,20p' "$0"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --skip-postgres) SKIP_POSTGRES=true; shift ;;
    --no-restart) NO_RESTART=true; shift ;;
    --pg-version)
      PG_VERSION="${2:-}"
      if [ -z "${PG_VERSION}" ]; then
        echo "ERROR: --pg-version requires a value (e.g. 18)" >&2
        exit 1
      fi
      shift 2
      ;;
    -h|--help) usage ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

run() {
  if $DRY_RUN; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

if [ "$(id -u)" -ne 0 ] && ! $DRY_RUN; then
  echo "ERROR: run as root (sudo ./scripts/install.sh)" >&2
  exit 1
fi

# Prefer the user who invoked sudo so NOPASSWD matches the account that runs `pnpm dev`
INSTALL_USER="${SUDO_USER:-${USER:-}}"
if [ -z "${INSTALL_USER}" ] || [ "${INSTALL_USER}" = "root" ]; then
  INSTALL_USER="$(stat -c '%U' "${PROJECT_DIR}" 2>/dev/null || echo "")"
fi
if [ -z "${INSTALL_USER}" ] || [ "${INSTALL_USER}" = "root" ]; then
  echo "ERROR: could not determine non-root install user. Set SUDO_USER or run via sudo from your account." >&2
  exit 1
fi

detect_pg_version() {
  if [ -n "${PG_VERSION}" ]; then
    return
  fi
  if command -v pg_lsclusters >/dev/null 2>&1; then
    PG_VERSION="$(pg_lsclusters --no-header 2>/dev/null | awk '$3=="5432" && $4=="online" {print $1; exit}')"
    if [ -z "${PG_VERSION}" ]; then
      PG_VERSION="$(pg_lsclusters --no-header 2>/dev/null | awk '$4=="online" {print $1; exit}')"
    fi
    if [ -z "${PG_VERSION}" ]; then
      PG_VERSION="$(pg_lsclusters --no-header 2>/dev/null | awk '{print $1; exit}')"
    fi
  fi
  if [ -z "${PG_VERSION}" ] && [ -d /etc/postgresql ]; then
    PG_VERSION="$(ls /etc/postgresql 2>/dev/null | sort -V | tail -1 || true)"
  fi
  PG_VERSION="${PG_VERSION:-}"
}

pg_sql() {
  # Peer auth as postgres OS user when running as root
  if [ "$(id -u)" -eq 0 ]; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres "$@"
  else
    psql -v ON_ERROR_STOP=1 -d postgres "$@"
  fi
}

pg_sql_t() {
  if [ "$(id -u)" -eq 0 ]; then
    sudo -u postgres psql -t -A -d postgres "$@"
  else
    psql -t -A -d postgres "$@"
  fi
}

restart_postgres() {
  local ver="$1"
  if systemctl cat "postgresql@${ver}-main.service" >/dev/null 2>&1; then
    systemctl restart "postgresql@${ver}-main"
  elif systemctl cat postgresql.service >/dev/null 2>&1; then
    systemctl restart postgresql
  elif command -v pg_ctlcluster >/dev/null 2>&1; then
    pg_ctlcluster "${ver}" main restart
  else
    echo "  WARNING: could not find a way to restart PostgreSQL" >&2
    return 1
  fi
}

echo "=== database-manager / pg-cdc Install ==="
echo "  Script dir:    ${SCRIPT_DIR}"
echo "  Project dir:   ${PROJECT_DIR}"
echo "  Install user:  ${INSTALL_USER}"
if $DRY_RUN; then echo "  Mode:          dry-run"; fi
if $SKIP_POSTGRES; then echo "  Postgres CDC:  skipped"; fi
echo ""

# ---- Config destinations ----
CONFIG_DEST="/etc/pg-cdc"
PGBACKREST_DEST="/etc/pgbackrest"
SYSTEMD_DEST="/etc/systemd/system"
LOCAL_BIN="/usr/local/bin"
SUDOERS_DEST="/etc/sudoers.d/db-manager"

# =============================================================================
# 0. Passwordless sudo for the app user
# =============================================================================
echo "--- Sudoers → ${SUDOERS_DEST} ---"
if [ -f "${SCRIPT_DIR}/sudoers.d-db-manager" ]; then
  TMP_SUDOERS="$(mktemp)"
  sed "s/@USER@/${INSTALL_USER}/g" "${SCRIPT_DIR}/sudoers.d-db-manager" > "${TMP_SUDOERS}"
  if command -v visudo >/dev/null 2>&1; then
    if ! visudo -cf "${TMP_SUDOERS}" >/dev/null 2>&1; then
      echo "ERROR: generated sudoers file failed validation" >&2
      cat "${TMP_SUDOERS}" >&2
      rm -f "${TMP_SUDOERS}"
      exit 1
    fi
  fi
  if $DRY_RUN; then
    echo "  [dry-run] install sudoers for ${INSTALL_USER}"
    sed 's/^/    /' "${TMP_SUDOERS}"
    rm -f "${TMP_SUDOERS}"
  else
    install -m 0440 "${TMP_SUDOERS}" "${SUDOERS_DEST}"
    rm -f "${TMP_SUDOERS}"
    echo "  installed ${SUDOERS_DEST} (NOPASSWD for ${INSTALL_USER})"
  fi
else
  echo "  WARNING: ${SCRIPT_DIR}/sudoers.d-db-manager not found — skipping sudoers"
fi

# =============================================================================
# 1. Config directories
# =============================================================================
echo "--- Config dirs ---"
run mkdir -p "${CONFIG_DEST}"
run mkdir -p "${PGBACKREST_DEST}"
run mkdir -p /var/pg-cdc
run mkdir -p /var/backups/pg
run mkdir -p /var/log/pg-cdc
run mkdir -p /var/lib/pgbackrest
# The CDC capture daemon (pg-cdc@.service) runs as User=postgres and writes
# stream files to /var/pg-cdc/<db>/.  The backup script and pgBackRest also
# need postgres-writable directories.  Without this chown the daemon fails with
# EACCES when it tries to create or append to stream_current.jsonl.
if id postgres >/dev/null 2>&1; then
  run chown postgres:postgres /var/pg-cdc
  run chown postgres:postgres /var/backups/pg
  run chown postgres:postgres /var/log/pg-cdc
  run chown postgres:postgres /var/lib/pgbackrest
fi
# Allow the app user to write configs (dev convenience + API writeConfigFile)
run chown -R "${INSTALL_USER}:${INSTALL_USER}" "${CONFIG_DEST}" 2>/dev/null || true
run chown "${INSTALL_USER}:${INSTALL_USER}" "${PGBACKREST_DEST}" 2>/dev/null || true
if [ ! -f "${PGBACKREST_DEST}/pgbackrest.conf" ]; then
  if $DRY_RUN; then
    echo "  [dry-run] create empty pgbackrest.conf"
  else
    cat > "${PGBACKREST_DEST}/pgbackrest.conf" <<'EOF'
[global]
repo1-path=/var/lib/pgbackrest
repo1-retention-full=2
start-fast=y
EOF
    chown "${INSTALL_USER}:${INSTALL_USER}" "${PGBACKREST_DEST}/pgbackrest.conf" 2>/dev/null || true
    echo "  created ${PGBACKREST_DEST}/pgbackrest.conf"
  fi
fi
echo "  ${CONFIG_DEST}"
echo "  ${PGBACKREST_DEST}"
echo "  /var/pg-cdc /var/backups/pg /var/log/pg-cdc /var/lib/pgbackrest"

# =============================================================================
# 2. Config files
# =============================================================================
echo "--- Config files → ${CONFIG_DEST} ---"
if [ -f "${PROJECT_DIR}/pg-cdc/protected_dbs.yaml" ]; then
  if [ ! -f "${CONFIG_DEST}/protected_dbs.yaml" ]; then
    run install -m 0644 -o "${INSTALL_USER}" -g "${INSTALL_USER}" \
      "${PROJECT_DIR}/pg-cdc/protected_dbs.yaml" "${CONFIG_DEST}/protected_dbs.yaml"
    echo "  protected_dbs.yaml"
  else
    echo "  protected_dbs.yaml (exists — left unchanged)"
  fi
fi
if [ -f "${PROJECT_DIR}/pg-cdc/pg-cdc.env" ]; then
  run install -m 0644 -o "${INSTALL_USER}" -g "${INSTALL_USER}" \
    "${PROJECT_DIR}/pg-cdc/pg-cdc.env" "${CONFIG_DEST}/pg-cdc.env"
  echo "  pg-cdc.env"
fi

# =============================================================================
# 3. Scripts
# =============================================================================
echo "--- Scripts → ${CONFIG_DEST} ---"
for script in capture-daemon.mjs rotate_stream.sh backup_db.sh alert.sh cleanup_cdc.sh health_check.sh; do
  if [ -f "${SCRIPT_DIR}/${script}" ]; then
    run install -m 0755 "${SCRIPT_DIR}/${script}" "${CONFIG_DEST}/${script}"
    echo "  ${script}"
  fi
done

# =============================================================================
# 4. Systemd units
# =============================================================================
echo "--- Systemd units → ${SYSTEMD_DEST} ---"
for unit in \
  pg-cdc@.service \
  pg-cdc-rotate@.service \
  pg-cdc-rotate@.timer \
  pg-cdc-backup@.service \
  pg-cdc-backup@.timer \
  pg-cdc-monitor.service \
  pg-cdc-monitor.timer \
  pg-cdc-healthcheck.service \
  pg-cdc-healthcheck.timer
do
  if [ -f "${SCRIPT_DIR}/${unit}" ]; then
    run install -m 0644 "${SCRIPT_DIR}/${unit}" "${SYSTEMD_DEST}/${unit}"
    echo "  ${unit}"
  fi
done

# =============================================================================
# 5. CLI tool
# =============================================================================
echo "--- CLI tool → ${LOCAL_BIN} ---"
if [ -f "${PROJECT_DIR}/pg-cdc/dist/cli.js" ]; then
  run install -m 0755 "${PROJECT_DIR}/pg-cdc/dist/cli.js" "${LOCAL_BIN}/pg-cdc"
  echo "  pg-cdc CLI installed to ${LOCAL_BIN}/pg-cdc"
else
  echo "  WARNING: dist/cli.js not found. Run 'pnpm build' in pg-cdc/ first (optional)."
fi

# =============================================================================
# 6. Optional host packages (pgBackRest) when apt is available
# =============================================================================
echo "--- Host packages ---"
if command -v apt-get >/dev/null 2>&1; then
  if command -v pgbackrest >/dev/null 2>&1; then
    echo "  [ok] pgbackrest already installed ($(pgbackrest version 2>/dev/null | head -1 || echo present))"
  else
    if $DRY_RUN; then
      echo "  [dry-run] apt-get install -y pgbackrest"
    else
      echo "  Installing pgbackrest..."
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      if apt-get install -y pgbackrest; then
        echo "  [ok] pgbackrest installed"
      else
        echo "  WARNING: could not install pgbackrest (optional for cluster backups)"
      fi
    fi
  fi
else
  echo "  (apt-get not available — skipping package installs)"
fi

# =============================================================================
# 7. Local PostgreSQL for CDC (wal2json + wal_level=logical)
# =============================================================================
PG_CONFIGURED=false
PG_RESTARTED=false
WAL_LEVEL_RESULT=""
WAL2JSON_OK=""

if $SKIP_POSTGRES; then
  echo "--- PostgreSQL CDC config ---"
  echo "  skipped (--skip-postgres)"
else
  detect_pg_version
  echo "--- PostgreSQL CDC config ---"

  if [ -z "${PG_VERSION}" ]; then
    echo "  No local PostgreSQL cluster detected — skipping CDC host config."
    echo "  (Use --pg-version N if PostgreSQL is installed but not listed by pg_lsclusters.)"
  else
    echo "  Target cluster version: ${PG_VERSION}"
    PKG="postgresql-${PG_VERSION}-wal2json"

    # 7a. wal2json package
    if dpkg -s "${PKG}" >/dev/null 2>&1; then
      echo "  [ok] ${PKG} already installed"
    else
      if ! command -v apt-get >/dev/null 2>&1; then
        echo "  WARNING: ${PKG} not installed and apt-get is unavailable"
      elif $DRY_RUN; then
        echo "  [dry-run] apt-get install -y ${PKG}"
      else
        echo "  Installing ${PKG}..."
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        if apt-get install -y "${PKG}"; then
          echo "  [ok] ${PKG} installed"
        else
          echo "  WARNING: failed to install ${PKG} — CDC slot creation will fail until fixed"
        fi
      fi
    fi

    # 7b. GUCs (require restart for wal_level)
    if $DRY_RUN; then
      echo "  [dry-run] ALTER SYSTEM SET wal_level = 'logical'"
      echo "  [dry-run] ALTER SYSTEM SET max_replication_slots = 20"
      echo "  [dry-run] ALTER SYSTEM SET max_wal_senders = 20"
      if ! $NO_RESTART; then
        echo "  [dry-run] restart PostgreSQL ${PG_VERSION}"
      fi
    else
      if ! command -v psql >/dev/null 2>&1; then
        echo "  WARNING: psql not found — cannot apply wal_level / probe settings"
      elif ! id postgres >/dev/null 2>&1; then
        echo "  WARNING: OS user 'postgres' not found — cannot apply settings via peer auth"
      else
        NEED_RESTART=false

        CURRENT_WAL="$(pg_sql_t -c "SHOW wal_level;" 2>/dev/null || echo "")"
        if [ "${CURRENT_WAL}" = "logical" ]; then
          echo "  [ok] wal_level already = logical"
        else
          echo "  Setting wal_level=logical (was: ${CURRENT_WAL:-unknown})..."
          pg_sql -c "ALTER SYSTEM SET wal_level = 'logical';"
          NEED_RESTART=true
        fi

        CURRENT_SLOTS="$(pg_sql_t -c "SHOW max_replication_slots;" 2>/dev/null || echo "0")"
        if [ "${CURRENT_SLOTS:-0}" -ge 20 ] 2>/dev/null; then
          echo "  [ok] max_replication_slots = ${CURRENT_SLOTS}"
        else
          echo "  Setting max_replication_slots=20 (was: ${CURRENT_SLOTS:-unknown})..."
          pg_sql -c "ALTER SYSTEM SET max_replication_slots = 20;"
          NEED_RESTART=true
        fi

        CURRENT_SENDERS="$(pg_sql_t -c "SHOW max_wal_senders;" 2>/dev/null || echo "0")"
        if [ "${CURRENT_SENDERS:-0}" -ge 20 ] 2>/dev/null; then
          echo "  [ok] max_wal_senders = ${CURRENT_SENDERS}"
        else
          echo "  Setting max_wal_senders=20 (was: ${CURRENT_SENDERS:-unknown})..."
          pg_sql -c "ALTER SYSTEM SET max_wal_senders = 20;"
          NEED_RESTART=true
        fi

        # 7c. Restart if needed
        if $NEED_RESTART; then
          if $NO_RESTART; then
            echo "  NOTE: settings pending restart (--no-restart). Run:"
            echo "        sudo systemctl restart postgresql@${PG_VERSION}-main"
          else
            echo "  Restarting PostgreSQL ${PG_VERSION} so wal_level takes effect..."
            if restart_postgres "${PG_VERSION}"; then
              PG_RESTARTED=true
              echo "  [ok] PostgreSQL restarted"
              # Wait briefly for accept
              for _ in 1 2 3 4 5 6 7 8 9 10; do
                if pg_sql_t -c "SELECT 1;" >/dev/null 2>&1; then
                  break
                fi
                sleep 0.5
              done
            else
              echo "  WARNING: restart failed — wal_level may still be pending"
            fi
          fi
        fi

        # 7d. Verify
        WAL_LEVEL_RESULT="$(pg_sql_t -c "SHOW wal_level;" 2>/dev/null || echo "unknown")"
        if [ "${WAL_LEVEL_RESULT}" = "logical" ]; then
          echo "  [ok] wal_level = logical"
          PG_CONFIGURED=true
        else
          echo "  WARNING: wal_level is '${WAL_LEVEL_RESULT}' (need logical + restart)"
        fi

        # Probe wal2json (create + drop a throwaway slot)
        if [ "${WAL_LEVEL_RESULT}" = "logical" ]; then
          # Drop leftover probe slot if any
          pg_sql -c "SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = 'pgcdc_install_probe';" >/dev/null 2>&1 || true
          if pg_sql -c "SELECT pg_create_logical_replication_slot('pgcdc_install_probe', 'wal2json');" >/dev/null 2>&1; then
            pg_sql -c "SELECT pg_drop_replication_slot('pgcdc_install_probe');" >/dev/null 2>&1 || true
            echo "  [ok] wal2json plugin works (probe slot created/dropped)"
            WAL2JSON_OK=true
          else
            echo "  WARNING: could not create a wal2json logical slot — is ${PKG} installed?"
            WAL2JSON_OK=false
          fi
        fi
      fi
    fi
  fi
fi

# =============================================================================
# 8. Reload systemd
# =============================================================================
echo "--- Reloading systemd ---"
if $DRY_RUN; then
  echo "  [dry-run] systemctl daemon-reload"
else
  systemctl daemon-reload
  echo "  Done."
fi

# =============================================================================
# 9. Verify passwordless sudo
# =============================================================================
echo "--- Verifying passwordless sudo for ${INSTALL_USER} ---"
if $DRY_RUN; then
  echo "  [dry-run] skip sudo -n check"
else
  if sudo -u "${INSTALL_USER}" sudo -n /usr/bin/mkdir -p /etc/pg-cdc 2>/dev/null; then
    echo "  OK: ${INSTALL_USER} can run allowed sudo commands without a password"
  else
    echo "  WARNING: could not verify passwordless sudo for ${INSTALL_USER}."
    echo "           Check ${SUDOERS_DEST}."
  fi
fi

echo ""
echo "=== Install complete ==="
if [ -n "${PG_VERSION}" ] && ! $SKIP_POSTGRES; then
  echo "PostgreSQL ${PG_VERSION}:"
  echo "  wal_level   = ${WAL_LEVEL_RESULT:-n/a}"
  if [ "${WAL2JSON_OK}" = "true" ]; then
    echo "  wal2json    = OK"
  elif [ "${WAL2JSON_OK}" = "false" ]; then
    echo "  wal2json    = FAILED (install ${PKG:-postgresql-*-wal2json})"
  else
    echo "  wal2json    = n/a"
  fi
  if $PG_RESTARTED; then
    echo "  restarted   = yes"
  fi
fi
echo ""
echo "Next steps:"
echo "  1. Restart the app (pnpm dev) so it picks up sudo rules"
echo "  2. In Settings, add your PostgreSQL server"
echo "     e.g. postgresql://postgres:YOURPASS@127.0.0.1:5432"
echo "  3. CDC protection should auto-configure for discovered databases"
echo ""
echo "  For a remote PostgreSQL server, just add it in Settings with the"
echo "  connection URL and SSH username — the app will SSH into the remote"
echo "  host to install packages and configure PostgreSQL automatically."
if ! $PG_CONFIGURED && ! $SKIP_POSTGRES; then
  echo ""
  echo "If CDC setup still fails on wal_level / wal2json:"
  echo "  sudo ./scripts/install.sh --pg-version ${PG_VERSION:-18}"
  echo "  # or only re-run postgres bits after fixing packages"
fi
echo ""
