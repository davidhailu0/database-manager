"use client"

import * as React from "react"
import { toast } from "sonner"
import {
  HardDriveUploadIcon,
  Loader2Icon,
  AlertTriangleIcon,
  DatabaseIcon,
  ClockIcon,
} from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { runRestore as apiRunRestore, runCdcRestore as apiRunCdcRestore } from "@/lib/api"
import type { Backup } from "@/lib/db-context"

function RestoreForm({
  backup,
  onOpenChange,
  onRestored,
}: {
  backup: Backup
  onOpenChange: (open: boolean) => void
  onRestored?: () => void
}) {
  const [targetDb, setTargetDb] = React.useState(backup.db)
  const [dataOnly, setDataOnly] = React.useState(false)
  const [createDb, setCreateDb] = React.useState(false)
  const [schemaOnly, setSchemaOnly] = React.useState(false)
  const [clean, setClean] = React.useState(false)
  const [restoreTime, setRestoreTime] = React.useState("")
  const [isRestoring, setIsRestoring] = React.useState(false)
  const [confirmOpen, setConfirmOpen] = React.useState(false)

  const isOverwrite = targetDb === backup.db
  const isCdcBackup = backup.source === "cdc"
  const pitrTs = restoreTime.trim() ? new Date(restoreTime) : null
  const hasPitr = pitrTs !== null && !isNaN(pitrTs.getTime())
  const canRestore =
    backup.status === "Completed" &&
    targetDb.trim().length > 0 &&
    (!restoreTime.trim() || hasPitr)

  async function handleRestore() {
    setConfirmOpen(false)
    setIsRestoring(true)
    try {
      let result: { message: string; output?: string }
      if (hasPitr && pitrTs) {
        const isoTs = pitrTs.toISOString()
        result = await apiRunCdcRestore(
          backup.db,
          targetDb.trim(),
          isoTs,
          isOverwrite,
        )
      } else {
        result = await apiRunRestore(backup.id, {
          targetDb: targetDb.trim(),
          dataOnly,
          createDb,
          schemaOnly,
          clean,
        })
      }
      toast.success("Restore completed", {
        description: result.message,
      })
      onRestored?.()
      onOpenChange(false)
    } catch (err) {
      toast.error("Restore failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsRestoring(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <HardDriveUploadIcon className="size-4" />
          Restore backup
        </DialogTitle>
        <DialogDescription>
          Restore from snapshot <span className="font-mono font-medium">{backup.id}</span> to a target database.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-4 py-2">
        <div className="grid grid-cols-2 gap-2 rounded-lg border p-3 text-xs">
          <div className="flex flex-col">
            <span className="text-muted-foreground">Source database</span>
            <span className="font-medium font-mono">{backup.db}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-muted-foreground">Size</span>
            <span className="font-medium">{backup.size}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-muted-foreground">Created</span>
            <span className="font-medium">{backup.createdAt}</span>
          </div>
          <div className="flex flex-col">
            <span className="text-muted-foreground">Type</span>
            <span className="font-medium">{backup.type}</span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="target-db" className="text-xs">Target database name</Label>
          <div className="flex items-center gap-2">
            <DatabaseIcon className="size-4 text-muted-foreground shrink-0" />
            <Input
              id="target-db"
              value={targetDb}
              onChange={(e) => setTargetDb(e.target.value)}
              className="font-mono text-sm"
              placeholder="e.g. mydb_restore"
            />
          </div>
          {isOverwrite ? (
            <div className="flex items-center gap-1.5 text-xs text-amber-600">
              <AlertTriangleIcon className="size-3" />
              <span>Restoring in-place will overwrite the existing database.</span>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">
              A new database will be created with the restored data.
            </span>
          )}
        </div>

        {isCdcBackup && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="restore-time" className="text-xs flex items-center gap-1.5">
            <ClockIcon className="size-3.5 text-muted-foreground" />
            Restore to specific time (optional)
          </Label>
          <Input
            id="restore-time"
            type="datetime-local"
            value={restoreTime}
            onChange={(e) => setRestoreTime(e.target.value)}
            className="text-sm"
          />
          <span className="text-xs text-muted-foreground">
            {hasPitr
              ? "Point-in-time restore via WAL replay. pg_restore flags below do not apply."
              : "Leave empty for a plain snapshot restore. Set a time to replay WAL records up to that point."}
          </span>
        </div>
        )}

        <div className="flex flex-col gap-2">
          <Label className="text-xs">Restore options</Label>
          <div className={`grid gap-2 ${hasPitr ? "opacity-50 pointer-events-none" : ""}`}>
            <label className="flex items-start gap-2.5 cursor-pointer rounded-md border p-2.5 hover:bg-muted/50 transition-colors">
              <Checkbox
                checked={dataOnly}
                onCheckedChange={(v) => {
                  setDataOnly(!!v)
                  if (v) setSchemaOnly(false)
                }}
                className="mt-0.5"
              />
              <div className="flex flex-col">
                <span className="text-sm font-medium">Data only</span>
                <span className="text-xs text-muted-foreground">
                  Restore only table data, skipping schema definitions.
                </span>
              </div>
            </label>

            <label className="flex items-start gap-2.5 cursor-pointer rounded-md border p-2.5 hover:bg-muted/50 transition-colors">
              <Checkbox
                checked={schemaOnly}
                onCheckedChange={(v) => {
                  setSchemaOnly(!!v)
                  if (v) setDataOnly(false)
                }}
                className="mt-0.5"
              />
              <div className="flex flex-col">
                <span className="text-sm font-medium">Schema only</span>
                <span className="text-xs text-muted-foreground">
                  Restore only schema definitions (tables, indexes, etc.), no data.
                </span>
              </div>
            </label>

            <label className="flex items-start gap-2.5 cursor-pointer rounded-md border p-2.5 hover:bg-muted/50 transition-colors">
              <Checkbox
                checked={createDb}
                onCheckedChange={(v) => setCreateDb(!!v)}
                className="mt-0.5"
              />
              <div className="flex flex-col">
                <span className="text-sm font-medium">Create database</span>
                <span className="text-xs text-muted-foreground">
                  Issue a CREATE DATABASE command before restoring into it.
                </span>
              </div>
            </label>

            <label className="flex items-start gap-2.5 cursor-pointer rounded-md border p-2.5 hover:bg-muted/50 transition-colors">
              <Checkbox
                checked={clean}
                onCheckedChange={(v) => setClean(!!v)}
                className="mt-0.5"
              />
              <div className="flex flex-col">
                <span className="text-sm font-medium">Clean (drop first)</span>
                <span className="text-xs text-muted-foreground">
                  Drop existing database objects before recreating them.
                </span>
              </div>
            </label>
          </div>
        </div>

        {hasPitr && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Active mode:</span>
            <Badge variant="secondary" className="text-xs">PITR (WAL replay)</Badge>
            <Badge variant="secondary" className="text-xs font-mono">{hasPitr ? pitrTs!.toLocaleString() : restoreTime}</Badge>
          </div>
        )}

        {(dataOnly || schemaOnly || createDb || clean) && !hasPitr && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Active flags:</span>
            {dataOnly && <Badge variant="secondary" className="text-xs">--data-only</Badge>}
            {schemaOnly && <Badge variant="secondary" className="text-xs">--schema-only</Badge>}
            {createDb && <Badge variant="secondary" className="text-xs">--create-db</Badge>}
            {clean && <Badge variant="secondary" className="text-xs">--clean</Badge>}
          </div>
        )}

        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangleIcon className="size-3.5 shrink-0 mt-0.5" />
          <span>
            {isOverwrite || (clean && !hasPitr)
              ? "This action will modify the target database and cannot be undone. Ensure you have a recent backup."
              : hasPitr
                ? "Point-in-time restore will replay WAL records on top of the baseline snapshot. Existing data in the target will be overwritten."
                : "The restore will load data into the target database. Existing objects with the same name may cause errors."}
          </span>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} size="sm">
          Cancel
        </Button>
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogTrigger render={<Button disabled={isRestoring || !canRestore} size="sm" />}>
            {isRestoring ? (
              <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <HardDriveUploadIcon className="mr-1.5 size-3.5" />
            )}
            {isRestoring ? "Restoring\u2026" : "Restore now"}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirm restore?</AlertDialogTitle>
              <AlertDialogDescription>
                Backup <span className="font-mono">{backup.id}</span> will be restored
                to database <span className="font-mono">{targetDb}</span>.
                {hasPitr && pitrTs && (
                  <>
                    {" "}WAL records will be replayed up to{" "}
                    <span className="font-mono">{pitrTs.toLocaleString()}</span>.
                  </>
                )}
                {isOverwrite || (clean && !hasPitr)
                  ? " This will overwrite existing data and cannot be undone."
                  : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleRestore}>
                Continue
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogFooter>
    </>
  )
}

export function RestoreDialog({
  backup,
  open,
  onOpenChange,
  onRestored,
}: {
  backup: Backup | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onRestored?: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open && backup && (
          <RestoreForm
            backup={backup}
            onOpenChange={onOpenChange}
            onRestored={onRestored}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
