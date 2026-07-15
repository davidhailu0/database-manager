import postgres from 'postgres';
// =============================================================================
// Prerequisite checks
// =============================================================================
export async function runPreflightChecks(cfg) {
    const results = [];
    // --- Connection check ---
    let sql = null;
    try {
        sql = postgres(cfg.pg_connection, { max: 1, idle_timeout: 10 });
        await sql `SELECT 1`;
        results.push({
            name: 'pg_connection',
            status: 'pass',
            message: `Connected to ${cfg.pg_connection.replace(/\/\/.*@/, '//***@')}`,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
            name: 'pg_connection',
            status: 'fail',
            message: `Cannot connect: ${msg}`,
        });
        return results;
    }
    // --- wal_level ---
    try {
        const rows = await sql `SHOW wal_level`;
        const walLevel = rows[0]?.wal_level;
        if (walLevel === 'logical') {
            results.push({ name: 'wal_level', status: 'pass', message: 'wal_level = logical' });
        }
        else {
            results.push({
                name: 'wal_level',
                status: 'fail',
                message: `wal_level = ${walLevel}, must be 'logical'`,
                fix: [
                    `ALTER SYSTEM SET wal_level = 'logical';`,
                    `-- Then restart PostgreSQL:`,
                    `sudo systemctl restart postgresql`,
                ].join('\n'),
            });
        }
    }
    catch (err) {
        results.push({
            name: 'wal_level',
            status: 'fail',
            message: err instanceof Error ? err.message : String(err),
        });
    }
    // --- max_replication_slots ---
    try {
        const rows = await sql `SHOW max_replication_slots`;
        const configured = parseInt(rows[0]?.max_replication_slots, 10);
        const needed = cfg.databases.length + 2; // +2 headroom
        // Also count existing slots
        const existingRows = await sql `SELECT count(*)::int as cnt FROM pg_replication_slots`;
        const existing = existingRows[0]?.cnt ?? 0;
        const free = configured - existing;
        if (free >= needed) {
            results.push({
                name: 'max_replication_slots',
                status: 'pass',
                message: `${configured} configured, ${existing} in use (${free} free, ${needed} needed)`,
            });
        }
        else {
            results.push({
                name: 'max_replication_slots',
                status: 'fail',
                message: `Only ${free} slots free but ${needed} needed (${configured} configured, ${existing} used)`,
                fix: [
                    `ALTER SYSTEM SET max_replication_slots = ${Math.max(configured, existing + needed + 2)};`,
                    `-- Then restart PostgreSQL:`,
                    `sudo systemctl restart postgresql`,
                ].join('\n'),
            });
        }
    }
    catch (err) {
        results.push({
            name: 'max_replication_slots',
            status: 'fail',
            message: err instanceof Error ? err.message : String(err),
        });
    }
    // --- max_wal_senders ---
    try {
        const rows = await sql `SHOW max_wal_senders`;
        const configured = parseInt(rows[0]?.max_wal_senders, 10);
        const needed = cfg.databases.length + 2;
        const existingRows = await sql `SELECT count(*)::int as cnt FROM pg_stat_replication`;
        const existing = existingRows[0]?.cnt ?? 0;
        const free = configured - existing;
        if (free >= needed) {
            results.push({
                name: 'max_wal_senders',
                status: 'pass',
                message: `${configured} configured, ${existing} active (${free} free, ${needed} needed)`,
            });
        }
        else {
            results.push({
                name: 'max_wal_senders',
                status: 'fail',
                message: `Only ${free} WAL senders free but ${needed} needed`,
                fix: [
                    `ALTER SYSTEM SET max_wal_senders = ${Math.max(configured, existing + needed + 2)};`,
                    `-- Then restart PostgreSQL:`,
                    `sudo systemctl restart postgresql`,
                ].join('\n'),
            });
        }
    }
    catch (err) {
        results.push({
            name: 'max_wal_senders',
            status: 'fail',
            message: err instanceof Error ? err.message : String(err),
        });
    }
    // --- wal2json availability ---
    try {
        // Check if wal2json is in shared_preload_libraries, OR available as extension
        const libRows = await sql `SHOW shared_preload_libraries`;
        const libs = libRows[0]?.shared_preload_libraries ?? '';
        const extRows = await sql `
      SELECT count(*)::int as cnt FROM pg_available_extensions WHERE name = 'wal2json'
    `;
        const extAvailable = (extRows[0]?.cnt ?? 0) > 0;
        const inPreload = libs.split(',').map(s => s.trim()).includes('wal2json');
        if (inPreload) {
            results.push({
                name: 'wal2json',
                status: 'pass',
                message: 'wal2json loaded via shared_preload_libraries',
            });
        }
        else if (extAvailable) {
            results.push({
                name: 'wal2json',
                status: 'warn',
                message: 'wal2json available as extension but not in shared_preload_libraries',
                fix: [
                    `ALTER SYSTEM SET shared_preload_libraries = 'wal2json';`,
                    `-- (Append to existing value if other libraries are loaded)`,
                    `-- Then restart PostgreSQL:`,
                    `sudo systemctl restart postgresql`,
                ].join('\n'),
            });
        }
        else {
            results.push({
                name: 'wal2json',
                status: 'fail',
                message: 'wal2json is not installed',
                fix: [
                    `-- Install wal2json from source or package:`,
                    `# Debian/Ubuntu:`,
                    `sudo apt install postgresql-16-wal2json`,
                    `# or from PGXN:`,
                    `sudo pgxn install wal2json`,
                    `-- Then add to shared_preload_libraries and restart.`,
                ].join('\n'),
            });
        }
    }
    catch (err) {
        results.push({
            name: 'wal2json',
            status: 'fail',
            message: err instanceof Error ? err.message : String(err),
        });
    }
    // --- Check for same-disk warning ---
    try {
        const dataDirRows = await sql `SHOW data_directory`;
        const dataDir = dataDirRows[0]?.data_directory;
        // Basic check: if data dir and backup dir are on same mount
        // We do a simple check by comparing stat device IDs if possible
        const { stat } = await import('fs/promises');
        try {
            const dataStat = await stat(dataDir);
            const backupStat = await stat(cfg.backup_dir);
            // On Linux, stat.dev gives the device number
            if (dataStat.dev === backupStat.dev) {
                results.push({
                    name: 'disk_separation',
                    status: 'warn',
                    message: `Backup dir "${cfg.backup_dir}" and PG data dir "${dataDir}" appear to be on the same device (dev=${dataStat.dev})`,
                    fix: `Configure backup_dir to point to a different physical disk/partition from the PG data directory.`,
                });
            }
            else {
                results.push({
                    name: 'disk_separation',
                    status: 'pass',
                    message: 'Backup and data directories are on different devices',
                });
            }
        }
        catch {
            // Can't stat — skip this check
        }
    }
    catch {
        // Can't check data_directory — skip
    }
    await sql.end();
    return results;
}
// =============================================================================
// Report formatter
// =============================================================================
export function formatPreflightReport(results) {
    const lines = [];
    let hasFatal = false;
    lines.push('');
    lines.push('═'.repeat(60));
    lines.push('  pg-cdc — Preflight Prerequisites Check');
    lines.push('═'.repeat(60));
    lines.push('');
    for (const r of results) {
        const icon = r.status === 'pass' ? '✓' : r.status === 'warn' ? '⚠' : '✗';
        lines.push(`  ${icon}  [${r.status.toUpperCase()}] ${r.name}`);
        lines.push(`      ${r.message}`);
        if (r.fix) {
            lines.push(`      Fix:`);
            for (const line of r.fix.split('\n')) {
                lines.push(`        ${line}`);
            }
        }
        lines.push('');
        if (r.status === 'fail')
            hasFatal = true;
    }
    lines.push('─'.repeat(60));
    if (hasFatal) {
        lines.push('  ❌  FAILED — some checks did not pass.');
        lines.push('  Apply the suggested fixes above, then re-run preflight.');
    }
    else {
        const warns = results.filter(r => r.status === 'warn').length;
        if (warns > 0) {
            lines.push(`  ⚠  ${warns} warning(s) — review and address if needed.`);
        }
        lines.push('  ✅  All critical checks passed.');
    }
    lines.push('═'.repeat(60));
    lines.push('');
    return lines.join('\n');
}
