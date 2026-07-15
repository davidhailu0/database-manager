export interface DatabaseConfig {
    name: string;
    connection?: string;
    retention_days: number;
    baseline_cron?: string;
    baseline_offset_minutes?: number;
}
export interface SafetyValveConfig {
    max_lag_bytes: number;
    grace_period_seconds: number;
}
export interface MonitoringConfig {
    lag_warn_bytes: number;
    slot_inactive_seconds: number;
    stream_stale_seconds: number;
    check_interval_seconds: number;
}
export interface PgCdcConfig {
    pg_connection: string;
    capture_dir: string;
    backup_dir: string;
    scripts_dir: string;
    safety_valve: SafetyValveConfig;
    monitoring: MonitoringConfig;
    baseline_concurrency: number;
    databases: DatabaseConfig[];
}
export declare function loadConfig(configPath?: string): PgCdcConfig;
export declare function pgConnectionForDb(cfg: PgCdcConfig, dbName: string): string;
