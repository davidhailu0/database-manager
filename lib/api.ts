import type { Backup } from "@/lib/db-context"

export type CronJob = {
  id: string
  name: string
  db: string
  expression: string
  enabled: boolean
  lastRun: string
  nextRun: string
  createdAt?: string
  source: 'pgbackrest' | 'cdc'
}

export type StorageSettings = {
  storagePath: string
  retentionDays: number
}

export type PgBackRestConfig = Record<string, { key: string; value: string }[]>

export type ServerRecord = {
  id: string
  label: string
  connectionUrl: string
  engine: string
  databases: string[]
  sshUser?: string | null
}

/** Client-side check: does the connection URL point to a remote (non-local) host? */
export function isRemoteUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const h = u.hostname.toLowerCase().trim()
    return h !== '' && h !== 'localhost' && h !== '127.0.0.1' && h !== '::1' && h !== '0.0.0.0' && !h.endsWith('.localhost')
  } catch {
    return false
  }
}

export type CdcDbStatus = {
  db: string
  slotName: string
  slotActive: boolean
  lagBytes: number | null
  lagHuman: string
  daemonRunning: boolean
  streamStaleSec: number | null
  lastBaseline: string | null
}

export type CdcStatusResult = {
  success: boolean
  statuses: CdcDbStatus[]
}

const AUTH_TOKEN_KEY = 'db-manager-auth-token'

function authHeaders(extra?: { headers?: Record<string, string> }): { headers: Record<string, string> } {
  const headers: Record<string, string> = { ...extra?.headers }
  // Auto-attach the Bearer token from localStorage if present and not already set.
  // This is client-side only; localStorage is available in the browser.
  if (typeof window !== 'undefined' && !headers.Authorization) {
    try {
      const token = window.localStorage.getItem(AUTH_TOKEN_KEY)
      if (token) headers.Authorization = `Bearer ${token}`
    } catch {
      // localStorage may be unavailable (SSR / restricted env) — skip silently
    }
  }
  return { headers }
}

async function parseResponse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  if (!text) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(
      res.ok
        ? `Invalid JSON response from ${res.url || 'API'}`
        : `Request failed (${res.status}${res.statusText ? ` ${res.statusText}` : ''})`
    )
  }
}

function throwApiError(url: string, res: Response, data: Record<string, unknown>): never {
  const msg = (typeof data.error === 'string' && data.error)
    || (typeof data.message === 'string' && data.message)
    || `Request to ${url} failed`
  const detail = (typeof data.details === 'string' && data.details)
    || (typeof data.note === 'string' && data.note)
    || ''
  // Prefer server error text; append detail when it adds information
  if (detail && detail !== msg) throw new Error(`${msg}: ${detail}`)
  if (!res.ok && msg === `Request to ${url} failed`) {
    throw new Error(`${msg} (${res.status})`)
  }
  throw new Error(msg)
}

async function post<T>(url: string, body?: unknown, extra?: { headers?: Record<string, string> }): Promise<T> {
  const { headers } = authHeaders(extra)
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await parseResponse(res)
  if (!res.ok || data.success === false) {
    throwApiError(url, res, data)
  }
  return data as T
}

async function get<T>(url: string, extra?: { headers?: Record<string, string> }): Promise<T> {
  const { headers } = authHeaders(extra)
  const res = await fetch(url, { headers })
  const data = await parseResponse(res)
  if (!res.ok || data.success === false) {
    throwApiError(url, res, data)
  }
  return data as T
}

// Databases
export async function fetchDatabases(connectionUrl: string): Promise<string[]> {
  const data = await post<{ databases: string[] }>("/api/databases", { connectionUrl })
  return data.databases
}

// Backup
export async function runBackup(stanza: string, type: "Full" | "Incremental") {
  return post<{ id: string; backup: Backup; message: string }>("/api/backup", { stanza, type })
}

// Restore
export async function runRestore(snapshotId: string) {
  return post<{ message: string }>("/api/restore", { snapshotId })
}

// Backups list / delete
export async function listBackups(): Promise<Backup[]> {
  const data = await get<{ backups: Backup[] }>("/api/backups")
  return data.backups
}

export async function deleteBackup(id: string) {
  return post<{ message: string }>("/api/backups/delete", { id })
}

// Cron jobs
export async function listCronJobs(): Promise<CronJob[]> {
  const data = await get<{ jobs: CronJob[] }>("/api/cron")
  return data.jobs
}

/** Create a scheduled job. For pgBackRest, `db` is the stanza (server label); for CDC, `db` is the database name. */
export async function createCronJob(input: {
  name: string
  /** Stanza/server label (pgBackRest) or database name (CDC). Required for both sources. */
  db: string
  expression: string
  enabled?: boolean
  source?: 'pgbackrest' | 'cdc'
}) {
  return post<{ job: CronJob }>("/api/cron", input)
}

export async function updateCronJob(id: string, enabled: boolean) {
  return post<{ job: CronJob }>("/api/cron/update", { id, enabled })
}

export async function deleteCronJob(id: string) {
  return post<{ message: string }>("/api/cron/delete", { id })
}

export async function runCronJobNow(id: string) {
  return post<{ message: string }>("/api/cron/run", { id })
}

