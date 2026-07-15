import { existsSync } from 'fs'
import { execSync } from 'child_process'
import postgres from 'postgres'
import { PgCdcConfig, pgConnectionForDb } from './config.js'

// =============================================================================
// Phase 1: Per-Database Setup (idempotent)
// =============================================================================
//
// For a given DB name:
//   1. Create PUBLICATION <db>_pub FOR ALL TABLES (if not exists)
//   2. Create logical replication slot <db>_cdc (wal2json) (if not exists)
//   3. Create local capture directory /var/pg-cdc/<db>/
//   4. Deploy / enable systemd unit pg-cdc@<db>.service
//   5. Start the capture daemon
// =============================================================================

export interface SetupResult {
  db: string
  publication: 'created' | 'exists'
  slot: 'created' | 'exists'
  directory: 'created' | 'exists'
  systemd: 'enabled_started' | 'enabled' | 'exists'
  warnings: string[]
}

export async function setupDatabase(cfg: PgCdcConfig, dbName: string): Promise<SetupResult> {
  const result: SetupResult = {
    db: dbName,
    publication: 'exists',
    slot: 'exists',
    directory: 'exists',
    systemd: 'exists',
    warnings: [],
  }

  const dbConn = pgConnectionForDb(cfg, dbName)
  const pubName = `${dbName}_pub`
  const slotName = `${dbName}_cdc`

  // ---- 2+3. Connect to the TARGET database for slot + publication ----
  // Slots must be created on the database they capture changes for, and
  // pg_recvlogical must connect to that same database to consume them.
  const sql = postgres(dbConn, { max: 1, idle_timeout: 10 })

  try {
    // Create PUBLICATION if not exists
    const existingPub = await sql`
      SELECT pubname FROM pg_publication WHERE pubname = ${pubName}
    `
    if (existingPub.length === 0) {
      await sql`CREATE PUBLICATION ${sql(pubName)} FOR ALL TABLES`
      result.publication = 'created'
    } else {
      result.publication = 'exists'
    }

    // Create logical replication slot if not exists (on the target database)
    const existingSlot = await sql`
      SELECT slot_name FROM pg_replication_slots WHERE slot_name = ${slotName}
    `
    if (existingSlot.length === 0) {
      await sql`SELECT pg_create_logical_replication_slot(${slotName}, 'wal2json')`
      result.slot = 'created'
    } else {
      result.slot = 'exists'
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Failed to set up replication for "${dbName}": ${msg}\n` +
      `Ensure wal2json is installed and loaded via shared_preload_libraries.`
    )
  } finally {
    await sql.end()
  }

  // ---- 4. Create local capture directory ----
  const capDir = `${cfg.capture_dir}/${dbName}`
  try {
    execSync(`sudo mkdir -p "${capDir}"`, { stdio: 'ignore', timeout: 10000 })
    result.directory = 'created'
  } catch {
    if (existsSync(capDir)) {
      result.directory = 'exists'
    } else {
      throw new Error(`Cannot create directory ${capDir}`)
    }
  }

  // ---- 5. Deploy the capture daemon script if not present ----
  const daemonPath = `${cfg.scripts_dir}/capture-daemon.mjs`
  // The daemon script is deployed manually or via package install.
  // For now, check if it exists and warn if not.
  if (!existsSync(daemonPath)) {
    result.warnings.push(
      `Capture daemon not found at ${daemonPath}. Deploy it before starting the service.`
    )
  }

  // ---- 6. Install and enable systemd unit ----
  const unitName = `pg-cdc@${dbName}.service`
  try {
    // Enable the unit (creates symlink)
    execSync(`sudo systemctl enable ${unitName}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    })
    // Start the unit
    execSync(`sudo systemctl start ${unitName}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
    })
    result.systemd = 'enabled_started'

    // Also enable the rotation timer
    try {
      execSync(`sudo systemctl enable pg-cdc-rotate@${dbName}.timer`, {
        stdio: 'ignore',
        timeout: 10000,
      })
      execSync(`sudo systemctl start pg-cdc-rotate@${dbName}.timer`, {
        stdio: 'ignore',
        timeout: 10000,
      })
    } catch {
      // Timer setup is best-effort
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    // If it's already enabled/started, that's fine
    if (msg.includes('already')) {
      result.systemd = 'exists'
    } else {
      result.warnings.push(`systemd setup warning: ${msg}`)
    }
  }

  return result
}

// =============================================================================
// Teardown
// =============================================================================

export async function teardownDatabase(cfg: PgCdcConfig, dbName: string): Promise<void> {
  const slotName = `${dbName}_cdc`
  const pubName = `${dbName}_pub`
  const unitName = `pg-cdc@${dbName}.service`

  // Stop and disable systemd unit
  try {
    execSync(`sudo systemctl stop ${unitName}`, { stdio: 'ignore', timeout: 15000 })
  } catch { /* best effort */ }
  try {
    execSync(`sudo systemctl disable ${unitName}`, { stdio: 'ignore', timeout: 15000 })
  } catch { /* best effort */ }

  try {
    execSync(`sudo systemctl stop pg-cdc-rotate@${dbName}.timer`, { stdio: 'ignore', timeout: 10000 })
  } catch { /* best effort */ }
  try {
    execSync(`sudo systemctl disable pg-cdc-rotate@${dbName}.timer`, { stdio: 'ignore', timeout: 10000 })
  } catch { /* best effort */ }

  // Drop slot + publication (connect to the target DB — slots are per-DB)
  const dbConn = pgConnectionForDb(cfg, dbName)
  const sql = postgres(dbConn, { max: 1, idle_timeout: 10 })
  try {
    await sql`SELECT pg_drop_replication_slot(${slotName})`
  } catch {
    // Slot may not exist
  }
  try {
    await sql`DROP PUBLICATION IF EXISTS ${sql(pubName)}`
  } finally {
    await sql.end()
  }

  console.log(`Teardown complete for ${dbName}`)
}
