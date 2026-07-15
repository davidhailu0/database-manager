"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  DatabaseIcon,
  EyeIcon,
  EyeOffIcon,
  Loader2Icon,
} from "lucide-react"
import { toast } from "sonner"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuth } from "@/lib/auth-context"

export default function SignInPage() {
  const router = useRouter()
  const { login, token } = useAuth()
  const [credential, setCredential] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [showPassword, setShowPassword] = React.useState(false)
  const [isSubmitting, setIsSubmitting] = React.useState(false)

  // Already signed in — redirect to dashboard
  React.useEffect(() => {
    if (token) router.push("/")
  }, [token, router])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const input = credential.trim()
    if (!input || !password) {
      toast.error("Please enter your username/email and password")
      return
    }
    // Strip @domain if user entered a full email
    const username = input.includes("@") ? input.split("@")[0] : input
    setIsSubmitting(true)
    try {
      await login(username, password)
      toast.success("Signed in successfully")
      router.push("/")
    } catch (err) {
      toast.error("Sign in failed", {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-muted/30 p-4">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center justify-center gap-2">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <DatabaseIcon className="size-5" />
          </div>
          <span className="text-lg font-semibold tracking-tight">DB Manager</span>
        </div>

        <Card className="shadow-none">
          <CardHeader className="text-center">
            <CardTitle className="text-lg">Sign in to your account</CardTitle>
            <CardDescription>
              Enter your Active Directory credentials
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="credential" className="text-xs">Username or Email</Label>
                <Input
                  id="credential"
                  type="text"
                  placeholder="username or email@company.com"
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                  autoComplete="username"
                  required
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="password" className="text-xs">Password</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? (
                      <EyeOffIcon className="size-4" />
                    ) : (
                      <EyeIcon className="size-4" />
                    )}
                  </button>
                </div>
              </div>

              <Button type="submit" disabled={isSubmitting} className="w-full">
                {isSubmitting ? (
                  <Loader2Icon className="mr-1.5 size-4 animate-spin" />
                ) : null}
                {isSubmitting ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
