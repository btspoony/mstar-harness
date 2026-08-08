/**
 * Engine host module — host auto-detection from tool shapes, skill-root
 * resolution, and the type-only HostAdapter contract (thin; roadmap §8.2
 * `host` row, §4.2/§8.4).
 *
 * Source skills (semantic SSOT — this module ports their deterministic
 * rules verbatim, it never redefines them; roadmap §8.5 C2):
 * - `mstar-host` SKILL.md § Detect active host — the ordered table
 *   cursor → opencode → omp → kimi → zcode → codex ("Order matters").
 * - `mstar-host` SKILL.md § Resolve loaded skill root — per-host skill-root
 *   resolution.
 * - `.harness/references/skill-programmatic-roadmap.md` §8.4 — the
 *   `HostAdapter` shared contract (all hooks optional; no concrete adapters
 *   in the engine; pi/dsh deferred).
 *
 * UX judgment (ambiguous-host fallback reasoning, plan-mode bridges) stays
 * prompt — this module only turns tool shapes into a host id.
 */
import type { GateResult, ValidationResult } from "./core.js";
import type { AssignmentFields } from "./dispatch.js";
import type { IntegrationMergeLease } from "./lease.js";

/** All hosts the engine knows about (roadmap §8.4 host union). `pi` and
 * `dsh` have no plugin API in v1 — they appear in the union (and in
 * `HostAdapter.host`) but are never detected and get no adapters. */
export type HostId = "opencode" | "omp" | "pi" | "dsh" | "cursor" | "codex" | "kimi" | "zcode";

/** Result of `detectHost`: one of the six known hosts or `ambiguous`
 * (prompt judgment then applies per mstar-host). */
export type DetectResult = "opencode" | "omp" | "cursor" | "codex" | "kimi" | "zcode" | "ambiguous";

/** Tool-shape signal tokens accepted by `detectHost`, derived from the
 * mstar-host detection table. Plan-mode extras (CreatePlan/SwitchMode) and
 * Browser-plugin tools are documented in the table but are not part of the
 * v1 signal enum. */
export type ToolSignal =
  | "subagent_type"
  | "question"
  | "task_subagent"
  | "task_agent_batch"
  | "ask"
  | "hub"
  | "Agent"
  | "AgentSwarm"
  | "AskUserQuestion"
  | "EnterPlanMode"
  | "TodoWrite"
  | "plan_slash"
  | "goal"
  | "functions.*"
  | "tool_search";

/**
 * Detect the active host from session tool shapes, per the ordered
 * mstar-host table (ported verbatim):
 *
 * | Signal | Host |
 * |--------|------|
 * | `subagent_type` (Task param; plan mode + CreatePlan/SwitchMode) | cursor |
 * | `question`, or `task_subagent` (task tool, singular subagent, no batch) | opencode |
 * | `task_agent_batch` (task tool, agent/tasks[] batch), `ask`, `hub` | omp |
 * | `Agent`/`AskUserQuestion`/`EnterPlanMode` + `AgentSwarm` (Kimi-only) | kimi |
 * | `Agent`/`AskUserQuestion`/`EnterPlanMode`/`TodoWrite`, no `AgentSwarm` | zcode |
 * | `/plan`, `/goal`; Goal tools; `functions.*` namespaces; `tool_search` | codex |
 *
 * Order matters: cursor → opencode → omp → kimi → zcode → codex — the
 * sharpest Task-based split is `subagent_type` (Cursor) vs `subagent`
 * (OpenCode) vs `agent`/`tasks[]` (omp). Still ambiguous → `"ambiguous"`
 * (prompt judgment stays in the skill).
 */
export function detectHost(signals: readonly ToolSignal[]): DetectResult {
  const s = new Set(signals);
  if (s.has("subagent_type")) return "cursor";
  if (s.has("question") || s.has("task_subagent")) return "opencode";
  if (s.has("task_agent_batch") || s.has("ask") || s.has("hub")) return "omp";
  if (s.has("AgentSwarm")) return "kimi";
  if (s.has("Agent") || s.has("AskUserQuestion") || s.has("EnterPlanMode") || s.has("TodoWrite")) return "zcode";
  if (s.has("plan_slash") || s.has("goal") || s.has("functions.*") || s.has("tool_search")) return "codex";
  return "ambiguous";
}

/** Skill name + optional skill-relative path for skill-root resolution. */
export type SkillRootPaths = { skill: string; rel?: string };

/**
 * Resolve the loaded skill root for a host (mstar-host § Resolve loaded
 * skill root). Returns the canonical resolution string for the host —
 * resolve the loaded skill directory first, never `skills/<name>/…` from a
 * consumer app cwd (that layout exists in the harness source / plugin
 * package only).
 *
 * | Host | Resolution |
 * |------|------------|
 * | omp | `skill://<name>[/<rel>]` (filesystem fallback: plugin package root `skills/<name>/` after install/link) |
 * | cursor | `~/.cursor/plugins/local/morning-star-harness/skills/<name>[/<rel>]` (global plugin fallback; prefer skill name via plugin skills) |
 * | codex | `skills/<name>[/<rel>]` (plugin-mounted; project command skills under `.agents/skills/<name>/`) |
 * | opencode | `harness-skills/<name>[/<rel>]` (package-internal via `@mstar-harness/opencode` — never `process.cwd()/skills/`) |
 * | kimi / zcode | `./skills/<name>[/<rel>]` (plugin mount from the installed plugin root) |
 * | pi / dsh | deferred — no plugin API in v1 (roadmap §8.4) |
 */
export function resolveSkillRoot(host: HostId, paths: SkillRootPaths): string {
  const { skill, rel } = paths;
  const suffix = rel === undefined || rel === "" ? "" : `/${rel}`;
  switch (host) {
    case "omp":
      return `skill://${skill}${suffix}`;
    case "cursor":
      return `~/.cursor/plugins/local/morning-star-harness/skills/${skill}${suffix}`;
    case "codex":
      return `skills/${skill}${suffix}`;
    case "opencode":
      return `harness-skills/${skill}${suffix}`;
    case "kimi":
    case "zcode":
      return `./skills/${skill}${suffix}`;
    case "pi":
    case "dsh":
      return `deferred: ${host} has no plugin API in v1 — skill-root resolution lands with its adapter (roadmap §8.4)`;
  }
}

/**
 * Shared host-adapter contract (roadmap §8.4) — every host plugin implements
 * this; the engine never imports host-specific SDKs. All lifecycle hooks are
 * optional so a host degrades gracefully when a slot is absent (standalone
 * rule: skill text remains authoritative; the engine only returns results
 * the caller chooses to honor). `log` is required — adapters must be able to
 * report. No concrete adapters ship in the engine: opencode binds via its
 * own plugin code, omp via the command layer; pi/dsh adapters are deferred
 * until their plugin APIs land.
 */
export interface HostAdapter {
  host: "opencode" | "omp" | "pi" | "dsh" | "cursor" | "codex" | "kimi" | "zcode";
  /** Called before a status.json write; return a validation result the host
   * surfaces (non-blocking warn in v1, opt-in block in v2). */
  beforeStatusWrite?: (path: string, doc: unknown) => Promise<ValidationResult>;
  /** Called before a subagent dispatch; return the Assignment field gate. */
  beforeDispatch?: (assignment: AssignmentFields) => Promise<GateResult>;
  /** Called before an integration-branch merge; return the lease gate. */
  beforeMerge?: (lease: IntegrationMergeLease) => Promise<GateResult>;
  log: (level: "info" | "warn" | "error", msg: string) => void;
}
