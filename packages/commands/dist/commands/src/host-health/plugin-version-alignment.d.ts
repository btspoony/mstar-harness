export type HostTarget = "opencode" | "cursor" | "codex" | "zcode" | "omp" | "dsh" | "kimi";
export type HostScope = "global" | "project";
export declare const PLUGIN_VERSION_SHAPE_RE: RegExp;
export declare function detectOpencodePluginVersion(packagesRoot?: string): string | null;
export declare function detectCursorPluginVersion(pluginRoot: string): string | null;
export declare function detectCursorPluginVersionForScope(scope: HostScope, paths?: {
    project?: string;
    global?: string;
}): string | null;
export declare function detectZcodePluginVersion(cacheRoot?: string): string | null;
export declare function detectDshPluginVersion(dshHome?: string): string | null;
/** Version precedence for one parsed `omp plugin list` entry; no subprocess. */
export declare function ompEntryVersion(entry: Record<string, unknown>): string | null;
export declare function formatPluginVersionDoctorNote(target: HostTarget, cliVersion: string, installed: string | null): string;
