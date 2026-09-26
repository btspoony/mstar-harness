export declare const DSH_BIN = "dsh";
/** The profile the dsh adapter operates on (fixed default `web`; dsh-tui not verified). */
export declare const DSH_PROFILE = "web";
export declare const DSH_PROFILE_FLAG = "--profile";
export declare const DSH_DUMP_FLAG = "--dump-config";
/** dsh home resolution: `$DSH_HOME`, else `~/.dsh`. */
export declare const DSH_HOME_ENV = "DSH_HOME";
export declare const DSH_HOME_SUBDIR = ".dsh";
export declare const DSH_PROFILES_DIR = "profiles";
export declare const DSH_INSTALL_HINT = "Install the DeepSeek Harness CLI (@deepseek-ai/dsh), e.g. `pnpm add -g @deepseek-ai/dsh` or `npm install -g @deepseek-ai/dsh`, then re-run init.";
/** Install/doctor row order: mstar first, fallbacks second. The fallbacks spec is an
 * exact pin (`DSH_LLM_FALLBACKS_VERSION`) because an unpinned `dsh plugin add` follows
 * the dsh CLI's own range and can boot-break the installed artifact. */
export declare const DSH_PLUGIN_SPECS: readonly string[];
export declare const DSH_FALLBACKS_SPEC: string;
/** Spec → loader-row name: strip a trailing `@<version>` (none in mstar's spec; fallbacks carries the pin). */
export declare function dshLoaderName(spec: string): string;
/** Loader-row name for the fallbacks package (dump-config `name:` line is version-free). */
export declare const DSH_FALLBACKS_LOADER_NAME: string;
/** One loader entry from a `--dump-config` dump. */
export type DshLoaderEntry = {
    name: string;
    enabled: boolean;
};
export type DshCommandRunner = (args: string[]) => string;
export type DshDoctorResult = {
    location: string;
    errors: string[];
    notes: string[];
};
/** Resolve the dsh home. An explicit root wins so callers can probe a synthetic tree
 * without reading `$DSH_HOME` or the real home directory. */
export declare function resolveDshHome(dshHome?: string): string;
/** The `web` profile directory under a dsh home. */
export declare function resolveDshProfileDir(dshHome?: string): string;
/** Read the installed fallbacks package version from a profile tree. Missing or unreadable artifacts return null. */
export declare function readInstalledFallbacksVersion(profileDir: string): string | null;
/** True when the profile's installed fallbacks version is missing or differs from the harness pin. */
export declare function fallbacksVersionDrifted(profileDir: string): boolean;
/** Probe whether dsh is executable; diagnostic failures are reported as unavailable. */
export declare function isDshAvailable(probe: () => unknown): boolean;
/** Parse loader entries from a `dsh --profile <name> --dump-config` dump: a
 * flat list of `- id: <id>` entries, each carrying a `name: <spec>` line plus
 * optional keys at the same 2-space indent. Returns null when the dump is
 * non-empty but yields no named entry (or an entry without a `name:` line) —
 * format drift — so callers degrade loudly instead of misreporting the
 * installed state. `enabled` is false for a literal `disabled: true` or
 * `enabled: false` marker (standalone 2-space line, or inline on the `- id:` /
 * `name:` line). `!!js` expressions are not statically decidable and count as enabled. */
export declare function parseDshLoaderEntries(dump: string): DshLoaderEntry[] | null;
/** Assemble read-only dsh doctor findings from a command probe and a profile root.
 * `mounted` means a loader row is present and not disabled; this does not boot a fiber.
 * Issue states go to `errors`; every state also gets a worded `notes` line. An unusable
 * probe degrades into an explicit error instead of a silent pass. */
export declare function diagnoseDshHost(runDsh: DshCommandRunner, roots?: {
    dshHome?: string;
}): DshDoctorResult;
