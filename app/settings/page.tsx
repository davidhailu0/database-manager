"use client"

import * as React from "react"
import { toast } from "sonner"
import { Trash2Icon, PlusIcon, HardDriveIcon, FileTextIcon, ServerIcon, RefreshCwIcon, RadioIcon } from "lucide-react"

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
  getPgBackRestConfig, savePgBackRestConfig, stanzaCreate,
  createServer, deleteServer, discoverDatabases,
  setupCdcForDb, isRemoteUrl,
} from "@/lib/api"
import type { PgBackRestConfig, ServerRecord } from "@/lib/api"

function AddServerCard({ onAdded }: { onAdded: () => void }) {
  const [label, setLabel] = React.useState("")
  const [url, setUrl] = React.useState("")
  const [sshUser, setSshUser] = React.useState("")
  const [isAdding, setIsAdding] = React.useState(false)
  const { setupCdc } = useDb()

  async function handleAdd() {
    if (!label.trim() || !url.trim()) {
      toast.error("Label and connection URL are required")
      return
    }
    setIsAdding(true)
    try {
      const result = await createServer(label.trim(), url.trim(), sshUser.trim() || undefined)
      let stanzaMsg = ''
      if (result.stanzaCreated) stanzaMsg = ' — stanza created'
      else if (result.pgDataDir) stanzaMsg = ' — stanza config added'
      else if (result.stanzaMessage) stanzaMsg = ` — ${result.stanzaMessage}`
      toast.success(`Server "${label}" added${stanzaMsg}`)

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
          {isAdding ? "Adding…" : "Add server"}
        </Button>
      </div>
    </div>
  )
}

function ServerRow({ server, onRefresh }: { server: ServerRecord; onRefresh: () => void }) {
  const [isDiscovering, setIsDiscovering] = React.useState(false)
  const { cdcStatuses, setupCdc } = useDb()

  const protectedDbs = new Set(cdcStatuses.map(s => s.db))

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

function PgBackRestCard() {
  const [config, setConfig] = React.useState<PgBackRestConfig | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const [isSaving, setIsSaving] = React.useState(false)
  const [newStanzaName, setNewStanzaName] = React.useState("")
  const [creatingStanza, setCreatingStanza] = React.useState<string | null>(null)

  React.useEffect(() => {
    getPgBackRestConfig().then((c) => { setConfig(c); setIsLoading(false) }).catch(() => setIsLoading(false))
  }, [])

  function updateValue(section: string, idx: number, newValue: string) {
    if (!config) return
    const updated = { ...config }
    updated[section] = updated[section].map((pair, i) => i === idx ? { ...pair, value: newValue } : pair)
    setConfig(updated)
  }

  function updateKey(section: string, idx: number, newKey: string) {
    if (!config) return
    const updated = { ...config }
    updated[section] = updated[section].map((pair, i) => i === idx ? { ...pair, key: newKey } : pair)
    setConfig(updated)
  }

  function addPair(section: string) {
    if (!config) return
    const updated = { ...config }
    updated[section] = [...updated[section], { key: '', value: '' }]
    setConfig(updated)
  }

  function removePair(section: string, idx: number) {
    if (!config) return
    const updated = { ...config }
    updated[section] = updated[section].filter((_, i) => i !== idx)
    if (updated[section].length === 0) delete updated[section]
    setConfig(updated)
  }

  async function addStanza() {
    const name = newStanzaName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
    if (!name) return
    if (!config) return
    if (config[name]) {
      toast.error(`Stanza "${name}" already exists`)
      return
    }
    const updated = { ...config, [name]: [] }
    setConfig(updated)
    setNewStanzaName("")
    try {
      await savePgBackRestConfig(updated)
      toast.success(`Stanza "${name}" added to config`)
    } catch (err) {
      toast.error("Failed to save config", {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function removeStanza(section: string) {
    if (!config) return
    if (section === 'global') {
      toast.error("Cannot remove the [global] section")
      return
    }
    const updated = { ...config }
    delete updated[section]
    setConfig(updated)
  }

  async function save() {
    if (!config) return
    setIsSaving(true)
    try {
      await savePgBackRestConfig(config)
      toast.success("pgBackRest config saved")
    } catch (err) {
      toast.error("Failed to save config", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Card className="shadow-none">
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle className="text-sm font-semibold">pgBackRest Config</CardTitle>
          <CardDescription>
            Edit /etc/pgbackrest/pgbackrest.conf — stanza paths, retention, compression, S3, etc.
          </CardDescription>
        </div>
        <FileTextIcon className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading config...</p>
        ) : !config || Object.keys(config).length === 0 ? (
          <p className="text-sm text-muted-foreground">No config file found.</p>
        ) : (
          Object.entries(config).map(([section, pairs]) => (
            <div key={section}>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-xs font-semibold text-primary">{section}</span>
                <span className="text-xs text-muted-foreground">[{section}]</span>
                <Button variant="ghost" size="xs" className="ml-auto" onClick={() => addPair(section)}>
                  + Add
                </Button>
                {section !== 'global' && (
                  <Button variant="ghost" size="xs" onClick={() => removeStanza(section)}>
                    <Trash2Icon className="size-3 text-muted-foreground hover:text-destructive" />
                  </Button>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                {pairs.map((pair, idx) => {
                  const isComment = pair.key === '' && pair.value.startsWith('#')
                  return (
                    <div key={idx} className="flex items-center gap-2">
                      {isComment ? (
                        <span className="font-mono text-xs text-muted-foreground/50">{pair.value}</span>
                      ) : (
                        <>
                          {pair.key ? (
                            <span className="w-48 shrink-0 font-mono text-xs text-muted-foreground truncate" title={pair.key}>{pair.key}</span>
                          ) : (
                            <Input
                              value={pair.key}
                              placeholder="key"
                              onChange={(e) => updateKey(section, idx, e.target.value)}
                              className="w-48 shrink-0 font-mono text-xs"
                            />
                          )}
                          {pair.key !== undefined && (
                            <Input
                              value={pair.value}
                              onChange={(e) => updateValue(section, idx, e.target.value)}
                              className="font-mono text-xs"
                              placeholder="value"
                            />
                          )}
                          {!isComment && (
                            <Button variant="ghost" size="xs" onClick={() => removePair(section, idx)}>
                              <Trash2Icon className="size-3" />
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))
        )}
        {config && Object.keys(config).length > 0 && <Separator />}
        {config && Object.keys(config).length > 0 && (
          <div className="flex items-center gap-2">
            <Input
              value={newStanzaName}
              onChange={(e) => setNewStanzaName(e.target.value)}
              placeholder="New stanza name"
              className="font-mono text-xs"
              onKeyDown={(e) => e.key === 'Enter' && addStanza()}
            />
            <Button variant="secondary" size="sm" onClick={addStanza} className="shrink-0" disabled={creatingStanza !== null}>
              <PlusIcon className="mr-1.5 size-3.5" />
              {creatingStanza ? "Creating…" : "Add stanza"}
            </Button>
          </div>
        )}
        {config && Object.keys(config).length > 0 && (
          <div className="flex gap-2">
            <Button onClick={save} size="sm" disabled={isSaving}>
              <HardDriveIcon className="mr-1.5 size-3.5" />
              {isSaving ? "Saving…" : "Save config"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// function StorageCard({
//   storagePath,
//   retentionDays,
//   onSave,
// }: {
//   storagePath: string
//   retentionDays: number
//   onSave: (path: string, days: number) => void
// }) {
//   const [pathInput, setPathInput] = React.useState(storagePath)
//   const [retentionInput, setRetentionInput] = React.useState(String(retentionDays))
//   const [isSaving, setIsSaving] = React.useState(false)

//   async function saveStorage() {
//     const days = Math.max(1, Math.min(365, Number(retentionInput) || 30))
//     const path = pathInput.trim() || "/var/backups/db"
//     setIsSaving(true)
//     try {
//       await saveStorageSettings({ storagePath: path, retentionDays: days })

//       try {
//         const config = await getPgBackRestConfig()
//         if (config && config['global']) {
//           const globalSection = config['global']
//           const pathIdx = globalSection.findIndex((p) => p.key === 'repo1-path')
//           if (pathIdx >= 0) {
//             globalSection[pathIdx] = { ...globalSection[pathIdx], value: path }
//           } else {
//             globalSection.push({ key: 'repo1-path', value: path })
//           }
//           const retentionIdx = globalSection.findIndex((p) => p.key === 'repo1-retention-full')
//           if (retentionIdx >= 0) {
//             globalSection[retentionIdx] = { ...globalSection[retentionIdx], value: String(days) }
//           } else {
//             globalSection.push({ key: 'repo1-retention-full', value: String(days) })
//           }
//           await savePgBackRestConfig(config)
//         }
//       } catch {
//         // pgBackRest config sync is optional
//       }

//       onSave(path, days)
//       setRetentionInput(String(days))
//       toast.success("Storage settings saved")
//     } catch (err) {
//       toast.error("Failed to save storage settings", {
//         description: err instanceof Error ? err.message : String(err),
//       })
//     } finally {
//       setIsSaving(false)
//     }
//   }

//   return (
//     <Card className="shadow-none">
//       <CardHeader>
//         <CardTitle className="text-sm font-semibold">Storage</CardTitle>
//         <CardDescription>Where backup files are stored and how long to keep them.</CardDescription>
//       </CardHeader>
//       <CardContent className="flex flex-col gap-4">
//         <div className="grid gap-4 md:grid-cols-2">
//           <div className="flex flex-col gap-2">
//             <Label htmlFor="dest" className="text-xs">Destination path</Label>
//             <Input
//               id="dest"
//               placeholder="/var/backups/db"
//               value={pathInput}
//               onChange={(e) => setPathInput(e.target.value)}
//               className="font-mono text-sm"
//             />
//           </div>
//           <div className="flex flex-col gap-2">
//             <Label htmlFor="retention" className="text-xs">Retention (days)</Label>
//             <Input
//               id="retention"
//               type="number"
//               min={1}
//               max={365}
//               value={retentionInput}
//               onChange={(e) => setRetentionInput(e.target.value)}
//               className="text-sm"
//             />
//           </div>
//         </div>
//         <div>
//           <Button onClick={saveStorage} size="sm" disabled={isSaving}>
//             <HardDriveIcon className="mr-1.5 size-3.5" />
//             {isSaving ? "Saving…" : "Save storage settings"}
//           </Button>
//         </div>
//       </CardContent>
//     </Card>
//   )
// }

export default function SettingsPage() {
  const { servers, refreshServers } = useDb()

  return (
    <AppShell>
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Settings</h2>
          <p className="text-sm text-muted-foreground">
            Configure database servers, storage, and pgBackRest.
          </p>
        </div>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Servers</CardTitle>
            <CardDescription>
              Manage database servers. Each server is discovered via its connection URL.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {servers.length === 0 ? (
              <p className="text-sm text-muted-foreground">No servers yet. Add one below.</p>
            ) : (
              servers.map((s) => <ServerRow key={s.id} server={s} onRefresh={refreshServers} />)
            )}
            <Separator />
            <AddServerCard onAdded={refreshServers} />
          </CardContent>
        </Card>

        <PgBackRestCard />
      </div>
    </AppShell>
  )
}
