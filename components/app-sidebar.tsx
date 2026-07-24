"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  DatabaseIcon,
  LayoutDashboardIcon,
  SettingsIcon,
  ChevronUpIcon,
  UsersIcon,
  LogOutIcon,
} from "lucide-react"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
} from "@/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { useAuth } from "@/lib/auth-context"

type NavItem = {
  title: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  pageKey: string
}

const allNav: NavItem[] = [
  { title: "Dashboard", href: "/", icon: LayoutDashboardIcon, pageKey: "dashboard" },
  { title: "Databases", href: "/databases", icon: DatabaseIcon, pageKey: "databases" },
  { title: "Users", href: "/users", icon: UsersIcon, pageKey: "users" },
  { title: "Settings", href: "/settings", icon: SettingsIcon, pageKey: "settings" }
]

export function AppSidebar() {
  const pathname = usePathname()
  const { user, logout, hasPageAccess } = useAuth()

  const nav = allNav.filter((item) => hasPageAccess(item.pageKey))
  const initials = user?.displayName
    ? user.displayName.split(" ").map((s) => s[0]).join("").toUpperCase().slice(0, 2)
    : "??"

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <DatabaseIcon className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">DB Manager</span>
                <span className="truncate text-xs text-muted-foreground">
                  Backup &amp; Restore
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {nav.map((item) => {
                const Icon = item.icon
                const active = pathname === item.href
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton isActive={active} tooltip={item.title} render={<Link href={item.href} />}>
                      <Icon className="size-4" />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent" render={<DropdownMenuTrigger />}>
                <Avatar className="size-7 rounded-md">
                  <AvatarFallback className="rounded-md bg-muted text-xs font-medium text-foreground">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">{user?.displayName ?? "User"}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user?.email ?? ""}
                  </span>
                </div>
                <ChevronUpIcon className="ml-auto size-4" />
              </SidebarMenuButton>
              <DropdownMenuContent side="top" className="w-56" align="end">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{user?.role ?? "Unknown"}</DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem>
                  <SettingsIcon className="mr-2 size-4" />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={logout}>
                  <LogOutIcon className="mr-2 size-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
