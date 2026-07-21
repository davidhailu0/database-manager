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
} from "lucide-react"

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
} from "@/lib/api"
import type { ServerRecord } from "@/lib/api"

function AddServerCard({ onAdded }: { onAdded: () => void }) {
  const [label, setLabel] = React.useState("")
  const [url, setUrl] = React.useState("")
  const [sshUser, setSshUser] = React.useState("")
  const [isAdding, setIsAdding] = React.useState(false)

  async function handleAdd() {
    if (!label.trim() || !url.trim()) {
      toast.error("Label and connection URL are required")
      return
    }
    setIsAdding(true)
    try {
      const result = await createServer(label.trim(), url.trim(), sshUser.trim() || undefined)
      let msg = ''
      if (result.stanzaCreated) msg = ' — stanza created'
      else if (result.pgDataDir) msg = ' — stanza config added'
      else if (result.stanzaMessage) msg = ` — ${result.stanzaMessage}`
      toast.success(`Server "${label}" added${msg}`)

      // Auto-setup pg-cdc for discovered PostgreSQL databases
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

function ServerRow({ server, onRefresh }: { server: ServerRecord; onRefresh: () => void }) {
  const [isDiscovering, setIsDiscovering] = React.useState(false)
  const { cdcStatuses, setupCdc } = useDb()

  const protectedDbs = new Set(cdcStatuses.map((s) => s.db))

  async function handleDelete() {
    try {
      await deleteServer(server.id)
      toast.success(`Server "${server.label}" deleted`)
      onRefresh()
    } catch (err) {
      toast.error("Failed to delete server", {
        description: err instanceof Error ? err.message : String(err),
      })
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

  return (
    <div className="rounded-md border px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary/10">
            <ServerIcon className="size-4 text-primary" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-medium">{server.label}</span>
            <span className="text-xs text-muted-foreground font-mono truncate max-w-80">{server.connectionUrl}</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={handleDiscover} disabled={isDiscovering}>
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Button variant="ghost" size="sm" onClick={handleDelete}>
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="text-xs">{server.engine}</Badge>
        <Badge variant="outline" className="text-xs gap-1">
          <DatabaseIcon className="size-3" />
          {server.databases.length} database{server.databases.length !== 1 ? "s" : ""}
        </Badge>
        {server.databases.map((db) => (
          <div key={db} className="flex items-center gap-1">
            <Badge variant="outline" className="text-xs font-mono">{db}</Badge>
            {protectedDbs.has(db) ? (
              <span title="CDC protected"><RadioIcon className="size-3 text-emerald-500" /></span>
            ) : server.engine === "PostgreSQL" ? (
              <button
                className="text-xs text-muted-foreground hover:text-primary cursor-pointer"
                onClick={async () => {
                  try {
                    await setupCdc(db)
                    toast.success(`CDC protection enabled for "${db}"`)
                    onRefresh()
                  } catch (err) {
                    toast.error("CDC setup failed", {
                      description: err instanceof Error ? err.message : String(err),
                    })
                  }
                }}
                title="Enable CDC protection"
              >
                +CDC
              </button>
            ) : null}
          </div>
        ))}
        {server.databases.length === 0 && (
          <span className="text-xs text-muted-foreground">No databases discovered</span>
        )}
      </div>
    </div>
  )
}

export default function SettingsPage() {
  const { servers, refreshServers } = useDb()

  return (
    <AppShell>
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Settings</h2>
          <p className="text-sm text-muted-foreground">
            Configure database servers. Discovered databases are automatically protected with pg-cdc.
          </p>
        </div>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <ServerIcon className="size-4" />
              Servers
            </CardTitle>
            <CardDescription>
              Manage database servers. Each server is discovered via its connection URL.
              Databases on each server can be configured individually from the Databases page.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {servers.length === 0 ? (
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

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <HardDriveIcon className="size-4" />
              Storage defaults
            </CardTitle>
            <CardDescription>
              Default paths used when configuring database backups.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
              <span className="text-muted-foreground">Backup directory</span>
              <span className="font-mono font-medium">/var/backups/pg/&lt;db&gt;</span>
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
              <span className="text-muted-foreground">CDC stream directory</span>
              <span className="font-mono font-medium">/var/pg-cdc/&lt;db&gt;</span>
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
              <span className="text-muted-foreground">Config file</span>
              <span className="font-mono font-medium">/etc/pg-cdc/protected_dbs.yaml</span>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
