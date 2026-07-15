import postgres from 'postgres';
import { execSync } from 'child_process';
import { existsSync, statSync } from 'fs';
// =============================================================================
// Main check
// =============================================================================
export async function runMonitor(cfg) {
    const result = {
        statuses: [],
        alerts: [],
        safetyValveDropped: [],
    };
    const sql = postgres(cfg.pg_connection, { max: 1, idle_timeout: 10 });
    const now = Date.now();
    try {
        // Query all replication slots
        const slots = await sql `
      SELECT
        s.slot_name,
        s.confirmed_flush_lsn,
        s.active,
        s.restart_lsn,
        pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), s.confirmed_flush_lsn)) AS lag_pretty,
        pg_wal_lsn_diff(pg_current_wal_lsn(), s.confirmed_flush_lsn) AS lag_bytes,
        (SELECT extract(epoch from (now() - backend_start))::bigint
         FROM pg_stat_replication r
         WHERE r.pid = s.active_pid) AS active_seconds
      FROM pg_replication_slots s
      WHERE s.slot_type = 'logical'
        AND s.plugin = 'wal2json'
    `;
        for (const slot of slots) {
            const slotName = slot.slot_name;
            // Extract DB name from slot name (expecting <db>_cdc)
            const dbMatch = slotName.match(/^(.+)_cdc$/);
            const db = dbMatch ? dbMatch[1] : slotName;
            const lagBytes = slot.lag_bytes ?? null;
            const isActive = slot.active;
            const activeSeconds = slot.active_seconds ?? null;
            // Check systemd unit
            const unitName = `pg-cdc@${db}.service`;
            let daemonRunning = false;
            try {
                const status = execSync(`systemctl is-active ${unitName}`, { encoding: 'utf-8', timeout: 5000 }).trim();
                daemonRunning = status === 'active';
            }
            catch {
                daemonRunning = false;
            }
            // Check stream file staleness
            const streamFile = `${cfg.capture_dir}/${db}/stream_current.jsonl`;
            let streamStalenessSec = null;
            if (existsSync(streamFile)) {
                const mtimeMs = statSync(streamFile).mtimeMs;
                streamStalenessSec = Math.floor((now - mtimeMs) / 1000);
            }
            // Get restart count from systemd
            let restarts = null;
            try {
                const nRestarts = execSync(`systemctl show ${unitName} --property=NRestarts --value`, { encoding: 'utf-8', timeout: 5000 }).trim();
                restarts = parseInt(nRestarts, 10) || 0;
            }
            catch {
                // unit might not exist
            }
            result.statuses.push({
                db,
                slotName,
                lagBytes,
                daemonRunning,
                streamStalenessSec,
                restartsSinceLastCheck: restarts,
            });
            // ---- Alert checks ----
            // Lag warning
            if (lagBytes !== null && lagBytes > cfg.monitoring.lag_warn_bytes) {
                const lagMB = (lagBytes / 1048576).toFixed(1);
                result.alerts.push({
                    type: 'lag-warn',
                    db,
                    message: `Replication lag ${lagMB} MB (threshold: ${(cfg.monitoring.lag_warn_bytes / 1048576).toFixed(0)} MB)`,
                });
            }
            // Slot inactive
            if (!isActive) {
                const inactiveFor = activeSeconds ?? streamStalenessSec ?? 0;
                if (inactiveFor >= cfg.monitoring.slot_inactive_seconds) {
                    result.alerts.push({
                        type: 'slot-inactive',
                        db,
                        message: `Slot inactive for ${inactiveFor}s (threshold: ${cfg.monitoring.slot_inactive_seconds}s)`,
                    });
                    // Auto-heal: attempt to restart the capture daemon
                    if (!daemonRunning) {
                        try {
                            execSync(`sudo systemctl restart ${unitName}`, { stdio: 'pipe', timeout: 15000 });
                            result.alerts.push({
                                type: 'daemon-dead',
                                db,
                                message: `Daemon restart initiated for inactive slot ${slotName}`,
                            });
                        }
                        catch (restartErr) {
                            result.alerts.push({
                                type: 'daemon-dead',
                                db,
                                message: `Failed to restart daemon for slot ${slotName}: ${restartErr instanceof Error ? restartErr.message : String(restartErr)}`,
                            });
                        }
                    }
                }
            }
            // Stream stale
            if (streamStalenessSec !== null && streamStalenessSec > cfg.monitoring.stream_stale_seconds) {
                result.alerts.push({
                    type: 'stream-stale',
                    db,
                    message: `Stream file not modified in ${streamStalenessSec}s (threshold: ${cfg.monitoring.stream_stale_seconds}s)`,
                });
            }
            // ---- Safety valve ----
            if (lagBytes !== null &&
                lagBytes > cfg.safety_valve.max_lag_bytes &&
                !daemonRunning) {
                // Check if daemon has been down long enough
                if (streamStalenessSec !== null && streamStalenessSec > cfg.safety_valve.grace_period_seconds) {
                    // Drop the slot
                    try {
                        await sql `
              SELECT pg_drop_replication_slot(${slotName})
            `;
                        result.alerts.push({
                            type: 'safety-valve',
                            db,
                            message: `Slot ${slotName} DROPPED: lag ${(lagBytes / 1048576).toFixed(1)} MB exceeded max ${(cfg.safety_valve.max_lag_bytes / 1048576).toFixed(0)} MB and daemon dead for ${streamStalenessSec}s`,
                        });
                        result.safetyValveDropped.push(db);
                    }
                    catch (err) {
                        result.alerts.push({
                            type: 'safety-valve',
                            db,
                            message: `Failed to drop slot ${slotName}: ${err instanceof Error ? err.message : String(err)}`,
                        });
                    }
                }
                else {
                    result.alerts.push({
                        type: 'daemon-dead',
                        db,
                        message: `Lag ${(lagBytes / 1048576).toFixed(1)} MB and daemon not running. Grace period: ${Math.max(0, cfg.safety_valve.grace_period_seconds - (streamStalenessSec ?? 0))}s remaining before slot drop`,
                    });
                }
            }
        }
    }
    finally {
        await sql.end();
    }
    return result;
}
// =============================================================================
// Formatter
// =============================================================================
export function formatMonitorReport(result) {
    const lines = [];
    lines.push('');
    lines.push('═'.repeat(72));
    lines.push('  pg-cdc — Monitoring Report');
    lines.push('═'.repeat(72));
    if (result.statuses.length === 0) {
        lines.push('  No active wal2json replication slots found.');
        lines.push('  Run `pg-cdc setup <dbname>` to protect databases.');
        lines.push('');
        return lines.join('\n');
    }
    for (const s of result.statuses) {
        const daemonIcon = s.daemonRunning ? '✓' : '✗';
        const lagStr = s.lagBytes !== null
            ? (s.lagBytes / 1048576).toFixed(1) + ' MB'
            : 'N/A';
        const staleStr = s.streamStalenessSec !== null
            ? s.streamStalenessSec + 's'
            : 'N/A';
        const restartsStr = s.restartsSinceLastCheck !== null
            ? `${s.restartsSinceLastCheck} restarts`
            : 'N/A';
        lines.push(`  ${s.db}:`);
        lines.push(`    Slot:       ${s.slotName}`);
        lines.push(`    Lag:        ${lagStr}`);
        lines.push(`    Daemon:     ${daemonIcon} (${s.daemonRunning ? 'running' : 'STOPPED'})`);
        lines.push(`    Stream:     ${staleStr} since last write`);
        lines.push(`    Restarts:   ${restartsStr}`);
    }
    if (result.alerts.length > 0) {
        lines.push('');
        lines.push('─'.repeat(72));
        lines.push(`  ALERTS (${result.alerts.length}):`);
        lines.push('');
        for (const a of result.alerts) {
            const icon = a.type === 'safety-valve' ? '🔴' :
                a.type === 'lag-critical' ? '🔴' :
                    a.type === 'daemon-dead' ? '🟠' : '🟡';
            lines.push(`  ${icon} [${a.type}] ${a.db}:`);
            lines.push(`      ${a.message}`);
        }
    }
    if (result.safetyValveDropped.length > 0) {
        lines.push('');
        lines.push('─'.repeat(72));
        lines.push('  🔴 SAFETY VALVE TRIGGERED:');
        for (const db of result.safetyValveDropped) {
            lines.push(`    - Slot for "${db}" was dropped to protect cluster WAL`);
            lines.push(`      Re-run 'pg-cdc setup ${db}' to re-protect after fixing the issue`);
        }
    }
    if (result.alerts.length === 0) {
        lines.push('');
        lines.push('  ✅ All systems nominal.');
    }
    lines.push('');
    return lines.join('\n');
}
