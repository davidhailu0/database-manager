import { PgCdcConfig } from './config.js';
export interface RestoreOptions {
    targetDb: string;
    toTimestamp?: string;
    forceProduction?: boolean;
}
export interface Wal2JsonChange {
    kind: string;
    table?: string;
    schema?: string;
    columnnames?: string[];
    columntypes?: string[];
    columnvalues?: any[];
    oldkeys?: {
        columnnames: string[];
        columntypes: string[];
        columnvalues: any[];
    };
}
export interface Wal2JsonRecord {
    nextlsn?: string;
    timestamp?: string;
    xid?: number;
    change: Wal2JsonChange[];
}
export interface BaselineInfo {
    path: string;
    timestamp: string;
    size: number;
}
export interface RestoreSummary {
    baselineUsed: BaselineInfo | null;
    eventsParsed: number;
    transactionsCommitted: number;
    transactionsDiscarded: number;
    pointInTimeRequested: string;
    pointInTimeReached: string;
    warnings: string[];
}
export declare function restoreDatabase(cfg: PgCdcConfig, sourceDb: string, options: RestoreOptions): Promise<RestoreSummary>;
