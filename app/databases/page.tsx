"use client"

import * as React from "react"
import Link from "next/link"
import {
  DatabaseIcon,
  RefreshCwIcon,
  Link2Icon,
  SettingsIcon,
  CheckCircle2Icon,
  XCircleIcon,
  AlertCircleIcon,
  ActivityIcon,
  Loader2Icon,
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
import { useDb } from "@/lib/db-context"

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

function timeAgo(createdAt: string): string {
  if (createdAt === "Just now") return "Just now"
  try {
    const date = new Date(createdAt)
    if (isNaN(date.getTime())) return createdAt
    const diffMs = Date.now() - date.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return "Just now"
    if (diffMin < 60) return `${diffMin}m ago`
    const diffHr = Math.floor(diffMin / 60)
    if (diffHr < 24) return `${diffHr}h ago`
    const diffDay = Math.floor(diffHr / 24)
    if (diffDay < 30) return `${diffDay}d ago`
    return date.toLocaleDateString()
  } catch {
    return createdAt
  }
}

export default function DatabasesPage() {
  const {
    servers,
    backups,
    cdcStatuses,
    dbConfigs,
    loading,
    refreshBackups,
    refreshCdcStatus,
    refreshDbConfigs,
  } = useDb()

  const [serverFilter, setServerFilter] = React.useState<string>("__all__")

  // Gather all databases from all servers, keyed by server id + db name
  // to avoid collisions when the same db name exists on multiple servers.
  const allDbs = React.useMemo(() => {
    const seen = new Set<string>()
    const dbs: { serverId: string; serverLabel: string; engine: string; name: string }[] = []
    for (const s of servers) {
      for (const db of s.databases) {
        const key = `${s.id}:${db}`
        if (!seen.has(key)) {
          seen.add(key)
          dbs.push({ serverId: s.id, serverLabel: s.label, engine: s.engine, name: db })
        }
      }
    }
    return dbs
  }, [servers])

  const filteredDbs = React.useMemo(() => {
    if (serverFilter === "__all__") return allDbs
    return allDbs.filter((d) => d.serverId === serverFilter)
  }, [allDbs, serverFilter])

  const configMap = React.useMemo(() => new Map(dbConfigs.map((c) => [c.db, c])), [dbConfigs])

  function getHealthStatus(dbName: string): HealthStatus {
    const cdc = cdcStatuses.find((s) => s.db === dbName)
    if (!cdc) return "unprotected"
    if (cdc.daemonRunning && cdc.slotActive) return "healthy"
    return "degraded"
  }

  function getBackupCount(dbName: string): number {
    return backups.filter((b) => b.db === dbName && b.source === "cdc").length
  }

  function getLastBackup(dbName: string): { createdAt: string } | null {
    const dbBackups = backups
      .filter((b) => b.db === dbName && b.source === "cdc")
      .sort((a, b) => {
        const ta = new Date(a.createdAtIso ?? a.createdAt).getTime()
        const tb = new Date(b.createdAtIso ?? b.createdAt).getTime()
        return (isNaN(tb) ? 0 : tb) - (isNaN(ta) ? 0 : ta)
      })
    if (dbBackups.length === 0) return null
    return dbBackups[0]
  }

  return (
    <AppShell>
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Databases</h2>
            <p className="text-sm text-muted-foreground">
              Monitor health, manage backups, and restore individual databases.
            </p>
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
            {servers.length === 0 && (
              <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/settings" />}>
                <Link2Icon className="mr-1.5 size-3.5" />
                Configure servers
              </Button>
            )}
          </div>
        </div>

        {loading ? (
          <Card className="shadow-none">
            <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              Loading databases…
            </CardContent>
          </Card>
        ) : allDbs.length === 0 ? (
          <Card className="shadow-none">
            <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
              <DatabaseIcon className="size-10 text-muted-foreground" />
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">No databases discovered</span>
                <span className="text-xs text-muted-foreground">
                  Add a server in{" "}
                  <Link href="/settings" className="text-primary underline underline-offset-2">Settings</Link>
                  {" "}to discover databases.
                </span>
              </div>
            </CardContent>
          </Card>
        ) : (
          <>
          {servers.length >= 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => setServerFilter("__all__")}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  serverFilter === "__all__"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                All ({allDbs.length})
              </button>
              {servers.map((s) => {
                const count = allDbs.filter((d) => d.serverId === s.id).length
                return (
                  <button
                    key={s.id}
                    onClick={() => setServerFilter(s.id)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      serverFilter === s.id
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    }`}
                  >
                    {s.label} ({count})
                  </button>
                )
              })}
            </div>
          )}
          {filteredDbs.length === 0 ? (
            <Card className="shadow-none">
              <CardContent className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
                <DatabaseIcon className="size-6" />
                <span>No databases on the selected server.</span>
              </CardContent>
            </Card>
          ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredDbs.map(({ name, serverLabel, engine }) => {
              const health = getHealthStatus(name)
              const info = healthInfo(health)
              const HealthIcon = info.icon
              const backupCount = getBackupCount(name)
              const lastBackup = getLastBackup(name)
              const hasConfig = configMap.has(name)

              return (
                <Link key={`${serverLabel}:${name}`} href={`/databases/${encodeURIComponent(name)}`} className="block">
                <Card
                  className="shadow-none cursor-pointer transition-all hover:ring-2 hover:ring-primary/20"
                >
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <div className="flex size-9 items-center justify-center rounded-md bg-primary/10">
                          <DatabaseIcon className="size-4 text-primary" />
                        </div>
                        <div className="flex flex-col">
                          <CardTitle className="text-sm font-mono">{name}</CardTitle>
                          <span className="text-xs text-muted-foreground">{serverLabel}</span>
                        </div>
                      </div>
                      <Badge variant="secondary" className={`text-xs ${info.badge}`}>
                        <HealthIcon className="size-3" />
                        {info.label}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-xs text-muted-foreground">Backups</span>
                        <span className="text-lg font-semibold">{backupCount}</span>
                      </div>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-xs text-muted-foreground">Last backup</span>
                        <span className="text-sm font-medium">
                          {lastBackup ? timeAgo(lastBackup.createdAt) : "Never"}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between border-t pt-2">
                      {hasConfig ? (
                        <Badge variant="outline" className="text-xs gap-1">
                          <CheckCircle2Icon className="size-3 text-emerald-500" />
                          Configured
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs gap-1 text-muted-foreground">
                          <SettingsIcon className="size-3" />
                          Not configured
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground">{engine}</span>
                    </div>
                  </CardContent>
                </Card>
                </Link>
              )
            })}
          </div>
          )}
          </>
        )}
      </div>
    </AppShell>
  )
}
