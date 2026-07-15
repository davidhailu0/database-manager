#!/usr/bin/env node

// =============================================================================
// pg-cdc capture daemon
// =============================================================================
//
// Reads JSONL from pg_recvlogical stdout and writes to rotating files with
// crash-safe semantics.
//
// Usage:
//   capture-daemon.mjs <dbname>
//
// Environment (via pg-cdc.env):
//   PGCDC_CONNECTION_STRING  — connection URI for the target DB
//   PGCDC_CAPTURE_DIR        — base capture directory
//   PGCDC_PG_BIN             — optional PostgreSQL bin directory
// =============================================================================

import { createWriteStream, renameSync, statSync, existsSync, mkdirSync, accessSync } from 'fs'
import { spawn, execFileSync } from 'child_process'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DB = process.argv[2]
if (!DB) {
  console.error('Usage: capture-daemon.mjs <dbname>')
  process.exit(1)
}

const CONN_STRING = process.env.PGCDC_CONNECTION_STRING
if (!CONN_STRING) {
  console.error('PGCDC_CONNECTION_STRING env var is required')
  process.exit(1)
}

// Derive per-DB connection by replacing the database name in the URI
// e.g. postgresql://user:pass@host:5432/postgres → postgresql://user:pass@host:5432/<DB>
function dbConnection(dbName) {
  return CONN_STRING.replace(/\/[^/]*$/, '/' + dbName)
}

const CAPTURE_DIR = process.env.PGCDC_CAPTURE_DIR || '/var/pg-cdc'
const DB_DIR = resolve(CAPTURE_DIR, DB)
const STREAM_FILE = resolve(DB_DIR, 'stream_current.jsonl')
const SLOT_NAME = `${DB}_cdc`
const ROTATE_INTERVAL_MS = 3600_000  // 1 hour
const STATS_INTERVAL_MS = 60_000     // Log stats every 60s

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentStream = null       // write stream handle
let currentStreamPath = ''     // path of current stream file
let bytesWritten = 0
let eventsWritten = 0
let rotationTimer = null
let statsTimer = null
let shuttingDown = false

// ---------------------------------------------------------------------------
// Logger (writes to stderr so pipe stays clean for JSONL)
// ---------------------------------------------------------------------------
function log(level, msg) {
  const ts = new Date().toISOString()
  console.error(`[${ts}] [${level}] [${DB}] ${msg}`)
}

// ---------------------------------------------------------------------------
// Stream management
// ---------------------------------------------------------------------------
function openStream(filePath) {
  if (currentStream) {
    try { currentStream.end() } catch {}
  }

  // Create parent dir if needed (should already exist from setup)
  mkdirSync(dirname(filePath), { recursive: true })

  currentStream = createWriteStream(filePath, { flags: 'a' })
  currentStreamPath = filePath

  currentStream.on('error', (err) => {
    log('ERROR', `Write error on ${filePath}: ${err.message}`)
  })

  return currentStream
}

function rotate() {
  if (shuttingDown) return

  const now = new Date()
  const ts = now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') + '_' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0')
  const archiveName = `stream_${ts}.jsonl`
  const archivePath = resolve(DB_DIR, archiveName)

  // Close current stream
  const oldStream = currentStream
  currentStream = null

  // Rename current file to archive name (atomic on same filesystem)
  // If stream_current.jsonl doesn't exist yet (empty), that's fine — skip rename
  if (existsSync(STREAM_FILE)) {
    renameSync(STREAM_FILE, archivePath)
    log('INFO', `Rotated: ${STREAM_FILE} → ${archiveName}`)
  }

  // Open a new stream_current.jsonl
  openStream(STREAM_FILE)
}

// ---------------------------------------------------------------------------
// Crash recovery: on startup, if stream_current.jsonl exists, it may contain
// data that was being written when the process died. We keep it and append —
// the slot's confirmed_flush_lsn ensures pg_recvlogical won't replay old data.
// ---------------------------------------------------------------------------
function recoverStream() {
  if (existsSync(STREAM_FILE)) {
    const st = statSync(STREAM_FILE)
    if (st.size > 0) {
      log('INFO', `Recovered existing stream file (${st.size} bytes), will append`)
    }
  }
  openStream(STREAM_FILE)
}

// ---------------------------------------------------------------------------
// Find pg_recvlogical binary
// ---------------------------------------------------------------------------
function findPgRecvlogical() {
  const hint = process.env.PGCDC_PG_BIN
  if (hint) {
    const candidate = resolve(hint, 'pg_recvlogical')
    try { accessSync(candidate, 0o111); return candidate } catch {}
  }
  const candidates = [
    '/usr/lib/postgresql/16/bin/pg_recvlogical',
    '/usr/lib/postgresql/15/bin/pg_recvlogical',
    '/usr/lib/postgresql/14/bin/pg_recvlogical',
    '/usr/lib/postgresql/17/bin/pg_recvlogical',
    '/usr/pgsql-16/bin/pg_recvlogical',
    '/usr/pgsql-15/bin/pg_recvlogical',
    '/usr/pgsql-14/bin/pg_recvlogical',
    '/usr/pgsql-17/bin/pg_recvlogical',
  ]
  for (const p of candidates) {
    try { accessSync(p, 0o111); return p } catch {}
  }
  // Fallback — rely on PATH (may work if postgres user profile sets it)
  return 'pg_recvlogical'
}

