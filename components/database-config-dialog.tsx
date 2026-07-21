"use client"

import * as React from "react"
import { toast } from "sonner"
import { SettingsIcon, Loader2Icon, CheckCircle2Icon } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { upsertDbConfig, deleteDbConfig } from "@/lib/api"
import type { DbConfig } from "@/lib/api"

const SCHEDULE_PRESETS: { label: string; value: string; description: string }[] = [
  { label: "Every minute", value: "* * * * *", description: "Runs every minute" },
  { label: "Every 15 minutes", value: "*/15 * * * *", description: "Runs every 15 minutes" },
  { label: "Every 30 minutes", value: "*/30 * * * *", description: "Runs every 30 minutes" },
  { label: "Every hour", value: "0 * * * *", description: "Runs at minute 0 of every hour" },
  { label: "Every day at 02:00", value: "0 2 * * *", description: "Daily at 2 AM" },
  { label: "Every Monday 03:00", value: "0 3 * * 1", description: "Weekly on Monday at 3 AM" },
  { label: "1st of month 04:00", value: "0 4 1 * *", description: "Monthly on day 1 at 4 AM" },
]

function isPresetValue(value: string): boolean {
  return SCHEDULE_PRESETS.some((p) => p.value === value)
}

function presetLabel(value: string): string {
  return SCHEDULE_PRESETS.find((p) => p.value === value)?.label ?? value
}

function ConfigForm({
  dbName,
  config,
  onOpenChange,
  onSaved,
}: {
  dbName: string
  config: DbConfig | null
  onOpenChange: (open: boolean) => void
  onSaved?: () => void
}) {
  const defaultPath = `/var/backups/pg/${dbName}`
  const [destinationPath, setDestinationPath] = React.useState(config?.destinationPath ?? defaultPath)
  const [scheduleCron, setScheduleCron] = React.useState(config?.scheduleCron ?? SCHEDULE_PRESETS[4].value)
  const [keepLatest, setKeepLatest] = React.useState(String(config?.keepLatest ?? 7))
  const [enabled, setEnabled] = React.useState(config?.enabled ?? true)
  const [isSaving, setIsSaving] = React.useState(false)
  const [isDeleting, setIsDeleting] = React.useState(false)
  const [useCustomSchedule, setUseCustomSchedule] = React.useState(
    config ? !isPresetValue(config.scheduleCron) : false
  )

  async function handleSave() {
    const keepNum = Number(keepLatest)
    if (!Number.isFinite(keepNum) || keepNum < 1 || keepNum > 365) {
      toast.error("Keep latest must be a number between 1 and 365")
      return
    }
    if (!destinationPath.trim()) {
      toast.error("Destination path is required")
      return
    }
    setIsSaving(true)
    try {
      await upsertDbConfig({
        db: dbName,
        destinationPath: destinationPath.trim(),
        scheduleCron: scheduleCron.trim(),
        keepLatest: Math.floor(keepNum),
        enabled,
      })
      toast.success(`Configuration saved for "${dbName}"`)
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      toast.error("Failed to save configuration", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDelete() {
    setIsDeleting(true)
    try {
      await deleteDbConfig(dbName)
      toast.success(`Configuration removed for "${dbName}"`)
      onSaved?.()
      onOpenChange(false)
    } catch (err) {
      toast.error("Failed to delete configuration", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <SettingsIcon className="size-4" />
          Configure &quot;{dbName}&quot;
        </DialogTitle>
        <DialogDescription>
          Set the backup destination, schedule, and retention policy for this database.
          This configuration can be edited at any time.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4 py-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="dest-path" className="text-xs">Destination path</Label>
          <Input
            id="dest-path"
            value={destinationPath}
            onChange={(e) => setDestinationPath(e.target.value)}
            className="font-mono text-sm"
            placeholder={defaultPath}
          />
          <span className="text-xs text-muted-foreground">
            Where backup files will be stored on disk.
          </span>
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <Label className="text-xs">Schedule</Label>
          {!useCustomSchedule ? (
            <Select value={scheduleCron} onValueChange={(v) => {
              if (v === "__custom__") {
                setUseCustomSchedule(true)
              } else if (v) {
                setScheduleCron(v)
              }
            }}>
              <SelectTrigger>
                <SelectValue placeholder="Select schedule" />
              </SelectTrigger>
              <SelectContent>
                {SCHEDULE_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    <div className="flex flex-col">
                      <span>{p.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {p.value} &mdash; {p.description}
                      </span>
                    </div>
                  </SelectItem>
                ))}
                <SelectItem value="__custom__">
                  <div className="flex flex-col">
                    <span>Custom expression</span>
                    <span className="text-xs text-muted-foreground">
                      Write your own cron expression
                    </span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <div className="flex flex-col gap-2">
              <Input
                value={scheduleCron}
                onChange={(e) => setScheduleCron(e.target.value)}
                className="font-mono text-sm"
                placeholder="0 2 * * *"
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Format: minute hour day month weekday
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    setUseCustomSchedule(false)
                    setScheduleCron(SCHEDULE_PRESETS[4].value)
                  }}
                >
                  Use presets
                </Button>
              </div>
            </div>
          )}
          {scheduleCron && (
            <span className="text-xs text-muted-foreground">
              Active schedule: <span className="font-mono">{presetLabel(scheduleCron)}</span>
            </span>
          )}
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <Label htmlFor="keep-latest" className="text-xs">Keep latest</Label>
          <Input
            id="keep-latest"
            type="number"
            min={1}
            max={365}
            value={keepLatest}
            onChange={(e) => setKeepLatest(e.target.value)}
            className="text-sm w-full"
          />
          <span className="text-xs text-muted-foreground">
            Number of backups to retain. When exceeded, the oldest backup will be deleted automatically.
          </span>
        </div>

        <Separator />

        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <Label htmlFor="enabled-toggle" className="text-xs">Enabled</Label>
            <span className="text-xs text-muted-foreground">
              Disabled configurations will not run scheduled backups.
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
        {config && (
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isDeleting || isSaving}
            size="sm"
            className="mr-auto"
          >
            {isDeleting ? (
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
            ) : null}
            Remove
          </Button>
        )}
        <Button variant="outline" onClick={() => onOpenChange(false)} size="sm">
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={isSaving} size="sm">
          {isSaving ? (
            <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
          ) : (
            <CheckCircle2Icon className="mr-1.5 size-3.5" />
          )}
          {isSaving ? "Saving\u2026" : "Save configuration"}
        </Button>
      </DialogFooter>
    </>
  )
}

export function DatabaseConfigDialog({
  dbName,
  config,
  open,
  onOpenChange,
  onSaved,
}: {
  dbName: string
  config: DbConfig | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open && (
          <ConfigForm
            dbName={dbName}
            config={config}
            onOpenChange={onOpenChange}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
