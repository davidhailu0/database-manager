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
            Manage cluster backups, restores, and scheduled jobs.
          </p>
        </div>

        <DbStats />
        <DbCdcStats />

        <div className="grid gap-4 md:grid-cols-2">
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Backup</CardTitle>
              <CardDescription>
                Create a full or incremental backup of a selected database.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="secondary" size="sm" nativeButton={false} render={<Link href="/backup" />}>
                Backup <ArrowRightIcon className="ml-1 size-3" />
              </Button>
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Restore</CardTitle>
              <CardDescription>
                Restore an entire cluster from a previous backup snapshot.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="secondary" size="sm" nativeButton={false} render={<Link href="/restore" />}>
                Restore <ArrowRightIcon className="ml-1 size-3" />
              </Button>
            </CardContent>
          </Card>
          <Card className="shadow-none">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Schedule Full Backups</CardTitle>
              <CardDescription>
                Configure a cron job to run full backups automatically on a schedule.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="secondary" size="sm" nativeButton={false} render={<Link href="/cron" />}>
                Configure <ArrowRightIcon className="ml-1 size-3" />
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
