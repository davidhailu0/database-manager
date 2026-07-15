import { PgCdcConfig } from './config.js';
export interface SetupResult {
    db: string;
    publication: 'created' | 'exists';
    slot: 'created' | 'exists';
    directory: 'created' | 'exists';
    systemd: 'enabled_started' | 'enabled' | 'exists';
    warnings: string[];
}
export declare function setupDatabase(cfg: PgCdcConfig, dbName: string): Promise<SetupResult>;
export declare function teardownDatabase(cfg: PgCdcConfig, dbName: string): Promise<void>;
