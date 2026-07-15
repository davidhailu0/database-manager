#!/usr/bin/env node
import { execSync } from 'child_process';
import { loadConfig } from './config.js';
import { runPreflightChecks, formatPreflightReport } from './preflight.js';
import { setupDatabase, teardownDatabase } from './setup.js';
import { runMonitor, formatMonitorReport } from './monitor.js';
import { restoreDatabase } from './restore.js';
// =============================================================================
// pg-cdc CLI — Per-Database Logical Replication Backup Manager
// =============================================================================
//
// Usage:
//   pg-cdc preflight                         Run preflight checks
//   pg-cdc setup <dbname>                   Set up replication for a DB
//   pg-cdc teardown <dbname>                Remove replication for a DB
//   pg-cdc status [dbname]                  Show capture status
//   pg-cdc backup <dbname>                  Trigger baseline dump
//   pg-cdc restore <dbname> <target> [opts] Restore to point in time
//   pg-cdc monitor                          Run monitoring check once
//   pg-cdc rotate <dbname>                  Rotate stream file
// =============================================================================
function usage(exitCode = 0) {
    const msg = `
Usage: pg-cdc <command> [options]

  pg-cdc preflight [--config <path>]    Run preflight prerequisites check
  pg-cdc setup <dbname>                 Set up replication for a database
  pg-cdc teardown <dbname>              Tear down replication for a database
  pg-cdc status [dbname]                Show capture status for all or one DB
  pg-cdc backup <dbname>                Trigger a baseline dump now
  pg-cdc restore <dbname> <target>      Restore a database to point-in-time
         [--to-timestamp <ISO8601>]
         [--force-production]
  pg-cdc monitor                        Run monitoring check once (for cron)
  pg-cdc rotate <dbname>                Rotate the stream file for a DB
  pg-cdc config                         Print resolved configuration

Options:
  --config <path>    Path to config file (default: search /etc/pg-cdc/ and cwd)
  --help, -h         Show this help
`;
    console.log(msg);
    process.exit(exitCode);
}
async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        usage(0);
    }
    // Strip leading "--" (pnpm exec quirk)
    const clean = args[0] === '--' ? args.slice(1) : args;
    const cmd = clean[0];
    const cmdArgs = clean.slice(1);
    // Parse --config <path> from args if present
    let configPath;
    const filtered = [];
    for (let i = 0; i < cmdArgs.length; i++) {
        if (cmdArgs[i] === '--config' && i + 1 < cmdArgs.length) {
            configPath = cmdArgs[++i];
        }
        else {
            filtered.push(cmdArgs[i]);
        }
    }
    let cfg;
    try {
        cfg = loadConfig(configPath);
    }
    catch (err) {
        console.error('Error loading config:', err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
    switch (cmd) {
        case 'preflight': {
            const results = await runPreflightChecks(cfg);
            console.log(formatPreflightReport(results));
            const hasFatal = results.some(r => r.status === 'fail');
            process.exit(hasFatal ? 1 : 0);
        }
        case 'config': {
            console.log(JSON.stringify(cfg, null, 2));
            break;
        }
        case 'setup': {
            const dbName = filtered[0];
            if (!dbName) {
                console.error('Usage: pg-cdc setup <dbname>');
                process.exit(1);
            }
            const result = await setupDatabase(cfg, dbName);
            console.log(`\nSetup complete for "${dbName}":`);
            console.log(`  Publication ${result.publication}`);
            console.log(`  Slot        ${result.slot}`);
            console.log(`  Directory   ${result.directory}`);
            console.log(`  Systemd     ${result.systemd}`);
            if (result.warnings.length > 0) {
                for (const w of result.warnings)
                    console.warn(`  ⚠ ${w}`);
            }
            break;
        }
        case 'teardown': {
            const dbName = filtered[0];
            if (!dbName) {
                console.error('Usage: pg-cdc teardown <dbname>');
                process.exit(1);
            }
            await teardownDatabase(cfg, dbName);
            break;
        }
        case 'status': {
            console.log('status command — not yet implemented (Phase 4)');
            process.exit(1);
        }
        case 'backup': {
            const dbName = filtered[0];
            if (!dbName) {
                console.error('Usage: pg-cdc backup <dbname>');
                process.exit(1);
            }
            const script = `${cfg.scripts_dir}/backup_db.sh`;
            console.log(`Running ${script} ${dbName}...`);
            execSync(`sudo -u postgres ${script} ${dbName}`, { stdio: 'inherit', timeout: 3600_000 });
            break;
        }
        case 'restore': {
            const sourceDb = filtered[0];
            const targetDb = filtered[1];
            if (!sourceDb || !targetDb) {
                console.error('Usage: pg-cdc restore <source_db> <target_db> [--to-timestamp <ISO8601>] [--force-production]');
                process.exit(1);
            }
            const toTimestampIdx = filtered.indexOf('--to-timestamp');
            const toTimestamp = toTimestampIdx >= 0 ? filtered[toTimestampIdx + 1] : undefined;
            const forceProduction = filtered.includes('--force-production');
            await restoreDatabase(cfg, sourceDb, { targetDb, toTimestamp, forceProduction });
            break;
        }
        case 'monitor': {
            const result = await runMonitor(cfg);
            console.log(formatMonitorReport(result));
            // Also route alerts through the alert hook
            for (const alert of result.alerts) {
                try {
                    execSync(`sudo -u postgres ${cfg.scripts_dir}/alert.sh "${alert.type}" "${alert.db}" "${alert.message}"`, { stdio: 'ignore', timeout: 10000 });
                }
                catch {
                    // alert hook is best-effort
                }
            }
            break;
        }
        case 'rotate': {
            const dbName = filtered[0];
            if (!dbName) {
                console.error('Usage: pg-cdc rotate <dbname>');
                process.exit(1);
            }
            const script = `${cfg.scripts_dir}/rotate_stream.sh`;
            execSync(`${script} ${dbName}`, { stdio: 'inherit', timeout: 15000 });
            break;
        }
        default: {
            console.error(`Unknown command: ${cmd}`);
            usage(1);
        }
    }
}
main().catch((err) => {
    console.error('Fatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
});