// Storage settings
export async function getStorageSettings(): Promise<StorageSettings> {
  return get<StorageSettings>("/api/settings/storage")
}

export async function saveStorageSettings(input: StorageSettings) {
  return post<{ message: string }>("/api/settings/storage", input)
}

// pgBackRest config
export async function getPgBackRestConfig(): Promise<PgBackRestConfig> {
  const data = await get<{ config: PgBackRestConfig }>("/api/settings/pgbackrest")
  return data.config
}

export async function savePgBackRestConfig(config: PgBackRestConfig) {
  return post<{ message: string }>("/api/settings/pgbackrest", { config })
}

export async function stanzaCreate(stanza: string) {
  return post<{ message: string; output: string }>("/api/stanza-create", { stanza })
}

// Servers
export async function listServers(): Promise<ServerRecord[]> {
  const data = await get<{ servers: ServerRecord[] }>("/api/servers")
  return data.servers
}

export async function createServer(label: string, connectionUrl: string, sshUser?: string) {
  return post<{ server: ServerRecord; pgDataDir?: string; stanzaCreated?: boolean; stanzaMessage?: string }>("/api/servers", { label, connectionUrl, sshUser })
}

export async function deleteServer(id: string) {
  return post<{ message: string }>("/api/servers/delete", { id })
}

export async function discoverDatabases(id: string) {
  return post<{ server: ServerRecord }>("/api/servers/discover", { id })
}

// pg-cdc
export async function getCdcStatus(): Promise<CdcDbStatus[]> {
  const data = await get<CdcStatusResult>("/api/cdc/status")
  return data.statuses
}

export async function setupCdcForDb(dbName: string) {
  return post<{ message: string; output: string }>("/api/cdc/setup", { dbName })
}

export async function startCdcDaemon(dbName: string) {
  return post<{ message: string }>("/api/cdc/start-daemon", { dbName })
}

export async function runCdcBackup(dbName: string) {
  return post<{ id: string; backup: Backup; message: string; output: string }>("/api/cdc/backup", { dbName })
}

export async function runCdcRestore(sourceDb: string, targetDb: string, toTimestamp?: string, forceProduction?: boolean) {
  return post<{ message: string; output: string; toTimestamp?: string }>("/api/cdc/restore", { sourceDb, targetDb, toTimestamp, forceProduction })
}

export type HealthCheckpoint = {
  id: string
  db: string
  timestamp: string
  walLsn: string
  status: 'healthy' | 'degraded'
  createdAt: string
}

export async function runHealthCheck() {
  return post<{ success: boolean; allHealthy: boolean; checks: { db: string; healthy: boolean; walLsn: string; detail: string }[]; checkpoints: HealthCheckpoint[]; message: string }>("/api/cdc/health-check")
}

export async function getHealthCheckpoints(db?: string): Promise<HealthCheckpoint[]> {
  const qs = db ? `?db=${encodeURIComponent(db)}` : ''
  const data = await get<{ checkpoints: HealthCheckpoint[] }>(`/api/cdc/health-checkpoints${qs}`)
  return data.checkpoints
}

// Auth
export type AppUser = {
  id: string
  email: string
  employeeId: string
  displayName: string
  samAccountName: string
  department: string
  title: string
  role: 'admin' | 'operator' | 'viewer'
  allowedPages: string[]
  allowedActions: string[]
  createdAt: string
}

export type LoginResult = {
  token: string
  user: AppUser
  message: string
}

export async function login(username: string, password: string): Promise<LoginResult> {
  return post<LoginResult>("/api/auth/login", { username, password })
}

export async function logout() {
  return post<{ message: string }>("/api/auth/logout")
}

export async function getCurrentUser(token: string): Promise<AppUser> {
  const data = await get<{ user: AppUser }>("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
  return data.user
}

export async function listUsers(token: string): Promise<AppUser[]> {
  const data = await get<{ users: AppUser[] }>("/api/users", { headers: { Authorization: `Bearer ${token}` } })
  return data.users
}

export async function createUser(token: string, input: {
  email: string
  samAccountName: string
  displayName?: string
  department?: string
  title?: string
  role?: string
  allowedPages?: string[]
  allowedActions?: string[]
}) {
  return post<{ user: AppUser; message: string }>("/api/users", input, { headers: { Authorization: `Bearer ${token}` } })
}

export async function updateUser(token: string, input: {
  id: string
  role?: string
  allowedPages?: string[]
  allowedActions?: string[]
  displayName?: string
  department?: string
  title?: string
}) {
  return post<{ user: AppUser; message: string }>("/api/users/update", input, { headers: { Authorization: `Bearer ${token}` } })
}

export async function deleteUser(token: string, id: string) {
  return post<{ message: string }>("/api/users/delete", { id }, { headers: { Authorization: `Bearer ${token}` } })
}

// System — reconciliation
export async function reconcileOrphanedResources(token: string) {
  return post<{ message: string; orphanedCdcDbs: string[]; orphanedStanzas: string[]; orphanedServices: string[]; orphanedSlots: string[]; errors: string[] }>("/api/system/reconcile", {}, { headers: { Authorization: `Bearer ${token}` } })
}
