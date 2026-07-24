"use client"

import * as React from "react"
import { toast } from "sonner"
import {
  PlusIcon,
  Trash2Icon,
  ShieldIcon,
  SaveIcon,
  KeyIcon,
  Loader2Icon,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { useAuth } from "@/lib/auth-context"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  setUserPassword,
} from "@/lib/api"
import type { AppUser } from "@/lib/api"

const ALL_PAGES = [
  { key: "dashboard", label: "Dashboard" },
  { key: "databases", label: "Databases" },
  { key: "settings", label: "Settings" },
  { key: "users", label: "Users" },
]

const ALL_ACTIONS = [
  { key: "backup:create", label: "Create backup" },
  { key: "backup:delete", label: "Delete backup" },
  { key: "backup:retry", label: "Retry backup" },
  { key: "restore:run", label: "Run restore" },
  { key: "config:read", label: "Read config" },
  { key: "config:write", label: "Write config" },
  { key: "settings:read", label: "Read settings" },
  { key: "settings:write", label: "Write settings" },
  { key: "users:manage", label: "Manage users" },
]

function roleBadge(role: string) {
  const colors: Record<string, string> = {
    admin: "bg-purple-50 text-purple-700 border-purple-200",
    operator: "bg-blue-50 text-blue-700 border-blue-200",
    viewer: "bg-gray-50 text-gray-700 border-gray-200",
  }
  return (
    <Badge variant="secondary" className={colors[role] ?? ""}>
      {role}
    </Badge>
  )
}

