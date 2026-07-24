"use client"

import * as React from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import {
  DatabaseIcon,
  HardDriveDownloadIcon,
  RefreshCwIcon,
  Trash2Icon,
  Loader2Icon,
  SettingsIcon,
  CheckCircle2Icon,
  XCircleIcon,
  AlertCircleIcon,
  HardDriveUploadIcon,
  ArrowLeftIcon,
  ActivityIcon,
  RadioIcon,
} from "lucide-react"
import { toast } from "sonner"

import { AppShell } from "@/components/app-shell"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { useDb } from "@/lib/db-context"
import type { Backup } from "@/lib/db-context"
import {
  runCdcBackup,
  deleteBackup as apiDeleteBackup,
  startCdcDaemon,
} from "@/lib/api"
import { DatabaseConfigDialog } from "@/components/database-config-dialog"
import { RestoreDialog } from "@/components/restore-dialog"
import type { DbConfig } from "@/lib/api"

type HealthStatus = "healthy" | "degraded" | "unprotected" | "unknown"

function healthInfo(status: HealthStatus): {
  label: string
  icon: React.ComponentType<{ className?: string }>
  color: string
  badge: string
} {
  switch (status) {
    case "healthy":
      return { label: "Healthy", icon: CheckCircle2Icon, color: "text-emerald-600", badge: "bg-emerald-50 text-emerald-700 border-emerald-200" }
    case "degraded":
      return { label: "Degraded", icon: AlertCircleIcon, color: "text-amber-600", badge: "bg-amber-50 text-amber-700 border-amber-200" }
    case "unprotected":
      return { label: "Not protected", icon: XCircleIcon, color: "text-muted-foreground", badge: "bg-muted text-muted-foreground" }
    default:
      return { label: "Unknown", icon: ActivityIcon, color: "text-muted-foreground", badge: "bg-muted text-muted-foreground" }
  }
}

function StatusBadge({ status }: { status: string }) {
  if (status === "Completed")
    return <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">Completed</Badge>
  if (status === "Running")
    return <Badge variant="secondary" className="bg-blue-50 text-blue-700 border-blue-200">Running</Badge>
  return <Badge variant="destructive">Failed</Badge>
}

