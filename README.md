# Database Manager

A web-based management tool for PostgreSQL databases with CDC (Change Data Capture)
protection, pgBackRest backup/restore, and health monitoring. Supports both **local**
and **remote** PostgreSQL servers.

## Features

- **Multi-server management** — add/remove PostgreSQL servers from the Settings page
- **CDC protection** — logical replication slots (`wal2json`) with auto-healing daemons
- **pgBackRest integration** — full and incremental backups, point-in-time restore
- **Health monitoring** — automated health checks with slot/daemon auto-recovery
- **Cron scheduling** — UI-created backup jobs via `node-cron`
- **AD authentication** — Active Directory login with role-based access control

## Architecture

```
database-manager/
├── app/
│   ├── api/[[...route]]/route.ts   # Hono API — all endpoints (servers, CDC, backups, auth)
│   ├── settings/page.tsx           # Settings — add/remove servers, pgBackRest config
│   ├── backup/page.tsx             # Backup UI
│   ├── restore/page.tsx            # Restore UI
│   ├── cron/page.tsx               # Cron job management
│   └── users/page.tsx              # User management
├── components/
│   ├── db-overview.tsx             # Dashboard — CDC status, daemon/slot health
│   └── ui/                         # shadcn/ui primitives
├── lib/
│   ├── api.ts                      # Client-side API wrappers + types
│   ├── db-context.tsx              # React context (servers, backups, CDC status)
│   └── auth-context.tsx            # Auth context (AD login, sessions)
├── scripts/
│   ├── install.sh                  # One-shot local host setup (sudoers, packages, PG config)
│   ├── capture-daemon.mjs          # pg_recvlogical capture daemon (runs as systemd service)
│   └── ...                         # backup_db.sh, rotate_stream.sh, health_check.sh, etc.
├── pg-cdc/                         # Standalone CDC CLI (setup/monitor/restore)
├── tests/                          # Vitest test suite
└── data.db                         # SQLite (servers, users, backups, cron_jobs, health_checkpoints)
```

## Quick Start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Run the install script (local host setup)

```bash
sudo ./scripts/install.sh
```

This sets up the **local app server**:
- Passwordless sudo rules for the app user (`/etc/sudoers.d/db-manager`)
- Config directories (`/etc/pg-cdc`, `/etc/pgbackrest`)
- Data directories (`/var/pg-cdc`, `/var/backups/pg`, `/var/log/pg-cdc`, `/var/lib/pgbackrest`)
  — all owned by `postgres:postgres` so the CDC daemon and pgBackRest can write
- Scripts and systemd units (`/etc/pg-cdc/`, `/etc/systemd/system/`)
- pgBackRest package (via `apt-get`)
- Local PostgreSQL CDC config (wal2json, `wal_level=logical`, `max_replication_slots`, `max_wal_senders`)

> **Note:** `install.sh` only sets up the local machine. For remote PostgreSQL servers,
> the app handles everything automatically when you add the server in Settings (see below).

### 3. Start the app

```bash
pnpm dev
```

### 4. Add a database server

Go to **Settings** and add a PostgreSQL server:

| Field | Local server | Remote server |
|-------|-------------|---------------|
| Label | `Production PG` | `Production PG` |
| Connection URL | `postgresql://postgres:pass@127.0.0.1:5432` | `postgresql://postgres:pass@10.0.0.5:5432` |
| SSH username | _(hidden — not needed)_ | `admin` (or whichever OS user has sudo access) |

The SSH username field **only appears** when the connection URL points to a non-local
host (`localhost`, `127.0.0.1`, `0.0.0.0`, `::1`, Unix socket).

## What happens when you add a server

### Local server

1. Discover databases and data directory via the connection URL
2. Create a pgBackRest stanza in `/etc/pgbackrest/pgbackrest.conf` with `pg1-path`
3. Run `pgbackrest --stanza=<label> stanza-create`
4. Set `archive_mode = on` via `ALTER SYSTEM` (if not already on)
5. Set `archive_command = 'pgbackrest --stanza=<label> archive-push %p'` via `ALTER SYSTEM`
6. Restart PostgreSQL if any settings changed (via `pg_lsclusters` + `systemctl`)
7. Deploy CDC config (`/etc/pg-cdc/protected_dbs.yaml`), systemd units, and daemon scripts
8. Ensure data directories exist and are owned by `postgres:postgres`
   (`/var/pg-cdc`, `/var/backups/pg`, `/var/log/pg-cdc`, `/var/lib/pgbackrest`)
9. Auto-setup CDC for each discovered database (replication slot + publication)

> Packages (wal2json, pgBackRest) and GUCs (`wal_level`, `max_replication_slots`,
> `max_wal_senders`) are installed by `install.sh` beforehand.

### Remote server

Everything above, **plus** the app SSHes into the remote host to:

1. Detect PostgreSQL version via `SHOW server_version_num`
2. Install `postgresql-<version>-wal2json` via `apt-get install` (over SSH)
3. Install `pgbackrest` via `apt-get install` (over SSH)
4. Create data directories and `chown postgres:postgres`
   (`/var/pg-cdc`, `/var/backups/pg`, `/var/log/pg-cdc`, `/var/lib/pgbackrest`)
5. Set `wal_level = logical` via `ALTER SYSTEM` (over the network)
6. Set `max_replication_slots = 20` via `ALTER SYSTEM`
7. Set `max_wal_senders = 20` via `ALTER SYSTEM`
8. Set `archive_mode = on` and `archive_command` via `ALTER SYSTEM`
9. Restart PostgreSQL via SSH (`ssh <user>@<host> sudo systemctl restart postgresql`)

The pgBackRest stanza for a remote server includes `pg1-host`, `pg1-user`, `pg1-port`
so pgBackRest can SSH into the database host for backup/restore operations.

