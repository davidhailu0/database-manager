"use client"

import * as React from "react"
import { usePathname } from "next/navigation"

import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { AppSidebar } from "@/components/app-sidebar"

function useRouteTitle(pathname: string) {
  if (pathname === "/") return "Dashboard"
  if (pathname.startsWith("/backup")) return "Backup"
  if (pathname.startsWith("/restore")) return "Restore"
  if (pathname.startsWith("/cron")) return "Cron Jobs"
  if (pathname.startsWith("/settings")) return "Settings"
  if (pathname.startsWith("/users")) return "Users"
  return "DB Manager"
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const title = useRouteTitle(pathname)

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-14 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-4" />
          <h1 className="text-sm font-semibold tracking-tight">{title}</h1>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  )
}
