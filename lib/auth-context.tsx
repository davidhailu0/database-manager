"use client"

import * as React from "react"
import { useRouter, usePathname } from "next/navigation"
import { login as apiLogin, logout as apiLogout, getCurrentUser } from "@/lib/api"
import type { AppUser } from "@/lib/api"

const TOKEN_KEY = "db-manager-auth-token"

type AuthValue = {
  user: AppUser | null
  token: string | null
  isLoading: boolean
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  hasPageAccess: (page: string) => boolean
  hasActionAccess: (action: string) => boolean
}

const AuthContext = React.createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<AppUser | null>(null)
  const [token, setToken] = React.useState<string | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)
  const router = useRouter()
  const pathname = usePathname()

  React.useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY)
    if (stored) {
      setToken(stored)
      getCurrentUser(stored)
        .then((u) => setUser(u))
        .catch(() => {
          localStorage.removeItem(TOKEN_KEY)
          setToken(null)
        })
        .finally(() => setIsLoading(false))
    } else {
      setIsLoading(false)
    }
  }, [])

  // Redirect unauthenticated users away from protected pages
  React.useEffect(() => {
    if (isLoading) return
    if (pathname === "/sign-in") return
    if (!token) {
      router.push("/sign-in")
    }
  }, [isLoading, token, pathname, router])

  const login = React.useCallback(async (username: string, password: string) => {
    const result = await apiLogin(username, password)
    localStorage.setItem(TOKEN_KEY, result.token)
    setToken(result.token)
    setUser(result.user)
  }, [])

  const logout = React.useCallback(async () => {
    if (token) {
      try { await apiLogout() } catch { /* ignore */ }
    }
    localStorage.removeItem(TOKEN_KEY)
    setToken(null)
    setUser(null)
    router.push("/sign-in")
  }, [token, router])

  const hasPageAccess = React.useCallback((page: string) => {
    if (!user) return false
    if (user.role === "admin") return true
    return user.allowedPages.includes(page)
  }, [user])

  const hasActionAccess = React.useCallback((action: string) => {
    if (!user) return false
    if (user.role === "admin") return true
    return user.allowedActions.includes(action)
  }, [user])

  return (
    <AuthContext.Provider value={{ user, token, isLoading, login, logout, hasPageAccess, hasActionAccess }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = React.useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within AuthProvider")
  return ctx
}
