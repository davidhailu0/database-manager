"use client"

import * as React from "react"
import {
  TimerIcon,
  PlusIcon,
  Trash2Icon,
  PlayIcon,
  PauseIcon,
  ClockIcon,
  DatabaseIcon,
  CheckCircle2Icon,
  Loader2Icon,
  Link2Icon,
  AlertCircleIcon,
  ServerIcon,
  RadioIcon,
  HardDriveDownloadIcon,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
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
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { useDb } from "@/lib/db-context"
import type { CronJob } from "@/lib/api"
import { listCronJobs, createCronJob, updateCronJob, deleteCronJob, runCronJobNow } from "@/lib/api"

const presets: { label: string; value: string; description: string }[] = [
  { label: "Every hour", value: "0 * * * *", description: "Runs at minute 0 of every hour" },
  { label: "Every day at 02:00", value: "0 2 * * *", description: "Daily at 2 AM" },
  { label: "Every Monday 03:00", value: "0 3 * * 1", description: "Weekly on Monday at 3 AM" },
  { label: "1st of month 04:00", value: "0 4 1 * *", description: "Monthly on day 1 at 4 AM" },
  { label: "Every 15 minutes", value: "*/15 * * * *", description: "High frequency" },
]

function presetLabel(value: string) {
  return presets.find((p) => p.value === value)?.label ?? value
}

export default function CronPage() {
  const { servers } = useDb()
  const [jobs, setJobs] = React.useState<CronJob[]>([])

  React.useEffect(() => {
    listCronJobs().then(setJobs).catch(() => setJobs([]))
  }, [])
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [isSaving, setIsSaving] = React.useState(false)

  const [name, setName] = React.useState("")
  const [serverId, setServerId] = React.useState("")
  const [db, setDb] = React.useState("")
  const [preset, setPreset] = React.useState<string>(presets[1].value)
  const [customExpr, setCustomExpr] = React.useState("")
  const [useCustom, setUseCustom] = React.useState(false)
  const [enabled, setEnabled] = React.useState(true)
  const [backupType, setBackupType] = React.useState<'pgbackrest' | 'cdc'>('pgbackrest')

  const selectedServer = servers.find((s) => s.id === serverId)
  const serverDbs = selectedServer ? selectedServer.databases : servers.flatMap((s) => s.databases)
  const effectiveDb = db || serverDbs[0] || ""

  function resetForm() {
    setName("")
    setServerId(servers[0]?.id ?? "")
    setDb("")
    setPreset(presets[1].value)
    setCustomExpr("")
    setUseCustom(false)
    setEnabled(true)
    setBackupType('pgbackrest')
  }

  async function saveJob() {
    const expression = useCustom ? customExpr.trim() : preset
    if (!name.trim()) {
      toast.error("Name is required")
      return
    }
    if (!expression) {
      toast.error("Cron expression is required")
      return
    }
    // pgBackRest jobs store the server label (stanza) in `db`; CDC jobs store the database name
    const targetDb = backupType === 'pgbackrest'
      ? (selectedServer?.label || '')
      : effectiveDb
    if (!targetDb) {
      toast.error(backupType === 'cdc'
        ? "Database is required for CDC backups"
        : "Server is required for pgBackRest backups")
      return
    }
    setIsSaving(true)
    try {
      const result = await createCronJob({ name: name.trim(), db: targetDb, expression, enabled, source: backupType })
      setJobs((prev) => [result.job, ...prev])
      setDialogOpen(false)
      resetForm()
      toast.success("Cron job created", {
        description: `${name} \u00b7 ${expression}`,
      })
    } catch (err) {
      toast.error("Failed to create cron job", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsSaving(false)
    }
  }

  async function toggleJob(job: CronJob) {
    const newEnabled = !job.enabled
    try {
      await updateCronJob(job.id, newEnabled)
      setJobs((prev) =>
        prev.map((j) => (j.id === job.id ? { ...j, enabled: newEnabled } : j))
      )
    } catch (err) {
      toast.error("Failed to toggle job", {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function deleteJob(id: string) {
    try {
      await deleteCronJob(id)
      setJobs((prev) => prev.filter((j) => j.id !== id))
      toast.success("Cron job deleted")
    } catch (err) {
      toast.error("Failed to delete cron job", {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function runNow(job: CronJob) {
    toast.loading("Triggering backup\u2026", { id: "run-toast" })
    try {
      await runCronJobNow(job.id)
      toast.success("Backup triggered", {
        id: "run-toast",
        description: `${job.name} started manually`,
      })
    } catch (err) {
      toast.error("Failed to trigger backup", {
        id: "run-toast",
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <AppShell>
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Cron Jobs</h2>
            <p className="text-sm text-muted-foreground">
              Configure scheduled full backups for your databases.
            </p>
          </div>
          {servers.length === 0 && (
            <Button variant="outline" size="sm" nativeButton={false} render={<a href="/settings" />}>
              <Link2Icon className="mr-1.5 size-3.5" />
              Add server
            </Button>
          )}
        </div>

        <Card className="shadow-none">
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle className="text-sm font-semibold">Scheduled jobs</CardTitle>
              <CardDescription>
                Each job performs a full backup of the selected database on the given schedule.
              </CardDescription>
            </div>
            <Dialog open={dialogOpen} onOpenChange={(open) => {
              setDialogOpen(open)
              if (!open) resetForm()
            }}>
              <DialogTrigger render={<Button size="sm" />}>
                <PlusIcon className="mr-1.5 size-3.5" />
                New job
              </DialogTrigger>
              <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle>New cron job</DialogTitle>
                  <DialogDescription>
                    Schedule a recurring full backup for a database.
                  </DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4 py-2">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cron-name" className="text-xs">Job name</Label>
                    <Input
                      id="cron-name"
                      placeholder="e.g. Postgres nightly full"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cron-server" className="text-xs">Server</Label>
                    <Select value={serverId} onValueChange={(v) => { if (v) { setServerId(v); setDb("") } }}>
                      <SelectTrigger id="cron-server">
                        <SelectValue placeholder="Select server">{selectedServer?.label || "Select server"}</SelectValue>
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
                  {backupType === 'cdc' && (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="cron-db" className="text-xs">Database</Label>
                    <Select value={effectiveDb} onValueChange={(v) => v && setDb(v)}>
                      <SelectTrigger id="cron-db">
                        <SelectValue placeholder="Select database">{effectiveDb || "Select database"}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {serverDbs.length === 0 ? (
                          <SelectItem value="__none__" disabled>
                            No databases available
                          </SelectItem>
                        ) : (
                          serverDbs.map((name) => (
                            <SelectItem key={name} value={name}>
                              <span className="flex items-center gap-2">
                                <DatabaseIcon className="size-3.5" />
                                {name}
                              </span>
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    {servers.length === 0 && (
                      <span className="flex items-center gap-1 text-xs text-amber-600">
                        <AlertCircleIcon className="size-3" />
                        No servers configured.{" "}
                        <a href="/settings" className="underline underline-offset-2">Settings</a>
                      </span>
                    )}
                  </div>
                  )}

                  <div className="flex flex-col gap-2">
                    <Label className="text-xs">Backup type</Label>
                    <div className="flex gap-2 rounded-md border p-1 bg-muted/30 w-fit">
                      <Button
                        variant={backupType === 'pgbackrest' ? 'default' : 'ghost'}
                        size="sm"
                        onClick={() => setBackupType('pgbackrest')}
                        type="button"
                      >
                        <HardDriveDownloadIcon className="mr-1.5 size-3.5" />
                        pgBackRest (cluster)
                      </Button>
                      <Button
                        variant={backupType === 'cdc' ? 'default' : 'ghost'}
                        size="sm"
                        onClick={() => setBackupType('cdc')}
                        type="button"
                      >
                        <RadioIcon className="mr-1.5 size-3.5" />
                        pg-cdc (single DB)
                      </Button>
                    </div>
                  </div>

                  <Separator />

                  <div className="flex items-center justify-between">
                    <div className="flex flex-col">
                      <Label htmlFor="custom-toggle" className="text-xs">Custom expression</Label>
                      <span className="text-xs text-muted-foreground">
                        Write your own cron expression instead of using a preset.
                      </span>
                    </div>
                    <Switch
                      id="custom-toggle"
                      checked={useCustom}
                      onCheckedChange={setUseCustom}
                    />
                  </div>

                  {!useCustom ? (
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="cron-preset" className="text-xs">Schedule</Label>
                      <Select value={preset} onValueChange={(v) => v && setPreset(v)}>
                        <SelectTrigger id="cron-preset">
                          <SelectValue placeholder="Select schedule" />
                        </SelectTrigger>
                        <SelectContent>
                          {presets.map((p) => (
                            <SelectItem key={p.value} value={p.value}>
                              <div className="flex flex-col">
                                <span>{p.label}</span>
                                <span className="text-xs text-muted-foreground">
                                  {p.value} &mdash; {p.description}
                                </span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="cron-expr" className="text-xs">Cron expression</Label>
                      <Input
                        id="cron-expr"
                        placeholder="0 2 * * *"
                        value={customExpr}
                        onChange={(e) => setCustomExpr(e.target.value)}
                        className="font-mono"
                      />
                      <span className="text-xs text-muted-foreground">
                        Format: minute hour day month weekday (5 fields).
                      </span>
                    </div>
                  )}

                  <Separator />

                  <div className="flex items-center justify-between">
                    <div className="flex flex-col">
                      <Label htmlFor="enabled-toggle" className="text-xs">Enabled</Label>
                      <span className="text-xs text-muted-foreground">
                        Disabled jobs will not run on schedule.
                      </span>
                    </div>
                    <Switch
                      id="enabled-toggle"
                      checked={enabled}
                      onCheckedChange={setEnabled}
                    />
                  </div>
                </div>

                <DialogFooter>
                  <Button variant="outline" onClick={() => setDialogOpen(false)} size="sm">
                    Cancel
                  </Button>
                  <Button onClick={saveJob} disabled={isSaving} size="sm">
                    {isSaving ? (
                      <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2Icon className="mr-1.5 size-3.5" />
                    )}
                    {isSaving ? "Saving\u2026" : "Create job"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead>Next run</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                      No cron jobs configured. Click &quot;New job&quot; to create one.
                    </TableCell>
                  </TableRow>
                ) : (
                  jobs.map((j) => (
                    <TableRow key={j.id}>
                      <TableCell className="font-medium">{j.name}</TableCell>
                      <TableCell className="font-mono text-xs">{j.db || '—'}</TableCell>
                      <TableCell>
                        {j.source === 'cdc' ? (
                          <Badge variant="secondary" className="bg-purple-50 text-purple-700 border-purple-200 gap-1">
                            <RadioIcon className="size-3" />
                            CDC
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="bg-orange-50 text-orange-700 border-orange-200 gap-1">
                            <HardDriveDownloadIcon className="size-3" />
                            pgBackRest
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span>{presetLabel(j.expression)}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {j.expression}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{j.lastRun}</TableCell>
                      <TableCell className="text-muted-foreground">{j.nextRun}</TableCell>
                      <TableCell>
                        {j.enabled ? (
                          <Badge variant="secondary" className="bg-emerald-50 text-emerald-700 border-emerald-200">Active</Badge>
                        ) : (
                          <Badge variant="secondary">Paused</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => runNow(j)}>
                            <PlayIcon className="mr-1 size-3.5" />
                            Run
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => toggleJob(j)}>
                            {j.enabled ? (
                              <PauseIcon className="mr-1 size-3.5" />
                            ) : (
                              <PlayIcon className="mr-1 size-3.5" />
                            )}
                            {j.enabled ? "Pause" : "Enable"}
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>
                              <Trash2Icon className="size-3.5" />
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete {j.name}?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This scheduled job will be permanently removed.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => deleteJob(j.id)}>
                                  Delete
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Common schedules</CardTitle>
            <CardDescription>Reference for typical cron expressions.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {presets.map((p) => (
                <div key={p.value} className="flex items-start gap-3 rounded-md border p-3">
                  <ClockIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">{p.label}</span>
                    <span className="font-mono text-xs text-muted-foreground">{p.value}</span>
                    <span className="text-xs text-muted-foreground">{p.description}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <TimerIcon className="size-3.5 shrink-0" />
          <span>All scheduled jobs perform a <strong>Full</strong> backup.</span>
        </div>
      </div>
    </AppShell>
  )
}
