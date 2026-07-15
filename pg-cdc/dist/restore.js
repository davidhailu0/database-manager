import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';
import postgres from 'postgres';
import { execSync } from 'child_process';
import { pgConnectionForDb } from './config.js';
// =============================================================================
// Find baseline
// =============================================================================
function findBaseline(backupDir, targetTs) {
    if (!existsSync(backupDir))
        return null;
    const files = readdirSync(backupDir)
        .filter(f => f.startsWith('base_') && f.endsWith('.dump'))
        .sort()
        .reverse(); // newest first
    for (const file of files) {
        // Parse timestamp from filename: base_YYYYMMDD_HHMMSS.dump
        const match = file.match(/^base_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.dump$/);
        if (!match)
            continue;
        const [_, y, mo, d, h, mi, s] = match;
        const fileTs = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
        if (fileTs <= targetTs) {
            const fullPath = resolve(backupDir, file);
            return {
                path: fullPath,
                timestamp: fileTs.toISOString(),
                size: statSync(fullPath).size,
            };
        }
    }
    return null;
}
// =============================================================================
// Parse capture stream files
// =============================================================================
function readStreamFiles(captureDir) {
    if (!existsSync(captureDir))
        return [];
    const files = readdirSync(captureDir)
        .filter(f => f.startsWith('stream_') && f.endsWith('.jsonl'))
        .sort()
        .reverse(); // newest first for searching
    const records = [];
    for (const file of files) {
        const content = readFileSync(resolve(captureDir, file), 'utf-8');
        // wal2json with pretty-print=1 outputs multi-line JSON objects separated
        // by newlines at the top level. Accumulate lines until we have a valid
        // JSON object, then parse it.
        let buffer = '';
        let braceDepth = 0;
        let inString = false;
        let escapeNext = false;
        for (const ch of content) {
            buffer += ch;
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            if (ch === '\\' && inString) {
                escapeNext = true;
                continue;
            }
            if (ch === '"')
                inString = !inString;
            if (!inString) {
                if (ch === '{')
                    braceDepth++;
                if (ch === '}')
                    braceDepth--;
            }
            // When braceDepth returns to 0 after a complete object, try parsing
            if (braceDepth === 0 && buffer.trimEnd().endsWith('}')) {
                const trimmed = buffer.trim();
                if (trimmed) {
                    try {
                        const record = JSON.parse(trimmed);
                        if (record.change && Array.isArray(record.change)) {
                            records.push(record);
                        }
                    }
                    catch {
                        // skip malformed records
                    }
                }
                buffer = '';
            }
        }
    }
    return records;
}
// =============================================================================
// Filter records by timestamp range
// =============================================================================
function parseTimestamp(ts) {
    return new Date(ts).getTime();
}
function filterRecords(records, fromTimestamp, // only include records AFTER this timestamp
targetTs) {
    const targetMs = targetTs.getTime();
    const fromMs = fromTimestamp ? fromTimestamp.getTime() : 0;
    const warnings = [];
    const sqlStatements = [];
    let discarded = 0;
    let reachedTimestamp = '';
    // Sort records by timestamp (wal2json with pretty-print groups
    // all changes per xid into a single record — each IS a complete txn)
    const sorted = [...records].sort((a, b) => {
        const ta = a.timestamp ? parseTimestamp(a.timestamp) : 0;
        const tb = b.timestamp ? parseTimestamp(b.timestamp) : 0;
        return ta - tb;
    });
    for (const record of sorted) {
        if (!record.change || !Array.isArray(record.change))
            continue;
        const tsMatch = record.timestamp;
        const recordMs = tsMatch ? parseTimestamp(tsMatch) : 0;
        // Skip records before the baseline (already in the restore)
        if (fromMs > 0 && recordMs <= fromMs)
            continue;
        // If this record's timestamp is past the target, discard
        if (tsMatch && targetMs > 0 && recordMs > targetMs) {
            discarded++;
            continue;
        }
        // Build SQL for all DML changes in this transaction
        const statements = [];
        for (const change of record.change) {
            const k = change.kind;
            if (k !== 'insert' && k !== 'update' && k !== 'delete')
                continue;
            const sql = changeToSql(change, record);
            if (sql)
                statements.push(sql);
        }
        if (statements.length > 0) {
            const txSql = buildTransactionSql(statements);
            if (txSql)
                sqlStatements.push(txSql);
        }
    }
    // The last reachable timestamp is the last committed record's timestamp
    const included = sorted.filter(r => r.timestamp && parseTimestamp(r.timestamp) <= targetMs && parseTimestamp(r.timestamp) > fromMs);
    reachedTimestamp = included.length > 0
        ? included[included.length - 1].timestamp
        : targetTs.toISOString();
    return {
        commits: sqlStatements,
        discarded,
        reachedTs: reachedTimestamp,
        warnings,
    };
}
// =============================================================================
// Convert wal2json change to SQL
// =============================================================================
function changeToSql(change, record) {
    if (!change.table || !change.columnnames)
        return null;
    const schema = change.schema ?? 'public';
    const table = `"${schema}"."${change.table}"`;
    switch (change.kind) {
        case 'insert': {
            if (!change.columnvalues)
                return null;
            const cols = change.columnnames.map(c => `"${c}"`).join(', ');
            const vals = change.columnvalues.map(v => formatValue(v)).join(', ');
            return `INSERT INTO ${table} (${cols}) VALUES (${vals});`;
        }
        case 'update': {
            if (!change.columnvalues)
                return null;
            const setClauses = change.columnnames.map((c, i) => `"${c}" = ${formatValue(change.columnvalues[i])}`).join(', ');
            let whereClause = '';
            if (change.oldkeys) {
                whereClause = change.oldkeys.columnnames.map((c, i) => `"${c}" = ${formatValue(change.oldkeys.columnvalues[i])}`).join(' AND ');
            }
            if (whereClause) {
                return `UPDATE ${table} SET ${setClauses} WHERE ${whereClause};`;
            }
            return null;
        }
        case 'delete': {
            if (change.oldkeys) {
                const whereClause = change.oldkeys.columnnames.map((c, i) => `"${c}" = ${formatValue(change.oldkeys.columnvalues[i])}`).join(' AND ');
                return `DELETE FROM ${table} WHERE ${whereClause};`;
            }
            return null;
        }
        default:
            return null;
    }
}
function formatValue(val) {
    if (val === null || val === undefined)
        return 'NULL';
    if (typeof val === 'number')
        return val.toString();
    if (typeof val === 'boolean')
        return val ? 'true' : 'false';
    // Escape single quotes for string values
    const str = String(val).replace(/'/g, "''");
    return `'${str}'`;
}
function buildTransactionSql(statements) {
    if (statements.length === 0)
        return null;
    const lines = ['BEGIN;'];
    for (const stmt of statements) {
        lines.push(stmt);
    }
    lines.push('COMMIT;');
    return lines.join('\n');
}
// =============================================================================
// Check for known gaps (Phase 6)
// =============================================================================
async function checkForGaps(sql, targetDb) {
    const warnings = [];
    // Check for large objects
    try {
        const loCount = await sql `
      SELECT count(*)::int as cnt FROM pg_largeobject_metadata
    `;
        if (loCount[0]?.cnt > 0) {
            warnings.push(`Target database "${targetDb}" uses large objects (${loCount[0].cnt} large objects). ` +
                `Large objects are NOT captured by logical replication. They must be transferred separately.`);
        }
    }
    catch {
        // pg_largeobject_metadata might not be accessible
    }
    // Check for sequences that need setval
    try {
        const seqs = await sql `
      SELECT relname FROM pg_class WHERE relkind = 'S'
    `;
        if (seqs.length > 0) {
            warnings.push(`Found ${seqs.length} sequence(s) in the restored database. ` +
                `Sequence values are NOT replicated by logical replication. ` +
                `After restore, reconcile sequence values with the source: ` +
                `SELECT setval('seq_name', (SELECT max(id) FROM source_table) + 1);`);
        }
    }
    catch {
        // best effort
    }
    return warnings;
}
// =============================================================================
// Main restore orchestrator
// =============================================================================
export async function restoreDatabase(cfg, sourceDb, options) {
    const warnings = [];
    const captureDir = `${cfg.capture_dir}/${sourceDb}`;
    const backupDir = `${cfg.backup_dir}/${sourceDb}`;
    const targetTs = options.toTimestamp ? new Date(options.toTimestamp) : new Date();
    // ---- Derive target connection from source connection ----
    // The target database is not in the config, so we derive its connection
    // string by replacing the database name in the source connection.
    const sourceConnStr = pgConnectionForDb(cfg, sourceDb);
    function targetConnStr(db) {
        return sourceConnStr.replace(/\/[^/]*$/, '/' + db);
    }
    // ---- Safety: never restore to source without --force-production ----
    if (options.targetDb === sourceDb && !options.forceProduction) {
        throw new Error(`Refusing to restore "${sourceDb}" over itself without --force-production. ` +
            `Specify a different target database name or add --force-production.`);
    }
    const summary = {
        baselineUsed: null,
        eventsParsed: 0,
        transactionsCommitted: 0,
        transactionsDiscarded: 0,
        pointInTimeRequested: options.toTimestamp ?? 'now',
        pointInTimeReached: '',
        warnings,
    };
    // ---- Find baseline ----
    const baseline = findBaseline(backupDir, targetTs);
    if (!baseline) {
        warnings.push(`No baseline dump found for "${sourceDb}" at or before ${targetTs.toISOString()}. Replaying from empty database.`);
    }
    else {
        summary.baselineUsed = baseline;
        warnings.push(`Using baseline: ${baseline.path} (${(baseline.size / 1048576).toFixed(1)} MB)`);
    }
    // ---- Parse stream files ----
    const allRecords = readStreamFiles(captureDir);
    summary.eventsParsed = allRecords.reduce((sum, r) => sum + r.change.length, 0);
    if (allRecords.length === 0) {
        warnings.push(`No capture stream files found in ${captureDir}. Restoring baseline only.`);
        summary.pointInTimeReached = targetTs.toISOString();
        return summary;
    }
    // ---- Filter records (from baseline timestamp onward to avoid duplicates) ----
    const baselineFilter = baseline ? new Date(baseline.timestamp) : null;
    const filtered = filterRecords(allRecords, baselineFilter, targetTs);
    summary.transactionsCommitted = filtered.commits.length;
    summary.transactionsDiscarded = filtered.discarded;
    summary.pointInTimeReached = filtered.reachedTs;
    summary.warnings.push(...filtered.warnings);
    // ---- Print planned actions (dry-run summary for the CLI) ----
    console.log('\nRestore Plan:');
    console.log(`  Source DB:      ${sourceDb}`);
    console.log(`  Target DB:      ${options.targetDb}`);
    console.log(`  Target time:    ${summary.pointInTimeRequested}`);
    console.log(`  Baseline:       ${baseline?.path ?? 'none'}`);
    console.log(`  Events parsed:  ${summary.eventsParsed}`);
    console.log(`  Transactions:   ${summary.transactionsCommitted} commit, ${summary.transactionsDiscarded} discard`);
    console.log(`  PIT reached:    ${summary.pointInTimeReached}`);
    console.log('');
    // ---- Execute restoration ----
    // Step 0: Ensure target database exists
    const createSql = postgres(cfg.pg_connection, { max: 1, idle_timeout: 30 });
    try {
        await createSql `CREATE DATABASE ${createSql(options.targetDb)}`;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (!msg.includes('already exists')) {
            warnings.push(`Could not create database: ${msg}`);
        }
    }
    finally {
        await createSql.end();
    }
    // Step 1: pg_restore baseline
    if (baseline) {
        console.log(`[RESTORE] Restoring baseline to "${options.targetDb}"...`);
        const tConn = targetConnStr(options.targetDb);
        const tUrl = new URL(tConn);
        const pgPass = tUrl.password;
        tUrl.password = '';
        const restoreArgs = [
            'pg_restore',
            '--dbname=' + tUrl.toString(),
            '--clean', '--if-exists',
            '--no-owner',
            baseline.path,
        ];
        try {
            execSync(restoreArgs.join(' '), {
                stdio: 'inherit',
                timeout: 3600_000,
                env: { ...process.env, PGPASSWORD: pgPass },
            });
        }
        catch (err) {
            throw new Error(`Baseline restore failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // Step 2: Replay captured events
    if (filtered.commits.length > 0) {
        console.log(`[RESTORE] Replaying ${filtered.commits.length} transactions...`);
        let replayed = 0;
        for (let i = 0; i < filtered.commits.length; i++) {
            const txSql = filtered.commits[i];
            // Use a fresh connection per transaction to avoid aborted-txn cascading
            const replaySql = postgres(targetConnStr(options.targetDb), { max: 1, idle_timeout: 30 });
            try {
                await replaySql.unsafe(txSql);
                replayed++;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                warnings.push(`Transaction ${i + 1} failed during replay: ${msg}`);
            }
            finally {
                await replaySql.end();
            }
        }
        summary.transactionsCommitted = replayed;
    }
    // ---- Phase 6: Check for known gaps ----
    const gapSql = postgres(targetConnStr(options.targetDb), { max: 1, idle_timeout: 30 });
    try {
        const gapWarnings = await checkForGaps(gapSql, options.targetDb);
        summary.warnings.push(...gapWarnings);
    }
    catch {
        // best effort
    }
    finally {
        await gapSql.end();
    }
    // ---- Summary ----
    warnings.push('');
    warnings.push('⚠  Post-restore checklist (manual steps required):');
    warnings.push('   1. Reconcile sequence values with setval()');
    warnings.push('   2. Verify row counts and data integrity');
    warnings.push('   3. Point application traffic at the restored DB manually');
    warnings.push('');
    console.log('\n' + '═'.repeat(60));
    console.log('  Restore Complete');
    console.log('═'.repeat(60));
    console.log(`  Baseline:         ${baseline?.path ?? 'none'}`);
    console.log(`  Events replayed:  ${summary.transactionsCommitted}`);
    console.log(`  Events discarded: ${summary.transactionsDiscarded}`);
    console.log(`  PIT requested:    ${summary.pointInTimeRequested}`);
    console.log(`  PIT reached:      ${summary.pointInTimeReached}`);
    if (summary.warnings.length > 0) {
        console.log('');
        console.log('  Warnings:');
        for (const w of summary.warnings) {
            console.log(`    ⚠ ${w}`);
        }
    }
    console.log('');
    return summary;
}
