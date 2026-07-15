"use client"

import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { DbProvider } from "@/lib/db-context"
import { AuthProvider } from "@/lib/auth-context"

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider delay={200}>
      <AuthProvider>
        <DbProvider>
          {children}
        </DbProvider>
      </AuthProvider>
      <Toaster position="top-right" richColors />
    </TooltipProvider>
  )
}
