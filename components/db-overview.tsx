"use client"

import * as React from "react"
import Link from "next/link"
import {
  DatabaseIcon,
  HardDriveDownloadIcon,
  ActivityIcon,
  ArrowRightIcon,
  ServerIcon,
  RadioIcon,
  CheckCircle2Icon,
  XCircleIcon,
  Loader2Icon,
} from "lucide-react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useDb } from "@/lib/db-context"
import { startCdcDaemon } from "@/lib/api"
import { toast } from "sonner"

function statusBadge(status: string) {
  if (status === "Completed")
    return <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">Completed</Badge>
  if (status === "Running")
    return <Badge variant="secondary" className="bg-blue-50 text-blue-700 border-blue-200">Running</Badge>
  return <Badge variant="destructive">{status}</Badge>
}

export function DbStats() {
  const { servers, backups, cdcStatuses, loading } = useDb()

  const totalDbs = servers.reduce((sum, s) => sum + s.databases.length, 0)
  const healthyCount = cdcStatuses.filter(s => s.daemonRunning && s.slotActive).length
  const degradedCount = cdcStatuses.filter(s => !(s.daemonRunning && s.slotActive)).length
  const unprotectedCount = Math.max(0, totalDbs - cdcStatuses.length)

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card className="shadow-none">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription className="text-xs font-medium">Servers</CardDescription>
          <ServerIcon className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardTitle className="px-6 pb-6 text-2xl">{loading ? "…" : servers.length}</CardTitle>
      </Card>
      <Card className="shadow-none">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription className="text-xs font-medium">Databases</CardDescription>
          <DatabaseIcon className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardTitle className="px-6 pb-6 text-2xl">{loading ? "…" : totalDbs}</CardTitle>
      </Card>
      <Card className="shadow-none">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription className="text-xs font-medium">Total backups</CardDescription>
          <HardDriveDownloadIcon className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardTitle className="px-6 pb-6 text-2xl">{loading ? "…" : backups.length}</CardTitle>
      </Card>
      <Card className="shadow-none">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription className="text-xs font-medium">Health</CardDescription>
          <ActivityIcon className={`size-4 ${healthyCount > 0 ? "text-emerald-500" : unprotectedCount > 0 ? "text-amber-500" : "text-muted-foreground"}`} />
        </CardHeader>
        <CardTitle className="px-6 pb-6 text-2xl">
          {loading ? "…" : servers.length === 0 ? "Disconnected" : (
            <span className="flex items-center gap-2 text-base">
              <span className="text-emerald-600">{healthyCount}</span>
              {degradedCount > 0 && <span className="text-amber-600">{degradedCount}</span>}
              {unprotectedCount > 0 && <span className="text-muted-foreground">{unprotectedCount}</span>}
            </span>
          )}
        </CardTitle>
      </Card>
    </div>
  )
}

