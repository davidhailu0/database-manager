"use client"

import * as React from "react"
import {
  HardDriveDownloadIcon,
  RefreshCwIcon,
  Trash2Icon,
  Loader2Icon,
  Link2Icon,
  FolderIcon,
  ServerIcon,
  DatabaseIcon,
  RadioIcon,
} from "lucide-react"
import { toast } from "sonner"

import { AppShell } from "@/components/app-shell"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { useDb } from "@/lib/db-context"
import { runBackup as apiRunBackup, deleteBackup as apiDeleteBackup, runCdcBackup, startCdcDaemon } from "@/lib/api"

function StatusBadge({ status }: { status: string }) {
  if (status === "Completed")
    return <Badge variant="secondary" className="mx-auto bg-emerald-50 text-emerald-700 border-emerald-200">Completed</Badge>
  if (status === "Running")
    return <Badge variant="secondary" className="mx-auto bg-blue-50 text-blue-700 border-blue-200">Running</Badge>
  return <Badge variant="destructive" className="mx-auto">Failed</Badge>
}

export default function BackupPage() {
  const { servers, backups, storagePath, retentionDays, cdcStatuses, addBackup, deleteBackup, refreshBackups, refreshCdcStatus } = useDb()
  const [mode, setMode] = React.useState<"pgbackrest" | "cdc">("pgbackrest")
  const [selectedServerId, setSelectedServerId] = React.useState<string>("")
  const [selectedDb, setSelectedDb] = React.useState<string>("")
  const [backupType, setBackupType] = React.useState<"Full" | "Incremental">("Full")
  const [isBackingUp, setIsBackingUp] = React.useState(false)
  const [progress, setProgress] = React.useState(0)

  const selectedServer = servers.find((s) => s.id === selectedServerId)
  const stanza = selectedServer?.label || ""

  const availableDbs = selectedServer?.databases || []

  React.useEffect(() => {
    if (servers.length > 0 && !selectedServerId) {
      setSelectedServerId(servers[0].id)
    }
  }, [servers, selectedServerId])

  React.useEffect(() => {
    if (availableDbs.length > 0 && !selectedDb) {
      setSelectedDb(availableDbs[0])
    }
  }, [availableDbs, selectedDb])

  async function runBackup(targetStanza?: string, type?: "Full" | "Incremental") {
    const s = targetStanza || stanza
    const t = type || backupType
    if (!s) {
      toast.error("No server selected")
      return
    }
    setIsBackingUp(true)
    setProgress(0)

    const placeholderId = "bkp_" + Math.random().toString(16).slice(2, 6)
    addBackup({
      id: placeholderId,
      db: s,
      type: t,
      size: "\u2014",
      createdAt: "Just now",
      status: "Running",
      source: "pgbackrest",
    })

    try {
      const result = await apiRunBackup(s, t)

      // Replace placeholder with the server-issued record
      deleteBackup(placeholderId)
      addBackup({
        id: result.id,
        db: result.backup.db ?? s,
        type: result.backup.type ?? t,
        size: result.backup.size,
        createdAt: result.backup.createdAt ?? "Just now",
        status: result.backup.status ?? "Completed",
        source: result.backup.source ?? "pgbackrest",
      })

      for (let p = 10; p <= 100; p += 10) {
        await new Promise((r) => setTimeout(r, 40))
        setProgress(p)
      }

      toast.success(`Backup ${result.id} completed`, {
        description: `${t} backup of stanza "${s}"`,
      })
      await refreshBackups()
    } catch (err) {
      // Drop local placeholder and reload so the server-side Failed row (if any) is shown
      deleteBackup(placeholderId)
      await refreshBackups().catch(() => {})
      toast.error("Backup failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsBackingUp(false)
    }
  }

  async function runCdcBackupForDb(dbName: string) {
    if (!dbName) {
      toast.error("No database selected")
      return
    }
    setIsBackingUp(true)
    setProgress(0)

    const placeholderId = "cdc_" + Math.random().toString(16).slice(2, 6)
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
      setProgress(100)
      toast.success(`CDC baseline backup for "${dbName}" completed`, {
        description: result.message,
      })
      refreshCdcStatus()
      await refreshBackups()
    } catch (err) {
      deleteBackup(placeholderId)
      await refreshBackups().catch(() => {})
      toast.error("CDC backup failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsBackingUp(false)
    }
  }

  const isProtected = (db: string) => cdcStatuses.some(s => s.db === db)

  const filteredBackups = React.useMemo(() => {
    return backups.filter((b) => b.source === mode)
  }, [backups, mode])

  return (
    <AppShell>
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Backup</h2>
            <p className="text-sm text-muted-foreground">
              Create a cluster-level (pgBackRest) or single-database (pg-cdc) backup.
            </p>
          </div>
          {servers.length === 0 && (
            <Button variant="outline" size="sm" nativeButton={false} render={<a href="/settings" />}>
              <Link2Icon className="mr-1.5 size-3.5" />
              Configure servers
            </Button>
          )}
        </div>

        <div className="flex gap-2 rounded-md border p-1 bg-muted/30 w-fit">
          <Button
            variant={mode === "pgbackrest" ? "default" : "ghost"}
            size="sm"
            onClick={() => setMode("pgbackrest")}
          >
            <ServerIcon className="mr-1.5 size-3.5" />
            pgBackRest (cluster)
          </Button>
          <Button
            variant={mode === "cdc" ? "default" : "ghost"}
            size="sm"
            onClick={() => setMode("cdc")}
          >
            <RadioIcon className="mr-1.5 size-3.5" />
            pg-cdc (single DB)
          </Button>
        </div>

        {mode === "pgbackrest" && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="shadow-none lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">New backup</CardTitle>
              <CardDescription>
                Select a server. The entire cluster (stanza) will be backed up via pgBackRest.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="server-select" className="text-xs">Server (stanza)</Label>
                  <Select value={selectedServerId} onValueChange={(v) => { if (v) setSelectedServerId(v) }}>
                    <SelectTrigger id="server-select">
                      <SelectValue placeholder="Select server">{stanza || "Select server"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {servers.length === 0 ? (
                        <SelectItem value="__none__" disabled>No servers configured</SelectItem>
                      ) : (
                        servers.map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            <span className="flex items-center gap-2">
                              <ServerIcon className="size-3.5" />
                              {s.label}
                            </span>
                          </SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="type-select" className="text-xs">Backup type</Label>
                  <Select
                    value={backupType}
                    onValueChange={(v) => v && setBackupType(v as "Full" | "Incremental")}
                  >
                    <SelectTrigger id="type-select">
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Full">Full</SelectItem>
                      <SelectItem value="Incremental">Incremental</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {isBackingUp && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Backing up stanza &ldquo;{stanza}&rdquo;&hellip;</span>
                    <span>{progress}%</span>
                  </div>
                  <Progress value={progress} />
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button onClick={() => runBackup()} disabled={isBackingUp || !stanza} size="sm">
                  {isBackingUp ? (
                    <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
                  ) : (
                    <HardDriveDownloadIcon className="mr-1.5 size-3.5" />
                  )}
                  {isBackingUp ? "Backing up\u2026" : "Start backup"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isBackingUp}
                  onClick={() => {
                    setBackupType("Full")
                    toast.info("Form reset")
                  }}
                >
                  <RefreshCwIcon className="mr-1.5 size-3.5" />
                  Reset
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-4">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Selected stanza</CardTitle>
                <CardDescription>The cluster being backed up.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                {stanza ? (
                  <>
                    <div className="flex items-center gap-3">
                      <div className="flex size-9 items-center justify-center rounded-md bg-primary/10">
                        <ServerIcon className="size-4 text-primary" />
                      </div>
                      <div className="flex flex-col">
                        <span className="font-medium">{stanza}</span>
                        <span className="text-xs text-muted-foreground">
                          pgBackRest stanza
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                      <span className="text-muted-foreground">Backup type</span>
                      <span className="font-medium">{backupType}</span>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-2 py-4 text-center text-xs text-muted-foreground">
                    <ServerIcon className="size-8" />
                    <span>No server selected.<br />Go to Settings to add a server.</span>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Storage</CardTitle>
                <CardDescription>Where backups are saved.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                <div className="flex items-center gap-2">
                  <FolderIcon className="size-4 text-muted-foreground shrink-0" />
                  <span className="font-mono text-xs text-muted-foreground truncate">{storagePath}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Retention: {retentionDays} days</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
        )}

        {mode === "cdc" && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="shadow-none lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Single-database baseline backup</CardTitle>
              <CardDescription>
                Pick a database protected by pg-cdc to trigger a baseline (pg_dump) backup.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs">Server</Label>
                  <Select value={selectedServerId} onValueChange={(v) => { if (v) setSelectedServerId(v) }}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select server">{stanza || "Select server"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {servers.filter(s => s.engine === "PostgreSQL").length === 0 ? (
                        <SelectItem value="__none__" disabled>No PostgreSQL servers</SelectItem>
                      ) : (
                        servers.filter(s => s.engine === "PostgreSQL").map((s) => (
                          <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>
                        ))
                      )}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label className="text-xs">Database</Label>
                  <Select value={selectedDb} onValueChange={(v) => v && setSelectedDb(v)}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select database">{selectedDb || "Select database"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {availableDbs.map((db) => (
                        <SelectItem key={db} value={db}>
                          <span className="flex items-center gap-2">
                            <DatabaseIcon className="size-3.5" />
                            {db}
                            {isProtected(db) && <RadioIcon className="size-3 text-emerald-500" />}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {isBackingUp && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Running pg_dump on &ldquo;{selectedDb}&rdquo;&hellip;</span>
                    <span>{progress}%</span>
                  </div>
                  <Progress value={progress} />
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button onClick={() => runCdcBackupForDb(selectedDb)} disabled={isBackingUp || !selectedDb || !isProtected(selectedDb)} size="sm">
                  {isBackingUp ? (
                    <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
                  ) : (
                    <HardDriveDownloadIcon className="mr-1.5 size-3.5" />
                  )}
                  {isBackingUp ? "Backing up\u2026" : "Start baseline"}
                </Button>
              </div>
              {selectedDb && !isProtected(selectedDb) && (
                <p className="text-xs text-amber-600">This database is not protected by pg-cdc. Set it up in Settings first.</p>
              )}
            </CardContent>
          </Card>

          <div className="flex flex-col gap-4">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">CDC protection</CardTitle>
                <CardDescription>Current status for selected database.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                {selectedDb && isProtected(selectedDb) ? (
                  (() => {
                    const s = cdcStatuses.find(st => st.db === selectedDb)
                    return s ? (
                      <>
                        <div className="flex items-center gap-3">
                          <div className={`flex size-9 items-center justify-center rounded-md ${s.daemonRunning ? 'bg-emerald-50' : 'bg-red-50'}`}>
                            <RadioIcon className={`size-4 ${s.daemonRunning ? 'text-emerald-600' : 'text-red-600'}`} />
                          </div>
                          <div className="flex flex-col">
                            <span className="font-medium">{s.db}</span>
                            <span className="text-xs text-muted-foreground">{s.slotName}</span>
                          </div>
                        </div>
                        <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                          <span className="text-muted-foreground">Daemon</span>
                          <span className={s.daemonRunning ? 'text-emerald-600 font-medium' : 'text-red-600 font-medium'}>{s.daemonRunning ? 'Running' : 'Stopped'}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                          <span className="text-muted-foreground">Lag</span>
                          <span className="font-medium">{s.lagHuman}</span>
                        </div>
                        <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                          <span className="text-muted-foreground">Last baseline</span>
                          <span className="font-medium">{s.lastBaseline ? new Date(s.lastBaseline).toLocaleDateString() : 'Never'}</span>
                        </div>
                        {!s.daemonRunning && (
                          <Button variant="outline" size="sm" onClick={async () => {
                            try {
                              await startCdcDaemon(s.db)
                              toast.success(`Daemon started for "${s.db}"`)
                              refreshCdcStatus()
                            } catch (err) {
                              toast.error("Failed to start daemon", {
                                description: err instanceof Error ? err.message : String(err),
                              })
                            }
                          }} className="w-full">
                            <RadioIcon className="mr-1.5 size-3.5" />
                            Start daemon
                          </Button>
                        )}
                      </>
                    ) : null
                  })()
                ) : (
                  <div className="flex flex-col items-center gap-2 py-4 text-center text-xs text-muted-foreground">
                    <RadioIcon className="size-8" />
                    <span>No CDC protection for this database.</span>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Storage</CardTitle>
                <CardDescription>Where baselines are saved.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                <div className="flex items-center gap-2">
                  <FolderIcon className="size-4 text-muted-foreground shrink-0" />
                  <span className="font-mono text-xs text-muted-foreground truncate">/var/backups/pg/{selectedDb}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Stream: /var/pg-cdc/{selectedDb}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
        )}

        <Card className="shadow-none">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle className="text-sm font-semibold">Backup history</CardTitle>
              <CardDescription>All snapshots currently stored.</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => {
              toast.info("Refreshing\u2026")
              refreshBackups()
            }}>
              <RefreshCwIcon className="mr-1.5 size-3.5" />
              Refresh
            </Button>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Snapshot</TableHead>
                  <TableHead>Stanza / DB</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredBackups.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                      No backups yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredBackups.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="font-mono text-xs">{b.id}</TableCell>
                      <TableCell>{b.db}</TableCell>
                      <TableCell>{b.type}</TableCell>
                      <TableCell>{b.size}</TableCell>
                      <TableCell className="text-muted-foreground">{b.createdAt}</TableCell>
                      <TableCell className="text-center"><StatusBadge status={b.status} /></TableCell>
                      <TableCell className="text-right">
                        {b.status === "Failed" && b.source === "pgbackrest" && (
                          <Button variant="ghost" size="sm" onClick={() => runBackup(b.db, b.type as "Full" | "Incremental")}>
                            <RefreshCwIcon className="mr-1 size-3.5" />
                            Retry
                          </Button>
                        )}
                        <AlertDialog>
                          <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>
                            <Trash2Icon className="size-3.5" />
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete {b.id}?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This snapshot will be permanently removed.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={async () => {
                                try {
                                  await apiDeleteBackup(b.id)
                                  deleteBackup(b.id)
                                  toast.success(`Backup ${b.id} deleted`)
                                } catch (err) {
                                  toast.error("Failed to delete", {
                                    description: err instanceof Error ? err.message : String(err),
                                  })
                                }
                              }}>
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
