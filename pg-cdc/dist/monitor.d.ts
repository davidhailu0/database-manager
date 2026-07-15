import { PgCdcConfig } from './config.js';
export interface DbStatus {
    db: string;
    slotName: string;
    lagBytes: number | null;
    daemonRunning: boolean;
    streamStalenessSec: number | null;
    restartsSinceLastCheck: number | null;
}
export interface MonitorAlert {
    type: 'lag-warn' | 'lag-critical' | 'slot-inactive' | 'stream-stale' | 'daemon-dead' | 'safety-valve';
    db: string;
    message: string;
}
export interface MonitorResult {
    statuses: DbStatus[];
    alerts: MonitorAlert[];
    safetyValveDropped: string[];
}
export declare function runMonitor(cfg: PgCdcConfig): Promise<MonitorResult>;
export declare function formatMonitorReport(result: MonitorResult): string;
