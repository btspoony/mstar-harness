import os from "node:os";
import path from "node:path";
import {
 detectOpencodeGeneration,
 getOpencodeDoctorWarnings,
 getOpencodeDoctorWarningsV2,
 isAnyMstarHarnessOpencodeSlot,
 isMstarHarnessOpencodePlugin,
 isMstarHarnessOpencodeV2Slot,
 OPENCODE_CONFIG_SCHEMA,
 OPENCODE_V2_PLUGIN,
 opencodeGenerationGuardWarning,
 validateOpencodeConfig,
 validateOpencodeConfigV2,
 type OpencodeGeneration,
} from "@mstar-harness/commands";
import { ALL_ROLES } from "../constants";
import type { AgentAdapter, MutateConfigForInitOptions, Scope } from "../types";
import { ensureObject, resolveProjectRoot } from "../utils";
import { ensureHostPresent } from "./host-presence";
import { probeOpencodeGeneration } from "./opencode-version-probe";

const MSTAR_OPENCODE_PLUGIN = "@mstar-harness/opencode@latest";

/** Exact dry-run annotation pinned by the prototype (revision 4) for a preview with no resolvable generation. */
const UNRESOLVED_GENERATION_ANNOTATION =
 "generation: unresolved (no --opencode-generation flag; no config markers; probes are skipped under --dry-run)";

/**
 * V2 MCP server entry mirroring `packages/opencode/mcp.json`'s `morning-star`
 * row (`["npx","@mstar-harness/cli","mcp"]`). The V2 schema (tag v2.0.26
 * `Mcp.LocalConfig`) has no `enabled` key \u2014 `disabled` absent means enabled,
 * so the V2 translation carries `type` + `command` only.
 */
const MORNING_STAR_MCP_SERVER = { type: "local", command: ["npx", "@mstar-harness/cli", "mcp"] };

function resolveOpencodeConfigPath(scope: Scope, outputPath?: string) {
 if (outputPath && outputPath.trim()) {
 const raw = outputPath.trim();
 if (path.isAbsolute(raw)) return raw;
 // A relative --output must name a path inside the project root: parent-dir
 // segments are refused outright, so the appended result cannot escape.
 if (raw.split(/[\\/]/).includes("..")) {
 throw new Error(`--output must not contain ".." segments: ${raw}`);
 }
 const root = resolveProjectRoot();
 return root.endsWith(path.sep) ? root + raw : root + path.sep + raw;
 }
 if (scope === "global") {
 const home = os.homedir();
 return `${home}${path.sep}.config${path.sep}opencode${path.sep}opencode.json`;
 }
 const root = resolveProjectRoot();
 return root.endsWith(path.sep) ? `${root}opencode.json` : `${root}${path.sep}opencode.json`;
}

// --- V1 write set (unchanged; singular `plugin` / `agent` keys, V1 $schema pin) ---

function ensureConfigSchema(config: Record<string, unknown>) {
 const next = ensureObject(config);
 next.$schema = OPENCODE_CONFIG_SCHEMA;
 return next;
}

function updatePluginList(config: Record<string, unknown>) {
 const next = ensureObject(config);
 const existing = Array.isArray(next.plugin) ? next.plugin : [];
 const result: unknown[] = [];
 for (const item of existing) {
 if (typeof item === "string" && isAnyMstarHarnessOpencodeSlot(item.trim())) continue;
 result.push(item);
 }
 result.push(MSTAR_OPENCODE_PLUGIN);
 next.plugin = result;
 return next;
}

/** Optional advanced path: write role models only when caller supplied assignments. */
function applyAssignments(config: Record<string, unknown>, assignments: Record<string, string>) {
 if (!Object.keys(assignments).length) return config;
 const next = ensureObject(config);
 const agent = ensureObject(next.agent);
 next.agent = agent;
 for (const [roleId, modelId] of Object.entries(assignments)) {
 const roleConfig = ensureObject(agent[roleId]);
 roleConfig.model = modelId;
 agent[roleId] = roleConfig;
 }
 return next;
}

function applyV1Init(config: Record<string, unknown>, assignments: Record<string, string>) {
 return applyAssignments(updatePluginList(ensureConfigSchema(config)), assignments);
}

// --- V2 write set (plural `plugins` / `agents` keys; $schema preserve-don't-invent) ---

/**
 * Owned-slot dedupe for the plural `plugins` array: every harness slot (V2
 * npm string/object forms, V1 npm string/object forms, legacy git entries) is
 * removed and the single canonical V2 entry appended \u2014 the V2 equivalent of
 * the V1 pass's dedupe. Unrelated entries keep their positions and shapes
 * byte-faithfully (objects by reference).
 */
