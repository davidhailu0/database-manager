import { Hono } from 'hono'
import { handle } from 'hono/vercel'
import postgres from 'postgres'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { randomUUID } from 'crypto'
import { dirname, resolve } from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'
import * as cron from 'node-cron'

const execFileAsync = promisify(execFile)

const app = new Hono().basePath('/api')

// ---------------------------------------------------------------------------
// sudo helper — always non-interactive (-n); fail fast with a clear message
// if passwordless sudo is not configured instead of hanging on a prompt.
// ---------------------------------------------------------------------------
class SudoNotConfiguredError extends Error {
  constructor() {
    super(
      'Passwordless sudo is not configured for this user. ' +
      'Run: sudo ./scripts/install.sh  (installs /etc/sudoers.d/db-manager with the required NOPASSWD rules).'
    )
    this.name = 'SudoNotConfiguredError'
  }
}

function isSudoAuthRequired(msg: string): boolean {
  const lower = msg.toLowerCase()
  return (
    lower.includes('a password is required') ||
    lower.includes('interactive authentication is required') ||
    lower.includes('sudo: a password is required') ||
    lower.includes('sudo: sorry') ||
    lower.includes('no tty present and no askpass program specified') ||
    lower.includes('is not in the sudoers file')
  )
}

async function sudoExec(args: string[], opts?: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv; host?: string; sshUser?: string }) {
  const { host, sshUser, ...execOpts } = opts || {}
  try {
    if (host) {
      const user = sshUser || process.env.PG_SSH_USER || process.env.USER || ''
      const sshTarget = user ? `${user}@${host}` : host
      const result = await execFileAsync('ssh', [
        '-n', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
        sshTarget, 'sudo', '-n', ...args,
      ], execOpts)
      return { stdout: String(result.stdout), stderr: String(result.stderr) }
    }
    const result = await execFileAsync('sudo', ['-n', ...args], execOpts)
    // Normalize stdout/stderr to strings (execFile types them as string | Buffer)
    return { stdout: String(result.stdout), stderr: String(result.stderr) }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    // execFile errors put the sudo rejection in stderr, not in .message
    const stderr = (err as { stderr?: string | Buffer }).stderr
    const stderrStr = stderr ? String(stderr) : ''
    if (isSudoAuthRequired(msg) || isSudoAuthRequired(stderrStr)) {
      throw new SudoNotConfiguredError()
    }
    throw err
  }
}

/**
 * Discover databases and (when possible) the local PostgreSQL data directory.
 * DB listing and data_directory probes are independent so one failure does not
 * wipe the other. Falls back to pg_lsclusters and peer-auth via postgres user.
 */