export default function DatabaseDetailPage() {
  const params = useParams<{ db: string }>()
  const dbName = decodeURIComponent(params.db)

  const {
    servers,
    backups,
    cdcStatuses,
    dbConfigs,
    loading,
    addBackup,
    deleteBackup,
    refreshBackups,
    refreshCdcStatus,
    refreshDbConfigs,
    setupCdc,
  } = useDb()

  const [configDialogOpen, setConfigDialogOpen] = React.useState(false)
  const [restoreBackup, setRestoreBackup] = React.useState<Backup | null>(null)
  const [restoreDialogOpen, setRestoreDialogOpen] = React.useState(false)
  const [isBackingUp, setIsBackingUp] = React.useState(false)
  const [isStartingDaemon, setIsStartingDaemon] = React.useState(false)
  const [isSettingUpCdc, setIsSettingUpCdc] = React.useState(false)

  const cdcDbSet = React.useMemo(() => new Set(cdcStatuses.map((s) => s.db)), [cdcStatuses])
  const configMap = React.useMemo(() => new Map(dbConfigs.map((c) => [c.db, c])), [dbConfigs])

  const cdcStatus = cdcStatuses.find((s) => s.db === dbName)
  const config: DbConfig | null = configMap.get(dbName) ?? null

  const health: HealthStatus = cdcStatus
    ? (cdcStatus.daemonRunning && cdcStatus.slotActive ? "healthy" : "degraded")
    : "unprotected"

  const dbBackups = React.useMemo(() => {
    return backups
      .filter((b) => b.db === dbName && b.source === "cdc")
      .sort((a, b) => {
        const ta = new Date(a.createdAtIso ?? a.createdAt).getTime()
        const tb = new Date(b.createdAtIso ?? b.createdAt).getTime()
        return (isNaN(tb) ? 0 : tb) - (isNaN(ta) ? 0 : ta)
      })
  }, [backups, dbName])

  const server = servers.find((s) => s.databases.includes(dbName))

  async function handleBackupNow() {
    if (!dbName) return
    setIsBackingUp(true)

    const placeholderId = "cdc_" + (crypto.randomUUID?.() ?? Math.random().toString(16).slice(2, 10))
    addBackup({
      id: placeholderId,
      db: dbName,
      type: "Full",
      size: "\u2014",
      createdAt: "Just now",
      status: "Running",
      source: "cdc",
    })

    try {
      const result = await runCdcBackup(dbName)
      deleteBackup(placeholderId)
      addBackup({
        id: result.id,
        db: result.backup.db ?? dbName,
        type: result.backup.type ?? "Full",
        size: result.backup.size,
        createdAt: result.backup.createdAt ?? "Just now",
        status: result.backup.status ?? "Completed",
        source: result.backup.source ?? "cdc",
      })
      toast.success(`Backup completed for "${dbName}"`, {
        description: result.message,
      })
      refreshCdcStatus()
      await refreshBackups()
      await refreshDbConfigs()
    } catch (err) {
      deleteBackup(placeholderId)
      await refreshBackups().catch(() => {})
      toast.error("Backup failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsBackingUp(false)
    }
  }

  async function handleDeleteBackup(id: string) {
    try {
      await apiDeleteBackup(id)
      deleteBackup(id)
      toast.success(`Backup ${id} deleted`)
    } catch (err) {
      toast.error("Failed to delete backup", {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function handleStartDaemon() {
    setIsStartingDaemon(true)
    try {
      await startCdcDaemon(dbName)
      toast.success(`Daemon started for "${dbName}"`)
      refreshCdcStatus()
    } catch (err) {
      toast.error("Failed to start daemon", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsStartingDaemon(false)
    }
  }

  async function handleSetupCdc() {
    setIsSettingUpCdc(true)
    try {
      await setupCdc(dbName)
      toast.success(`CDC protection enabled for "${dbName}"`)
      refreshCdcStatus()
    } catch (err) {
      toast.error("CDC setup failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsSettingUpCdc(false)
    }
  }

  function openRestoreDialog(backup: Backup) {
    setRestoreBackup(backup)
    setRestoreDialogOpen(true)
  }

  const info = healthInfo(health)
  const HealthIcon = info.icon

  return (
    <AppShell>
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" nativeButton={false} render={<Link href="/databases" />}>
              <ArrowLeftIcon className="size-4" />
            </Button>
            <div className="flex items-center gap-2">
              <div className="flex size-9 items-center justify-center rounded-md bg-primary/10">
                <DatabaseIcon className="size-4 text-primary" />
              </div>
              <div className="flex flex-col">
                <h2 className="text-lg font-semibold tracking-tight font-mono">{dbName}</h2>
                <span className="text-xs text-muted-foreground">
                  {server?.label ?? "Unknown server"} &middot; {server?.engine ?? "PostgreSQL"}
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => {
              toast.info("Refreshing\u2026")
              refreshBackups()
              refreshCdcStatus()
              refreshDbConfigs()
            }}>
              <RefreshCwIcon className="mr-1.5 size-3.5" />
              Refresh
            </Button>
          </div>
        </div>

        {/* Status cards */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="shadow-none">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <span className="text-xs font-medium text-muted-foreground">Health</span>
              <HealthIcon className={`size-4 ${info.color}`} />
            </CardHeader>
            <CardContent>
              <span className={`text-sm font-medium ${info.color}`}>{info.label}</span>
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <span className="text-xs font-medium text-muted-foreground">Backups</span>
              <HardDriveDownloadIcon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <span className="text-sm font-medium">{dbBackups.length}</span>
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <span className="text-xs font-medium text-muted-foreground">Config</span>
              <SettingsIcon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {config ? (
                <Badge variant="outline" className="text-xs gap-1">
                  <CheckCircle2Icon className="size-3 text-emerald-500" />
                  Configured
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs text-muted-foreground">
                  Not configured
                </Badge>
              )}
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <span className="text-xs font-medium text-muted-foreground">Schedule</span>
              <RadioIcon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <span className="text-xs font-mono font-medium">
                {config ? config.scheduleCron : "—"}
              </span>
            </CardContent>
          </Card>
        </div>

        {/* CDC details */}
        {cdcStatus && (
          <Card className="shadow-none">
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <span className="text-xs font-medium text-muted-foreground">Replication status</span>
              <RadioIcon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                <span className="text-muted-foreground">Replication slot</span>
                <span className={`font-medium ${cdcStatus.slotActive ? "text-emerald-600" : "text-red-600"}`}>
                  {cdcStatus.slotName} ({cdcStatus.slotActive ? "Active" : "Inactive"})
                </span>
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                <span className="text-muted-foreground">Daemon</span>
                <span className={`font-medium ${cdcStatus.daemonRunning ? "text-emerald-600" : "text-red-600"}`}>
                  {cdcStatus.daemonRunning ? "Running" : "Stopped"}
                </span>
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                <span className="text-muted-foreground">Lag</span>
                <span className="font-medium">{cdcStatus.lagHuman}</span>
              </div>
              {cdcStatus.lastBaseline && (
                <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                  <span className="text-muted-foreground">Last baseline</span>
                  <span className="font-medium">{new Date(cdcStatus.lastBaseline).toLocaleString()}</span>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={handleBackupNow} disabled={isBackingUp}>
            {isBackingUp ? (
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <HardDriveDownloadIcon className="mr-1.5 size-3.5" />
            )}
            Backup now
          </Button>
          <Button variant="outline" size="sm" onClick={() => setConfigDialogOpen(true)}>
            <SettingsIcon className="mr-1.5 size-3.5" />
            {config ? "Edit configuration" : "Configure"}
          </Button>
          {cdcStatus && !cdcStatus.daemonRunning && (
            <Button variant="outline" size="sm" onClick={handleStartDaemon} disabled={isStartingDaemon}>
              {isStartingDaemon ? (
                <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
              ) : null}
              {isStartingDaemon ? "Starting\u2026" : "Start daemon"}
            </Button>
          )}
          {!cdcDbSet.has(dbName) && (
            <Button variant="outline" size="sm" onClick={handleSetupCdc} disabled={isSettingUpCdc}>
              {isSettingUpCdc ? (
                <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
              ) : null}
              {isSettingUpCdc ? "Enabling\u2026" : "Enable CDC"}
            </Button>
          )}
        </div>

        {/* No config prompt */}
        {!config && (
          <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs text-blue-800">
            <AlertCircleIcon className="size-3.5 shrink-0 mt-0.5" />
            <span>
              No backup configuration set for this database.
              Click <strong>Configure</strong> to set a destination path, schedule, and retention policy.
            </span>
          </div>
        )}

        {/* Backups table */}
        <Card className="shadow-none">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle className="text-sm font-semibold">Backups</CardTitle>
            <span className="text-xs text-muted-foreground">
              {dbBackups.length} total
            </span>
          </CardHeader>
          <CardContent className="px-0">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" />
                Loading backups…
              </div>
            ) : dbBackups.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
                <HardDriveDownloadIcon className="size-8" />
                <span>No backups yet. Click &quot;Backup now&quot; to create one.</span>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">Snapshot</TableHead>
                    <TableHead className="text-xs">Size</TableHead>
                    <TableHead className="text-xs">Created</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dbBackups.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="font-mono text-xs">{b.id}</TableCell>
                    <TableCell className="text-xs">{b.size}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{b.createdAt}</TableCell>
                    <TableCell><StatusBadge status={b.status} /></TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {b.status === "Completed" && (
                          <Button variant="ghost" size="xs" onClick={() => openRestoreDialog(b)}>
                            <HardDriveUploadIcon className="size-3.5" />
                            Restore
                          </Button>
                        )}
                        <AlertDialog>
                          <AlertDialogTrigger render={<Button variant="ghost" size="icon-xs" />}>
                            <Trash2Icon className="size-3.5" />
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete {b.id}?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This backup will be permanently removed.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => handleDeleteBackup(b.id)}>
                                Delete
                            </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </TableCell>
                  </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Config dialog (centered modal) */}
      <DatabaseConfigDialog
        dbName={dbName}
        config={config}
        open={configDialogOpen}
        onOpenChange={setConfigDialogOpen}
        onSaved={() => {
          refreshDbConfigs()
        }}
      />

      {/* Restore dialog */}
      <RestoreDialog
        backup={restoreBackup}
        open={restoreDialogOpen}
        onOpenChange={setRestoreDialogOpen}
        onRestored={() => {
          refreshBackups()
          refreshCdcStatus()
        }}
      />
    </AppShell>
  )
}
