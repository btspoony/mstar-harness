import fs from "node:fs";
import path from "node:path";
import {
 getOpencodeDoctorWarnings,
 isAnyMstarHarnessOpencodeSlot,
 isMstarHarnessOpencodePlugin,
 validateOpencodeConfig,
} from "./opencode.js";

/**
 * V2 `$schema` pin decision — preserve-don't-invent (spec Q3 `$schema` pin rule).
 *
 * Source: anomalyco/opencode tag [`v2.0.26`](https://github.com/anomalyco/opencode/tree/v2.0.26)
 * `packages/schema/src/config.ts` declares `$schema` as `optional(Schema.String)`
 * with **no published default id/URL**, so no publishable V2 `$schema` id exists
 * at the pinned tag. Per the contracted fallback: the V2 write pass preserves
 * any existing `$schema` and never invents one, and the V2 validator checks the
 * plural-key contract instead of a `$schema` requirement. The V1 validator and
 * `OPENCODE_CONFIG_SCHEMA` stay untouched in `host-health/opencode.ts`.
 */
export const OPENCODE_V2_CONFIG_SCHEMA: string | null = null;

/** The single canonical V2 plugin slot this harness writes (owned-slot dedupe target). */
export const OPENCODE_V2_PLUGIN = "@mstar-harness/opencode-v2@latest";

export type OpencodeGeneration = "v1" | "v2";

/**
 * Match the owned V2 plugin slot in the plural `plugins` array — string form
 * (`@mstar-harness/opencode-v2[@version]`) and the V2 `{package, options}`
 * object form (tag v2.0.26 `ConfigPlugin.Entry`).
 */
export function isMstarHarnessOpencodeV2Slot(plugin: unknown): boolean {
 if (typeof plugin === "string") return isV2SlotName(plugin);
 if (plugin !== null && typeof plugin === "object" && !Array.isArray(plugin) && "package" in plugin) {
 return typeof plugin.package === "string" && isV2SlotName(plugin.package);
 }
 return false;
}

function isV2SlotName(value: string): boolean {
 const name = value.trim();
 return name === "@mstar-harness/opencode-v2" || name.startsWith("@mstar-harness/opencode-v2@");
}

/** Any owned slot this harness dedupes out of a `plugins` array: V2 slots (string/object), V1 npm slots, legacy git entries. */
function isOwnedPluginSlot(plugin: unknown): boolean {
 if (isMstarHarnessOpencodeV2Slot(plugin)) return true;
 if (typeof plugin === "string") return isAnyMstarHarnessOpencodeSlot(plugin.trim());
 if (plugin !== null && typeof plugin === "object" && !Array.isArray(plugin) && "package" in plugin) {
 return typeof plugin.package === "string" && isMstarHarnessOpencodePlugin(plugin.package.trim());
 }
 return false;
}

/**
 * V2 markers: the plural `plugins` key present as an array (the key itself is
 * the V2-native surface — its entries are irrelevant to the marker).
 */
export function hasOpencodeV2Markers(config: Record<string, unknown>): boolean {
 return Array.isArray(config.plugins);
}

/**
 * V1 markers: the singular `plugin` key holding an owned V1 slot (npm or
 * legacy git). The singular key alone, without an owned slot, is not a marker.
 */
export function hasOpencodeV1Markers(config: Record<string, unknown>): boolean {
 if (!Array.isArray(config.plugin)) return false;
 return config.plugin.some((item) => typeof item === "string" && isAnyMstarHarnessOpencodeSlot(item.trim()));
}

/**
 * Config-marker generation detection — the **consistency guard** (D12):
 * informational only, never the selection path. Returns `null` with no
 * markers, and on dual-host configs (both generations' keys present) where
 * no single generation can be derived; the doctor validates both instead.
 */
export function detectOpencodeGeneration(config: Record<string, unknown>): OpencodeGeneration | null {
 const v2 = hasOpencodeV2Markers(config);
 const v1 = hasOpencodeV1Markers(config);
 if (v2 && !v1) return "v2";
 if (v1 && !v2) return "v1";
 return null;
}

