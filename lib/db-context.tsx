"use client"

import * as React from "react"
import { listBackups as apiListBackups, getStorageSettings as apiGetStorageSettings, listServers, getCdcStatus, setupCdcForDb as apiSetupCdcForDb, listDbConfigs as apiListDbConfigs } from "@/lib/api"
import type { ServerRecord, CdcDbStatus, DbConfig } from "@/lib/api"
import { useAuth } from "@/lib/auth-context"

export type Backup = {
  id: string
  db: string
  type: "Full" | "Incremental"
  size: string
  createdAt: string
  status: "Completed" | "Running" | "Failed"
  source: "pgbackrest" | "cdc"
}

type DbContextValue = {
  servers: ServerRecord[]
  backups: Backup[]
  storagePath: string
  retentionDays: number
  dbConfigs: DbConfig[]
  addBackup: (backup: Backup) => void
  updateBackup: (id: string, updates: Partial<Backup>) => void
  deleteBackup: (id: string) => void
  refreshBackups: () => Promise<void>
  refreshStorageSettings: () => Promise<void>
  refreshServers: () => Promise<void>
  refreshDbConfigs: () => Promise<void>
  isRestoring: boolean
  setIsRestoring: (v: boolean) => void
  setStoragePath: (path: string) => void
  setRetentionDays: (days: number) => void
  cdcStatuses: CdcDbStatus[]
  refreshCdcStatus: () => Promise<void>
  setupCdc: (dbName: string) => Promise<void>
}

const BACKUPS_KEY = "db-manager-backups"
const STORAGE_PATH_KEY = "db-manager-storage-path"
const RETENTION_KEY = "db-manager-retention"

function readStoredBackups(): Backup[] {
  if (typeof window === "undefined") return []
  const saved = localStorage.getItem(BACKUPS_KEY)
  if (!saved) return []
  try {
    return JSON.parse(saved)
  } catch {
    return []
  }
}

function readStoredPath(): string {
  if (typeof window === "undefined") return "/var/backups/db"
  return localStorage.getItem(STORAGE_PATH_KEY) ?? "/var/backups/db"
}

function readStoredRetention(): number {
  if (typeof window === "undefined") return 30
  const raw = localStorage.getItem(RETENTION_KEY)
  return raw ? Number(raw) || 30 : 30
}

const DbContext = React.createContext<DbContextValue | null>(null)

export function DbProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth()
  const [backups, setBackups] = React.useState<Backup[]>([])
  const [isRestoring, setIsRestoring] = React.useState(false)
  const [storagePath, setStoragePath] = React.useState('/var/backups/db')
  const [retentionDays, setRetentionDays] = React.useState(30)
  const [servers, setServers] = React.useState<ServerRecord[]>([])
  const [cdcStatuses, setCdcStatuses] = React.useState<CdcDbStatus[]>([])
  const [dbConfigs, setDbConfigs] = React.useState<DbConfig[]>([])
  const skipBackupsSave = React.useRef(true)

  const refreshBackups = React.useCallback(async () => {
    try {
      const api = await apiListBackups()
      setBackups(api)
    } catch {
      const stored = readStoredBackups()
      setBackups(stored)
    }
  }, [])

  const refreshStorageSettings = React.useCallback(async () => {
    try {
      const api = await apiGetStorageSettings()
      setStoragePath(api.storagePath)
      setRetentionDays(api.retentionDays)
    } catch {
      // fall back to localStorage
    }
  }, [])

  const refreshServers = React.useCallback(async () => {
    try {
      const api = await listServers()
      setServers(api)
    } catch {
      setServers([])
    }
  }, [])

  const refreshCdcStatus = React.useCallback(async () => {
    try {
      const api = await getCdcStatus()
      setCdcStatuses(api)
    } catch {
      setCdcStatuses([])
    }
  }, [])

  const refreshDbConfigs = React.useCallback(async () => {
    try {
      const api = await apiListDbConfigs()
      setDbConfigs(api)
    } catch {
      setDbConfigs([])
    }
  }, [])

  const setupCdc = React.useCallback(async (dbName: string) => {
    await apiSetupCdcForDb(dbName)
    await refreshCdcStatus()
  }, [refreshCdcStatus])

  React.useEffect(() => {
    setStoragePath(readStoredPath())
    setRetentionDays(readStoredRetention())
    const stored = readStoredBackups()
    setBackups(stored)
    refreshStorageSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  React.useEffect(() => {
    if (!token) return
    refreshServers()
    refreshBackups()
    refreshCdcStatus()
    refreshDbConfigs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  React.useEffect(() => {
    if (skipBackupsSave.current) {
      skipBackupsSave.current = false
      return
    }
    localStorage.setItem(BACKUPS_KEY, JSON.stringify(backups))
  }, [backups])

  React.useEffect(() => {
    localStorage.setItem(STORAGE_PATH_KEY, storagePath)
  }, [storagePath])

  React.useEffect(() => {
    localStorage.setItem(RETENTION_KEY, String(retentionDays))
  }, [retentionDays])

  const addBackup = React.useCallback((backup: Backup) => setBackups((prev) => [backup, ...prev]), [])
  const updateBackup = React.useCallback((id: string, updates: Partial<Backup>) =>
    setBackups((prev) => prev.map((b) => b.id === id ? { ...b, ...updates } : b)),
  [])
  const deleteBackup = React.useCallback((id: string) =>
    setBackups((prev) => prev.filter((b) => b.id !== id)),
  [])

  return (
    <DbContext.Provider value={{
      servers, backups, storagePath, retentionDays, dbConfigs,
      addBackup, updateBackup, deleteBackup,
      refreshBackups, refreshStorageSettings, refreshServers, refreshDbConfigs,
      isRestoring, setIsRestoring,
      setStoragePath, setRetentionDays,
      cdcStatuses, refreshCdcStatus, setupCdc,
    }}>
      {children}
    </DbContext.Provider>
  )
}

export function useDb() {
  const ctx = React.useContext(DbContext)
  if (!ctx) throw new Error("useDb must be used within DbProvider")
  return ctx
}