function updateV2PluginList(config: Record<string, unknown>) {
 const next = ensureObject(config);
 const existing = Array.isArray(next.plugins) ? next.plugins : [];
 const result: unknown[] = [];
 for (const item of existing) {
 if (isOwnedOpencodeSlot(item)) continue;
 result.push(item);
 }
 result.push(OPENCODE_V2_PLUGIN);
 next.plugins = result;
 return next;
}

function isOwnedOpencodeSlot(item: unknown): boolean {
 if (isMstarHarnessOpencodeV2Slot(item)) return true;
 if (typeof item === "string") return isAnyMstarHarnessOpencodeSlot(item.trim());
 if (item !== null && typeof item === "object" && !Array.isArray(item) && "package" in item) {
 return typeof item.package === "string" && isMstarHarnessOpencodePlugin(item.package.trim());
 }
 return false;
}

/** Plural `agents.<role>.model` assignments, only when caller-supplied. */
function applyV2Assignments(config: Record<string, unknown>, assignments: Record<string, string>) {
 if (!Object.keys(assignments).length) return config;
 const next = ensureObject(config);
 const agents = ensureObject(next.agents);
 next.agents = agents;
 for (const [roleId, modelId] of Object.entries(assignments)) {
 const roleConfig = ensureObject(agents[roleId]);
 roleConfig.model = modelId;
 agents[roleId] = roleConfig;
 }
 return next;
}

/**
 * Non-destructive `mcp.servers["morning-star"]` merge: other servers and
 * other `mcp` keys survive untouched, and an existing morning-star entry
 * (user-modified or not) is never rewritten.
 */
/** The pinned V2 MCP schema allows only `timeout` and `servers` at the `mcp`
 * level; a V1-flat `mcp.<server>` row is not decodable by OpenCode V2. */
const V2_MCP_TOP_LEVEL_KEYS = new Set(["timeout", "servers"]);

/** Migrate V1-flat `mcp.<server>` rows under `mcp.servers` so a V2 config is
 * decodable instead of mixed; the flat keys are removed after migration. */
function migrateFlatMcpEntries(mcp: Record<string, unknown>): void {
 const servers = ensureObject(mcp.servers);
 mcp.servers = servers;
 for (const [key, value] of Object.entries(mcp)) {
  if (V2_MCP_TOP_LEVEL_KEYS.has(key)) continue;
  servers[key] = value;
  delete mcp[key];
 }
}

function mergeV2McpServer(config: Record<string, unknown>) {
 const next = ensureObject(config);
 const mcp = ensureObject(next.mcp);
 next.mcp = mcp;
 migrateFlatMcpEntries(mcp);
 const servers = ensureObject(mcp.servers);
 mcp.servers = servers;
 if (servers["morning-star"] === undefined) servers["morning-star"] = { ...MORNING_STAR_MCP_SERVER };
 return next;
}

/**
 * `$schema` pin rule (spec Q3): opencode v2.0.26 publishes no V2 `$schema` id
 * (`OPENCODE_V2_CONFIG_SCHEMA` is null by the contracted fallback), so the V2
 * pass preserves any existing `$schema` and never invents one \u2014 deliberately
 * no write here.
 */
function applyV2Init(config: Record<string, unknown>, assignments: Record<string, string>) {
 return mergeV2McpServer(applyV2Assignments(updateV2PluginList(config), assignments));
}

// --- generation resolution (presence gate / dry-run pure preview) ---

function asGeneration(value: string | undefined): OpencodeGeneration | undefined {
 return value === "v1" || value === "v2" ? value : undefined;
}

type GenerationResolution = {
 generation: OpencodeGeneration | null;
 /** Human-visible line naming the resolved generation and its source (or the exact unresolved annotation). */
 sourceLine: string;
 warning: string | null;
};

async function resolveInitGeneration(
 config: Record<string, unknown>,
 opts: MutateConfigForInitOptions,
): Promise<GenerationResolution> {
 if (opts.generation !== undefined) {
 const generation = asGeneration(opts.generation);
 if (generation === undefined) {
 throw new Error(`Invalid --opencode-generation value: ${String(opts.generation)}. Use --opencode-generation <v1|v2>.`);
 }
 const dryNote = opts.dryRun === true ? "; probes skipped under --dry-run" : "";
 return {
 generation,
 sourceLine: `Generation: ${generation} (explicit --opencode-generation flag${dryNote})`,
 warning: opencodeGenerationGuardWarning(config, generation),
 };
 }
 if (opts.dryRun === true) {
 //: under --dry-run neither probe runs. The preview generation comes
 // from the config-marker consistency guard, else the preview proceeds
 // non-refusing with the exact unresolved annotation \u2014 no silent default.
 const markers = detectOpencodeGeneration(config);
 if (markers === null) {
 return { generation: null, sourceLine: `Generation: ${UNRESOLVED_GENERATION_ANNOTATION}`, warning: null };
 }
 return {
 generation: markers,
 sourceLine: `Generation: ${markers} (config markers; probes skipped under --dry-run)`,
 warning: null,
 };
 }
 // Real install without the flag: the generation probe decides (the
 // host-presence gate has already run); probe failure is a typed refusal
 // naming the failure mode and the flag recovery \u2014 never a guess.
 const generation = await probeOpencodeGeneration(opts.probeRunner);
 return {
 generation,
 sourceLine: `Generation: ${generation} (opencode --version probe)`,
 warning: opencodeGenerationGuardWarning(config, generation),
 };
}