let PG_RECVLOGICAL_PATH

// ---------------------------------------------------------------------------
// Main capture loop: spawn pg_recvlogical and pipe through
// ---------------------------------------------------------------------------
function startCapture() {
  if (!PG_RECVLOGICAL_PATH) {
    PG_RECVLOGICAL_PATH = findPgRecvlogical()
    log('INFO', `Using pg_recvlogical at ${PG_RECVLOGICAL_PATH}`)
  }

  // Self-heal: ensure publication and slot exist before each start attempt
  ensureSlot()

  const pgArgs = [
    '--dbname=' + dbConnection(DB),
    '--slot=' + SLOT_NAME,
    '--start',
    '--file=-',
    '--option=pretty-print=1',
    '--option=include-timestamp=1',
    '--option=include-xids=1',
    '--option=include-type-oids=1',
  ]

  log('INFO', `Starting pg_recvlogical for slot ${SLOT_NAME}`)

  const pgRecv = spawn(PG_RECVLOGICAL_PATH, pgArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  pgRecv.stdout.on('data', (chunk) => {
    if (currentStream && currentStream.writable) {
      currentStream.write(chunk)
      // Count newlines = approximate events
      const newlines = chunk.toString().split('\n').length - 1
      eventsWritten += newlines
      bytesWritten += chunk.length
    }
  })

  pgRecv.stderr.on('data', (chunk) => {
    log('STDERR', chunk.toString().trim())
  })

  pgRecv.on('error', (err) => {
    log('ERROR', `pg_recvlogical error: ${err.message}`)
    scheduleRestart()
  })

  pgRecv.on('exit', (code, signal) => {
    log('WARN', `pg_recvlogical exited (code=${code}, signal=${signal})`)
    if (!shuttingDown) {
      scheduleRestart()
    }
  })

  return pgRecv
}

let currentChild = null
let restartTimer = null

function scheduleRestart() {
  if (shuttingDown) return
  if (restartTimer) clearTimeout(restartTimer)
  log('INFO', 'Restarting pg_recvlogical in 2s...')
  restartTimer = setTimeout(() => {
    if (!shuttingDown) {
      currentChild = startCapture()
    }
  }, 2000)
}

// ---------------------------------------------------------------------------
// Stats logging
// ---------------------------------------------------------------------------
function logStats() {
  log('INFO', `Stats: ${eventsWritten} events, ${(bytesWritten / 1024 / 1024).toFixed(2)} MB written`)
}

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true

  log('INFO', 'Shutting down...')

  if (rotationTimer) clearInterval(rotationTimer)
  if (statsTimer) clearInterval(statsTimer)
  if (restartTimer) clearTimeout(restartTimer)

  // Do a final rotation
  try { rotate() } catch {}

  // Kill pg_recvlogical
  if (currentChild) {
    currentChild.kill('SIGTERM')
    // Give it 5s to exit gracefully, then SIGKILL
    setTimeout(() => {
      try { currentChild.kill('SIGKILL') } catch {}
      process.exit(0)
    }, 5000)
  } else {
    process.exit(0)
  }
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGHUP', () => {
  log('INFO', 'SIGHUP received — rotating stream')
  rotate()
})

// ---------------------------------------------------------------------------
// Slot self-healing: create publication + slot if missing
// ---------------------------------------------------------------------------
function ensureSlot() {
  const conn = dbConnection(DB)
  const pubName = `${DB}_pub`

  log('INFO', `Ensuring publication (${pubName}) and slot (${SLOT_NAME}) exist...`)

  // Create publication if not exists
  try {
    execFileSync('psql', [conn, '-c', `CREATE PUBLICATION "${pubName}" FOR ALL TABLES`], {
      stdio: 'pipe', timeout: 10000, env: { ...process.env },
    })
    log('INFO', `Publication ${pubName} created`)
  } catch (err) {
    const msg = err.stderr?.toString?.() || err.message || String(err)
    if (msg.includes('already exists')) {
      log('INFO', `Publication ${pubName} already exists`)
    } else {
      log('WARN', `Failed to create publication ${pubName}: ${msg}`)
    }
  }

  // Create logical replication slot if not exists
  try {
    execFileSync('psql', [conn, '-c', `SELECT pg_create_logical_replication_slot('${SLOT_NAME}', 'wal2json')`], {
      stdio: 'pipe', timeout: 10000, env: { ...process.env },
    })
    log('INFO', `Slot ${SLOT_NAME} created`)
  } catch (err) {
    const msg = err.stderr?.toString?.() || err.message || String(err)
    if (msg.includes('already exists')) {
      log('INFO', `Slot ${SLOT_NAME} already exists`)
    } else {
      log('WARN', `Failed to create slot ${SLOT_NAME}: ${msg}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
recoverStream()

// Start the capture (ensureSlot is called inside startCapture before each attempt)
currentChild = startCapture()

// Schedule periodic rotation
rotationTimer = setInterval(rotate, ROTATE_INTERVAL_MS)

// Schedule stats logging
statsTimer = setInterval(logStats, STATS_INTERVAL_MS)

log('INFO', `Daemon started for ${DB}, writing to ${STREAM_FILE}`)