/**
 * Consistency-guard warning for a resolved generation that disagrees with a
 * single-generation marker set. `null` = agreement, no markers, or an
 * ambiguous dual-host config (every resolved generation matches one marker).
 */
export function opencodeGenerationGuardWarning(
 config: Record<string, unknown>,
 resolved: OpencodeGeneration,
): string | null {
 const markers = detectOpencodeGeneration(config);
 if (markers === null || markers === resolved) return null;
 const markerKey = markers === "v2" ? "`plugins`" : "`plugin`";
 return (
 `Config markers indicate ${markers} (${markerKey} key) but the resolved generation is ${resolved}; ` +
 `markers are a consistency guard only — continuing with ${resolved}. ` +
 `Re-run with --opencode-generation ${markers} if that is not intended.`
 );
}

/**
 * V2 config validation — the plural-key contract. `$schema` is never required
 * (no publishable V2 id at the pinned tag; see `OPENCODE_V2_CONFIG_SCHEMA`).
 * The singular `plugin` key is not validated here: a dual-host config is a
 * supported state, and V1 stays responsible for its own key.
 */
export function validateOpencodeConfigV2(config: Record<string, unknown>): string[] {
 const plugins = Array.isArray(config.plugins) ? config.plugins : [];
 const hasOwnedSlot = plugins.some((item) => isMstarHarnessOpencodeV2Slot(item));
 if (!hasOwnedSlot) {
 return ["Missing @mstar-harness/opencode-v2 plugin entry in `plugins` (string or {package} form)."];
 }
 return [];
}

/** V2 doctor warnings — mirrors the V1 model-coverage warning on the plural `agents` key. */
export function getOpencodeDoctorWarningsV2(
 config: Record<string, unknown>,
 allRoles: readonly string[],
): string[] {
 const warnings: string[] = [];
 const agents = config.agents !== null && typeof config.agents === "object" && !Array.isArray(config.agents)
 ? config.agents as Record<string, unknown>
 : {};
 const missingModels = allRoles.filter((roleId) => {
 const role = agents[roleId] !== null && typeof agents[roleId] === "object" && !Array.isArray(agents[roleId])
 ? agents[roleId] as Record<string, unknown>
 : {};
 return typeof role.model !== "string" || !role.model.trim();
 });
 if (missingModels.length) {
 warnings.push(
 `${missingModels.length} role(s) have no explicit agents.<role>.model — OpenCode default model will be used (recommended for fastest setup).`,
 );
 }
 return warnings;
}

export type OpencodeV2DoctorResult = {
 location: string;
 errors: string[];
 warnings: string[];
 /** The generations the doctor validated, in validation order. */
 generations: OpencodeGeneration[];
 /** Where the validated generation scope came from. */
 generationSource: string;
};

/**
 * Generation-aware doctor for `opencode.json` beneath a supplied root.
 *
 * `resolved` is the generation the caller resolved (explicit flag or probe —
 * the subprocess boundary stays with the caller). Under explicit selection
 * the doctor scopes to that one generation; otherwise a dual-host config
 * (both generations' keys present) validates BOTH and reports per-generation
 * results, and everything else validates the resolved generation. Marker
 * disagreement with the resolved generation becomes a warning, never an error.
 */
