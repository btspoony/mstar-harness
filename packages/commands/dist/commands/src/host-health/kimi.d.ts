export declare function kimiManagedRoot(kimiCodeHome?: string): string;
/** Discover the highest installed Kimi plugin version; absent or malformed artifacts report null. */
export declare function detectKimiPluginVersion(kimiCodeHome?: string): string | null;
export type KimiDoctorResult = {
    location: string;
    errors: string[];
    notes: string[];
};
/** Assemble read-only Kimi doctor findings; Kimi manages plugin installation through its TUI. */
export declare function diagnoseKimiHost(kimiCodeHome?: string): KimiDoctorResult;
