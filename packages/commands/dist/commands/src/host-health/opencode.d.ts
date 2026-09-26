export declare const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";
/** Historical git-based plugin entries for this harness repository. */
export declare function isLegacyMorningStarGitPlugin(plugin: string): boolean;
export declare function isMstarHarnessOpencodePlugin(plugin: string): boolean;
export declare function isAnyMstarHarnessOpencodeSlot(plugin: string): boolean;
export declare function validateOpencodeConfig(config: Record<string, unknown>): string[];
export declare function getOpencodeDoctorWarnings(config: Record<string, unknown>, allRoles: readonly string[]): string[];
export type OpencodeDoctorResult = {
    location: string;
    errors: string[];
    warnings: string[];
};
/** Discover and validate opencode.json beneath a supplied synthetic or real host root. */
export declare function diagnoseOpencodeHost(root: string, allRoles: readonly string[]): OpencodeDoctorResult;
