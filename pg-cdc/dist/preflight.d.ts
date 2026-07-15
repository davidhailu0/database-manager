import { PgCdcConfig } from './config.js';
export interface CheckResult {
    name: string;
    status: 'pass' | 'warn' | 'fail';
    message: string;
    fix?: string;
}
export declare function runPreflightChecks(cfg: PgCdcConfig): Promise<CheckResult[]>;
export declare function formatPreflightReport(results: CheckResult[]): string;
