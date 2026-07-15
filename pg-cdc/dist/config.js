import { readFileSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
// =============================================================================
// Defaults
// =============================================================================
const DEFAULTS = {
    capture_dir: '/var/pg-cdc',
    backup_dir: '/var/backups/pg',
    scripts_dir: '/etc/pg-cdc',
    safety_valve: {
        max_lag_bytes: 1073741824,
        grace_period_seconds: 300,
    },
    monitoring: {
        lag_warn_bytes: 52428800,
        slot_inactive_seconds: 600,
        stream_stale_seconds: 120,
        check_interval_seconds: 60,
    },
    baseline_concurrency: 3,
    databases: [],
};
// =============================================================================
// Config paths (searched in order)
// =============================================================================
const CONFIG_PATHS = [
    '/etc/pg-cdc/protected_dbs.yaml',
    './protected_dbs.yaml',
    './pg-cdc/protected_dbs.yaml',
];
// =============================================================================
// Loader
// =============================================================================
export function loadConfig(configPath) {
    const path = configPath ?? CONFIG_PATHS.find((p) => {
        try {
            readFileSync(p, 'utf-8');
            return true;
        }
        catch {
            return false;
        }
    });
    if (!path) {
        throw new Error('No config file found. Searched: ' + CONFIG_PATHS.join(', ') +
            '\nCreate one or pass --config <path>');
    }
    const raw = readFileSync(path, 'utf-8');
    const doc = parseYaml(raw);
    if (!doc || typeof doc !== 'object') {
        throw new Error(`Config file ${path} is empty or not valid YAML`);
    }
    const cfg = {
        pg_connection: required(doc, 'pg_connection', path),
        capture_dir: doc.capture_dir ?? DEFAULTS.capture_dir,
        backup_dir: doc.backup_dir ?? DEFAULTS.backup_dir,
        scripts_dir: doc.scripts_dir ?? DEFAULTS.scripts_dir,
        safety_valve: {
            max_lag_bytes: doc.safety_valve?.max_lag_bytes ??
                DEFAULTS.safety_valve.max_lag_bytes,
            grace_period_seconds: doc.safety_valve?.grace_period_seconds ??
                DEFAULTS.safety_valve.grace_period_seconds,
        },
        monitoring: {
            lag_warn_bytes: doc.monitoring?.lag_warn_bytes ??
                DEFAULTS.monitoring.lag_warn_bytes,
            slot_inactive_seconds: doc.monitoring?.slot_inactive_seconds ??
                DEFAULTS.monitoring.slot_inactive_seconds,
            stream_stale_seconds: doc.monitoring?.stream_stale_seconds ??
                DEFAULTS.monitoring.stream_stale_seconds,
            check_interval_seconds: doc.monitoring?.check_interval_seconds ??
                DEFAULTS.monitoring.check_interval_seconds,
        },
        baseline_concurrency: doc.baseline_concurrency ?? DEFAULTS.baseline_concurrency,
        databases: (doc.databases ?? []).map((d, i) => ({
            name: required(d, 'name', `${path}[${i}]`),
            connection: d.connection,
            retention_days: d.retention_days ?? 30,
            baseline_cron: d.baseline_cron ?? '0 3 * * *',
            baseline_offset_minutes: d.baseline_offset_minutes ?? 0,
        })),
    };
    validate(cfg, path);
    return cfg;
}
// =============================================================================
// Validation
// =============================================================================
function validate(cfg, path) {
    const errors = [];
    if (!cfg.pg_connection.startsWith('postgresql://') && !cfg.pg_connection.startsWith('postgres://')) {
        errors.push('pg_connection must be a valid PostgreSQL connection URI');
    }
    if (cfg.safety_valve.max_lag_bytes <= 0) {
        errors.push('safety_valve.max_lag_bytes must be > 0');
    }
    if (cfg.safety_valve.grace_period_seconds <= 0) {
        errors.push('safety_valve.grace_period_seconds must be > 0');
    }
    const names = new Set();
    for (const db of cfg.databases) {
        if (names.has(db.name)) {
            errors.push(`Duplicate database name: ${db.name}`);
        }
        names.add(db.name);
        if (db.retention_days <= 0) {
            errors.push(`Database "${db.name}": retention_days must be > 0`);
        }
    }
    if (errors.length > 0) {
        throw new Error(`Config validation failed in ${path}:\n  - ` + errors.join('\n  - '));
    }
}
function required(doc, key, label) {
    const val = doc[key];
    if (!val || typeof val !== 'string' || val.trim() === '') {
        throw new Error(`Missing required config field "${key}" in ${label}`);
    }
    return val.trim();
}
// =============================================================================
// Helpers for downstream use
// =============================================================================
export function pgConnectionForDb(cfg, dbName) {
    const db = cfg.databases.find((d) => d.name === dbName);
    if (!db)
        throw new Error(`Unknown database: ${dbName}`);
    return db.connection ?? cfg.pg_connection.replace(/\/[^/]+$/, '/' + dbName);
}