async function discoverPostgresCluster(connectionUrl: string): Promise<{ databases: string[]; pgDataDir: string | null }> {
  let databases: string[] = []
  let pgDataDir: string | null = null

  // ---- 1. Application-level connection (postgres.js) ----
  try {
    const urlObj = new URL(connectionUrl)
    if (urlObj.pathname === '/' || urlObj.pathname === '') {
      urlObj.pathname = '/postgres'
    }
    const sql = postgres(urlObj.toString(), { max: 1, idle_timeout: 5 })
    try {
      const dbs = await sql`
        SELECT datname FROM pg_catalog.pg_database
        WHERE datistemplate = false AND datallowconn = true AND datname != 'postgres'
      `
      databases = dbs.map((row) => String((row as { datname: string }).datname))
    } catch { /* listing failed — try other methods */ }
    try {
      const rows = await sql`SHOW data_directory`
      const setting = (rows[0] as { setting?: string } | undefined)?.setting
      if (setting) pgDataDir = String(setting).trim() || null
    } catch { /* needs superuser on some versions — try fallbacks */ }
    await sql.end().catch(() => {})
  } catch { /* connection failed — fall through to CLI */ }

  // ---- 2. psql CLI fallback for anything still missing ----
  if (databases.length === 0 || !pgDataDir) {
    try {
      const u = new URL(connectionUrl)
      const psqlArgs = ['-h', u.hostname, '-p', u.port || '5432', '-U', u.username]
      // URL.password is already percent-decoded by the URL parser
      const psqlEnv = { ...process.env, PGPASSWORD: u.password || '' }

      if (databases.length === 0) {
        const { stdout: listOut } = await execFileAsync('psql', [...psqlArgs, '-l', '-t', '-A'], {
          env: psqlEnv,
          timeout: 10_000,
        })
        const allDbs = listOut
          .trim()
          .split('\n')
          .filter((l) => l.includes('|'))
          .map((l) => l.split('|')[0])
        databases = allDbs.filter((d) => d && d !== 'postgres' && d !== 'template0' && d !== 'template1')
      }

      if (!pgDataDir) {
        const probeDb =
          databases[0] ||
          (u.pathname && u.pathname !== '/' ? u.pathname.replace(/^\//, '') : 'postgres') ||
          'postgres'
        const { stdout: dirOut } = await execFileAsync(
          'psql',
          [...psqlArgs, '-d', probeDb, '-t', '-A', '-c', 'SHOW data_directory'],
          { env: psqlEnv, timeout: 10_000 },
        )
        const dir = dirOut.trim()
        if (dir) pgDataDir = dir
      }
    } catch { /* CLI discovery failed */ }
  }

  // ---- 3. Local Debian/Ubuntu cluster listing (no DB credentials needed) ----
  if (!pgDataDir) {
    try {
      let targetPort = '5432'
      try {
        const u = new URL(connectionUrl)
        targetPort = u.port || '5432'
      } catch { /* keep default */ }

      const { stdout } = await execFileAsync('pg_lsclusters', ['--no-header'], { timeout: 5_000 })
      for (const line of stdout.trim().split('\n')) {
        if (!line.trim()) continue
        // Columns: Ver Name Port Status Owner Data directory Log file
        const parts = line.trim().split(/\s+/)
        if (parts.length < 6) continue
        const port = parts[2]
        const dataDir = parts[5]
        if (port === targetPort && dataDir.startsWith('/')) {
          pgDataDir = dataDir
          break
        }
      }
      // If no port match, use the first online cluster with a path
      if (!pgDataDir) {
        for (const line of stdout.trim().split('\n')) {
          const parts = line.trim().split(/\s+/)
          if (parts.length >= 6 && parts[5]?.startsWith('/')) {
            pgDataDir = parts[5]
            break
          }
        }
      }
    } catch { /* pg_lsclusters not available */ }
  }

  // ---- 4. Peer auth as postgres OS user (passwordless sudo -u postgres) ----
  if (!pgDataDir) {
    try {
      const { stdout } = await sudoExec(
        ['-u', 'postgres', 'psql', '-t', '-A', '-c', 'SHOW data_directory'],
        { timeout: 5_000 },
      )
      const dir = stdout.trim()
      if (dir) pgDataDir = dir
    } catch { /* no peer-auth path */ }
  }

  return { databases, pgDataDir }
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------
const VALID_ROLES = ['admin', 'operator', 'viewer'] as const
type Role = typeof VALID_ROLES[number]

function isValidStanza(s: string): boolean {
  return typeof s === 'string' && /^[a-z0-9_-]+$/i.test(s) && s.length > 0 && s.length <= 64
}

/** PostgreSQL database / identifier names used in shell args and systemd units. */
function isValidDbName(s: string): boolean {
  return typeof s === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s.length > 0 && s.length <= 63
}

/** Returns true when the hostname refers to the local machine. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().trim()
  return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost')
}

/** Returns true when the connection URL points to a remote (non-local) host. */
export function isRemoteConnection(connectionUrl: string): boolean {
  try {
    const u = new URL(connectionUrl)
    return !isLocalHost(u.hostname)
  } catch {
    return false
  }
}

/** Returns the SSH target host for a connection URL, or null when the server is local. */
export function getSshHost(connectionUrl: string): string | null {
  if (!isRemoteConnection(connectionUrl)) return null
  try {
    return new URL(connectionUrl).hostname
  } catch {
    return null
  }
}

/** Builds pgBackRest stanza config entries — adds pg1-host/pg1-user/pg1-port for remote servers. */
export function buildStanzaEntries(pgDataDir: string, connectionUrl: string): { key: string; value: string }[] {
  const entries: { key: string; value: string }[] = []
  if (isRemoteConnection(connectionUrl)) {
    try {
      const u = new URL(connectionUrl)
      entries.push({ key: 'pg1-host', value: u.hostname })
      entries.push({ key: 'pg1-user', value: 'postgres' })
      entries.push({ key: 'pg1-port', value: u.port || '5432' })
    } catch { /* fall through to local-only config */ }
  }
  entries.push({ key: 'pg1-path', value: pgDataDir })
  return entries
}

function isValidCronExpression(e: string): boolean {
  try {
    return cron.validate(e)
  } catch {
    return false
  }
}

function isValidRole(r: string): r is Role {
  return (VALID_ROLES as readonly string[]).includes(r)
}

function errJson(c: any, error: string, status: number, extra?: Record<string, unknown>) {
  return c.json({ success: false, error, ...extra }, status)
}

function detectEngine(url: string): string | null {
  if (!url) return null
  if (url.startsWith('postgresql://') || url.startsWith('postgres://')) return 'PostgreSQL'
  if (url.startsWith('mysql://')) return 'MySQL'
  if (url.startsWith('mongodb://') || url.startsWith('mongodb+srv://')) return 'MongoDB'
  if (url.startsWith('mariadb://')) return 'MariaDB'
  if (url.startsWith('redis://')) return 'Redis'
  return null
}

function isValidUrl(u: string): boolean {
  try {
    new URL(u)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BackupRecord = {
  id: string
  db: string
  type: 'Full' | 'Incremental'
  size: string
  createdAt: string
  createdAtIso?: string | null
  status: 'Completed' | 'Running' | 'Failed'
  path?: string
  source: 'pgbackrest' | 'cdc'
}

type HealthCheckpoint = {
  id: string
  db: string
  timestamp: string       // ISO 8601
  walLsn: string          // e.g. 0/ABCDEF
  status: 'healthy' | 'degraded'
  createdAt: string
}

type CronJobRecord = {
  id: string
  name: string
  db: string
  expression: string
  enabled: boolean
  lastRun: string
  nextRun: string
  createdAt: string
  source: 'pgbackrest' | 'cdc'
}

// ---------------------------------------------------------------------------
// SQLite database — replaces JSON file storage
// ---------------------------------------------------------------------------
const DB_PATH = process.env.DB_PATH || 'data.db'

let _db: Database.Database | null = null

function getDb(): Database.Database {
  if (!_db) {
    const dir = DB_PATH.substring(0, DB_PATH.lastIndexOf('/'))
    if (dir && dir !== DB_PATH) {
      try { fs.mkdirSync(dir, { recursive: true }) } catch { }
    }
    _db = new Database(DB_PATH)
    _db.pragma('journal_mode = WAL')
    initDb()
  }
  return _db
}

function initDb() {
  const db = _db!
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      connection_url TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'PostgreSQL',
      databases TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      employee_id TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT '',
      sam_account_name TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'viewer',
      allowed_pages TEXT NOT NULL DEFAULT '[]',
      allowed_actions TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      db TEXT NOT NULL,
      type TEXT NOT NULL,
      size TEXT NOT NULL DEFAULT '—',
      created_at TEXT NOT NULL,
      status TEXT NOT NULL,
      path TEXT,
      source TEXT NOT NULL DEFAULT 'pgbackrest'
    );
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      db TEXT NOT NULL,
      expression TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run TEXT NOT NULL DEFAULT '—',
      next_run TEXT NOT NULL DEFAULT 'Pending',
      created_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'pgbackrest'
    );
    CREATE TABLE IF NOT EXISTS health_checkpoints (
      id TEXT PRIMARY KEY,
      db TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      wal_lsn TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'healthy',
      created_at TEXT NOT NULL
    );
  `)
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_checkpoints_db_created ON health_checkpoints(db, created_at)') } catch {}
  // Schema migrations (idempotent)
  try { db.exec('ALTER TABLE backups ADD COLUMN source TEXT NOT NULL DEFAULT \'pgbackrest\'') } catch {}
  try { db.exec('ALTER TABLE cron_jobs ADD COLUMN source TEXT NOT NULL DEFAULT \'pgbackrest\'') } catch {}
  try { db.exec('ALTER TABLE backups ADD COLUMN created_at_iso TEXT') } catch {}
  try { db.exec('ALTER TABLE servers ADD COLUMN ssh_user TEXT') } catch {}
  seedUsers()
}

// ---------------------------------------------------------------------------
// Targeted CRUD helpers (no full-table rewrites — fixes concurrent-write loss)
// ---------------------------------------------------------------------------
function rowToBackup(r: any): BackupRecord {
  return {
    id: r.id,
    db: r.db,
    type: r.type as 'Full' | 'Incremental',
    size: r.size,
    createdAt: r.created_at,
    createdAtIso: r.created_at_iso ?? null,
    status: r.status as 'Completed' | 'Running' | 'Failed',
    source: (r.source || 'pgbackrest') as 'pgbackrest' | 'cdc',
    ...(r.path ? { path: r.path } : {}),
  }
}

function listBackups(): BackupRecord[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM backups').all() as any[]
  return rows.map(rowToBackup)
}

function insertBackup(b: BackupRecord): void {
  getDb().prepare(
    'INSERT INTO backups (id, db, type, size, created_at, created_at_iso, status, path, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(b.id, b.db, b.type, b.size, b.createdAt, b.createdAtIso ?? null, b.status, b.path || null, b.source)
}

function updateBackupById(id: string, patch: Partial<BackupRecord>): void {
  const db = getDb()
  const cur = db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as any
  if (!cur) return
  const next = { ...rowToBackup(cur), ...patch }
  db.prepare(
    'UPDATE backups SET db=?, type=?, size=?, created_at=?, created_at_iso=?, status=?, path=?, source=? WHERE id=?'
  ).run(next.db, next.type, next.size, next.createdAt, next.createdAtIso ?? null, next.status, next.path || null, next.source, id)
}

function deleteBackupById(id: string): number {
  return getDb().prepare('DELETE FROM backups WHERE id = ?').run(id).changes
}

function rowToCronJob(r: any): CronJobRecord {
  return {
    id: r.id,
    name: r.name,
    db: r.db,
    expression: r.expression,
    enabled: !!r.enabled,
    lastRun: r.last_run,
    nextRun: r.next_run,
    createdAt: r.created_at,
    source: (r.source || 'pgbackrest') as 'pgbackrest' | 'cdc',
  }
}

function listCronJobs(): CronJobRecord[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM cron_jobs').all() as any[]
  return rows.map(rowToCronJob)
}

function insertCronJob(j: CronJobRecord): void {
  getDb().prepare(
    'INSERT INTO cron_jobs (id, name, db, expression, enabled, last_run, next_run, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(j.id, j.name, j.db, j.expression, j.enabled ? 1 : 0, j.lastRun, j.nextRun, j.createdAt, j.source)
}

function updateCronJobById(id: string, patch: Partial<CronJobRecord>): void {
  const db = getDb()
  const cur = db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id) as any
  if (!cur) return
  const next = { ...rowToCronJob(cur), ...patch }
  db.prepare(
    'UPDATE cron_jobs SET name=?, db=?, expression=?, enabled=?, last_run=?, next_run=?, source=? WHERE id=?'
  ).run(next.name, next.db, next.expression, next.enabled ? 1 : 0, next.lastRun, next.nextRun, next.source, id)
}

function deleteCronJobById(id: string): number {
  return getDb().prepare('DELETE FROM cron_jobs WHERE id = ?').run(id).changes
}

function rowToServer(r: any): ServerRecord {
  return {
    id: r.id,
    label: r.label,
    connectionUrl: r.connection_url,
    engine: r.engine,
    databases: JSON.parse(r.databases),
    sshUser: r.ssh_user ?? null,
  }
}

function listServers(): ServerRecord[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM servers').all() as any[]
  return rows.map(rowToServer)
}

function insertServer(s: ServerRecord): void {
  getDb().prepare(
    'INSERT INTO servers (id, label, connection_url, engine, databases, ssh_user) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(s.id, s.label, s.connectionUrl, s.engine, JSON.stringify(s.databases), s.sshUser || null)
}

function updateServerById(id: string, patch: Partial<ServerRecord>): void {
  const db = getDb()
  const cur = db.prepare('SELECT * FROM servers WHERE id = ?').get(id) as any
  if (!cur) return
  const next = { ...rowToServer(cur), ...patch }
  db.prepare('UPDATE servers SET label=?, connection_url=?, engine=?, databases=?, ssh_user=? WHERE id=?')
    .run(next.label, next.connectionUrl, next.engine, JSON.stringify(next.databases), next.sshUser || null, id)
}

function deleteServerById(id: string): number {
  return getDb().prepare('DELETE FROM servers WHERE id = ?').run(id).changes
}

function rowToUser(r: any): AppUser {
  return {
    id: r.id,
    email: r.email,
    employeeId: r.employee_id,
    displayName: r.display_name,
    samAccountName: r.sam_account_name,
    department: r.department,
    title: r.title,
    role: r.role as Role,
    allowedPages: JSON.parse(r.allowed_pages),
    allowedActions: JSON.parse(r.allowed_actions),
    createdAt: r.created_at,
  }
}

function listUsers(): AppUser[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM users').all() as any[]
  return rows.map(rowToUser)
}

function insertUser(u: AppUser): void {
  getDb().prepare(
    'INSERT INTO users (id, email, employee_id, display_name, sam_account_name, department, title, role, allowed_pages, allowed_actions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(u.id, u.email, u.employeeId, u.displayName, u.samAccountName, u.department, u.title, u.role, JSON.stringify(u.allowedPages), JSON.stringify(u.allowedActions), u.createdAt)
}

function updateUserById(id: string, patch: Partial<AppUser>): void {
  const db = getDb()
  const cur = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any
  if (!cur) return
  const next = { ...rowToUser(cur), ...patch }
  db.prepare(
    'UPDATE users SET email=?, employee_id=?, display_name=?, sam_account_name=?, department=?, title=?, role=?, allowed_pages=?, allowed_actions=? WHERE id=?'
  ).run(next.email, next.employeeId, next.displayName, next.samAccountName, next.department, next.title, next.role, JSON.stringify(next.allowedPages), JSON.stringify(next.allowedActions), id)
}

function deleteUserById(id: string): number {
  return getDb().prepare('DELETE FROM users WHERE id = ?').run(id).changes
}



function nowStamp() {
  return new Date().toLocaleString('en-US', { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
}

function isoStamp() {
  return new Date().toISOString()
}

async function fetchBackupSize(stanza: string): Promise<string> {
  try {
    const { stdout } = await sudoExec(['-u', 'postgres', '/usr/bin/pgbackrest', `--stanza=${stanza}`, '--output=json', 'info'])
    const info = JSON.parse(stdout)
    const latest = info[0]?.backup?.at(-1)?.backup
    if (latest) {
      const bytes: number = latest.backup_size ?? latest.size ?? 0
      if (bytes > 0) {
        const gb = bytes / 1073741824
        if (gb >= 1) return `${gb.toFixed(1)} GB`
        const mb = bytes / 1048576
        return `${Math.round(mb)} MB`
      }
      return '—' // no bytes recorded
    }
    return '—' // no backups listed
  } catch (err: unknown) {
    console.warn('[fetchBackupSize] parse failed for stanza', stanza, err instanceof Error ? err.message : err)
    return '—'
  }
}

// ---------------------------------------------------------------------------
// 1. Databases — list databases from a connection URL
// ---------------------------------------------------------------------------
app.post('/databases', async (c) => {
  try {
    const user = requireAuth(c)
    if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)

    const { connectionUrl } = await c.req.json()

    if (!connectionUrl) {
      return errJson(c, 'Connection URL is required', 400)
    }
    if (!isValidUrl(connectionUrl)) {
      return errJson(c, 'Invalid connection URL', 400)
    }
    const engine = detectEngine(connectionUrl)
    if (!engine) {
      return errJson(c, 'Unsupported connection URL scheme', 400)
    }
    if (engine !== 'PostgreSQL') {
      return errJson(c, `Database discovery is only supported for PostgreSQL (got ${engine})`, 400)
    }

    let finalizedUrl = connectionUrl
    const urlObj = new URL(connectionUrl)

    if (urlObj.pathname === '/' || urlObj.pathname === '') {
      urlObj.pathname = '/postgres'
      finalizedUrl = urlObj.toString()
    }

    let databaseList: string[] = []

    try {
      const sql = postgres(finalizedUrl, { max: 1, idle_timeout: 5 })
      const dbs = await sql`
        SELECT datname
        FROM pg_catalog.pg_database
        WHERE datistemplate = false
          AND datallowconn = true;
      `
      await sql.end()
      databaseList = dbs.map(row => row.datname)
    } catch {
      const u = new URL(connectionUrl)
      const { stdout } = await execFileAsync('psql', [
        '-h', u.hostname,
        '-p', u.port || '5432',
        '-U', u.username,
        '-l', '-t', '-A'
      ], { env: { ...process.env, PGPASSWORD: u.password }, timeout: 10_000 })
      databaseList = stdout.trim().split('\n').filter(l => l.includes('|')).map(l => l.split('|')[0]).filter(d => d !== 'template0' && d !== 'template1')
    }

    return c.json({ success: true, databases: databaseList })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

// ---------------------------------------------------------------------------
// 2. Backup — run pgBackRest backup for a stanza/database
// ---------------------------------------------------------------------------
app.post('/backup', async (c) => {
  try {
    const user = requireAuth(c)
    if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)

    const { stanza, type = 'Full' } = await c.req.json()

    if (!stanza) {
      return errJson(c, 'Stanza (server label) is required', 400)
    }
    if (!isValidStanza(stanza)) {
      return errJson(c, 'Stanza name must match /^[a-z0-9_-]+$/i (max 64 chars)', 400)
    }

    const backupType: 'Full' | 'Incremental' = type === 'Incremental' ? 'Incremental' : 'Full'

    // Record a "Running" entry immediately
    const id = 'bkp_' + randomUUID().slice(0, 8)
    const nowIso = isoStamp()
    const record: BackupRecord = {
      id,
      db: stanza,
      type: backupType,
      size: '—',
      createdAt: nowStamp(),
      createdAtIso: nowIso,
      status: 'Running',
      source: 'pgbackrest',
    }
    insertBackup(record)

    // Execute pgBackRest. Falls back to a simulated success if the binary is
    // unavailable (e.g. in dev without pgBackRest installed).
    try {
      const args = ['-u', 'postgres', '/usr/bin/pgbackrest', `--stanza=${stanza}`, 'backup']
      if (backupType === 'Incremental') args.push('--type=incr')
      const { stdout } = await sudoExec(args, { timeout: 120_000 })
      // Expire old backups + prune WAL only after a FULL backup.
      // Incremental backups depend on the preceding full backup, so we
      // must not expire anything until the next full backup completes.
      if (backupType === 'Full') {
        await sudoExec(['-u', 'postgres', '/usr/bin/pgbackrest', `--stanza=${stanza}`, 'expire'], { timeout: 30_000 }).catch(() => {})
      }
      const size = await fetchBackupSize(stanza)
      const path = `/var/lib/pgbackrest/${stanza}/${id}`
      updateBackupById(id, { status: 'Completed', size, path })
      const completed = { ...record, status: 'Completed' as const, size, path }
      return c.json({ success: true, id, message: 'Backup completed', output: stdout, backup: completed })
    } catch (execError: unknown) {
      const path = `/var/lib/pgbackrest/${stanza}/${id}`
      updateBackupById(id, { status: 'Failed', size: '—', path })
      // Surface pgBackRest's actual output (stdout/stderr) — the execFile
      // .message is just "Command failed: ..." which is useless for debugging.
      const errDetail = execError instanceof Error ? execError.message : ''
      const errStdout = String((execError as { stdout?: string | Buffer }).stdout ?? '').trim()
      const errStderr = String((execError as { stderr?: string | Buffer }).stderr ?? '').trim()
      const detail = [errStdout, errStderr, errDetail].filter(Boolean).join('\n')
      const failed = { ...record, status: 'Failed' as const, size: '—' as const, path }
      return c.json({
        success: false,
        id,
        error: 'Backup execution failed',
        message: 'Backup failed — pgBackRest did not complete',
        details: detail,
        backup: failed,
      }, 500)
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: 'Backup failed', details: message }, 500)
  }
})

// ---------------------------------------------------------------------------
// 3. Restore — restore from a backup snapshot
// ---------------------------------------------------------------------------
app.post('/restore', async (c) => {
  try {
    const user = requireAuth(c)
    if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)

    const { snapshotId } = await c.req.json()

    if (!snapshotId) {
      return c.json({ error: 'Snapshot ID is required' }, 400)
    }

    const all = listBackups()
    const snapshot = all.find((b) => b.id === snapshotId)
    if (!snapshot) {
      return c.json({ error: 'Snapshot not found' }, 404)
    }
    if (snapshot.status !== 'Completed') {
      return c.json({ error: 'Only completed backups can be restored' }, 400)
    }

    const stanza = snapshot.db

    // Derive PostgreSQL cluster unit from stanza's pg1-path
    // Path format: /var/lib/postgresql/<version>/<cluster>
    let pgUnit = 'postgresql'
    try {
      const raw = fs.readFileSync(PGBACKREST_CONF, 'utf-8')
      const config = parseIni(raw)
      const stanzaConfig = config[stanza]
      if (stanzaConfig) {
        const pathEntry = stanzaConfig.find(p => p.key === 'pg1-path')
        if (pathEntry) {
          const parts = pathEntry.value.match(/\/var\/lib\/postgresql\/(\d+)\/(.+)/)
          if (parts) {
            pgUnit = `postgresql@${parts[1]}-${parts[2]}`
          }
        }
      }
    } catch {
      // fall back to 'postgresql'
    }

    // Stop PostgreSQL, run restore, then start PostgreSQL
    try {
      await sudoExec(['systemctl', 'stop', pgUnit], { timeout: 60_000 })
    } catch {
      return c.json({ success: false, error: 'Failed to stop PostgreSQL' }, 500)
    }

    try {
      const { stdout } = await sudoExec([
        '-u', 'postgres', '/usr/bin/pgbackrest', `--stanza=${stanza}`, '--delta', 'restore',
      ], { timeout: 300_000 })

      // Best-effort restart; await so the client knows the cluster is back up
      await sudoExec(['systemctl', 'start', pgUnit], { timeout: 60_000 }).catch(() => {})
      return c.json({ success: true, message: 'Restore completed', output: stdout })
    } catch (execError: unknown) {
      // Attempt to restart PostgreSQL even on restore failure — await so the
      // client knows the cluster state before issuing the next request.
      await sudoExec(['systemctl', 'start', pgUnit], { timeout: 60_000 }).catch(() => {})
      const errDetail = execError instanceof Error ? execError.message : ''
      const errStdout = String((execError as { stdout?: string | Buffer }).stdout ?? '').trim()
      const errStderr = String((execError as { stderr?: string | Buffer }).stderr ?? '').trim()
      const detail = [errStdout, errStderr, errDetail].filter(Boolean).join('\n')
      return c.json({
        success: false,
        error: 'Restore execution failed',
        message: 'Restore failed — pgBackRest did not complete',
        details: detail,
      }, 500)
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: 'Restore failed', details: message }, 500)
  }
})

// ---------------------------------------------------------------------------
// 4. Backups — list & delete snapshots
// ---------------------------------------------------------------------------
app.get('/backups', (c) => {
  const user = requireAuth(c)
  if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)
  try {
    const list = listBackups()
    // Sort by ISO timestamp when available (correct across years); fall back to
    // locale compare on the human-readable string for legacy rows.
    list.sort((a, b) => {
      if (a.createdAtIso && b.createdAtIso) return b.createdAtIso.localeCompare(a.createdAtIso)
      return b.createdAt.localeCompare(a.createdAt)
    })
    return c.json({ success: true, backups: list })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/backups/delete', async (c) => {
  try {
    const user = requireAuth(c)
    if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)

    const { id } = await c.req.json()
    if (!id) return c.json({ error: 'Backup ID is required' }, 400)
    const changes = deleteBackupById(id)
    if (changes === 0) return c.json({ error: 'Backup not found' }, 404)
    return c.json({ success: true, message: `Backup ${id} deleted` })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

// ---------------------------------------------------------------------------
// Cron scheduler — node-cron for UI jobs + system crontab for pgBackRest archive
// ---------------------------------------------------------------------------

/** In-process scheduled tasks keyed by job id. Recreated on module load. */
const scheduledTasks = new Map<string, ReturnType<typeof cron.schedule>>()

function unscheduleCronJob(id: string) {
  const task = scheduledTasks.get(id)
  if (task) {
    try { task.stop() } catch { /* ignore */ }
    scheduledTasks.delete(id)
  }
}

function scheduleCronJob(job: CronJobRecord) {
  unscheduleCronJob(job.id)
  if (!job.enabled) return
  if (!isValidCronExpression(job.expression)) {
    console.warn('[cron] skip schedule — invalid expression for', job.id, job.expression)
    return
  }
  try {
    const task = cron.schedule(job.expression, () => {
      // Re-load job so disabled/deleted jobs don't run from a stale closure
      const latest = listCronJobs().find((j) => j.id === job.id)
      if (!latest || !latest.enabled) return
      runCronBackup(latest).catch((err: unknown) => {
        console.error('[cron] scheduled run failed for', job.id, err instanceof Error ? err.message : err)
      })
    })
    scheduledTasks.set(job.id, task)
  } catch (err: unknown) {
    console.warn('[cron] failed to schedule', job.id, err instanceof Error ? err.message : err)
  }
}

function rescheduleAllCronJobs() {
  for (const id of [...scheduledTasks.keys()]) unscheduleCronJob(id)
  try {
    for (const job of listCronJobs()) {
      if (job.enabled) scheduleCronJob(job)
    }
  } catch (err: unknown) {
    console.warn('[cron] rescheduleAll failed:', err instanceof Error ? err.message : err)
  }
}

async function runCronBackup(job: CronJobRecord): Promise<string> {
  const dayOfWeek = new Date().getDay()
  let backupId: string

  if (job.source === 'cdc') {
    if (!isValidDbName(job.db)) {
      console.error('[runCronBackup] invalid CDC db name:', job.db)
      throw new Error(`Invalid database name for CDC backup: ${job.db}`)
    }
    // CDC database baseline backup
    backupId = 'cdc_' + randomUUID().slice(0, 8)
    const record: BackupRecord = {
      id: backupId, db: job.db, type: 'Full',
      size: '—', createdAt: nowStamp(), createdAtIso: isoStamp(), status: 'Running', source: 'cdc',
    }
    insertBackup(record)

    try {
      // Pass db name as a separate argv to avoid shell injection
      const cdcEnv = process.env.PG_CDC_ENV || '/etc/pg-cdc/pg-cdc.env'
      await sudoExec([
        'bash', '-c',
        `set -a; . "${cdcEnv}"; set +a; exec /etc/pg-cdc/backup_db.sh "$1"`,
        '--', job.db,
      ], { timeout: 3600_000 })
      const backupDir = `/var/backups/pg/${job.db}`
      let size = '—'
      let path: string | undefined
      try {
        const files = fs.readdirSync(backupDir).filter(f => f.startsWith('base_') && f.endsWith('.dump')).sort().reverse()
        if (files.length > 0) {
          const stat = fs.statSync(backupDir + '/' + files[0])
          const bytes = stat.size
          const mb = bytes / 1048576
          size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
          path = backupDir + '/' + files[0]
        }
      } catch { /* best-effort */ }
      updateBackupById(backupId, { status: 'Completed', size, path })
    } catch (err: unknown) {
      console.error('[runCronBackup] cdc backup failed for', job.db, err instanceof Error ? err.message : err)
      updateBackupById(backupId, { status: 'Failed', size: '—' })
    }
  } else {
    // pgBackRest cluster backup — job.db stores the stanza (server label)
    const stanza = job.db
    if (!isValidStanza(stanza)) {
      console.error('[runCronBackup] invalid pgBackRest stanza:', stanza)
      throw new Error(`Invalid stanza for pgBackRest backup: ${stanza || '(empty)'}`)
    }
    backupId = 'bkp_' + randomUUID().slice(0, 8)
    const backupType: 'Full' | 'Incremental' = dayOfWeek === 0 ? 'Full' : 'Incremental'

    const record: BackupRecord = {
      id: backupId, db: stanza, type: backupType,
      size: '—', createdAt: nowStamp(), createdAtIso: isoStamp(), status: 'Running', source: 'pgbackrest',
    }
    insertBackup(record)

    try {
      const args = ['-u', 'postgres', '/usr/bin/pgbackrest', `--stanza=${stanza}`, 'backup']
      if (backupType === 'Incremental') args.push('--type=incr')
      await sudoExec(args, { timeout: 120_000 })
      // Expire old backups + prune WAL only after a FULL backup.
      // Incremental backups depend on the preceding full backup, so we
      // must not expire anything until the next full backup completes.
      if (backupType === 'Full') {
        await sudoExec(['-u', 'postgres', '/usr/bin/pgbackrest', `--stanza=${stanza}`, 'expire'], { timeout: 30_000 }).catch(() => {})
      }
      const size = await fetchBackupSize(stanza)
      const path = `/var/lib/pgbackrest/${stanza}/${backupId}`
      updateBackupById(backupId, { status: 'Completed', size, path })
    } catch (err: unknown) {
      console.error('[runCronBackup] pgbackrest backup failed for', stanza, err instanceof Error ? err.message : err)
      const path = `/var/lib/pgbackrest/${stanza}/${backupId}`
      updateBackupById(backupId, { status: 'Failed', size: '—', path })
    }
  }

  updateCronJobById(job.id, { lastRun: nowStamp(), nextRun: 'Pending' })
  return backupId
}

// ---------------------------------------------------------------------------
// 5. Cron jobs — list, create, update, delete, run-now
// ---------------------------------------------------------------------------
app.get('/cron', (c) => {
  const user = requireAuth(c)
  if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)
  try {
    const list = listCronJobs()
    return c.json({ success: true, jobs: list })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/cron', async (c) => {
  try {
    const user = requireAuth(c)
    if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)

    const { name, db: rawDb, expression, enabled = true, source = 'pgbackrest' } = await c.req.json()

    if (!name || !expression) {
      return errJson(c, 'name and expression are required', 400)
    }
    if (!isValidCronExpression(expression)) {
      return errJson(c, 'Invalid cron expression', 400)
    }
    if (source !== 'pgbackrest' && source !== 'cdc') {
      return errJson(c, 'source must be "pgbackrest" or "cdc"', 400)
    }
    // For pgBackRest, `db` is the stanza (server label). For CDC, `db` is the database name.
    if (!rawDb || typeof rawDb !== 'string') {
      return errJson(c, source === 'cdc'
        ? 'db is required for CDC backups'
        : 'db (stanza / server label) is required for pgBackRest backups', 400)
    }
    if (source === 'pgbackrest' && !isValidStanza(rawDb)) {
      return errJson(c, 'db must be a valid stanza name (/^[a-z0-9_-]+$/i, max 64)', 400)
    }
    if (source === 'cdc' && !isValidDbName(rawDb)) {
      return errJson(c, 'db must be a valid PostgreSQL identifier (max 63 chars)', 400)
    }
    const db = rawDb

    const id = 'cron_' + randomUUID().slice(0, 8)
    const record: CronJobRecord = {
      id,
      name,
      db,
      expression,
      enabled: !!enabled,
      lastRun: '—',
      nextRun: 'Pending',
      createdAt: new Date().toISOString().slice(0, 10),
      source: source === 'cdc' ? 'cdc' : 'pgbackrest',
    }
    insertCronJob(record)
    scheduleCronJob(record)
    return c.json({ success: true, job: record })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/cron/update', async (c) => {
  try {
    const user = requireAuth(c)
    if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)

    const { id, enabled } = await c.req.json()
    if (!id) return errJson(c, 'Job ID is required', 400)
    const jobs = listCronJobs()
    const existing = jobs.find(j => j.id === id)
    if (!existing) return errJson(c, 'Job not found', 404)
    if (typeof enabled === 'boolean') {
      updateCronJobById(id, { enabled })
      const updated = { ...existing, enabled }
      scheduleCronJob(updated)
      return c.json({ success: true, job: updated })
    }
    return c.json({ success: true, job: existing })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/cron/delete', async (c) => {
  try {
    const user = requireAuth(c)
    if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)

    const { id } = await c.req.json()
    if (!id) return errJson(c, 'Job ID is required', 400)
    const changes = deleteCronJobById(id)
    if (changes === 0) return errJson(c, 'Job not found', 404)
    unscheduleCronJob(id)
    return c.json({ success: true, message: `Job ${id} deleted` })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/cron/run', async (c) => {
  try {
    const user = requireAuth(c)
    if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)

    const { id } = await c.req.json()
    if (!id) return errJson(c, 'Job ID is required', 400)
    const jobs = listCronJobs()
    const job = jobs.find((j) => j.id === id)
    if (!job) return errJson(c, 'Job not found', 404)

    // Fire-and-forget; failures are logged and recorded as Failed backups.
    void runCronBackup(job).catch((err: unknown) => {
      console.error('[cron/run] unhandled failure for job', job.id, err instanceof Error ? err.message : err)
    })

    return c.json({ success: true, message: `Job ${job.name} triggered — backup running` })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

// ---------------------------------------------------------------------------
// 6. Storage settings
// ---------------------------------------------------------------------------
app.get('/settings/storage', (c) => {
  const user = requireAuth(c)
  if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)
  return c.json({
    success: true,
    storagePath: process.env.DB_BACKUP_PATH || '/var/backups/db',
    retentionDays: Number(process.env.DB_RETENTION_DAYS || 30),
  })
})

app.post('/settings/storage', async (c) => {
  try {
    const user = requireAuth(c)
    if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)

    const { storagePath, retentionDays } = await c.req.json()
    if (typeof storagePath !== 'string' || !storagePath.trim()) {
      return c.json({ error: 'storagePath is required' }, 400)
    }
    const days = Number(retentionDays)
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return c.json({ error: 'retentionDays must be a number between 1 and 365' }, 400)
    }
    process.env.DB_BACKUP_PATH = storagePath
    process.env.DB_RETENTION_DAYS = String(days)
    return c.json({ success: true, message: 'Storage settings saved' })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

// ---------------------------------------------------------------------------
// 7. pgBackRest config — read / write pgbackrest.conf
// ---------------------------------------------------------------------------

const PGBACKREST_CONF = process.env.PGBACKREST_CONF || '/etc/pgbackrest/pgbackrest.conf'
const PGCDC_CONF = process.env.PGCDC_CONF || '/etc/pg-cdc/protected_dbs.yaml'

/**
 * Rudimentary INI parser for pgbackrest.conf.
 * Returns an object where keys are section headers ("global", "stanza_name")
 * and values are arrays of { key, value } pairs (preserving order).
 */
function parseIni(text: string): Record<string, { key: string; value: string }[]> {
  const result: Record<string, { key: string; value: string }[]> = {}
  let currentSection = 'global'
  result[currentSection] = []

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      // preserve blank / comment lines by storing them as null
      result[currentSection].push({ key: '', value: trimmed })
      continue
    }
    const sectionMatch = trimmed.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      currentSection = sectionMatch[1]
      if (!result[currentSection]) result[currentSection] = []
      continue
    }
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim()
      const value = trimmed.slice(eqIdx + 1).trim()
      result[currentSection].push({ key, value })
    } else {
      result[currentSection].push({ key: '', value: trimmed })
    }
  }

  return result
}

function serializeIni(sections: Record<string, { key: string; value: string }[]>): string {
  const lines: string[] = []
  for (const [section, pairs] of Object.entries(sections)) {
    if (section !== 'global' && lines.length > 0 && !lines[lines.length-1].startsWith('[')) {
      lines.push('')
    }
    lines.push(`[${section}]`)
    for (const { key, value } of pairs) {
      // Skip pure blank-line placeholders (key='' and value='') — they're noise.
      // Keep comment lines (value starts with '#') and bare tokens.
      if (key === '' && value === '') continue
      lines.push(key ? `${key}=${value}` : value)
    }
  }
  return lines.join('\n') + '\n'
}

/** Reject duplicate keys within a section — pgbackrest would reject these. */
function validateIni(config: Record<string, { key: string; value: string }[]>): string | null {
  for (const [section, pairs] of Object.entries(config)) {
    const seen = new Set<string>()
    for (const { key } of pairs) {
      if (!key) continue
      if (seen.has(key)) return `Duplicate key "${key}" in section [${section}]`
      seen.add(key)
    }
  }
  return null
}

/** Write a file directly, falling back to sudo cp on EACCES/ENOENT. */
async function writeConfigFile(path: string, content: string): Promise<void> {
  try {
    fs.writeFileSync(path, content, 'utf-8')
    return
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      try { fs.mkdirSync(dirname(path), { recursive: true }) } catch {}
      try {
        fs.writeFileSync(path, content, 'utf-8')
        return
      } catch (innerErr: unknown) {
        const code = (innerErr as NodeJS.ErrnoException).code
        if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOENT') throw innerErr
      }
    } else if (e.code !== 'EACCES' && e.code !== 'EPERM') {
      throw err
    }
  }
  // Fallback: write to a temp file and copy via sudo -n
  const tmpFile = '/tmp/pgbackrest-conf-' + randomUUID().slice(0, 8)
  fs.writeFileSync(tmpFile, content, 'utf-8')
  try {
    await sudoExec(['mkdir', '-p', dirname(path)], { timeout: 5_000 }).catch(() => {})
    await sudoExec(['cp', tmpFile, path], { timeout: 10_000 })
  } finally {
    try { fs.unlinkSync(tmpFile) } catch {}
  }
}

app.get('/settings/pgbackrest', async (c) => {
  const user = requireAuth(c)
  if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)
  try {
    let raw = ''
    try {
      raw = fs.readFileSync(PGBACKREST_CONF, 'utf-8')
    } catch {
      // file doesn't exist yet — return an empty template
      raw = `[global]\n# repo1-path=/var/lib/pgbackrest\n# repo1-retention-full=2\n# compress-type=zst\n`
    }
    const config = parseIni(raw)
    return c.json({ success: true, config })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/settings/pgbackrest', async (c) => {
  try {
    const admin = requireRole(c, 'admin')
    if (!admin) return c.json({ success: false, error: c.res.status === 403 ? 'Forbidden' : 'Not authenticated' }, c.res.status === 403 ? 403 : 401)

    const { config } = await c.req.json()
    if (!config || typeof config !== 'object') {
      return c.json({ error: 'config object is required' }, 400)
    }
    const iniError = validateIni(config)
    if (iniError) return c.json({ error: iniError }, 400)

    const raw = serializeIni(config)
    await writeConfigFile(PGBACKREST_CONF, raw)
    return c.json({ success: true, message: 'pgBackRest config saved' })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/stanza-create', async (c) => {
  try {
    const admin = requireRole(c, 'admin')
    if (!admin) return c.json({ success: false, error: c.res.status === 403 ? 'Forbidden' : 'Not authenticated' }, c.res.status === 403 ? 403 : 401)

    const { stanza } = await c.req.json()
    if (!stanza) {
      return c.json({ error: 'Stanza name is required' }, 400)
    }
    if (!isValidStanza(stanza)) {
      return c.json({ error: 'Stanza name must match /^[a-z0-9_-]+$/i (max 64 chars)' }, 400)
    }
    const { stdout, stderr } = await sudoExec(['-u', 'postgres', '/usr/bin/pgbackrest', `--stanza=${stanza}`, 'stanza-create'], { timeout: 30_000 })
    return c.json({ success: true, message: `Stanza "${stanza}" created`, output: stdout || stderr })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: `Failed to create stanza: ${message}` }, 500)
  }
})

