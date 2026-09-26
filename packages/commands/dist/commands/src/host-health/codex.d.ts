export declare const CODEX_MARKETPLACE_NAME = "mstar-repo";
export type CodexCommandRunner = (args: string[]) => string;
/** Parse `codex plugin marketplace list --json` into configured marketplace names. */
export declare function parseCodexMarketplaceNames(dump: string): string[];
/** Parse `codex plugin list --json` into full installed entries. */
export declare function parseCodexInstalledEntries(dump: string): Array<Record<string, unknown>>;
/** Extract installed plugin IDs from a codex plugin-list response. */
export declare function parseCodexInstalledPluginIds(dump: string): string[];
/** Probe whether Codex is executable; diagnostic failures are reported as unavailable. */
export declare function isCodexAvailable(probe: () => unknown): boolean;
/** Discover the installed Morning Star plugin version; command and parse failures report null. */
export declare function detectCodexPluginVersion(runCodex: CodexCommandRunner): string | null;
/** Format a migration note for a legacy personal marketplace dump, if present. */
export declare function legacyCodexMarketplaceNote(raw: string, legacyPath: string): string | null;
export type CodexDoctorResult = {
    location: string;
    errors: string[];
    notes: string[];
};
/** Assemble read-only Codex doctor findings from the CLI probe and optional legacy artifact. */
export declare function diagnoseCodexHost(runCodex: CodexCommandRunner, legacyMarketplacePath: string): CodexDoctorResult;
