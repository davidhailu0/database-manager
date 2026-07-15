"use client"

import * as React from "react"
import {
  HardDriveUploadIcon,
  ClockIcon,
  RefreshCwIcon,
  Loader2Icon,
  Link2Icon,
  DatabaseIcon,
  RadioIcon,
  ServerIcon,
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
import { Input } from "@/components/ui/input"
import { useDb } from "@/lib/db-context"
import { runRestore as apiRunRestore, runCdcRestore, runHealthCheck, getHealthCheckpoints, startCdcDaemon } from "@/lib/api"
import type { HealthCheckpoint } from "@/lib/api"

export default function RestorePage() {
  const { servers, backups, cdcStatuses, isRestoring, setIsRestoring, refreshCdcStatus } = useDb()
  const [mode, setMode] = React.useState<"pgbackrest" | "cdc">("pgbackrest")
  const [restoreTarget, setRestoreTarget] = React.useState<string>("")
  const [stanzaFilter, setStanzaFilter] = React.useState<string>("")
  const [dialogOpen, setDialogOpen] = React.useState(false)

  // CDC restore state
  const [cdcSourceDb, setCdcSourceDb] = React.useState<string>("")
  const [cdcTargetDb, setCdcTargetDb] = React.useState<string>("")
  const [cdcTimestamp, setCdcTimestamp] = React.useState<string>("")
  const [lastCheckpoint, setLastCheckpoint] = React.useState<HealthCheckpoint | null>(null)
  const [useCheckpoint, setUseCheckpoint] = React.useState(true)
  const [inPlaceRestore, setInPlaceRestore] = React.useState(false)

  const allDbs = React.useMemo(() => {
    const seen = new Set<string>()
    const dbs: { server: string; name: string }[] = []
    for (const s of servers) {
      for (const db of s.databases) {
        if (!seen.has(db)) {
          seen.add(db)
          dbs.push({ server: s.label, name: db })
        }
      }
    }
    return dbs
  }, [servers])

  const cdcDbSet = React.useMemo(() => new Set(cdcStatuses.map(s => s.db)), [cdcStatuses])

  const firstCdcDb = allDbs.find(d => cdcDbSet.has(d.name))?.name || cdcStatuses[0]?.db || ""

  React.useEffect(() => {
    if (!cdcSourceDb && firstCdcDb) setCdcSourceDb(firstCdcDb)
  }, [firstCdcDb, cdcSourceDb])

  React.useEffect(() => {
    if (cdcSourceDb && !cdcTargetDb) setCdcTargetDb(cdcSourceDb + "_restore")
  }, [cdcSourceDb, cdcTargetDb])

  React.useEffect(() => {
    if (inPlaceRestore && cdcSourceDb) {
      setCdcTargetDb(cdcSourceDb)
    }
  }, [inPlaceRestore, cdcSourceDb])

  React.useEffect(() => {
    if (cdcSourceDb) {
      getHealthCheckpoints(cdcSourceDb).then(cps => {
        const healthy = cps.find(c => c.status === 'healthy')
        setLastCheckpoint(healthy || cps[0] || null)
        if (healthy) {
          setUseCheckpoint(true)
        }
      }).catch(() => {})
    } else {
      setLastCheckpoint(null)
    }
  }, [cdcSourceDb])

  const cdcInfo = cdcStatuses.find(s => s.db === cdcSourceDb)

  const stanzaNames = React.useMemo(() => {
    const names = new Set<string>()
    servers.forEach((s) => names.add(s.label))
    backups.forEach((b) => names.add(b.db))
    return Array.from(names)
  }, [servers, backups])

  const activeStanza = stanzaFilter || (stanzaNames.length > 0 ? stanzaNames[0] : "")

  const filteredBackups = React.useMemo(() => {
    if (!activeStanza) return []
    return backups.filter((b) => b.status === "Completed" && b.db === activeStanza && b.source === "pgbackrest")
  }, [backups, activeStanza])

  const activeRestoreTarget = restoreTarget || (filteredBackups.length > 0 ? filteredBackups[0].id : "")

  const selected = backups.find((b) => b.id === activeRestoreTarget)

  async function runRestore(snapshotId: string) {
    setIsRestoring(true)
    try {
      await apiRunRestore(snapshotId)
      toast.success("Restore completed", {
        description: `Restored cluster from snapshot ${snapshotId}`,
      })
    } catch (err) {
      toast.error("Restore failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsRestoring(false)
    }
  }

  async function runCdcRestoreForDb() {
    if (!cdcSourceDb || !cdcTargetDb) {
      toast.error("Source and target database names are required")
      return
    }
    setIsRestoring(true)
    const timestamp = useCheckpoint ? (lastCheckpoint?.timestamp || cdcTimestamp) : (cdcTimestamp || undefined)
    const forceProduction = inPlaceRestore
    try {
      const result = await runCdcRestore(cdcSourceDb, cdcTargetDb, timestamp, forceProduction)
      toast.success("CDC restore completed", {
        description: `Restored "${cdcSourceDb}" to "${cdcTargetDb}"${result.toTimestamp ? ` at ${new Date(result.toTimestamp).toLocaleString()}` : ''}`,
      })
      refreshCdcStatus()
    } catch (err) {
      toast.error("CDC restore failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsRestoring(false)
    }
  }

  async function handleRunHealthCheck() {
    try {
      const result = await runHealthCheck()
      toast.success(result.message)
      if (cdcSourceDb) {
        const cps = await getHealthCheckpoints(cdcSourceDb)
        const healthy = cps.find(c => c.status === 'healthy')
        setLastCheckpoint(healthy || cps[0] || null)
      }
    } catch (err) {
      toast.error("Health check failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <AppShell>
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Restore</h2>
            <p className="text-sm text-muted-foreground">
              Cluster-level (pgBackRest) or point-in-time single-database (pg-cdc) restore.
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
            pg-cdc (single DB PIT)
          </Button>
        </div>

        {mode === "pgbackrest" && (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Restore from snapshot</CardTitle>
            <CardDescription>
              Pick a completed backup snapshot. The entire stanza (cluster) will be restored.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {filteredBackups.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
                <HardDriveUploadIcon className="size-8" />
                <span>No completed backups available. Create a backup first.</span>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="stanza-filter" className="text-xs">Filter by stanza</Label>
                  <Select value={activeStanza} onValueChange={(v) => v && setStanzaFilter(v)}>
                    <SelectTrigger id="stanza-filter">
                      <SelectValue placeholder="Select stanza" />
                    </SelectTrigger>
                    <SelectContent>
                      {stanzaNames.map((name) => (
                        <SelectItem key={name} value={name}>{name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="restore-select" className="text-xs">Backup snapshot</Label>
                  <Select value={activeRestoreTarget} onValueChange={(v) => v && setRestoreTarget(v)}>
                    <SelectTrigger id="restore-select">
                      <SelectValue placeholder="Select snapshot">{selected ? `${selected.id} · ${selected.db} · ${selected.type}` : "Select snapshot"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {filteredBackups.map((b) => (
                        <SelectItem key={b.id} value={b.id}>
                          <span className="flex items-center gap-2">
                            <ClockIcon className="size-3.5" />
                            {b.id} &middot; {b.db} &middot; {b.type}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Restoring will overwrite the current data in the entire cluster (stanza). This action cannot be undone.
                </div>

                <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
                  <AlertDialogTrigger render={<Button disabled={isRestoring || !selected} size="sm" className="w-fit" />}>
                    {isRestoring ? (
                      <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
                    ) : (
                      <HardDriveUploadIcon className="mr-1.5 size-3.5" />
                    )}
                    {isRestoring ? "Restoring\u2026" : "Restore now"}
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Confirm cluster restore?</AlertDialogTitle>
                      <AlertDialogDescription>
                        The backup <span className="font-mono">{selected?.id}</span> for stanza{" "}
                        <span className="font-mono">{selected?.db}</span> will be restored. This will overwrite
                        the current data in the entire cluster.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => {
                        setDialogOpen(false)
                        if (selected) runRestore(selected.id)
                      }}>
                        Continue
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            )}
          </CardContent>
        </Card>
        )}

        {mode === "cdc" && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="shadow-none lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Point-in-time restore (single DB)</CardTitle>
              <CardDescription>
                Pick a database to restore. pg-cdc will apply the latest baseline dump + WAL stream replay.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {allDbs.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
                  <DatabaseIcon className="size-8" />
                  <span>No databases found. Configure a server in Settings first.</span>
                </div>
              ) : (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="flex flex-col gap-2">
                      <Label className="text-xs">Database to restore</Label>
                      <Select value={cdcSourceDb} onValueChange={(v) => { if (v) { setCdcSourceDb(v); setCdcTargetDb(v + "_restore") } }}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select database">{cdcSourceDb || "Select database"}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {allDbs.map(({ server, name }) => {
                            const isProtected = cdcDbSet.has(name)
                            return (
                              <SelectItem key={name} value={name} disabled={!isProtected}>
                                <span className="flex items-center gap-2">
                                  {isProtected ? <RadioIcon className="size-3.5 text-emerald-500" /> : <DatabaseIcon className="size-3.5 text-muted-foreground" />}
                                  <span>{name}</span>
                                  {isProtected && <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 border-emerald-200 text-emerald-700">CDC</Badge>}
                                </span>
                              </SelectItem>
                            )
                          })}
                        </SelectContent>
                      </Select>
                      {cdcSourceDb && !cdcDbSet.has(cdcSourceDb) && (
                        <p className="text-xs text-amber-600">This database is not protected by pg-cdc. Set up CDC protection in Settings first.</p>
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label className="text-xs">Restore as (new database name)</Label>
                      <Input
                        value={cdcTargetDb}
                        onChange={(e) => setCdcTargetDb(e.target.value)}
                        placeholder="e.g. mydb_restore"
                        className="font-mono text-sm"
                        disabled={inPlaceRestore}
                      />
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          checked={inPlaceRestore}
                          onChange={(e) => {
                            setInPlaceRestore(e.target.checked)
                            if (e.target.checked) {
                              setCdcTargetDb(cdcSourceDb)
                            } else {
                              setCdcTargetDb(cdcSourceDb ? cdcSourceDb + "_restore" : "")
                            }
                          }}
                          className="size-3.5"
                        />
                        Restore in-place (overwrite existing database)
                      </label>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Restore point</Label>
                      <div className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          id="use-checkpoint"
                          checked={useCheckpoint}
                          onChange={(e) => setUseCheckpoint(e.target.checked)}
                          className="size-3.5"
                        />
                        <label htmlFor="use-checkpoint" className="text-xs text-muted-foreground">Use last healthy checkpoint</label>
                      </div>
                    </div>
                    {useCheckpoint && lastCheckpoint ? (
                      <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                        <span className="text-muted-foreground">Last healthy checkpoint</span>
                        <span className="font-medium">{new Date(lastCheckpoint.timestamp).toLocaleString()}</span>
                      </div>
                    ) : (
                      <Input
                        value={cdcTimestamp}
                        onChange={(e) => setCdcTimestamp(e.target.value)}
                        placeholder="e.g. 2026-07-05T14:30:00Z"
                        className="font-mono text-sm"
                      />
                    )}
                    {!lastCheckpoint && (
                      <p className="text-xs text-amber-600">No health checkpoints found. Run a health check or enter a timestamp manually. Without a timestamp, the restore will replay all WAL up to now.</p>
                    )}
                  </div>

                  <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    {inPlaceRestore
                      ? "The existing database will be overwritten. This action cannot be undone."
                      : "A new database is created with the restored data. The source database is not modified."}
                  </div>

                  <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
                    <AlertDialogTrigger render={<Button disabled={isRestoring || !cdcSourceDb || !cdcTargetDb || !cdcDbSet.has(cdcSourceDb)} size="sm" className="w-fit" />}>
                      {isRestoring ? (
                        <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
                      ) : (
                        <HardDriveUploadIcon className="mr-1.5 size-3.5" />
                      )}
                      {isRestoring ? "Restoring\u2026" : "Restore now"}
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Confirm PIT restore?</AlertDialogTitle>
                        <AlertDialogDescription>
                          The baseline dump for <span className="font-mono">{cdcSourceDb}</span> will be restored to{" "}
                          <span className="font-mono">{cdcTargetDb}</span>
                          {useCheckpoint && lastCheckpoint
                            ? <>, then WAL replayed up to <span className="font-mono">{new Date(lastCheckpoint.timestamp).toLocaleString()}</span> (last healthy checkpoint)</>
                            : cdcTimestamp
                              ? <>, then WAL replayed up to <span className="font-mono">{cdcTimestamp}</span></>
                              : ", then WAL replayed to latest"
                          }.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => {
                          setDialogOpen(false)
                          runCdcRestoreForDb()
                        }}>
                          Continue
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </>
              )}
            </CardContent>
          </Card>

          <div className="flex flex-col gap-4">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">CDC status</CardTitle>
                <CardDescription>Protection info for the selected database.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                {cdcSourceDb && cdcInfo ? (
                  <>
                    <div className="flex items-center gap-3">
                      <div className={`flex size-9 items-center justify-center rounded-md ${cdcInfo.daemonRunning ? 'bg-emerald-50' : 'bg-red-50'}`}>
                        <RadioIcon className={`size-4 ${cdcInfo.daemonRunning ? 'text-emerald-600' : 'text-red-600'}`} />
                      </div>
                      <div className="flex flex-col">
                        <span className="font-medium">{cdcInfo.db}</span>
                        <span className="text-xs text-muted-foreground">{cdcInfo.slotName}</span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                      <span className="text-muted-foreground">Daemon</span>
                      <span className={cdcInfo.daemonRunning ? 'text-emerald-600 font-medium' : 'text-red-600 font-medium'}>{cdcInfo.daemonRunning ? 'Running' : 'Stopped'}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                      <span className="text-muted-foreground">Lag</span>
                      <span className="font-medium">{cdcInfo.lagHuman}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                      <span className="text-muted-foreground">Last baseline</span>
                      <span className="font-medium">{cdcInfo.lastBaseline ? new Date(cdcInfo.lastBaseline).toLocaleDateString() : 'Never'}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                      <span className="text-muted-foreground">Health checkpoint</span>
                      <span className="font-medium">{lastCheckpoint ? new Date(lastCheckpoint.timestamp).toLocaleString() : 'None'}</span>
                    </div>
                    {!cdcInfo.daemonRunning && (
                      <Button variant="outline" size="sm" onClick={async () => {
                        try {
                          await startCdcDaemon(cdcInfo.db)
                          toast.success(`Daemon started for "${cdcInfo.db}"`)
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
                    <Button variant="outline" size="sm" onClick={handleRunHealthCheck} className="w-full">
                      <RefreshCwIcon className="mr-1.5 size-3.5" />
                      Run health check
                    </Button>
                  </>
                ) : cdcSourceDb ? (
                  <div className="flex flex-col items-center gap-2 py-4 text-center text-xs text-muted-foreground">
                    <DatabaseIcon className="size-8" />
                    <span>Not protected by pg-cdc.<br />Set up CDC in Settings.</span>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2 py-4 text-center text-xs text-muted-foreground">
                    <RadioIcon className="size-8" />
                    <span>Select a database to see its CDC status.</span>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Restore plan</CardTitle>
                <CardDescription>What will happen.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-xs text-muted-foreground">
                <ol className="list-decimal list-inside space-y-1">
                  {inPlaceRestore ? (
                    <li>Overwrite existing database <span className="font-mono">{cdcTargetDb || '…'}</span></li>
                  ) : (
                    <li>Create new database <span className="font-mono">{cdcTargetDb || '…'}</span></li>
                  )}
                  <li>Restore latest baseline dump</li>
                  <li>Replay WAL stream up to {useCheckpoint && lastCheckpoint ? 'last healthy checkpoint' : 'chosen timestamp'}</li>
                  <li>Verify restored data integrity</li>
                </ol>
                {useCheckpoint && lastCheckpoint && (
                  <p className="mt-1 text-emerald-600">Restore will stop at the last known-good checkpoint. Data corrupted after this point is discarded.</p>
                )}
                {!lastCheckpoint && (
                  <p className="mt-1 text-amber-600">No health checkpoint yet — restore will replay all WAL up to the target time. Run a health check first to record a safe restore point.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
        )}

        {mode === "pgbackrest" && selected && (
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Snapshot details</CardTitle>
              <CardDescription>Information about the selected snapshot.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                <span className="text-muted-foreground">Snapshot</span>
                <span className="font-medium font-mono">{selected.id}</span>
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                <span className="text-muted-foreground">Stanza</span>
                <span className="font-medium">{selected.db}</span>
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                <span className="text-muted-foreground">Type</span>
                <span className="font-medium">{selected.type}</span>
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                <span className="text-muted-foreground">Size</span>
                <span className="font-medium">{selected.size}</span>
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
                <span className="text-muted-foreground">Created</span>
                <span className="font-medium">{selected.createdAt}</span>
              </div>
              <div className="flex items-center justify-center rounded-md border px-3 py-2 text-xs">
                <span className="text-muted-foreground mr-2">Status</span>
                <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">{selected.status}</Badge>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <RefreshCwIcon className="size-3.5 shrink-0" />
          <span>Restoring overwrites the current cluster data. Ensure you have a recent backup before proceeding.</span>
        </div>
      </div>
    </AppShell>
  )
}