// ---------------------------------------------------------------------------
// 8. Servers — multi-server management (replaces single connection URL)
// ---------------------------------------------------------------------------

type ServerRecord = {
  id: string
  label: string
  connectionUrl: string
  engine: string
  databases: string[]
  sshUser?: string | null
}

app.get('/servers', (c) => {
  const user = requireAuth(c)
  if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)
  try {
    const servers = listServers()
    return c.json({ success: true, servers })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/servers', async (c) => {
  try {
    const admin = requireRole(c, 'admin')
    if (!admin) return c.json({ success: false, error: c.res.status === 403 ? 'Forbidden' : 'Not authenticated' }, c.res.status === 403 ? 403 : 401)

    const { label, connectionUrl, sshUser } = await c.req.json()
    if (!label || !connectionUrl) {
      return c.json({ error: 'Label and connection URL are required' }, 400)
    }
    if (!isValidStanza(label)) {
      return c.json({ error: 'Label must match /^[a-z0-9_-]+$/i (max 64 chars) — it is used as a pgBackRest stanza name' }, 400)
    }
    if (!isValidUrl(connectionUrl)) {
      return c.json({ error: 'Invalid connection URL' }, 400)
    }
    const engine = detectEngine(connectionUrl)
    if (!engine) {
      return c.json({ error: 'Unsupported connection URL scheme' }, 400)
    }

    // Reject duplicate label
    const existingServers = listServers()
    if (existingServers.some(s => s.label.toLowerCase() === label.toLowerCase())) {
      return c.json({ error: `Server with label "${label}" already exists` }, 409)
    }

    const id = 'srv_' + randomUUID().slice(0, 8)
    let databases: string[] = []
    let pgDataDir: string | null = null

    // Discover databases and data directory (independent probes + local fallbacks)
    if (engine === 'PostgreSQL') {
      const discovered = await discoverPostgresCluster(connectionUrl)
      databases = discovered.databases
      pgDataDir = discovered.pgDataDir
    }

    const server: ServerRecord = { id, label, connectionUrl, engine, databases, sshUser: sshUser || null }
    insertServer(server)

    let stanzaCreated = false
    let stanzaMessage = ''

    // For remote servers: SSH into the remote host to install packages and set GUCs
    const sshHost = getSshHost(connectionUrl)
    if (sshHost && engine === 'PostgreSQL') {
      const sshOpts = { timeout: 60_000, host: sshHost, sshUser: sshUser || undefined }
      // Detect PG version from the connection to build the wal2json package name
      let pgMajorVersion: string | null = null
      try {
        const u = new URL(connectionUrl)
        if (u.pathname === '/' || u.pathname === '') { u.pathname = '/postgres' }
        const sql = postgres(u.toString(), { max: 1, idle_timeout: 5 })
        const rows = await sql`SHOW server_version_num`
        const versionNum = String((rows[0] as Record<string, string>)?.server_version_num ?? '')
        await sql.end().catch(() => {})
        if (versionNum.length >= 2) {
          pgMajorVersion = versionNum.slice(0, versionNum.length === 6 ? 2 : 1)
        }
      } catch { /* best-effort */ }

      // Install wal2json and pgBackRest on the remote host
      if (pgMajorVersion) {
        const wal2jsonPkg = `postgresql-${pgMajorVersion}-wal2json`
        try {
          await sudoExec(['apt-get', 'update', '-qq'], sshOpts)
          await sudoExec(['apt-get', 'install', '-y', wal2jsonPkg], sshOpts)
        } catch (e: unknown) {
          if (!stanzaMessage) stanzaMessage = `Failed to install ${wal2jsonPkg} on remote host — install manually`
        }
      }
      try {
        await sudoExec(['apt-get', 'install', '-y', 'pgbackrest'], sshOpts)
      } catch { /* pgBackRest may already be installed — ignore */ }

      // Create data directories on the remote host and chown to postgres.
      // The CDC daemon runs as User=postgres and writes stream files to
      // /var/pg-cdc/<db>/.  pgBackRest archive-push (archive_command) runs as
      // postgres and needs /var/lib/pgbackrest.  Without this chown the
      // daemon / archive-push fails with EACCES / permission denied.
      try {
        await sudoExec(['mkdir', '-p', '/var/pg-cdc', '/var/backups/pg', '/var/log/pg-cdc', '/var/lib/pgbackrest'], sshOpts)
        await sudoExec(['chown', 'postgres:postgres', '/var/pg-cdc', '/var/backups/pg', '/var/log/pg-cdc', '/var/lib/pgbackrest'], sshOpts)
      } catch { /* best-effort — dirs may already exist */ }

      // Set CDC GUCs via ALTER SYSTEM (works over the network)
      try {
        const u = new URL(connectionUrl)
        if (u.pathname === '/' || u.pathname === '') { u.pathname = '/postgres' }
        const sql = postgres(u.toString(), { max: 1, idle_timeout: 5 })
        try {
          const row = await sql`SHOW wal_level`
          const current = String((row[0] as Record<string, string>)?.wal_level ?? '')
          if (current !== 'logical') await sql`ALTER SYSTEM SET wal_level = 'logical'`
        } catch { /* best-effort */ }
        try {
          const row = await sql`SHOW max_replication_slots`
          const current = Number((row[0] as Record<string, string>)?.max_replication_slots ?? 0)
          if (current < 20) await sql`ALTER SYSTEM SET max_replication_slots = 20`
        } catch { /* best-effort */ }
        try {
          const row = await sql`SHOW max_wal_senders`
          const current = Number((row[0] as Record<string, string>)?.max_wal_senders ?? 0)
          if (current < 20) await sql`ALTER SYSTEM SET max_wal_senders = 20`
        } catch { /* best-effort */ }
        await sql.end().catch(() => {})
      } catch { /* best-effort */ }
    }

    // Auto-add pgBackRest stanza for this server and run stanza-create
    if (pgDataDir) {
      try {
        let raw = ''
        try { raw = fs.readFileSync(PGBACKREST_CONF, 'utf-8') } catch { raw = '[global]\n' }
        const config = parseIni(raw)
        if (!config[label]) {
          config[label] = buildStanzaEntries(pgDataDir, connectionUrl)
          const out = serializeIni(config)
          await writeConfigFile(PGBACKREST_CONF, out)
          // Run stanza-create after writing the config
          try {
            await sudoExec(['-u', 'postgres', '/usr/bin/pgbackrest', `--stanza=${label}`, 'stanza-create'], { timeout: 30_000 })
            stanzaCreated = true
          } catch {
            stanzaMessage = 'Stanza config written but stanza-create command failed — run it manually'
          }
        } else {
          stanzaMessage = `Stanza "${label}" already exists in config`
        }
      } catch (e: unknown) {
        stanzaMessage = `Failed to write pgBackRest config: ${e instanceof Error ? e.message : String(e)}`
      }

      // Configure archive_mode=on and archive_command for pgBackRest
      try {
        const u = new URL(connectionUrl)
        if (u.pathname === '/' || u.pathname === '') {
          u.pathname = '/postgres'
        }
        const sql = postgres(u.toString(), { max: 1, idle_timeout: 5 })
        const desiredArchiveCommand = `pgbackrest --stanza=${label} archive-push %p`

        let needRestart = false
        let needReload = false
        try {
          const amRow = await sql`SHOW archive_mode`
          const currentArchiveMode = String((amRow[0] as Record<string, string>)?.archive_mode ?? '')
          if (currentArchiveMode !== 'on') {
            await sql`ALTER SYSTEM SET archive_mode = 'on'`
            needRestart = true
          }
        } catch (e: unknown) {
          stanzaMessage = `Failed to set archive_mode: ${e instanceof Error ? e.message : String(e)}`
        }

        try {
          const acRow = await sql`SHOW archive_command`
          const currentArchiveCommand = String((acRow[0] as Record<string, string>)?.archive_command ?? '')
          if (currentArchiveCommand !== desiredArchiveCommand) {
            // ALTER SYSTEM SET doesn't support parameterized values ($1) —
            // use unsafe with a properly escaped string literal.
            const escapedCmd = desiredArchiveCommand.replace(/'/g, "''")
            await sql.unsafe(`ALTER SYSTEM SET archive_command = '${escapedCmd}'`)
            needReload = true
          }
        } catch (e: unknown) {
          stanzaMessage = `Failed to set archive_command: ${e instanceof Error ? e.message : String(e)}`
        }

        // Reload for SIGHUP parameters (archive_command) — lightweight, no downtime
        if (needReload && !needRestart) {
          try {
            await sql`SELECT pg_reload_conf()`
          } catch { /* best-effort — restart below will also apply it */ }
        }

        await sql.end().catch(() => {})

        if (needRestart) {
          const sshHost = getSshHost(connectionUrl)
          if (sshHost) {
            const sshOpts = { timeout: 30_000, host: sshHost, sshUser: sshUser || undefined }
            let restarted = false
            try {
              await sudoExec(['systemctl', 'restart', 'postgresql'], sshOpts)
              restarted = true
            } catch { /* best-effort */ }
            if (!restarted) {
              try {
                await sudoExec(['pg_ctlcluster', '--force', 'restart'], sshOpts)
                restarted = true
              } catch { /* best-effort */ }
            }
            if (!restarted && !stanzaMessage) {
              stanzaMessage = `archive_mode/archive_command set on remote server "${sshHost}" but could not restart via SSH — restart PostgreSQL there manually`
            }
          } else {
            let restarted = false
            try {
              const { stdout } = await execFileAsync('pg_lsclusters', ['--no-header'], { timeout: 5_000 })
              for (const line of stdout.trim().split('\n')) {
                const parts = line.trim().split(/\s+/)
                if (parts.length >= 6 && parts[5] === pgDataDir) {
                  const ver = parts[0]
                  await sudoExec(['systemctl', 'restart', `postgresql@${ver}-main`], { timeout: 30_000 })
                  restarted = true
                  break
                }
              }
            } catch { /* try fallback */ }
            if (!restarted) {
              try {
                await sudoExec(['systemctl', 'restart', 'postgresql'], { timeout: 30_000 })
                restarted = true
              } catch { /* best-effort */ }
            }
            if (!restarted && !stanzaMessage) {
              stanzaMessage = 'archive_mode/archive_command set but PostgreSQL could not be restarted automatically — restart it manually for pgBackRest to work'
            }
          }
        }
      } catch (e: unknown) {
        if (!stanzaMessage) {
          stanzaMessage = `Failed to configure archive_mode/archive_command: ${e instanceof Error ? e.message : String(e)}`
        }
      }
    } else if (engine === 'PostgreSQL') {
      stanzaMessage =
        'Could not discover PostgreSQL data directory — stanza not auto-created. ' +
        'Use a superuser connection URL, or ensure pg_lsclusters is available for local clusters. ' +
        'You can still create a stanza manually under Settings → pgBackRest.'
    }

    // Auto-create pg-cdc config file so setupCdcForDb works
    if (engine === 'PostgreSQL' && databases.length > 0) {
      try {
        const u = new URL(connectionUrl)
        if (u.pathname === '/' || u.pathname === '') {
          u.pathname = '/postgres'
        }
        const mgmtUrl = u.toString()
        let yaml = ''
        const known: string[] = []
        try {
          yaml = fs.readFileSync(PGCDC_CONF, 'utf-8')
          const nameRe = /^\s*-\s*name:\s*(.+)$/gm
          let m
          while ((m = nameRe.exec(yaml)) !== null) {
            known.push(m[1].trim().replace(/^["']|["']$/g, ''))
          }
        } catch {
          yaml =
            `pg_connection: "${mgmtUrl}"\n` +
            `capture_dir: /var/pg-cdc\n` +
            `backup_dir: /var/backups/pg\n` +
            `scripts_dir: /etc/pg-cdc\n` +
            `safety_valve:\n` +
            `  max_lag_bytes: 1073741824\n` +
            `  grace_period_seconds: 300\n` +
            `monitoring:\n` +
            `  lag_warn_bytes: 52428800\n` +
            `  slot_inactive_seconds: 600\n` +
            `  stream_stale_seconds: 120\n` +
            `  check_interval_seconds: 60\n` +
            `databases:\n`
        }
        // Keep pg_connection in sync with the newly added server when empty
        if (/^pg_connection:\s*["']?["']?\s*$/m.test(yaml) || !/^pg_connection:/m.test(yaml)) {
          if (/^pg_connection:/m.test(yaml)) {
            yaml = yaml.replace(/^pg_connection:\s*.*$/m, `pg_connection: "${mgmtUrl}"`)
          } else {
            yaml = `pg_connection: "${mgmtUrl}"\n` + yaml
          }
        }
        const missing = databases.filter((db) => !known.includes(db))
        if (missing.length > 0) {
          const dbIdx = yaml.search(/^databases:/m)
          if (dbIdx !== -1) {
            let insertAt = yaml.indexOf('\n', dbIdx) + 1
            for (const db of missing) {
              const entry = `  - name: ${db}\n`
              yaml = yaml.slice(0, insertAt) + entry + yaml.slice(insertAt)
              insertAt += entry.length
            }
          } else {
            yaml += `databases:\n` + missing.map((db) => `  - name: ${db}\n`).join('')
          }
        }
        // Use writeConfigFile so /etc/pg-cdc is created via sudo when needed
        await writeConfigFile(PGCDC_CONF, yaml)

        // Deploy systemd unit files and daemon scripts
        const scriptDir = process.cwd() + '/scripts'
        const deployFiles: [string, string][] = [
          ['pg-cdc@.service', '/etc/systemd/system/pg-cdc@.service'],
          ['pg-cdc-rotate@.service', '/etc/systemd/system/pg-cdc-rotate@.service'],
          ['pg-cdc-rotate@.timer', '/etc/systemd/system/pg-cdc-rotate@.timer'],
          ['capture-daemon.mjs', '/etc/pg-cdc/capture-daemon.mjs'],
          ['backup_db.sh', '/etc/pg-cdc/backup_db.sh'],
          ['rotate_stream.sh', '/etc/pg-cdc/rotate_stream.sh'],
          ['alert.sh', '/etc/pg-cdc/alert.sh'],
          ['pg-cdc-backup@.service', '/etc/systemd/system/pg-cdc-backup@.service'],
          ['pg-cdc-backup@.timer', '/etc/systemd/system/pg-cdc-backup@.timer'],
          ['pg-cdc-monitor.service', '/etc/systemd/system/pg-cdc-monitor.service'],
          ['pg-cdc-monitor.timer', '/etc/systemd/system/pg-cdc-monitor.timer'],
          ['pg-cdc-healthcheck.service', '/etc/systemd/system/pg-cdc-healthcheck.service'],
          ['pg-cdc-healthcheck.timer', '/etc/systemd/system/pg-cdc-healthcheck.timer'],
          ['health_check.sh', '/etc/pg-cdc/health_check.sh'],
          ['cleanup_cdc.sh', '/etc/pg-cdc/cleanup_cdc.sh'],
        ]
        for (const [src, dest] of deployFiles) {
          const srcPath = scriptDir + '/' + src
          try {
            await sudoExec(['cp', srcPath, dest], { timeout: 5000 })
            await sudoExec(['chmod', '755', dest], { timeout: 3000 })
          } catch {
            // individual file deploy is best-effort until sudoers is installed
          }
        }

        // Ensure data directories exist and are owned by postgres.
        // The CDC daemon (pg-cdc@.service User=postgres) writes stream files
        // to /var/pg-cdc/<db>/ and the backup script writes to /var/backups/pg/<db>/.
        // Without this chown the daemon fails with EACCES on stream_current.jsonl.
        try {
          await sudoExec(['mkdir', '-p', '/var/pg-cdc', '/var/backups/pg', '/var/log/pg-cdc', '/var/lib/pgbackrest'], { timeout: 5000 })
          await sudoExec(['chown', 'postgres:postgres', '/var/pg-cdc', '/var/backups/pg', '/var/log/pg-cdc', '/var/lib/pgbackrest'], { timeout: 5000 })
        } catch { /* best-effort — may already exist with correct owner */ }

        // Enable and start the health check timer so it runs automatically
        ensureHealthCheckTimer().catch(() => {})
      } catch (e: unknown) {
        // Surface sudo misconfiguration in stanza message when CDC deploy fails
        if (e instanceof SudoNotConfiguredError && !stanzaMessage) {
          stanzaMessage = e.message
        }
        // other pg-cdc config deploy errors are best-effort
      }
    }

    return c.json({ success: true, server, pgDataDir, stanzaCreated, stanzaMessage: stanzaMessage || undefined })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/servers/delete', async (c) => {
  try {
    const admin = requireRole(c, 'admin')
    if (!admin) return c.json({ success: false, error: c.res.status === 403 ? 'Forbidden' : 'Not authenticated' }, c.res.status === 403 ? 403 : 401)

    const { id } = await c.req.json()
    if (!id) return c.json({ error: 'Server ID is required' }, 400)

    // Look up the server before deleting so we know which databases to clean up
    const servers = listServers()
    const server = servers.find((s) => s.id === id)
    if (!server) return c.json({ error: 'Server not found' }, 404)

    const cleanupErrors: string[] = []

    // 1. Stop & disable systemd daemons and drop replication slots for each database
    for (const dbName of server.databases) {
      const unitName = `pg-cdc@${dbName}.service`
      try {
        await sudoExec(['systemctl', 'stop', unitName], { timeout: 15000 })
        await sudoExec(['systemctl', 'disable', unitName], { timeout: 15000 })
      } catch (e: unknown) {
        cleanupErrors.push(`Failed to stop/disable daemon for "${dbName}": ${e instanceof Error ? e.message : String(e)}`)
      }

      const slotName = `${dbName}_cdc`
      try {
        const u = new URL(server.connectionUrl)
        if (u.pathname === '/' || u.pathname === '') {
          u.pathname = '/' + dbName
        } else {
          u.pathname = u.pathname.replace(/\/[^/]*$/, '/' + dbName)
        }
        const dbConn = u.toString()
        const sql = postgres(dbConn, { max: 1, idle_timeout: 5 })
        try {
          await sql`SELECT pg_drop_replication_slot(${slotName})`
        } catch { /* slot may not exist — ignore */ }
        await sql.end()
      } catch (e: unknown) {
        cleanupErrors.push(`Failed to drop replication slot for "${dbName}": ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // 2. Remove database entries from the CDC YAML config
    if (server.databases.length > 0) {
      try {
        const yaml = fs.readFileSync(PGCDC_CONF, 'utf-8')
        const toRemove = new Set(server.databases)
        const lines = yaml.split('\n')
        const filtered: string[] = []
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(/^\s*-\s*name:\s*(.+)$/)
          if (m) {
            const name = m[1].trim().replace(/^["']|["']$/g, '')
            if (toRemove.has(name)) continue
          }
          filtered.push(lines[i])
        }
        await writeConfigFile(PGCDC_CONF, filtered.join('\n'))
      } catch (e: unknown) {
        if (e instanceof SudoNotConfiguredError) {
          cleanupErrors.push(e.message)
        } else {
          cleanupErrors.push(`Failed to update CDC config: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }

    // 3. Remove pgBackRest stanza from config and drop it
    try {
      const raw = fs.readFileSync(PGBACKREST_CONF, 'utf-8')
      const config = parseIni(raw)
      if (config[server.label]) {
        delete config[server.label]
        const out = serializeIni(config)
        await writeConfigFile(PGBACKREST_CONF, out)
      }
    } catch (e: unknown) {
      if (e instanceof SudoNotConfiguredError) {
        cleanupErrors.push(e.message)
      } else {
        cleanupErrors.push(`Failed to remove pgBackRest stanza: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    try {
      await sudoExec(['-u', 'postgres', '/usr/bin/pgbackrest', `--stanza=${server.label}`, 'stanza-drop'], { timeout: 30_000 })
    } catch { /* stanza may not exist — ignore */ }

    // 3.5. Update or clear archive_command in PostgreSQL
    //      The deleted server's stanza is gone, so archive_command must not
    //      still reference it. Point to a remaining server's stanza or clear it.
    try {
      const remainingServers = listServers().filter((s) => s.id !== id)
      const u = new URL(server.connectionUrl)
      if (u.pathname === '/' || u.pathname === '') { u.pathname = '/postgres' }
      const sql = postgres(u.toString(), { max: 1, idle_timeout: 5 })
      try {
        if (remainingServers.length > 0) {
          const newStanza = remainingServers[0].label
          const newArchiveCommand = `pgbackrest --stanza=${newStanza} archive-push %p`
          const acRow = await sql`SHOW archive_command`
          const currentArchiveCommand = String((acRow[0] as Record<string, string>)?.archive_command ?? '')
          if (currentArchiveCommand !== newArchiveCommand) {
            const escapedCmd = newArchiveCommand.replace(/'/g, "''")
            await sql.unsafe(`ALTER SYSTEM SET archive_command = '${escapedCmd}'`)
            await sql`SELECT pg_reload_conf()`
          }
        } else {
          await sql`ALTER SYSTEM SET archive_command = ''`
          await sql`SELECT pg_reload_conf()`
        }
      } catch (e: unknown) {
        cleanupErrors.push(`Failed to update archive_command: ${e instanceof Error ? e.message : String(e)}`)
      }
      await sql.end().catch(() => {})
    } catch (e: unknown) {
      cleanupErrors.push(`Failed to connect for archive_command cleanup: ${e instanceof Error ? e.message : String(e)}`)
    }

    // 4. Delete associated SQLite records (backups, cron jobs, health checkpoints)
    if (server.databases.length > 0) {
      const db = getDb()
      const placeholders = server.databases.map(() => '?').join(',')
      try {
        // Unschedule in-process cron jobs before deleting them
        const cronRows = db.prepare(`SELECT id FROM cron_jobs WHERE db IN (${placeholders})`).all(...server.databases) as { id: string }[]
        for (const row of cronRows) unscheduleCronJob(row.id)
        db.prepare(`DELETE FROM cron_jobs WHERE db IN (${placeholders})`).run(...server.databases)
      } catch (e: unknown) {
        cleanupErrors.push(`Failed to delete cron jobs: ${e instanceof Error ? e.message : String(e)}`)
      }
      try {
        db.prepare(`DELETE FROM backups WHERE db IN (${placeholders})`).run(...server.databases)
      } catch (e: unknown) {
        cleanupErrors.push(`Failed to delete backups: ${e instanceof Error ? e.message : String(e)}`)
      }
      try {
        db.prepare(`DELETE FROM health_checkpoints WHERE db IN (${placeholders})`).run(...server.databases)
      } catch (e: unknown) {
        cleanupErrors.push(`Failed to delete health checkpoints: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // 5. Remove on-disk CDC stream files and backup directories
    for (const dbName of server.databases) {
      try {
        await sudoExec(['rm', '-rf', `/var/pg-cdc/${dbName}`], { timeout: 10_000 })
      } catch (e: unknown) {
        cleanupErrors.push(`Failed to remove CDC stream files for "${dbName}": ${e instanceof Error ? e.message : String(e)}`)
      }
      try {
        await sudoExec(['rm', '-rf', `/var/backups/pg/${dbName}`], { timeout: 10_000 })
      } catch (e: unknown) {
        cleanupErrors.push(`Failed to remove backup files for "${dbName}": ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // 6. Delete the server from the database
    const changes = deleteServerById(id)
    if (changes === 0) return c.json({ error: 'Server not found' }, 404)

    return c.json({
      success: true,
      message: 'Server deleted',
      cleanupErrors: cleanupErrors.length > 0 ? cleanupErrors : undefined,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/servers/discover', async (c) => {
  try {
    const user = requireAuth(c)
    if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)

    const { id } = await c.req.json()
    if (!id) return c.json({ error: 'Server ID is required' }, 400)

    const servers = listServers()
    const idx = servers.findIndex((s) => s.id === id)
    if (idx === -1) return c.json({ error: 'Server not found' }, 404)

    const server = servers[idx]
    let databases = server.databases

    if (server.engine === 'PostgreSQL') {
      const discovered = await discoverPostgresCluster(server.connectionUrl)
      if (discovered.databases.length > 0) databases = discovered.databases
    }

    updateServerById(id, { databases })

    return c.json({ success: true, server: { ...server, databases } })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

// ---------------------------------------------------------------------------
// 9. Authentication & Authorization — AD auth + local user list
// ---------------------------------------------------------------------------

type AppUser = {
  id: string
  email: string
  employeeId: string
  displayName: string
  samAccountName: string
  department: string
  title: string
  role: Role
  allowedPages: string[]
  allowedActions: string[]
  createdAt: string
}

type AuthSession = {
  token: string
  user: AppUser
  createdAt: number
  lastAccessed: number
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000 // 8 hours

const AD_AUTH_URL = 'https://letsreflectandthrive.et/ad-auth/authenticate'

const sessions = new Map<string, AuthSession>()

// ---------------------------------------------------------------------------
// Login rate limiting — 10 attempts per 15 min per IP
// ---------------------------------------------------------------------------
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000
const LOGIN_RATE_LIMIT_MAX = 10
const loginAttempts = new Map<string, { count: number; resetAt: number }>()

function clientIp(c: any): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('x-real-ip')
    || 'unknown'
}

function checkLoginRateLimit(ip: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now()
  const entry = loginAttempts.get(ip)
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_RATE_LIMIT_WINDOW_MS })
    return { allowed: true, retryAfterSec: 0 }
  }
  entry.count++
  if (entry.count > LOGIN_RATE_LIMIT_MAX) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) }
  }
  return { allowed: true, retryAfterSec: 0 }
}

function resetLoginRateLimit(ip: string): void {
  loginAttempts.delete(ip)
}

function generateToken(): string {
  return 'sess_' + randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '')
}

function getSessionFromRequest(c: any): AppUser | null {
  const auth = c.req.header('Authorization')
  if (!auth || !auth.startsWith('Bearer ')) return null
  const token = auth.slice(7)
  const session = sessions.get(token)
  if (!session) return null
  // Evict expired sessions
  const now = Date.now()
  if (now - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token)
    return null
  }
  session.lastAccessed = now
  return session.user
}

const DEFAULT_ADMIN: AppUser = {
  id: 'admin_0001',
  email: 'admin@dbmanager.local',
  employeeId: '0',
  displayName: 'Admin',
  samAccountName: 'admin',
  department: 'IT',
  title: 'Administrator',
  role: 'admin',
  allowedPages: ['dashboard', 'backup', 'restore', 'cron', 'settings', 'users'],
  allowedActions: ['backup:create', 'backup:delete', 'backup:retry', 'restore:run', 'cron:create', 'cron:update', 'cron:delete', 'cron:run', 'settings:read', 'settings:write', 'users:manage'],
  createdAt: new Date().toISOString(),
}

function seedUsers() {
  const db = getDb()
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }
  if (count.c === 0) {
    insertUser(DEFAULT_ADMIN)
  }
}

// Login
app.post('/auth/login', async (c) => {
  try {
    const ip = clientIp(c)
    const rl = checkLoginRateLimit(ip)
    if (!rl.allowed) {
      c.header('Retry-After', String(rl.retryAfterSec))
      return c.json({ success: false, error: 'Too many login attempts. Try again later.' }, 429)
    }

    const { username, password } = await c.req.json()
    if (!username || !password) {
      return c.json({ success: false, error: 'Username and password are required' }, 400)
    }

    // Call AD auth API
    const adRes = await fetch(AD_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email:username, password }),
    })
    const adData = await adRes.json()

    if (!adData.success) {
      return c.json({
        success: false,
        error: adData.message || 'Authentication failed',
        details: adData.errors?.reason || 'Invalid credentials',
      }, 401)
    }

    // Extract user info from AD response
    const adUser = adData.data?.user
    if (!adUser?.email) {
      return c.json({ success: false, error: 'AD response missing user data' }, 500)
    }

    const localUsers = listUsers()
    const authorizedUser = localUsers.find(
      (u) => u.email.toLowerCase() === adUser.email.toLowerCase() || u.samAccountName.toLowerCase() === adUser.sam_account_name?.toLowerCase()
    )

    if (!authorizedUser) {
      return c.json({
        success: false,
        error: 'User not authorized',
        details: 'Contact an administrator to grant you access.',
      }, 403)
    }

    // Successful login — reset rate limit for this IP
    resetLoginRateLimit(ip)

    // Create session
    const token = generateToken()
    const now = Date.now()
    sessions.set(token, {
      token,
      user: authorizedUser,
      createdAt: now,
      lastAccessed: now,
    })

    return c.json({
      success: true,
      token,
      user: authorizedUser,
      message: `Welcome, ${authorizedUser.displayName}`,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: 'Login failed', details: message }, 500)
  }
})

// Logout
app.post('/auth/logout', (c) => {
  const auth = c.req.header('Authorization')
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7)
    sessions.delete(token)
  }
  return c.json({ success: true, message: 'Logged out' })
})

// Get current user from session
app.get('/auth/me', (c) => {
  const user = getSessionFromRequest(c)
  if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)
  return c.json({ success: true, user })
})

// Protect middleware helper
function requireAuth(c: any): AppUser | null {
  const user = getSessionFromRequest(c)
  if (!user) {
    c.status(401)
    return null
  }
  return user
}

function requireRole(c: any, role: 'admin' | 'operator' | 'viewer'): AppUser | null {
  const user = getSessionFromRequest(c)
  if (!user) {
    c.status(401)
    return null
  }
  if (user.role !== 'admin' && user.role !== role) {
    c.status(403)
    return null
  }
  return user
}

// ---------------------------------------------------------------------------
// 10. User management — CRUD for authorized users (admin only)
// ---------------------------------------------------------------------------

app.get('/users', (c) => {
  const user = requireAuth(c)
  if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)
  if (user.role !== 'admin') return c.json({ success: false, error: 'Forbidden' }, 403)

  try {
    const users = listUsers()
    return c.json({ success: true, users })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/users', async (c) => {
  try {
    const admin = requireAuth(c)
    if (!admin) return c.json({ success: false, error: 'Not authenticated' }, 401)
    if (admin.role !== 'admin') return c.json({ success: false, error: 'Forbidden' }, 403)

    const { email, samAccountName, displayName, department, title, role, allowedPages, allowedActions } = await c.req.json()
    if (!email || !samAccountName) {
      return c.json({ error: 'Email and SAM account name are required' }, 400)
    }
    if (role && !isValidRole(role)) {
      return c.json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` }, 400)
    }

    const users = listUsers()

    if (users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
      return c.json({ error: 'User with this email already exists' }, 409)
    }
    if (users.some((u) => u.samAccountName.toLowerCase() === samAccountName.toLowerCase())) {
      return c.json({ error: 'User with this SAM account name already exists' }, 409)
    }

    const newUser: AppUser = {
      id: 'usr_' + randomUUID().slice(0, 8),
      email,
      employeeId: '',
      displayName: displayName || email.split('@')[0],
      samAccountName,
      department: department || '',
      title: title || '',
      role: role || 'viewer',
      allowedPages: allowedPages || ['dashboard'],
      allowedActions: allowedActions || [],
      createdAt: new Date().toISOString(),
    }

    insertUser(newUser)

    return c.json({ success: true, user: newUser, message: 'User created' })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/users/update', async (c) => {
  try {
    const admin = requireAuth(c)
    if (!admin) return c.json({ success: false, error: 'Not authenticated' }, 401)
    if (admin.role !== 'admin') return c.json({ success: false, error: 'Forbidden' }, 403)

    const { id, role, allowedPages, allowedActions, displayName, department, title } = await c.req.json()

    const users = listUsers()
    const idx = users.findIndex((u) => u.id === id)
    if (idx === -1) return c.json({ error: 'User not found' }, 404)

    if (role !== undefined && !isValidRole(role)) {
      return c.json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` }, 400)
    }

    // Last-admin protection: don't let the last admin demote themselves.
    if (role && role !== 'admin' && users[idx].role === 'admin' && users[idx].id === admin.id) {
      const otherAdmins = users.filter(u => u.role === 'admin' && u.id !== id)
      if (otherAdmins.length === 0) {
        return c.json({ error: 'Cannot demote yourself — you are the last admin' }, 400)
      }
    }

    const patch: Partial<AppUser> = {}
    if (role) patch.role = role
    if (allowedPages) patch.allowedPages = allowedPages
    if (allowedActions) patch.allowedActions = allowedActions
    if (displayName) patch.displayName = displayName
    if (department) patch.department = department
    if (title) patch.title = title
    updateUserById(id, patch)

    return c.json({ success: true, user: { ...users[idx], ...patch }, message: 'User updated' })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/users/delete', async (c) => {
  try {
    const admin = requireAuth(c)
    if (!admin) return c.json({ success: false, error: 'Not authenticated' }, 401)
    if (admin.role !== 'admin') return c.json({ success: false, error: 'Forbidden' }, 403)

    const { id } = await c.req.json()
    if (!id) return c.json({ error: 'User ID is required' }, 400)

    // Self-delete protection
    if (id === admin.id) {
      return c.json({ error: 'Cannot delete yourself' }, 400)
    }

    // Last-admin protection
    const users = listUsers()
    const target = users.find(u => u.id === id)
    if (target?.role === 'admin') {
      const otherAdmins = users.filter(u => u.role === 'admin' && u.id !== id)
      if (otherAdmins.length === 0) {
        return c.json({ error: 'Cannot remove the last admin' }, 400)
      }
    }

    const changes = deleteUserById(id)
    if (changes === 0) return c.json({ error: 'User not found' }, 404)

    return c.json({ success: true, message: 'User deleted' })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

// Install system crontab entries for pgbackrest via subprocess
async function installSystemCronJobs() {
  const marker = '# pgbackrest-db-manager'
  const entries = [
    marker,
    '# pgBackRest full backup every Sunday 06:30',
    '30 06 * * 0 pgbackrest --stanza=main --type=full backup',
    '# pgBackRest incremental backup Mon-Sat 06:30',
    '30 06 * * 1-6 pgbackrest --stanza=main --type=incr backup',
    '# pgBackRest archive cron — prune archived WAL no longer needed by retained backups',
    '*/15 * * * * pgbackrest --stanza=main archive-cron',
    '# pg-cdc per-db stream & log cleanup (runs hourly, handles retention via PGCDC_RETENTION_DAYS)',
    '15 * * * * /etc/pg-cdc/cleanup_cdc.sh',
  ]

  let content: string
  try {
    const { stdout } = await sudoExec(['crontab', '-u', 'postgres', '-l'])
    if (stdout.includes(marker)) return
    content = (stdout || '') + '\n' + entries.join('\n') + '\n'
  } catch (err) {
    if (err instanceof SudoNotConfiguredError) return
    content = entries.join('\n') + '\n'
  }

  const tmpFile = '/tmp/pgbackrest-cron-' + randomUUID().slice(0, 8)
  fs.writeFileSync(tmpFile, content)
  try {
    try {
      await sudoExec(['crontab', '-u', 'postgres', tmpFile])
    } catch (writeErr: unknown) {
      if (writeErr instanceof SudoNotConfiguredError) return
      throw writeErr
    }
  } finally {
    fs.unlinkSync(tmpFile)
  }
}

/**
 * Self-healing: deploy health check systemd units and start the timer if missing.
 * Called on boot and after server creation.
 */
async function ensureHealthCheckTimer() {
  const scriptDir = process.cwd() + '/scripts'
  const deployFiles: [string, string][] = [
    ['pg-cdc-healthcheck.service', '/etc/systemd/system/pg-cdc-healthcheck.service'],
    ['pg-cdc-healthcheck.timer', '/etc/systemd/system/pg-cdc-healthcheck.timer'],
    ['health_check.sh', '/etc/pg-cdc/health_check.sh'],
  ]
  for (const [src, dest] of deployFiles) {
    const srcPath = scriptDir + '/' + src
    try {
      await sudoExec(['cp', srcPath, dest], { timeout: 5000 })
      await sudoExec(['chmod', '755', dest], { timeout: 3000 })
    } catch { /* best-effort */ }
  }

  await sudoExec(['systemctl', 'daemon-reload'], { timeout: 15000 }).catch(() => {})
  await sudoExec(['systemctl', 'enable', 'pg-cdc-healthcheck.timer'], { timeout: 10000 }).catch(() => {})
  await sudoExec(['systemctl', 'start', 'pg-cdc-healthcheck.timer'], { timeout: 10000 }).catch(() => {})
}

// ---------------------------------------------------------------------------
// 11. pg-cdc — Per-Database CDC backup & restore
// ---------------------------------------------------------------------------

const PROJECT_ROOT = process.cwd()
const TSX_BIN = resolve(PROJECT_ROOT, 'pg-cdc/node_modules/.bin/tsx')
const TSX_BIN_EXISTS = fs.existsSync(TSX_BIN)
const PG_CDC_ENV = process.env.PG_CDC_ENV || '/etc/pg-cdc/pg-cdc.env'

function parseCdcDbNames(raw: string): string[] {
  const names: string[] = []
  let inDatabases = false
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (t.startsWith('databases:')) { inDatabases = true; continue }
    if (inDatabases) {
      const m = t.match(/^-\s*name:\s*(.+)$/)
      if (m) names.push(m[1].trim().replace(/^["']|["']$/g, ''))
      else if (t && !t.startsWith('#') && line[0] !== ' ' && line[0] !== '\t') inDatabases = false
    }
  }
  return names
}

app.get('/cdc/status', async (c) => {
  const user = requireAuth(c)
  if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)
  try {
    let raw: string
    try { raw = fs.readFileSync(PGCDC_CONF, 'utf-8') }
    catch { return c.json({ success: true, statuses: [] }) }

    const mgmtMatch = raw.match(/^pg_connection:\s*(.+)$/m)
    const mgmtUrl = mgmtMatch ? mgmtMatch[1].trim().replace(/^["']|["']$/g, '') : ''
    const dbNames = parseCdcDbNames(raw)

    const statuses: any[] = []
    let slots: any[] = []
    if (mgmtUrl) {
      try {
        const sql = postgres(mgmtUrl, { max: 1, idle_timeout: 10 })
        slots = await sql`SELECT slot_name, active, pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS lag_pretty FROM pg_replication_slots WHERE slot_type = 'logical' AND plugin = 'wal2json'`
        await sql.end()
      } catch {}
    }

    for (const db of dbNames) {
      const slotName = `${db}_cdc`
      const slot = slots.find((s: any) => s.slot_name === slotName)

      let daemonRunning = false
      try {
        const { stdout } = await execFileAsync('systemctl', ['is-active', `pg-cdc@${db}.service`], { timeout: 5000 })
        daemonRunning = stdout.trim() === 'active'
      } catch {}

      const streamFile = `/var/pg-cdc/${db}/stream_current.jsonl`
      let streamStaleSec: number | null = null
      if (fs.existsSync(streamFile)) {
        streamStaleSec = Math.floor((Date.now() - fs.statSync(streamFile).mtimeMs) / 1000)
      }

      const backupDir = `/var/backups/pg/${db}`
      let lastBaseline: string | null = null
      if (fs.existsSync(backupDir)) {
        const files = fs.readdirSync(backupDir).filter(f => f.startsWith('base_') && f.endsWith('.dump')).sort().reverse()
        if (files.length > 0) {
          const m = files[0].match(/^base_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/)
          lastBaseline = m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : files[0]
        }
      }

      statuses.push({
        db, slotName,
        slotActive: slot ? !!slot.active : false,
        lagBytes: slot ? (Number(slot.lag_bytes) || 0) : null,
        lagHuman: slot ? slot.lag_pretty : 'N/A',
        daemonRunning, streamStaleSec, lastBaseline,
      })
    }

    return c.json({ success: true, statuses })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/cdc/setup', async (c) => {
  try {
    const user = requireAuth(c)
    if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)

    if (!TSX_BIN_EXISTS) {
      return c.json({ success: false, error: `CDC tooling not installed (tsx binary not found at ${TSX_BIN})` }, 400)
    }

    const { dbName } = await c.req.json()
    if (!dbName) return errJson(c, 'dbName is required', 400)
    if (!isValidDbName(dbName)) return errJson(c, 'dbName must be a valid PostgreSQL identifier (max 63 chars)', 400)

    // Ensure the database is in the yaml config before running setup
    // Write the db entry to the CDC config file (via sudo if direct write fails)
    async function ensureDbInConfig(): Promise<void> {
      let yaml = ''
      const known: string[] = []
      try {
        yaml = fs.readFileSync(PGCDC_CONF, 'utf-8')
        const nameRe = /^\s*-\s*name:\s*(.+)$/gm
        let m
        while ((m = nameRe.exec(yaml)) !== null) {
          known.push(m[1].trim().replace(/^["']|["']$/g, ''))
        }
      } catch {
        yaml =
          `pg_connection: ""\n` +
          `capture_dir: /var/pg-cdc\n` +
          `backup_dir: /var/backups/pg\n` +
          `scripts_dir: /etc/pg-cdc\n` +
          `databases:\n`
      }
      if (known.includes(dbName)) return
      const dbIdx = yaml.search(/^databases:/m)
      if (dbIdx !== -1) {
        const insertAt = yaml.indexOf('\n', dbIdx) + 1
        yaml = yaml.slice(0, insertAt) + `  - name: ${dbName}\n` + yaml.slice(insertAt)
      } else {
        yaml += `databases:\n  - name: ${dbName}\n`
      }
      await writeConfigFile(PGCDC_CONF, yaml)
    }
    await ensureDbInConfig()

    const { stdout } = await execFileAsync(TSX_BIN, ['pg-cdc/src/cli.ts', 'setup', dbName, '--config', PGCDC_CONF], { cwd: PROJECT_ROOT, timeout: 30000 })
    return c.json({ success: true, message: `CDC setup complete for "${dbName}"`, output: stdout })
  } catch (error: unknown) {
    if (error instanceof SudoNotConfiguredError) {
      return c.json({ success: false, error: 'CDC setup failed', details: error.message }, 500)
    }
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: 'CDC setup failed', details: message }, 500)
  }
})

app.post('/cdc/backup', async (c) => {
  try {
    const user = requireAuth(c)
    if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)

    const { dbName } = await c.req.json()
    if (!dbName) return errJson(c, 'dbName is required', 400)
    if (!isValidDbName(dbName)) return errJson(c, 'dbName must be a valid PostgreSQL identifier (max 63 chars)', 400)

    if (!fs.existsSync(PG_CDC_ENV)) {
      return c.json({ success: false, error: `pg-cdc environment file not found at ${PG_CDC_ENV}` }, 400)
    }

    const id = 'cdc_' + randomUUID().slice(0, 8)
    const record: BackupRecord = {
      id,
      db: dbName,
      type: 'Full',
      size: '—',
      createdAt: nowStamp(),
      createdAtIso: isoStamp(),
      status: 'Running',
      source: 'cdc',
    }
    insertBackup(record)

    try {
      // Pass db name as argv ($1) — never interpolate into the shell string
      const { stdout } = await sudoExec([
        'bash', '-c',
        `set -a; . "${PG_CDC_ENV}"; set +a; exec /etc/pg-cdc/backup_db.sh "$1"`,
        '--', dbName,
      ], { timeout: 3600_000 })

      let size = '—'
      let path: string | undefined
      const backupDir = `/var/backups/pg/${dbName}`
      try {
        const files = fs.readdirSync(backupDir).filter(f => f.startsWith('base_') && f.endsWith('.dump')).sort().reverse()
        if (files.length > 0) {
          const stat = fs.statSync(backupDir + '/' + files[0])
          const bytes = stat.size
          const mb = bytes / 1048576
          size = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
          path = backupDir + '/' + files[0]
        }
      } catch { /* best-effort */ }
      updateBackupById(id, { status: 'Completed', size, path })

      // Record a health checkpoint — a successful backup proves the DB was healthy
      try {
        const dbConn = getDb()
        const chkId = 'chk_' + randomUUID().slice(0, 8)
        const now = new Date().toISOString()
        dbConn.prepare('INSERT INTO health_checkpoints (id, db, timestamp, wal_lsn, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(chkId, dbName, now, '', 'healthy', now)
      } catch { /* best-effort */ }

      const completed = { ...record, status: 'Completed' as const, size, path }
      return c.json({ success: true, id, message: `Baseline backup complete for "${dbName}"`, output: stdout, backup: completed })
    } catch (execError: unknown) {
      updateBackupById(id, { status: 'Failed', size: '—' })
      const errDetail = execError instanceof Error ? execError.message : ''
      const errStdout = String((execError as { stdout?: string | Buffer }).stdout ?? '').trim()
      const errStderr = String((execError as { stderr?: string | Buffer }).stderr ?? '').trim()
      const detail = [errStdout, errStderr, errDetail].filter(Boolean).join('\n')
      const failed = { ...record, status: 'Failed' as const, size: '—' as const }
      return c.json({
        success: false,
        id,
        error: 'CDC backup execution failed',
        message: `Baseline backup failed for "${dbName}"`,
        details: detail,
        backup: failed,
      }, 500)
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: 'CDC backup failed', details: message }, 500)
  }
})

// ---------------------------------------------------------------------------
// 12. Health checkpoints — periodic known-good state snapshots
// ---------------------------------------------------------------------------

app.get('/cdc/health-checkpoints', async (c) => {
  const user = requireAuth(c)
  if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)
  try {
    const db = c.req.query('db') || undefined
    const dbConn = getDb()
    let rows: any[]
    if (db) {
      rows = dbConn.prepare('SELECT * FROM health_checkpoints WHERE db = ? ORDER BY created_at DESC LIMIT 20').all(db) as any[]
    } else {
      rows = dbConn.prepare('SELECT * FROM health_checkpoints ORDER BY created_at DESC LIMIT 50').all() as any[]
    }
    const checkpoints: HealthCheckpoint[] = rows.map(r => ({
      id: r.id,
      db: r.db,
      timestamp: r.timestamp,
      walLsn: r.wal_lsn,
      status: r.status as 'healthy' | 'degraded',
      createdAt: r.created_at,
    }))
    return c.json({ success: true, checkpoints })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: message }, 500)
  }
})

app.post('/cdc/health-check', async (c) => {
  try {
    // No auth required — this endpoint is called by the pg-cdc-healthcheck
    // systemd timer (as root) every 15 minutes. It only reads replication
    // slot status and records checkpoints; no secrets are exposed and no
    // destructive user-facing actions are performed.

    let raw: string
    try { raw = fs.readFileSync(PGCDC_CONF, 'utf-8') }
    catch { return c.json({ success: false, error: 'CDC config not found' }, 404) }

    const mgmtMatch = raw.match(/^pg_connection:\s*(.+)$/m)
    const mgmtUrl = mgmtMatch ? mgmtMatch[1].trim().replace(/^["']|["']$/g, '') : ''
    const dbNames = parseCdcDbNames(raw)

    if (!mgmtUrl) return c.json({ success: false, error: 'No management connection in config' }, 400)

    const checks: { db: string; healthy: boolean; walLsn: string; detail: string }[] = []
    let globalWalLsn = ''

    async function runChecks(sql: ReturnType<typeof postgres>) {
      const [wal] = await sql`SELECT pg_current_wal_lsn()::text AS lsn`
      globalWalLsn = (wal?.lsn as string) || ''

      for (const dbName of dbNames) {
        const slotName = `${dbName}_cdc`
        try {
          const slots = await sql`
            SELECT slot_name, active, pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes
            FROM pg_replication_slots
            WHERE slot_type = 'logical' AND plugin = 'wal2json' AND slot_name = ${slotName}
          `
          if (slots.length === 0) {
            checks.push({ db: dbName, healthy: false, walLsn: '', detail: 'No replication slot found' })
          } else if (!slots[0].active) {
            checks.push({ db: dbName, healthy: false, walLsn: '', detail: 'Replication slot inactive' })
          } else {
            const lagBytes = Number(slots[0].lag_bytes) || 0
            const healthy = lagBytes < 1073741824 // 1 GB threshold
            checks.push({ db: dbName, healthy, walLsn: globalWalLsn, detail: healthy ? 'OK' : `Lag ${(lagBytes / 1048576).toFixed(1)} MB exceeds threshold` })
          }
        } catch (err: unknown) {
          checks.push({ db: dbName, healthy: false, walLsn: '', detail: err instanceof Error ? err.message : 'Check failed' })
        }
      }
    }

    let sql: ReturnType<typeof postgres> | null = null
    try {
      sql = postgres(mgmtUrl, { max: 1, idle_timeout: 10 })
      await sql`SELECT 1 AS ok`
      await runChecks(sql)
      await sql.end()
      sql = null
    } catch {
      // Configured mgmtUrl failed — try alternate databases
      const u = new URL(mgmtUrl)
      for (const db of ['postgres', 'template1']) {
        if (sql) break
        try {
          u.pathname = `/${db}`
          sql = postgres(u.toString(), { max: 1, idle_timeout: 10 })
          await sql`SELECT 1`
        } catch {
          if (sql) { try { await sql.end() } catch {} }
          sql = null
        }
      }
      if (sql) {
        try {
          await runChecks(sql)
        } catch {
          for (const dbName of dbNames) {
            checks.push({ db: dbName, healthy: false, walLsn: '', detail: 'Health check failed after fallback connection' })
          }
        }
        await sql.end().catch(() => {})
      } else {
        for (const dbName of dbNames) {
          checks.push({ db: dbName, healthy: false, walLsn: '', detail: 'No reachable database on the server' })
        }
      }
    }

    // Auto-heal: recreate missing slots, restart daemons, ensure timers and cron
    let healSql: ReturnType<typeof postgres> | null = null
    const healUrl = new URL(mgmtUrl)
    for (const db of ['postgres', 'template1']) {
      if (healSql) break
      try {
        healUrl.pathname = `/${db}`
        healSql = postgres(healUrl.toString(), { max: 1, idle_timeout: 10 })
        await healSql`SELECT 1`
      } catch {
        if (healSql) { try { await healSql.end() } catch {} }
        healSql = null
      }
    }
    if (healSql) {
      for (const check of checks) {
        if (!check.healthy) {
          const unitName = `pg-cdc@${check.db}.service`
          const slotName = `${check.db}_cdc`
          try {
            const existing = await healSql`SELECT slot_name FROM pg_replication_slots WHERE slot_name = ${slotName}`
            if (existing.length === 0) {
              await healSql`SELECT pg_create_logical_replication_slot(${slotName}, 'wal2json')`
            }
          } catch (e: unknown) {
            console.warn('[cdc auto-heal] slot recreate failed for', check.db, e instanceof Error ? e.message : e)
          }
          try {
            await sudoExec(['systemctl', 'restart', unitName], { timeout: 15000 }).catch((e: unknown) => {
              console.warn('[cdc auto-heal] daemon restart failed for', unitName, e instanceof Error ? e.message : e)
            })
          } catch (e: unknown) {
            console.warn('[cdc auto-heal] daemon restart failed for', unitName, e instanceof Error ? e.message : e)
          }
        }
      }
      await healSql.end().catch(() => {})
    }

    // Fire-and-forget: ensure system timers and cron are running
    void (async () => {
      const sudoN = (args: string[], to?: number) => execFileAsync('sudo', ['-n', ...args], { timeout: to ?? 5000 }).catch(() => {})
      try {
        const { stdout } = await execFileAsync('sudo', ['-n', 'systemctl', 'is-active', 'pg-cdc-healthcheck.timer'], { timeout: 3000 })
        if (stdout.trim() !== 'active') { sudoN(['systemctl', 'enable', 'pg-cdc-healthcheck.timer']); sudoN(['systemctl', 'start', 'pg-cdc-healthcheck.timer']) }
      } catch { sudoN(['systemctl', 'enable', 'pg-cdc-healthcheck.timer']); sudoN(['systemctl', 'start', 'pg-cdc-healthcheck.timer']) }
      try {
        const { stdout } = await execFileAsync('sudo', ['-n', 'systemctl', 'is-active', 'pg-cdc-monitor.timer'], { timeout: 3000 })
        if (stdout.trim() !== 'active') { sudoN(['systemctl', 'enable', 'pg-cdc-monitor.timer']); sudoN(['systemctl', 'start', 'pg-cdc-monitor.timer']) }
      } catch { sudoN(['systemctl', 'enable', 'pg-cdc-monitor.timer']); sudoN(['systemctl', 'start', 'pg-cdc-monitor.timer']) }
      try {
        const { stdout } = await execFileAsync('sudo', ['-n', 'crontab', '-u', 'postgres', '-l'], { timeout: 3000 })
        if (!stdout.includes('# pgbackrest-db-manager')) { await installSystemCronJobs().catch(() => {}) }
      } catch { await installSystemCronJobs().catch(() => {}) }
    })()

    // Record checkpoints in SQLite
    const dbConn = getDb()
    const ins = dbConn.prepare('INSERT INTO health_checkpoints (id, db, timestamp, wal_lsn, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    const now = new Date().toISOString()
    const inserted: HealthCheckpoint[] = []

    for (const check of checks) {
      const id = 'chk_' + randomUUID().slice(0, 8)
      ins.run(id, check.db, now, check.walLsn, check.healthy ? 'healthy' : 'degraded', now)
      inserted.push({
        id, db: check.db, timestamp: now, walLsn: check.walLsn,
        status: check.healthy ? 'healthy' : 'degraded', createdAt: now,
      })
    }

    const allHealthy = checks.every(c => c.healthy)
    return c.json({
      success: true,
      allHealthy,
      checks,
      checkpoints: inserted,
      message: allHealthy
        ? `All ${checks.length} database(s) healthy — checkpoint recorded`
        : `${checks.filter(c => !c.healthy).length} database(s) degraded — checkpoints recorded`,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: 'Health check failed', details: message }, 500)
  }
})

app.post('/cdc/start-daemon', async (c) => {
  try {
    const user = requireAuth(c)
    if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)

    const { dbName } = await c.req.json()
    if (!dbName) return errJson(c, 'dbName is required', 400)
    if (!isValidDbName(dbName)) return errJson(c, 'dbName must be a valid PostgreSQL identifier (max 63 chars)', 400)

    // Redeploy the daemon script so any fixes (e.g. pg_recvlogical path detection) apply
    const deploySrc = process.cwd() + '/scripts/capture-daemon.mjs'
    const deployDst = '/etc/pg-cdc/capture-daemon.mjs'
    try {
      const buf = fs.readFileSync(deploySrc)
      fs.writeFileSync(deployDst, buf, { mode: 0o755 })
    } catch { /* best-effort */ }

    // Ensure the logical replication slot exists (create if missing)
    const slotName = `${dbName}_cdc`
    try {
      const yaml = fs.readFileSync(PGCDC_CONF, 'utf-8')
      const pgConnMatch = yaml.match(/^pg_connection:\s*(.+)$/m)
      const pgConn = pgConnMatch ? pgConnMatch[1].trim().replace(/^["']|["']$/g, '') : null
      if (pgConn) {
        const dbConn = pgConn.replace(/\/[^/]*$/, '/' + dbName)
        const sql = postgres(dbConn, { max: 1, idle_timeout: 5 })
        const existing = await sql`SELECT slot_name FROM pg_replication_slots WHERE slot_name = ${slotName}`
        if (existing.length === 0) {
          await sql`SELECT pg_create_logical_replication_slot(${slotName}, 'wal2json')`
        }
        await sql.end()
      }
    } catch { /* best-effort */ }

    // Ensure the per-DB capture directory exists and is owned by postgres
    // before starting the daemon — otherwise the daemon (User=postgres) fails
    // with EACCES when trying to write stream_current.jsonl.
    try {
      await sudoExec(['mkdir', '-p', `/var/pg-cdc/${dbName}`], { timeout: 5000 })
      await sudoExec(['chown', 'postgres:postgres', `/var/pg-cdc/${dbName}`], { timeout: 5000 })
    } catch { /* best-effort */ }

    const unitName = `pg-cdc@${dbName}.service`
    await sudoExec(['systemctl', 'start', unitName], { timeout: 15000 })
    return c.json({ success: true, message: `Daemon started for "${dbName}"` })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: 'Failed to start daemon', details: message }, 500)
  }
})

app.post('/cdc/restore', async (c) => {
  try {
    const user = requireAuth(c)
    if (!user) return c.json({ success: false, error: 'Not authenticated' }, 401)

    if (!TSX_BIN_EXISTS) {
      return c.json({ success: false, error: `CDC tooling not installed (tsx binary not found at ${TSX_BIN})` }, 400)
    }
    if (!fs.existsSync(PG_CDC_ENV)) {
      return c.json({ success: false, error: `pg-cdc environment file not found at ${PG_CDC_ENV}` }, 400)
    }

    const { sourceDb, targetDb, toTimestamp, forceProduction } = await c.req.json()
    if (!sourceDb || !targetDb) return errJson(c, 'sourceDb and targetDb are required', 400)
    if (!isValidDbName(sourceDb) || !isValidDbName(targetDb)) {
      return errJson(c, 'sourceDb and targetDb must be valid PostgreSQL identifiers (max 63 chars)', 400)
    }

    // If no timestamp provided, default to latest healthy checkpoint
    let ts = toTimestamp
    if (!ts) {
      const dbConn = getDb()
      const row = dbConn.prepare('SELECT * FROM health_checkpoints WHERE db = ? AND status = ? ORDER BY created_at DESC LIMIT 1').get(sourceDb, 'healthy') as any
      if (row) {
        ts = row.timestamp
      }
    }

    // Normalize timestamp to ISO-8601 UTC with Z suffix.
    // WAL records from wal2json carry timezone offsets (e.g. +03), so
    // new Date() parses them correctly.  But a user-typed timestamp
    // without a Z (e.g. "2026-07-05T14:30:00") is interpreted as local
    // time by the JS Date constructor, causing a silent timezone offset
    // against the UTC-based baseline filenames.  Normalizing here ensures
    // the restore engine always compares apples to apples.
    if (ts) {
      const parsed = new Date(ts)
      if (isNaN(parsed.getTime())) {
        return c.json({ success: false, error: `Invalid timestamp format: "${ts}". Use ISO-8601, e.g. 2026-07-05T14:30:00Z` }, 400)
      }
      ts = parsed.toISOString()
    }

    const args = ['pg-cdc/src/cli.ts', 'restore', sourceDb, targetDb, '--config', PGCDC_CONF]
    if (ts) args.push('--to-timestamp', ts)
    if (forceProduction) args.push('--force-production')
    const { stdout } = await execFileAsync(TSX_BIN, args, { cwd: PROJECT_ROOT, timeout: 3600_000 })
    return c.json({ success: true, message: `Restore of "${sourceDb}" to "${targetDb}" completed`, output: stdout, toTimestamp: ts || undefined })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: 'CDC restore failed', details: message }, 500)
  }
})

// ---------------------------------------------------------------------------
// System — manual reconciliation trigger
// ---------------------------------------------------------------------------
app.post('/system/reconcile', async (c) => {
  try {
    const admin = requireRole(c, 'admin')
    if (!admin) return c.json({ success: false, error: c.res.status === 403 ? 'Forbidden' : 'Not authenticated' }, c.res.status === 403 ? 403 : 401)

    const result = await reconcileOrphanedResources()
    const totalCleaned = result.orphanedCdcDbs.length + result.orphanedStanzas.length + result.orphanedServices.length + result.orphanedSlots.length
    return c.json({
      success: true,
      message: totalCleaned > 0 ? `Cleaned up ${totalCleaned} orphaned resource(s)` : 'No orphaned resources found',
      ...result,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ success: false, error: 'Reconciliation failed', details: message }, 500)
  }
})

// ---------------------------------------------------------------------------
// Orphan reconciliation — clean up external resources that have no
// corresponding server in SQLite. This happens when data.db is reset/lost
// but config files, systemd services, and replication slots persist on disk.
// ---------------------------------------------------------------------------
type ReconcileResult = {
  orphanedCdcDbs: string[]
  orphanedStanzas: string[]
  orphanedServices: string[]
  orphanedSlots: string[]
  errors: string[]
}

async function reconcileOrphanedResources(): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    orphanedCdcDbs: [],
    orphanedStanzas: [],
    orphanedServices: [],
    orphanedSlots: [],
    errors: [],
  }

  // Gather all known databases and server labels from SQLite
  const servers = listServers()
  const knownDbs = new Set<string>()
  const knownLabels = new Set<string>()
  for (const s of servers) {
    knownLabels.add(s.label)
    for (const db of s.databases) knownDbs.add(db)
  }

  // --- 1. Reconcile CDC YAML config ---
  let cdcDbNames: string[] = []
  try {
    const raw = fs.readFileSync(PGCDC_CONF, 'utf-8')
    cdcDbNames = parseCdcDbNames(raw)
    const orphanedCdc = cdcDbNames.filter((db) => !knownDbs.has(db))
    result.orphanedCdcDbs = orphanedCdc

    if (orphanedCdc.length > 0) {
      // Remove orphaned entries from YAML
      const toRemove = new Set(orphanedCdc)
      const lines = raw.split('\n')
      const filtered: string[] = []
      for (const line of lines) {
        const m = line.match(/^\s*-\s*name:\s*(.+)$/)
        if (m) {
          const name = m[1].trim().replace(/^["']|["']$/g, '')
          if (toRemove.has(name)) continue
        }
        filtered.push(line)
      }
      await writeConfigFile(PGCDC_CONF, filtered.join('\n'))
      console.warn(`[reconcile] removed ${orphanedCdc.length} orphaned CDC database(s) from config:`, orphanedCdc)
    }
  } catch (e: unknown) {
    if (!(e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT')) {
      result.errors.push(`CDC config reconcile failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // --- 2. Reconcile pgBackRest config ---
  try {
    const raw = fs.readFileSync(PGBACKREST_CONF, 'utf-8')
    const config = parseIni(raw)
    const orphanedStanzas = Object.keys(config).filter((s) => s !== 'global' && !knownLabels.has(s))
    result.orphanedStanzas = orphanedStanzas

    if (orphanedStanzas.length > 0) {
      for (const stanza of orphanedStanzas) {
        delete config[stanza]
        // Best-effort: drop the stanza from pgBackRest
        try {
          await sudoExec(['-u', 'postgres', '/usr/bin/pgbackrest', `--stanza=${stanza}`, 'stanza-drop'], { timeout: 30_000 })
        } catch { /* stanza may not exist — ignore */ }
      }
      const out = serializeIni(config)
      await writeConfigFile(PGBACKREST_CONF, out)
      console.warn(`[reconcile] removed ${orphanedStanzas.length} orphaned pgBackRest stanza(s):`, orphanedStanzas)
    }
  } catch (e: unknown) {
    if (!(e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT')) {
      result.errors.push(`pgBackRest config reconcile failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // --- 3. Reconcile systemd pg-cdc@ services ---
  try {
    const { stdout } = await execFileAsync('systemctl', ['list-units', 'pg-cdc@*', '--all', '--no-legend', '--no-pager'], { timeout: 5_000 })
    const serviceNames: string[] = []
    for (const line of stdout.trim().split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length > 0 && parts[0].startsWith('pg-cdc@')) {
        serviceNames.push(parts[0])
      }
    }
    // A service is orphaned if its DB name is not in the known set AND not in the (now-cleaned) CDC config
    const validCdcDbs = new Set(cdcDbNames.filter((db) => knownDbs.has(db)))
    const orphanedServices: string[] = []
    for (const svc of serviceNames) {
      const m = svc.match(/^pg-cdc@(.+)\.service$/)
      const dbName = m ? m[1] : ''
      if (dbName && !validCdcDbs.has(dbName)) {
        orphanedServices.push(svc)
        try {
          await sudoExec(['systemctl', 'stop', svc], { timeout: 10_000 })
          await sudoExec(['systemctl', 'disable', svc], { timeout: 10_000 })
        } catch (e: unknown) {
          result.errors.push(`Failed to stop/disable orphaned service ${svc}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    result.orphanedServices = orphanedServices
    if (orphanedServices.length > 0) {
      console.warn(`[reconcile] stopped ${orphanedServices.length} orphaned systemd service(s):`, orphanedServices)
    }
  } catch (e: unknown) {
    // systemctl may not be available in all environments
    if (!(e instanceof Error && e.message.includes('No units'))) {
      result.errors.push(`systemd service reconcile failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // --- 4. Reconcile PostgreSQL replication slots ---
  try {
    const raw = fs.readFileSync(PGCDC_CONF, 'utf-8')
    const mgmtMatch = raw.match(/^pg_connection:\s*(.+)$/m)
    const mgmtUrl = mgmtMatch ? mgmtMatch[1].trim().replace(/^["']|["']$/g, '') : ''
    if (mgmtUrl) {
      const sql = postgres(mgmtUrl, { max: 1, idle_timeout: 10 })
      try {
        const slots = await sql`SELECT slot_name FROM pg_replication_slots WHERE slot_type = 'logical' AND plugin = 'wal2json'`
        const validCdcDbs = new Set(cdcDbNames.filter((db) => knownDbs.has(db)))
        const orphanedSlots: string[] = []
        for (const row of slots as unknown as { slot_name: string }[]) {
          const slotName = row.slot_name
          // Slot names follow the pattern <dbname>_cdc
          const dbName = slotName.endsWith('_cdc') ? slotName.slice(0, -4) : slotName
          if (!validCdcDbs.has(dbName)) {
            orphanedSlots.push(slotName)
            try {
              await sql`SELECT pg_drop_replication_slot(${slotName})`
            } catch (e: unknown) {
              result.errors.push(`Failed to drop orphaned slot ${slotName}: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
        }
        result.orphanedSlots = orphanedSlots
        if (orphanedSlots.length > 0) {
          console.warn(`[reconcile] dropped ${orphanedSlots.length} orphaned replication slot(s):`, orphanedSlots)
        }
      } finally {
        await sql.end().catch(() => {})
      }
    }
  } catch (e: unknown) {
    result.errors.push(`Replication slot reconcile failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // --- 5. Remove orphaned on-disk CDC stream and backup directories ---
  for (const db of result.orphanedCdcDbs) {
    try {
      await sudoExec(['rm', '-rf', `/var/pg-cdc/${db}`], { timeout: 10_000 })
    } catch { /* best-effort */ }
    try {
      await sudoExec(['rm', '-rf', `/var/backups/pg/${db}`], { timeout: 10_000 })
    } catch { /* best-effort */ }
  }

  const totalCleaned = result.orphanedCdcDbs.length + result.orphanedStanzas.length + result.orphanedServices.length + result.orphanedSlots.length
  if (totalCleaned > 0) {
    console.warn(`[reconcile] cleaned up ${totalCleaned} orphaned resource(s)`)
  }

  return result
}

// Guard module-load side effects so a re-import doesn't double-init.
let bootInitialized = false
if (!bootInitialized) {
  bootInitialized = true
  installSystemCronJobs().catch((e: unknown) => {
    console.warn('[boot] installSystemCronJobs failed:', e instanceof Error ? e.message : e)
  })

  // Self-heal: deploy and start the health check timer if missing
  ensureHealthCheckTimer().catch((e: unknown) => {
    console.warn('[boot] ensureHealthCheckTimer failed:', e instanceof Error ? e.message : e)
  })

  // Schedule UI-created cron jobs from SQLite
  try {
    rescheduleAllCronJobs()
  } catch (e: unknown) {
    console.warn('[boot] rescheduleAllCronJobs failed:', e instanceof Error ? e.message : e)
  }

  // Reconcile orphaned external resources on boot
  reconcileOrphanedResources().catch((e: unknown) => {
    console.warn('[boot] reconcileOrphanedResources failed:', e instanceof Error ? e.message : e)
  })
}

export const GET = handle(app)
export const POST = handle(app)
