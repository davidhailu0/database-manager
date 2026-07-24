"use client"

import * as React from "react"
import { toast } from "sonner"
import {
  Trash2Icon,
  PlusIcon,
  ServerIcon,
  RefreshCwIcon,
  RadioIcon,
  DatabaseIcon,
  HardDriveIcon,
  Loader2Icon,
  SaveIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react"

import { AppShell } from "@/components/app-shell"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { useDb } from "@/lib/db-context"
import {
  createServer,
  deleteServer,
  discoverDatabases,
  setupCdcForDb,
  isRemoteUrl,
  saveStorageSettings,
  upsertDbConfig,
} from "@/lib/api"
import type { ServerRecord, DbConfig } from "@/lib/api"

function maskConnectionUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) {
      u.password = "\u2022\u2022\u2022\u2022"
    }
    return u.toString()
  } catch {
    return url
  }
}

function AddServerCard({ onAdded }: { onAdded: () => void }) {
  const [label, setLabel] = React.useState("")
  const [url, setUrl] = React.useState("")
  const [sshUser, setSshUser] = React.useState("")
  const [isAdding, setIsAdding] = React.useState(false)
  const { refreshCdcStatus } = useDb()

  async function handleAdd() {
    if (!label.trim() || !url.trim()) {
      toast.error("Label and connection URL are required")
      return
    }
    setIsAdding(true)
    try {
      const result = await createServer(label.trim(), url.trim(), sshUser.trim() || undefined)
      let msg = ''
      if (result.stanzaCreated) msg = ' \u2014 stanza created'
      else if (result.pgDataDir) msg = ' \u2014 stanza config added'
      else if (result.stanzaMessage) msg = ` \u2014 ${result.stanzaMessage}`
      toast.success(`Server "${label}" added${msg}`)

      if (result.server.databases.length > 0 && result.server.engine === "PostgreSQL") {
        for (const db of result.server.databases) {
          try {
            await setupCdcForDb(db)
            toast.info(`CDC protection enabled for "${db}"`)
          } catch (err) {
            toast.warning(`CDC setup skipped for "${db}"`, {
              description: err instanceof Error ? err.message : undefined,
            })
          }
        }
      }

      setLabel("")
      setUrl("")
      setSshUser("")
      onAdded()
      refreshCdcStatus()
    } catch (err) {
      toast.error("Failed to add server", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsAdding(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-4">
      <span className="text-sm font-medium">Add server</span>
      <div className="flex flex-col gap-2">
        <Label htmlFor="srv-label" className="text-xs">Label</Label>
        <Input id="srv-label" placeholder="e.g. Production PG" value={label} onChange={(e) => setLabel(e.target.value)} className="text-sm" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="srv-url" className="text-xs">Connection URL</Label>
        <Input id="srv-url" placeholder="postgresql://user:pass@host:5432" value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono text-sm" />
      </div>
      {isRemoteUrl(url) && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="srv-ssh-user" className="text-xs">SSH username (for remote management)</Label>
          <Input id="srv-ssh-user" placeholder="e.g. admin, ubuntu" value={sshUser} onChange={(e) => setSshUser(e.target.value)} className="text-sm" />
        </div>
      )}
      <div>
        <Button onClick={handleAdd} size="sm" disabled={isAdding}>
          <PlusIcon className="mr-1.5 size-3.5" />
          {isAdding ? "Adding\u2026" : "Add server"}
        </Button>
      </div>
    </div>
  )
}

function DbConfigRow({
  db,
  config,
  storagePath,
  retentionDays,
}: {
  db: string
  config: DbConfig | undefined
  storagePath: string
  retentionDays: number
}) {
  const [destinationPath, setDestinationPath] = React.useState(config?.destinationPath ?? `${storagePath}/${db}`)
  const [keepLatest, setKeepLatest] = React.useState(String(config?.keepLatest ?? retentionDays))
  const [saving, setSaving] = React.useState(false)
  const { refreshDbConfigs } = useDb()

  async function handleSave() {
    const keepNum = Number(keepLatest)
    if (!destinationPath.trim()) {
      toast.error("Destination path is required")
      return
    }
    if (!Number.isFinite(keepNum) || keepNum < 1 || keepNum > 365) {
      toast.error("Retention must be between 1 and 365")
      return
    }
    setSaving(true)
    try {
      await upsertDbConfig({
        db,
        destinationPath: destinationPath.trim(),
        scheduleCron: config?.scheduleCron ?? '0 2 * * *',
        keepLatest: Math.floor(keepNum),
        enabled: config?.enabled ?? true,
      })
      toast.success(`Config saved for "${db}"`)
      await refreshDbConfigs()
    } catch (err) {
      toast.error("Failed to save config", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border border-dashed p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <Label className="text-xs">Backup directory</Label>
        <Input
          value={destinationPath}
          onChange={(e) => setDestinationPath(e.target.value)}
          className="font-mono text-sm"
        />
      </div>
      <div className="flex flex-col gap-2 w-24">
        <Label className="text-xs">Retention (days)</Label>
        <Input
          type="number"
          min={1}
          max={365}
          value={keepLatest}
          onChange={(e) => setKeepLatest(e.target.value)}
          className="text-sm"
        />
      </div>
      <Button onClick={handleSave} size="sm" disabled={saving}>
        {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : <SaveIcon className="size-3.5" />}
        {saving ? "Saving\u2026" : "Save"}
      </Button>
    </div>
  )
}

function ServerRow({ server, onRefresh }: { server: ServerRecord; onRefresh: () => void }) {
  const [isDiscovering, setIsDiscovering] = React.useState(false)
  const [isDeleting, setIsDeleting] = React.useState(false)
  const [cdcLoadingDb, setCdcLoadingDb] = React.useState<string | null>(null)
  const [expandedDbs, setExpandedDbs] = React.useState<Set<string>>(new Set())
  const { cdcStatuses, setupCdc, refreshCdcStatus, dbConfigs, storagePath, retentionDays } = useDb()

  const protectedDbs = new Set(cdcStatuses.map((s) => s.db))

  function toggleDb(db: string) {
    setExpandedDbs((prev) => {
      const next = new Set(prev)
      if (next.has(db)) next.delete(db)
      else next.add(db)
      return next
    })
  }

  async function handleDelete() {
    setIsDeleting(true)
    try {
      await deleteServer(server.id)
      toast.success(`Server "${server.label}" deleted`)
      onRefresh()
    } catch (err) {
      toast.error("Failed to delete server", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsDeleting(false)
    }
  }

  async function handleDiscover() {
    setIsDiscovering(true)
    try {
      await discoverDatabases(server.id)
      toast.success(`Databases refreshed for "${server.label}"`)
      onRefresh()
    } catch (err) {
      toast.error("Discovery failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsDiscovering(false)
    }
  }

  async function handleSetupCdc(db: string) {
    setCdcLoadingDb(db)
    try {
      await setupCdc(db)
      toast.success(`CDC protection enabled for "${db}"`)
      onRefresh()
      refreshCdcStatus()
    } catch (err) {
      toast.error("CDC setup failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setCdcLoadingDb(null)
    }
  }

  return (
    <div className="rounded-md border px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary/10">
            <ServerIcon className="size-4 text-primary" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-medium">{server.label}</span>
            <span className="text-xs text-muted-foreground font-mono truncate max-w-80">{maskConnectionUrl(server.connectionUrl)}</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={handleDiscover} disabled={isDiscovering}>
            {isDiscovering ? <Loader2Icon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={isDeleting} />}>
              {isDeleting ? <Loader2Icon className="size-3.5 animate-spin" /> : <Trash2Icon className="size-3.5" />}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete server &quot;{server.label}&quot;?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will remove the server and all its discovered databases. CDC protection, replication slots, and scheduled jobs for these databases will also be cleaned up.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="text-xs">{server.engine}</Badge>
        <Badge variant="outline" className="text-xs gap-1">
          <DatabaseIcon className="size-3" />
          {server.databases.length} database{server.databases.length !== 1 ? "s" : ""}
        </Badge>
        {server.databases.length === 0 && (
          <span className="text-xs text-muted-foreground">No databases discovered</span>
        )}
      </div>
      {server.databases.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {server.databases.map((db) => {
            const cfg = dbConfigs.find((c) => c.db === db)
            return (
              <div key={db}>
                <div className="flex items-center gap-2">
                  <button
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground cursor-pointer"
                    onClick={() => toggleDb(db)}
                  >
                    {expandedDbs.has(db) ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
                  </button>
                  <Badge variant="outline" className="text-xs font-mono">{db}</Badge>
                  {protectedDbs.has(db) ? (
                    <span title="CDC protected"><RadioIcon className="size-3 text-emerald-500" /></span>
                  ) : server.engine === "PostgreSQL" ? (
                    <button
                      className="text-xs text-muted-foreground hover:text-primary cursor-pointer disabled:opacity-50"
                      onClick={() => handleSetupCdc(db)}
                      disabled={cdcLoadingDb === db}
                      title="Enable CDC protection"
                    >
                      {cdcLoadingDb === db ? "\u2026" : "+CDC"}
                    </button>
                  ) : null}
                  {cfg && (
                    <Badge variant="secondary" className="text-xs">configured</Badge>
                  )}
                </div>
                {expandedDbs.has(db) && (
                  <div className="mt-2 ml-5">
                    <DbConfigRow
                      db={db}
                      config={cfg}
                      storagePath={storagePath}
                      retentionDays={retentionDays}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function StorageSettingsCard() {
  const { storagePath, retentionDays, setStoragePath, setRetentionDays, refreshStorageSettings } = useDb()
  const [path, setPath] = React.useState(storagePath)
  const [retention, setRetention] = React.useState(String(retentionDays))
  const [isSaving, setIsSaving] = React.useState(false)

  async function handleSave() {
    const retentionNum = Number(retention)
    if (!path.trim()) {
      toast.error("Backup directory is required")
      return
    }
    if (!Number.isFinite(retentionNum) || retentionNum < 1 || retentionNum > 365) {
      toast.error("Retention days must be a number between 1 and 365")
      return
    }
    setIsSaving(true)
    try {
      await saveStorageSettings({ storagePath: path.trim(), retentionDays: Math.floor(retentionNum) })
      setStoragePath(path.trim())
      setRetentionDays(Math.floor(retentionNum))
      toast.success("Storage settings saved")
      refreshStorageSettings()
    } catch (err) {
      toast.error("Failed to save storage settings", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <HardDriveIcon className="size-4" />
          Storage defaults
        </CardTitle>
        <CardDescription>
          Global defaults used as fallback when a database has no explicit configuration.
          Override per-database by expanding a database above.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <div className="flex flex-col gap-2">
          <Label htmlFor="storage-path" className="text-xs">Backup directory</Label>
          <Input
            id="storage-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            className="font-mono text-sm"
            placeholder={storagePath}
          />
          <span className="text-xs text-muted-foreground">
            Base directory for backup files. Each database gets a subdirectory.
          </span>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="retention-days" className="text-xs">Retention (days)</Label>
          <Input
            id="retention-days"
            type="number"
            min={1}
            max={365}
            value={retention}
            onChange={(e) => setRetention(e.target.value)}
            className="text-sm w-32"
          />
          <span className="text-xs text-muted-foreground">
            Backups older than this will be automatically deleted.
          </span>
        </div>
        <div>
          <Button onClick={handleSave} size="sm" disabled={isSaving}>
            {isSaving ? (
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <SaveIcon className="mr-1.5 size-3.5" />
            )}
            {isSaving ? "Saving\u2026" : "Save defaults"}
          </Button>
        </div>
        <Separator />
        <div className="flex flex-col gap-2 text-xs">
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <span className="text-muted-foreground">CDC stream directory</span>
            <span className="font-mono font-medium">{storagePath.replace(/\/backups\/pg$/, '/pg-cdc')}/&lt;db&gt;</span>
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <span className="text-muted-foreground">Config file</span>
            <span className="font-mono font-medium">/etc/pg-cdc/protected_dbs.yaml</span>
          </div>
          <span className="text-muted-foreground pl-1">CDC paths are managed by the installer script.</span>
        </div>
      </CardContent>
    </Card>
  )
}

export default function SettingsPage() {
  const { servers, refreshServers, loading, storagePath, retentionDays } = useDb()

  return (
    <AppShell>
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Settings</h2>
          <p className="text-sm text-muted-foreground">
            Configure database servers, per-database backup paths and retention.
          </p>
        </div>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <ServerIcon className="size-4" />
              Servers
            </CardTitle>
            <CardDescription>
              Manage database servers. Expand a database to configure its backup directory and retention policy.
              Per-database settings override the global defaults below.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" />
                Loading servers\u2026
              </div>
            ) : servers.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
                <ServerIcon className="size-8" />
                <span>No servers configured. Add one below to get started.</span>
              </div>
            ) : (
              servers.map((s) => <ServerRow key={s.id} server={s} onRefresh={refreshServers} />)
            )}
            <Separator />
            <AddServerCard onAdded={refreshServers} />
          </CardContent>
        </Card>

        <StorageSettingsCard key={`global-${storagePath}-${retentionDays}`} />
      </div>
    </AppShell>
  )
}