function AddUserForm({ token, onDone }: { token: string; onDone: () => void }) {
  const [email, setEmail] = React.useState("")
  const [sam, setSam] = React.useState("")
  const [displayName, setDisplayName] = React.useState("")
  const [role, setRole] = React.useState<string>("viewer")
  const [isAdding, setIsAdding] = React.useState(false)

  async function handleAdd() {
    if (!email.trim() || !sam.trim()) {
      toast.error("Email and SAM account name are required")
      return
    }
    setIsAdding(true)
    try {
      await createUser(token, {
        email: email.trim(),
        samAccountName: sam.trim(),
        displayName: displayName.trim() || undefined,
        role,
        allowedPages: role === "admin" ? ALL_PAGES.map((p) => p.key) : ["dashboard"],
        allowedActions: role === "admin" ? ALL_ACTIONS.map((a) => a.key) : [],
      })
      toast.success("User created")
      setEmail("")
      setSam("")
      setDisplayName("")
      setRole("viewer")
      onDone()
    } catch (err) {
      toast.error("Failed to create user", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsAdding(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-4">
      <span className="text-sm font-medium">Add authorized user</span>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label className="text-xs">Email</Label>
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@company.com" className="text-sm" />
        </div>
        <div className="flex flex-col gap-2">
          <Label className="text-xs">SAM Account Name</Label>
          <Input value={sam} onChange={(e) => setSam(e.target.value)} placeholder="user.name" className="text-sm" />
        </div>
        <div className="flex flex-col gap-2">
          <Label className="text-xs">Display Name</Label>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Full Name" className="text-sm" />
        </div>
        <div className="flex flex-col gap-2">
          <Label className="text-xs">Role</Label>
          <Select value={role} onValueChange={(v) => v && setRole(v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="operator">Operator</SelectItem>
              <SelectItem value="viewer">Viewer</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Button onClick={handleAdd} size="sm" disabled={isAdding}>
          <PlusIcon className="mr-1.5 size-3.5" />
          {isAdding ? "Adding…" : "Add user"}
        </Button>
      </div>
    </div>
  )
}

function UserRow({ user, token, onRefresh }: { user: AppUser; token: string; onRefresh: () => void }) {
  const { user: currentUser } = useAuth()
  const [editing, setEditing] = React.useState(false)
  const [role, setRole] = React.useState(user.role)
  const [pages, setPages] = React.useState<string[]>(user.allowedPages)
  const [actions, setActions] = React.useState<string[]>(user.allowedActions)
  const [isSaving, setIsSaving] = React.useState(false)
  const [pwDialogOpen, setPwDialogOpen] = React.useState(false)
  const [newPassword, setNewPassword] = React.useState("")
  const [isSavingPw, setIsSavingPw] = React.useState(false)

  const isSelf = currentUser?.id === user.id

  async function handleSetPassword() {
    if (!newPassword || newPassword.length < 4) {
      toast.error("Password must be at least 4 characters")
      return
    }
    setIsSavingPw(true)
    try {
      await setUserPassword(token, user.id, newPassword)
      toast.success(`Password set for ${user.displayName}`)
      setPwDialogOpen(false)
      setNewPassword("")
    } catch (err) {
      toast.error("Failed to set password", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsSavingPw(false)
    }
  }

  async function handleSave() {
    setIsSaving(true)
    try {
      await updateUser(token, { id: user.id, role, allowedPages: pages, allowedActions: actions })
      toast.success("User updated")
      setEditing(false)
      onRefresh()
    } catch (err) {
      toast.error("Failed to update user", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDelete() {
    if (isSelf) {
      toast.error("Cannot delete yourself")
      return
    }
    try {
      await deleteUser(token, user.id)
      toast.success("User deleted")
      onRefresh()
    } catch (err) {
      toast.error("Failed to delete user", {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  function togglePage(page: string) {
    setPages((prev) => prev.includes(page) ? prev.filter((p) => p !== page) : [...prev, page])
  }

  function toggleAction(action: string) {
    setActions((prev) => prev.includes(action) ? prev.filter((a) => a !== action) : [...prev, action])
  }

  return (
    <div className="rounded-md border px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary/10">
            <ShieldIcon className="size-4 text-primary" />
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{user.displayName}</span>
              {roleBadge(user.role)}
              {isSelf && <Badge variant="outline" className="text-xs">You</Badge>}
            </div>
            <span className="text-xs text-muted-foreground">{user.email} &middot; {user.samAccountName}</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setEditing(!editing)}>
            {editing ? "Cancel" : "Edit"}
          </Button>
          {editing && (
            <Button variant="ghost" size="sm" onClick={handleSave} disabled={isSaving}>
              <SaveIcon className="size-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setPwDialogOpen(true)} title="Set local password">
            <KeyIcon className="size-3.5" />
          </Button>
          {!isSelf && (
            <Button variant="ghost" size="sm" onClick={handleDelete}>
              <Trash2Icon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <div className="mt-4 flex flex-col gap-4 border-t pt-4">
          <div className="flex flex-col gap-2">
            <Label className="text-xs">Role</Label>
            <Select value={role} onValueChange={(v) => v && setRole(v)}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="operator">Operator</SelectItem>
                <SelectItem value="viewer">Viewer</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {role !== "admin" && (
            <>
              <div className="flex flex-col gap-2">
                <Label className="text-xs">Page access</Label>
                <div className="flex flex-wrap gap-2">
                  {ALL_PAGES.map((p) => (
                    <label key={p.key} className="flex items-center gap-1.5 cursor-pointer">
                      <Switch checked={pages.includes(p.key)} onCheckedChange={() => togglePage(p.key)} />
                      <span className="text-xs">{p.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <Label className="text-xs">Actions</Label>
                <div className="flex flex-wrap gap-3">
                  {ALL_ACTIONS.map((a) => (
                    <label key={a.key} className="flex items-center gap-1.5 cursor-pointer">
                      <Switch checked={actions.includes(a.key)} onCheckedChange={() => toggleAction(a.key)} />
                      <span className="text-xs">{a.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <Dialog open={pwDialogOpen} onOpenChange={setPwDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <KeyIcon className="size-4" />
              Set local password
            </DialogTitle>
            <DialogDescription>
              Set a local password for {user.displayName}. Used as fallback when the AD server is unreachable.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <Input
              type="password"
              placeholder="New password (min 4 chars)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="text-sm"
              autoComplete="new-password"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPwDialogOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSetPassword} disabled={isSavingPw}>
              {isSavingPw ? (
                <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
              ) : null}
              {isSavingPw ? "Saving\u2026" : "Set password"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default function UsersPage() {
  const { user, token } = useAuth()
  const [users, setUsers] = React.useState<AppUser[]>([])

  const refresh = React.useCallback(() => {
    if (!token) return
    listUsers(token).then(setUsers).catch(() => setUsers([]))
  }, [token])

  React.useEffect(() => { refresh() }, [refresh])

  if (!user || user.role !== "admin") {
    return (
      <AppShell>
        <div className="mx-auto flex max-w-3xl flex-col gap-8">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Users</h2>
            <p className="text-sm text-muted-foreground">You do not have permission to view this page.</p>
          </div>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Users</h2>
          <p className="text-sm text-muted-foreground">
            Manage authorized users and their role-based access control.
          </p>
        </div>

        <Card className="shadow-none">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Authorized users</CardTitle>
            <CardDescription>
              Only users in this list can log in, even if AD authentication succeeds.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {users.length === 0 ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : (
              users.map((u) => <UserRow key={u.id} user={u} token={token!} onRefresh={refresh} />)
            )}
            <Separator />
            <AddUserForm token={token!} onDone={refresh} />
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}