export function diagnoseOpencodeV2Host(
 root: string,
 allRoles: readonly string[],
 opts: { resolved: OpencodeGeneration; explicitSelection?: boolean },
): OpencodeV2DoctorResult {
 const resolved = opts.resolved;
 const explicitSelection = opts.explicitSelection === true;
 const location = path.join(root, "opencode.json");
 let config: Record<string, unknown>;
 try {
 const parsed: unknown = JSON.parse(fs.readFileSync(location, "utf8"));
 config = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
 ? parsed as Record<string, unknown>
 : {};
 } catch (error) {
 if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
 return { location, errors: [`Missing config file: ${location}`], warnings: [], generations: [], generationSource: "config read failed" };
 }
 const message = error instanceof Error ? error.message : String(error);
 return { location, errors: [`Could not read config file ${location}: ${message}`], warnings: [], generations: [], generationSource: "config read failed" };
 }

 // Dual-host doctor scope is key presence: a user running both hosts on one
 // config path has both generation keys (the marker guard's stricter
 // owned-slot semantics stay in detectOpencodeGeneration).
 const dualHost = Array.isArray(config.plugin) && Array.isArray(config.plugins);
 const generations: OpencodeGeneration[] = explicitSelection || !dualHost ? [resolved] : ["v1", "v2"];
 const generationSource = explicitSelection
 ? "explicit --opencode-generation flag"
 : dualHost
 ? "both generation keys present"
 : "opencode --version probe";

 const errors: string[] = [];
 const warnings: string[] = [];
 for (const generation of generations) {
 const generationErrors = generation === "v1" ? validateOpencodeConfig(config) : validateOpencodeConfigV2(config);
 errors.push(...generationErrors.map((entry) => `[${generation}] ${entry}`));
 if (generationErrors.length === 0) {
 const generationWarnings = generation === "v1"
 ? getOpencodeDoctorWarnings(config, allRoles)
 : getOpencodeDoctorWarningsV2(config, allRoles);
 warnings.push(...generationWarnings.map((entry) => `[${generation}] ${entry}`));
 }
 }
 const guardWarning = opencodeGenerationGuardWarning(config, resolved);
 if (guardWarning !== null) warnings.push(guardWarning);
 return { location, errors, warnings, generations, generationSource };
}

/**
 * Parse prefixed (`opencode vMAJOR.MINOR.PATCH`) and plain
 * (`MAJOR.MINOR.PATCH`) output forms. Major ≥ 2 → v2, 1.x → v1; anything
 * else (0.x, garbage) → `null` — the caller refuses, never guesses.
 */
export function parseOpencodeVersionOutput(output: string): OpencodeGeneration | null {
 const match = /^\s*(?:opencode\s+v)?(\d+)\.\d+\.\d+.*$/im.exec(output);
 if (!match) return null;
 const major = Number(match[1]);
 if (major >= 2) return "v2";
 if (major === 1) return "v1";
 return null;
}

export type OpencodeProbeFailureMode = "binary-missing" | "timeout" | "unparseable" | "spawn-failed";

export const OPENCODE_VERSION_TIMEOUT_MS = 5_000;

/** The typed recovery every probe refusal names (never a guess, no silent v1 fallback). */
export const OPENCODE_GENERATION_RECOVERY = "re-run with --opencode-generation <v1|v2> to select the generation explicitly";

/** Map a probe runner error onto the typed failure mode (shared by the CLI probe and the doctor probe). */
export function classifyOpencodeProbeError(error: unknown): OpencodeProbeFailureMode {
 if (error !== null && typeof error === "object") {
 if ("code" in error) {
 if (error.code === "ENOENT") return "binary-missing";
 if (error.code === "ETIMEDOUT" || error.code === "ABORT_ERR") return "timeout";
 }
 if ("killed" in error && error.killed === true) return "timeout";
 if ("signal" in error && error.signal !== null && error.signal !== undefined) return "timeout";
 }
 return "spawn-failed";
}

/** Single source for probe refusal wording: names the failure mode and the `--opencode-generation <v1|v2>` recovery. */
export function opencodeProbeFailureMessage(mode: OpencodeProbeFailureMode, detail?: string): string {
 const suffix = detail ? ` (${detail})` : "";
 const cause = mode === "binary-missing"
 ? "the opencode binary was not found"
 : mode === "timeout"
 ? "`opencode --version` timed out"
 : mode === "unparseable"
 ? "`opencode --version` output was not in the expected `opencode vMAJOR.MINOR.PATCH` form"
 : "`opencode --version` failed to run";
 return `Could not probe the opencode generation (${mode}): ${cause}${suffix}. Install the OpenCode CLI (https://opencode.ai) or ${OPENCODE_GENERATION_RECOVERY}.`;
}