### SSH requirements for remote servers

- **SSH keys** must be set up for passwordless access:
  ```bash
  ssh-copy-id <ssh-user>@<remote-host>
  ```
- The SSH user must have **passwordless sudo** on the remote host
- SSH uses `-o BatchMode=yes -o StrictHostKeyChecking=accept-new` (non-interactive,
  auto-accepts new host keys without prompting)
- The SSH user can be overridden per-server via the SSH username field in Settings
- Fallback: `PG_SSH_USER` env var, then the current OS user

## What happens when you remove a server

All associated resources are cleaned up (best-effort):

| Step | What | How |
|------|------|-----|
| 1 | **Systemd daemons** | `systemctl stop` + `systemctl disable pg-cdc@<db>.service` for each database |
| 2 | **Replication slots** | `pg_drop_replication_slot('<db>_cdc')` in PostgreSQL |
| 3 | **archive_command** | Cleared via `ALTER SYSTEM SET archive_command = ''` + `pg_reload_conf()` |
| 4 | **CDC YAML config** | Removes database entries from `/etc/pg-cdc/protected_dbs.yaml` |
| 5 | **pgBackRest stanza** | Removes section from `pgbackrest.conf` + runs `stanza-drop` |
| 6 | **Cron jobs** | Deletes from SQLite + unschedules in-process tasks |
| 7 | **Backups** | Deletes from SQLite `backups` table |
| 8 | **Health checkpoints** | Deletes from SQLite `health_checkpoints` table |
| 9 | **CDC stream files** | `rm -rf /var/pg-cdc/<db>/` |
| 10 | **Backup files** | `rm -rf /var/backups/pg/<db>/` |
| 11 | **Server record** | Deletes from SQLite `servers` table |

Failures are collected into `cleanupErrors` and returned in the response — the server
is always removed from SQLite even if some cleanup steps fail.

## Point-in-time restore

The restore page lets you restore a database to any point in time covered by the
CDC capture stream — **not just health checkpoint boundaries**.

### How it works

1. **Find baseline** — the newest `pg_dump` baseline file at or before the target timestamp
2. **Read stream files** — all WAL change records from `/var/pg-cdc/<db>/stream_*.jsonl`
3. **Filter by timestamp** — keep records between the baseline timestamp and the target timestamp
4. **Restore baseline** — `pg_restore` the dump into the target database
5. **Replay WAL** — execute each filtered transaction (INSERT/UPDATE/DELETE) in order

### Overwriting an existing database

Use `--force-production` (or check the "overwrite" box in the UI) to restore directly
over the source database. Without this flag, the restore refuses to overwrite and
requires a different target database name.

### Timestamp selection

| Scenario | What happens |
|----------|-------------|
| Explicit timestamp provided | Restore to that exact point in time |
| No timestamp | Defaults to the last healthy checkpoint |
| No checkpoint either | Restores to "now" (all available WAL) |

### Example: restoring past the last checkpoint

If the last health checkpoint was at 1:15 PM and the database was corrupted at 1:25 PM,
you can restore to **1:24 PM** — the CDC daemon continuously captures all changes via
`pg_recvlogical`, so the WAL stream contains every change up to the moment of corruption.
The health checkpoint is a monitoring record, not a restore boundary.

```bash
# CLI: restore testdb to a specific timestamp, overwriting the existing DB
npx tsx pg-cdc/src/cli.ts restore testdb testdb \
  --config /etc/pg-cdc/protected_dbs.yaml \
  --force-production \
  --to-timestamp "2026-07-17T13:24:00+03:00"
```

### Known limitations

- **Sequences** — logical replication does not capture sequence values. After restore,
  run `SELECT setval('seq_name', (SELECT max(id) FROM table) + 1)` manually.
- **Large objects** — not captured by logical replication. Transfer separately.

## Development

```bash
pnpm dev          # Start dev server
pnpm build        # Production build
pnpm typecheck    # TypeScript type checking
pnpm lint         # ESLint
pnpm test         # Run test suite (vitest)
```

### Tests

Tests are in `tests/` and run with [Vitest](https://vitest.dev/):

- `tests/archive-config.test.ts` — `isLocalHost`, `isRemoteConnection`, `getSshHost`,
  `buildStanzaEntries` (local vs remote stanza config)
- `tests/is-remote-url.test.ts` — client-side `isRemoteUrl` (conditional SSH user field)
- `tests/install-sh.test.ts` — `install.sh` argument parsing and output

## Key configuration

| Path | Purpose | Owner |
|------|---------|-------|
| `/etc/pgbackrest/pgbackrest.conf` | pgBackRest stanzas and global config | app user |
| `/etc/pg-cdc/protected_dbs.yaml` | CDC-protected databases + pg_connection | app user |
| `/etc/pg-cdc/pg-cdc.env` | CDC environment variables | app user |
| `/etc/systemd/system/pg-cdc@.service` | CDC capture daemon systemd unit | root |
| `/var/pg-cdc/<db>/` | CDC stream files (JSONL) | `postgres:postgres` |
| `/var/backups/pg/<db>/` | Backup files (pg_dump baselines) | `postgres:postgres` |
| `/var/log/pg-cdc/` | CDC logs | `postgres:postgres` |
| `/var/lib/pgbackrest/` | pgBackRest repository | `postgres:postgres` |
| `data.db` | SQLite (servers, users, backups, cron_jobs, health_checkpoints) | app user |

## Tech stack

- **Next.js** (App Router) + **React** — frontend
- **Hono** — API framework (single route handler)
- **better-sqlite3** — SQLite persistence
- **postgres.js** — PostgreSQL client
- **node-cron** — in-process cron scheduler
- **shadcn/ui** + **Tailwind CSS** — UI components
- **Vitest** — testing
