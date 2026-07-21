import Link from "next/link"
import { ArrowRightIcon } from "lucide-react"

import { AppShell } from "@/components/app-shell"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { DbDatabases, DbRecentBackups, DbStats, DbCdcStats, DbCdcDetails } from "@/components/db-overview"

export default function DashboardPage() {
  return (
    <AppShell>
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Dashboard</h2>
          <p className="text-sm text-muted-foreground">
            Monitor database health, backups, and replication status.
          </p>
        </div>

        <DbStats />
        <DbCdcStats />

        <div className="grid gap-4 md:grid-cols-2">
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Databases</CardTitle>
              <CardDescription>
                View all databases, their health, backups, and restore from snapshots.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="secondary" size="sm" nativeButton={false} render={<Link href="/databases" />}>
                Manage databases <ArrowRightIcon className="ml-1 size-3" />
              </Button>
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Settings</CardTitle>
              <CardDescription>
                Configure database servers and discover databases.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="secondary" size="sm" nativeButton={false} render={<Link href="/settings" />}>
                Settings <ArrowRightIcon className="ml-1 size-3" />
              </Button>
            </CardContent>
          </Card>
        </div>

        <DbDatabases />

        <DbCdcDetails />

        <DbRecentBackups />
      </div>
    </AppShell>
  )
}