export function DbDatabases() {
  const { servers, loading } = useDb()

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Database servers</CardTitle>
        <CardDescription>Your configured servers and their discovered databases.</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading servers…</p>
        ) : servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No servers configured. Go to{" "}
            <a href="/settings" className="text-primary underline underline-offset-2">Settings</a> to add one.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {servers.map((srv) => (
              <div key={srv.id}>
                <div className="mb-2 flex items-center gap-2">
                  <ServerIcon className="size-4 text-muted-foreground" />
                  <span className="text-sm font-semibold">{srv.label}</span>
                  <Badge variant="secondary" className="text-xs">{srv.engine}</Badge>
                </div>
                {srv.databases.length === 0 ? (
                  <p className="text-xs text-muted-foreground ml-6">No databases discovered.</p>
                ) : (
                  <div className="grid gap-3 md:grid-cols-3 ml-6">
                    {srv.databases.map((db) => (
                      <div key={db} className="flex items-center gap-3 rounded-lg border p-3">
                        <div className="flex size-7 items-center justify-center rounded-md bg-primary/10">
                          <DatabaseIcon className="size-3.5 text-primary" />
                        </div>
                        <span className="text-sm font-mono">{db}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function DbRecentBackups() {
  const { backups, loading } = useDb()
  const recent = [...backups]
    .sort((a, b) => {
      const ta = new Date(a.createdAtIso ?? a.createdAt).getTime()
      const tb = new Date(b.createdAtIso ?? b.createdAt).getTime()
      return (isNaN(tb) ? 0 : tb) - (isNaN(ta) ? 0 : ta)
    })
    .slice(0, 4)

  return (
    <Card className="shadow-none">
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle className="text-sm font-semibold">Recent backups</CardTitle>
          <CardDescription>Latest backup activity across all databases.</CardDescription>
        </div>
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href="/databases" />}>
          Databases <ArrowRightIcon className="ml-1 size-3" />
        </Button>
      </CardHeader>
      <CardContent className="px-0">
        {loading ? (
          <p className="px-6 py-4 text-sm text-muted-foreground">Loading backups…</p>
        ) : recent.length === 0 ? (
          <p className="px-6 py-4 text-sm text-muted-foreground">No backups yet.</p>
        ) : (
          <div className="divide-y">
            {recent.map((b) => (
              <div key={b.id} className="flex items-center justify-between gap-3 px-6 py-3 text-sm">
                <div className="flex items-center gap-3">
                  <div className="flex size-7 items-center justify-center rounded-md bg-muted">
                    <HardDriveDownloadIcon className="size-3.5 text-muted-foreground" />
                  </div>
                  <div className="flex flex-col">
                    <span className="font-medium">{b.id}</span>
                    <span className="text-xs text-muted-foreground">
                      {b.db} &middot; {b.type}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">{b.createdAt}</span>
                  {statusBadge(b.status)}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function DbCdcStats() {
  const { cdcStatuses, loading } = useDb()
  const protectedCount = cdcStatuses.length
  const healthyCount = cdcStatuses.filter(s => s.daemonRunning && s.slotActive).length

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card className="shadow-none">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription className="text-xs font-medium">Protected DBs</CardDescription>
          <RadioIcon className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardTitle className="px-6 pb-6 text-2xl">{loading ? "…" : protectedCount}</CardTitle>
      </Card>
      <Card className="shadow-none">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription className="text-xs font-medium">Healthy daemons</CardDescription>
          <CheckCircle2Icon className="size-4 text-emerald-500" />
        </CardHeader>
        <CardTitle className="px-6 pb-6 text-2xl">{loading ? "…" : `${healthyCount}/${protectedCount}`}</CardTitle>
      </Card>
      <Card className="shadow-none">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription className="text-xs font-medium">Stopped daemons</CardDescription>
          <XCircleIcon className="size-4 text-red-500" />
        </CardHeader>
        <CardTitle className="px-6 pb-6 text-2xl">
          {loading ? "…" : cdcStatuses.filter(s => !s.daemonRunning).length}
        </CardTitle>
      </Card>
      <Card className="shadow-none">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardDescription className="text-xs font-medium">Inactive slots</CardDescription>
          <XCircleIcon className="size-4 text-red-500" />
        </CardHeader>
        <CardTitle className="px-6 pb-6 text-2xl">
          {loading ? "…" : cdcStatuses.filter(s => !s.slotActive).length}
        </CardTitle>
      </Card>
    </div>
  )
}

export function DbCdcDetails() {
  const { cdcStatuses, refreshCdcStatus, loading } = useDb()
  const [startingDb, setStartingDb] = React.useState<string | null>(null)

  if (loading) return null
  if (cdcStatuses.length === 0) return null

  async function handleStartDaemon(dbName: string) {
    setStartingDb(dbName)
    try {
      await startCdcDaemon(dbName)
      toast.success(`Daemon started for "${dbName}"`)
      refreshCdcStatus()
    } catch (err) {
      toast.error("Failed to start daemon", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setStartingDb(null)
    }
  }

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-sm font-semibold">CDC replication status</CardTitle>
        <CardDescription>Per-database logical replication health.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {cdcStatuses.map((s) => (
          <div key={s.db} className="flex items-center justify-between rounded-lg border p-3 text-sm">
            <div className="flex items-center gap-3">
              <div className={`flex size-8 items-center justify-center rounded-md ${s.daemonRunning ? 'bg-emerald-50' : 'bg-red-50'}`}>
                <RadioIcon className={`size-4 ${s.daemonRunning ? 'text-emerald-600' : 'text-red-600'}`} />
              </div>
              <div className="flex flex-col">
                <span className="font-medium font-mono">{s.db}</span>
                <span className="text-xs text-muted-foreground">
                  {s.slotName} &middot; lag: {s.lagHuman}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-4 text-xs">
              <div className="flex flex-col items-center">
                <span className={`font-medium ${s.daemonRunning ? 'text-emerald-600' : 'text-red-600'}`}>
                  {s.daemonRunning ? 'Running' : 'Stopped'}
                </span>
                <span className="text-muted-foreground">daemon</span>
              </div>
              <div className="flex flex-col items-center">
                <span className={`font-medium ${s.slotActive ? 'text-emerald-600' : 'text-red-600'}`}>
                  {s.slotActive ? 'Active' : 'Inactive'}
                </span>
                <span className="text-muted-foreground">slot</span>
              </div>
              <div className="flex flex-col items-center">
                <span className={`font-medium ${!s.daemonRunning && s.streamStaleSec !== null && s.streamStaleSec > 120 ? 'text-amber-600' : ''}`}>
                  {s.streamStaleSec !== null ? `${s.streamStaleSec}s` : '—'}
                </span>
                <span className="text-muted-foreground">stream age</span>
              </div>
              {s.lastBaseline && (
                <div className="flex flex-col items-center">
                  <span className="font-medium text-xs">{s.lastBaseline.slice(0, 10)}</span>
                  <span className="text-muted-foreground">baseline</span>
                </div>
              )}
              {!s.daemonRunning && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleStartDaemon(s.db)}
                  disabled={startingDb === s.db}
                >
                  {startingDb === s.db ? (
                    <Loader2Icon className="mr-1 size-3.5 animate-spin" />
                  ) : (
                    <RadioIcon className="mr-1 size-3.5" />
                  )}
                  {startingDb === s.db ? "Starting\u2026" : "Start"}
                </Button>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
