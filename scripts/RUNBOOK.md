# pg-cdc Runbook

Per-database logical replication backup & point-in-time recovery for PostgreSQL.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Onboarding a New Database](#onboarding-a-new-database)
3. [Running a Restore](#running-a-restore)
4. [Monitoring Alerts](#monitoring-alerts)
5. [Known Gaps & Limitations](#known-gaps--limitations)
6. [Safety Valve](#safety-valve)
7. [Disk Layout Warning](#disk-layout-warning)

---

## Architecture Overview

```
┌────────────────┐     ┌────────────────┐
│  PostgreSQL    │     │  pg_recvlogical│  (one per DB via systemd)
│  Cluster       │◄────│  → stdout     │
│                │     │       │        │
│  Slot: my_cdc  │     │       ▼        │
│  Pub: my_pub   │     │ capture-      │
│  wal2json      │     │ daemon.mjs    │
└────────────────┘     │       │        │
                       │       ▼        │
                       │ stream_current │
                       │ .jsonl (rotate)│
                       └───────┬────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
   backup_db.sh         restore_db.sh          monitor.sh
   (nightly pg_dump)    (baseline + replay)    (lag, health)
          │                    │                    │
          ▼                    ▼                    ▼
   /var/backups/pg/     New target DB          alert.sh
   base_*.dump                                  → syslog + file
```

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `pg-cdc` CLI | `/usr/local/bin/pg-cdc` | Entry point for all operations |
| Config | `/etc/pg-cdc/protected_dbs.yaml` | Database list + thresholds |
| Env vars | `/etc/pg-cdc/pg-cdc.env` | Connection strings, paths |
| Capture daemon | `/etc/pg-cdc/capture-daemon.mjs` | Reads pg_recvlogical output, manages files |
| Stream files | `/var/pg-cdc/<db>/` | Append-only change logs (JSONL) |
| Baseline dumps | `/var/backups/pg/<db>/` | Nightly pg_dump -Fc files |
| Systemd units | `pg-cdc@.service` (template) | One per protected DB |

### Data Flow

1. `pg_recvlogical` streams logical changes from each replication slot via `wal2json`
2. `capture-daemon.mjs` reads the pipe, writes to `stream_current.jsonl`, rotates hourly
3. `backup_db.sh` runs nightly via `pg-cdc-backup@.timer`, staggered per DB
4. On restore, baseline + filtered stream replay reconstructs the target DB to a point in time

---

## Onboarding a New Database

### Prerequisites

- PostgreSQL cluster with `wal_level = logical`
- `wal2json` installed and loaded via `shared_preload_libraries`
- Sufficient `max_replication_slots` and `max_wal_senders`
- **System install completed once** — creates `/etc/pg-cdc`, deploys units, installs
  passwordless sudo for the app user, installs `wal2json`, and sets
  `wal_level=logical` on the local PostgreSQL cluster (restarts Postgres):

```bash
sudo ./scripts/install.sh
```

Useful flags:

| Flag | Meaning |
|------|---------|
| `--dry-run` | Print actions without changing the system |
| `--skip-postgres` | Skip wal2json / wal_level (remote-only Postgres) |
| `--no-restart` | Write GUCs but do not restart PostgreSQL |
| `--pg-version 18` | Target a specific major version |

Without install, Settings → Add server often fails with either
`sudo: interactive authentication is required` or
`logical decoding requires wal_level >= logical`.

### Steps

1. **Edit config** (or add the server in the UI — Settings will update this file)

```bash
sudo vim /etc/pg-cdc/protected_dbs.yaml
```

Add a new entry under `databases`:

```yaml
databases:
  - name: my_new_db
    retention_days: 30
    baseline_cron: "0 3 * * *"
```

2. **Run preflight**

```bash
pg-cdc preflight
```

Fix any failures shown (see [Monitoring Alerts](#monitoring-alerts) for common fixes).

3. **Run setup**

```bash
pg-cdc setup my_new_db
```

This creates:
- Publication `my_new_db_pub FOR ALL TABLES`
- Replication slot `my_new_db_cdc` (wal2json)
- Directory `/var/pg-cdc/my_new_db/`
- Enables + starts `pg-cdc@my_new_db.service`

4. **Verify capture is running**

```bash
pg-cdc status
# or
systemctl status pg-cdc@my_new_db.service
journalctl -u pg-cdc@my_new_db.service -n 20 --no-pager
```

5. **Enable the backup timer** (if not auto-enabled by setup)

```bash
systemctl enable --now pg-cdc-backup@my_new_db.timer
```

### Removal

```bash
pg-cdc teardown my_new_db
systemctl disable --now pg-cdc-backup@my_new_db.timer 2>/dev/null || true
```

---

## Running a Restore

### Restore to Latest (near-now)

```bash
pg-cdc restore myapp myapp_restored
```

This:
1. Finds the most recent baseline at or before now
2. Restores it to a new database `myapp_restored`
3. Replays all complete transactions from captured streams up to the latest committed change
4. Prints a summary

### Restore to a Specific Point in Time

```bash
pg-cdc restore myapp myapp_restored --to-timestamp "2026-07-05T14:30:00Z"
```

**Transaction-boundary safety**: If the target timestamp falls mid-transaction, the restore stops at the last fully committed transaction *before* that timestamp. The summary reports the exact timestamp actually reached.

### Forcing Restore to Source (DANGEROUS)

```bash
pg-cdc restore myapp myapp --force-production
```

This overwrites the source database. Only use this when you fully understand the consequences.

### Restore Output Example

```
════════════════════════════════════════════════════════════
  Restore Complete
════════════════════════════════════════════════════════════
  Baseline:         /var/backups/pg/myapp/base_20260705_030000.dump (142.3 MB)
  Events replayed:  1523
  Events discarded: 0
  PIT requested:    2026-07-05T14:30:00.000Z
  PIT reached:      2026-07-05T14:29:58.123456Z

  Warnings:
    ⚠ Found 12 sequence(s) in the restored database.
      Sequence values are NOT replicated by logical replication.
      After restore, reconcile sequence values with the source:
      SELECT setval('seq_name', (SELECT max(id) FROM source_table) + 1);
    ⚠ Target database "myapp_restored" uses large objects (47 large objects).
      Large objects are NOT captured by logical replication.
```

### Post-Restore Checklist

1. Reconcile sequence values (see warning output)
2. Verify row counts against source
3. Point application traffic at the restored DB (manual, outside this tool)

---

## Monitoring Alerts

Each alert type, its meaning, and what to do.

### `lag-warn`

**Meaning**: Replication lag exceeds the configured threshold (`monitoring.lag_warn_bytes`, default 50 MB).

**Check**:
```bash
pg-cdc monitor
```

**Common causes**:
- The capture daemon is not running (check with `systemctl status pg-cdc@<db>.service`)
- The source database is under heavy write load
- Network bandwidth issue between the daemon and PostgreSQL

**Action**:
- If daemon is stopped: `systemctl restart pg-cdc@<db>.service`
- If lag persists under normal load: increase the threshold in `protected_dbs.yaml`

### `lag-critical`

**Meaning**: Lag exceeds the safety valve threshold (`safety_valve.max_lag_bytes`, default 1 GB) AND the capture daemon is confirmed dead beyond grace period.

**Action**: The safety valve will drop the slot automatically — see [Safety Valve](#safety-valve).

### `slot-inactive`

**Meaning**: A replication slot has been inactive/disconnected for longer than `monitoring.slot_inactive_seconds` (default 600s / 10 min).

**Check**:
```bash
psql -c "SELECT slot_name, active, pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes FROM pg_replication_slots WHERE slot_type = 'logical';"
```

**Action**:
- Restart the capture daemon: `systemctl restart pg-cdc@<db>.service`
- If the slot is genuinely abandoned, consider dropping it: `pg-cdc teardown <db>`

### `stream-stale`

**Meaning**: The capture stream file (`stream_current.jsonl`) has not been modified in longer than `monitoring.stream_stale_seconds` (default 120s / 2 min), even though the systemd unit may show "active".

**Check**:
```bash
ls -la /var/pg-cdc/<db>/stream_current.jsonl
journalctl -u pg-cdc@<db>.service -n 20 --no-pager
```

**Action**:
- If the daemon process is hung: `systemctl restart pg-cdc@<db>.service`
- If the file doesn't exist: re-run `pg-cdc setup <db>`

### `daemon-dead`

**Meaning**: Lag is growing but the capture daemon is not running. The grace period clock is ticking before the safety valve drops the slot.

**Action**: Immediately restart the daemon:
```bash
systemctl restart pg-cdc@<db>.service
pg-cdc monitor
```

### `safety-valve`

**Meaning**: The safety valve triggered — a replication slot was dropped to prevent unbounded WAL growth.

**THIS IS SERIOUS**. The database is no longer being captured. The source of the daemon failure must be found before re-protecting.

**Action**:
1. Investigate why the daemon failed: `journalctl -u pg-cdc@<db>.service -n 50`
2. Fix the root cause
3. Re-protect: `pg-cdc setup <db>`

If the lag was high enough to trigger the safety valve, you may need to take a fresh baseline:
```bash
pg-cdc backup <db>
```

### `backup-failed`

**Meaning**: The nightly `pg_dump` baseline failed.

**Check**:
```bash
ls -la /var/backups/pg/<db>/
cat /var/backups/pg/<db>/backup_*.log | tail -20
```

**Action**:
- Check disk space: `df -h /var/backups/pg`
- Check PostgreSQL connectivity
- Re-run: `pg-cdc backup <db>`

### `backup-corrupt`

**Meaning**: The baseline dump passed pg_dump but failed `pg_restore --list` integrity verification.

**Action**:
- The corrupt file was automatically deleted
- Re-run: `pg-cdc backup <db>`
- If it fails again, check for disk hardware issues

---

## Known Gaps & Limitations

### 1. DDL Not Captured

Logical replication (wal2json) only captures DML (INSERT/UPDATE/DELETE). DDL statements (ALTER TABLE, CREATE INDEX, etc.) are **not present** in the stream.

**Implications**:
- A restore can only replay to a point where the schema matches the baseline
- Schema changes applied between baseline and target time will be **missing**
- The restore script will attempt to apply DML against the new schema, which may fail

**Workaround**: Keep your baseline frequency high enough that schema changes are captured in a new baseline shortly after they're applied.

### 2. Sequence Values Not Replicated

Postgres sequences advance independently of logical replication. After a restore, sequence values will be at their baseline state, not at the values they would have been at the recovery point.

**Fix**: After every restore, manually reconcile sequences:

```sql
SELECT 'SELECT setval(''' || relname || ''', (SELECT COALESCE(max(id), 1) FROM '
  || (SELECT relname FROM pg_class WHERE pg_class.oid = seq_table_id)
  || '));'
FROM pg_sequence;
```

The restore script prints a reminder to do this.

### 3. Large Objects Not Captured

PostgreSQL large objects (stored via `lo_*` functions or `pg_largeobject` catalog) are **not captured** by logical replication.

**Detection**: The restore script checks `pg_largeobject_metadata` and warns if any large objects exist in the restored database.

**Workaround**: Transfer large objects separately (e.g., using `lo_export` / `lo_import` or a filesystem-level copy of `pg_largeobject`).

### 4. Disk on Same Filesystem as PG Data Directory

If `/var/backups/pg` or `/var/pg-cdc` is on the same physical disk/partition as the PostgreSQL data directory:

- A full disk due to captured changes could crash PostgreSQL
- Disk I/O contention between capture writing and PG WAL writing

**Recommendation**: Mount a separate disk/partition for capture and backup storage. The preflight check prints a warning if the devices match, but does not enforce separation.

### 5. Exactly-Once Semantics

The system provides **at-least-once** delivery within each rotation window. On restart, `pg_recvlogical` resumes from the slot's `confirmed_flush_lsn`, which may replay the last few events. The restore script uses transaction IDs to ensure only complete transactions are applied.

---

## Safety Valve

### Why It Exists

PostgreSQL does not automatically drop replication slots, even if the consuming process has been dead for days. A slot that is not consuming WAL will cause the cluster's WAL to grow without bound until the disk fills, crashing the entire PostgreSQL cluster, not just the database associated with the slot.

### How It Works

```
Every 60s (monitor timer):
  ┌───────────────────────────────────────┐
  │ For each slot:                        │
  │   if lag > max_lag_bytes (1 GB):      │
  │     if daemon is NOT running:         │
  │       if grace_period has elapsed:    │
  │         DROP the slot               │
  │         LOG LOUDLY                   │
  └───────────────────────────────────────┘
```

### Configuration

```yaml
safety_valve:
  max_lag_bytes: 1073741824       # 1 GB
  grace_period_seconds: 300       # 5 min
```

- **max_lag_bytes**: If lag exceeds this, the valve considers action. Set higher for low-traffic databases where lag is normal.
- **grace_period_seconds**: How long to wait after confirming the daemon is dead before dropping. This prevents premature slot drops during brief restarts.

### What Happens When It Fires

1. The slot is dropped via `pg_drop_replication_slot()`
2. An alert is raised with type `safety-valve`
3. The event is logged to:
   - `/var/log/pg-cdc/alert.log`
   - systemd journal (via `logger`)
   - The alert hook (`/etc/pg-cdc/alert.sh`)

4. The captured data up to the point of failure is still on disk and usable for partial recovery

### Recovery After Safety Valve

```bash
# 1. Fix whatever caused the daemon to die
journalctl -u pg-cdc@<db>.service -n 50

# 2. Re-setup (creates fresh slot)
pg-cdc setup <db>

# 3. Take a fresh baseline
pg-cdc backup <db>

# 4. Verify
pg-cdc monitor
```

---

## Disk Layout Warning

By default, data is stored at:

| Data | Path | Grows With |
|------|------|------------|
| Capture streams | `/var/pg-cdc/<db>/stream_*.jsonl` | Write rate × retention |
| Baseline dumps | `/var/backups/pg/<db>/base_*.dump` | DB size × retention days |

**If either of these paths is on the same physical disk as the PostgreSQL data directory**, a runaway capture or full disk could crash PostgreSQL.

**Check**:
```bash
stat -c '%d' /var/lib/postgresql/data   # PG data dir device
stat -c '%d' /var/pg-cdc                # capture dir device
stat -c '%d' /var/backups/pg            # backup dir device
```

Different numbers = different devices. Same number = same device.

**Fix**: Configure separate mounts in `/etc/fstab`, then update paths in `protected_dbs.yaml`.