export const opencodeAdapter: AgentAdapter = {
 target: "opencode",
 mode: "config",
 // No getAvailableModels \u2014 default init never calls `opencode models` (that command can hang with no feedback).
 resolveConfigPath: (scope, outputPath) => resolveOpencodeConfigPath(scope, outputPath),
 mutateConfigForInit: async (config, assignments, opts = {}) => {
 //: resolve the executable's PATH entry before generation logic or any
 // config write. A broken/hung `opencode --version` is handled separately
 // by the generation probe, which can recover through the explicit flag.
 // Under `--dry-run` neither lookup nor generation probe runs .
 if (opts.dryRun !== true) await ensureHostPresent("opencode", opts.presenceRunner);
 const resolution = await resolveInitGeneration(config, opts);
 console.log(resolution.sourceLine);
 if (resolution.warning !== null) console.warn(`Warning: ${resolution.warning}`);
 // Unresolved preview: no write set is selected (no silent default); the
 // config is returned unchanged and every generation-dependent summary
 // line carries the exact unresolved annotation.
 if (resolution.generation === null) return ensureObject(config);
 return resolution.generation === "v2"
 ? applyV2Init(config, assignments)
 : applyV1Init(config, assignments);
 },
 validateConfig: (config, opts = {}) => {
 // Post-mutation configs always carry the markers of their generation, so
 // marker derivation validates the right surface even when the generation
 // was resolved by the probe inside mutateConfigForInit.
 const generation = opts.generation ?? detectOpencodeGeneration(config);
 if (generation === "v2") return validateOpencodeConfigV2(config);
 if (generation === "v1") return validateOpencodeConfig(config);
 return []; // unresolved preview \u2014 nothing was selected, nothing to validate
 },
 getDoctorWarnings: (config) => getOpencodeDoctorWarnings(config, ALL_ROLES),
 printPostSetupSummary: (config) => {
 const v2Present = Array.isArray(config.plugins) && (config.plugins as unknown[]).some((item) => isMstarHarnessOpencodeV2Slot(item));
 const v1Present = Array.isArray(config.plugin) && (config.plugin as unknown[]).some((item) => typeof item === "string" && isAnyMstarHarnessOpencodeSlot(item.trim()));
 // A dual-host config (both generations' owned slots) reports per-generation, bracketed like the doctor.
 const dual = v1Present && v2Present;
 const tag: SummaryTag = dual ? (label, line) => `[${label}] ${line}` : (_label, line) => line;
 if (v2Present) printV2Summary(tag);
 if (v1Present) printV1Summary(tag);
 if (!v2Present && !v1Present) {
 // Unresolved preview : every generation-dependent line carries the
 // exact annotation instead of a silently selected generation.
 for (const label of ["Schema", "Plugin", "MCP server"]) {
 console.log(`${label}: ${UNRESOLVED_GENERATION_ANNOTATION}`);
 }
 }
 },
};

type SummaryTag = (label: "v1" | "v2", line: string) => string;

function printV1Summary(tag: SummaryTag) {
 console.log(tag("v1", `Schema: ${OPENCODE_CONFIG_SCHEMA} (ensured)`));
 console.log(tag("v1", `Plugin: ${MSTAR_OPENCODE_PLUGIN} (ensured; legacy git morning-star entries removed)`));
 console.log(tag("v1", "Role models: left to OpenCode defaults (set agent.<role>.model in opencode.json only if you want overrides)"));
}

function printV2Summary(tag: SummaryTag) {
 console.log(tag("v2", "Schema: preserved as-is (opencode v2.0.26 publishes no V2 $schema id \u2014 existing value kept, none invented)"));
 console.log(tag("v2", `Plugin: ${OPENCODE_V2_PLUGIN} (ensured in \`plugins\`; owned slots deduped)`));
 console.log(tag("v2", `MCP: mcp.servers["morning-star"] \u2192 ["npx", "@mstar-harness/cli", "mcp"] (non-destructive merge)`));
 console.log(tag("v2", "Role models: left to OpenCode defaults (set agents.<role>.model in opencode.json only if you want overrides)"));
}
