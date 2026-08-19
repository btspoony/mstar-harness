/**
 * Engine host module — host auto-detection from tool shapes, skill-root
 * resolution, and the HostAdapter contract.
 *
 * Spec sources (each test cites the skill/reference section it enforces;
 * roadmap §8.5 C2 — engine unit tests cite the source section as spec):
 * - Detection table: `mstar-host` SKILL.md § Detect active host — ordered
 *   cursor → opencode → omp → kimi → zcode → codex; "Order matters"; the
 *   sharpest Task-based split is `subagent_type` (Cursor) vs `subagent`
 *   (OpenCode) vs `agent`/`tasks[]` (omp); `AgentSwarm` is Kimi-only;
 *   zcode is the Agent/AskUserQuestion/EnterPlanMode/TodoWrite row with
 *   no `AgentSwarm`; still-ambiguous falls back to prompt judgment.
 * - Skill-root resolution: `mstar-host` SKILL.md § Resolve loaded skill
 *   root — omp `skill://<name>[/<rel>]`, Cursor global plugin
 *   `~/.cursor/plugins/local/morning-star-harness/skills/<name>/`,
 *   Codex plugin-mounted `skills/<name>/`, OpenCode package-internal
 *   `harness-skills/<name>/` (never `process.cwd()/skills/`), Kimi/ZCode
 *   plugin mount `./skills/<name>/` from the installed plugin root.
 * - dsh row: dsh-adapter roadmap §4 D5 (this
 *   iteration) — dsh detection via its model-facing `subagent` delegation
 *   tool; skill root resolves via the skill-local bundled root
 *   `$DSH_BUNDLED_SKILL_DIR/<name>[/<rel>]` (dsh-skill-local
 *   `bundledSkillDir` default; single canonical mount per roadmap D6).
 * - HostAdapter: roadmap §8.4 —
 *   `{ host, beforeStatusWrite?, beforeDispatch?, beforeMerge?, log }`,
 *   all hooks optional, no concrete adapters in the engine, pi deferred
 *   (dsh's adapter ships in the dsh plugin).
 */
import { describe, expect, test } from "bun:test";
import {
  detectHost,
  resolveSkillRoot,
  type DetectResult,
  type HostAdapter,
  type HostId,
  type ToolSignal,
} from "../src/host.js";
import type { GateResult, ValidationResult } from "../src/core.js";

// ---------------------------------------------------------------------------
// detectHost — ordered detection table (cursor → opencode → omp → kimi →
// zcode → codex), ported verbatim from mstar-host § Detect active host
// ---------------------------------------------------------------------------

describe("detectHost", () => {
  test("single-signal matrix maps every tool shape to its host", () => {
    const matrix: Array<[ToolSignal, DetectResult]> = [
      ["subagent_type", "cursor"],
      ["question", "opencode"],
      ["task_subagent", "opencode"],
      ["task_agent_batch", "omp"],
      ["ask", "omp"],
      ["hub", "omp"],
      ["subagent", "dsh"],
      ["AgentSwarm", "kimi"],
      ["Agent", "zcode"],
      ["AskUserQuestion", "zcode"],
      ["EnterPlanMode", "zcode"],
      ["TodoWrite", "zcode"],
      ["plan_slash", "codex"],
      ["goal", "codex"],
      ["functions.*", "codex"],
      ["tool_search", "codex"],
    ];
    for (const [signal, expected] of matrix) {
      expect(detectHost([signal]), signal).toBe(expected);
    }
  });

  test("ordered evaluation: cursor wins on subagent_type regardless of other signals", () => {
    expect(detectHost(["subagent_type", "question"])).toBe("cursor");
    expect(detectHost(["subagent_type", "task_agent_batch", "AgentSwarm"])).toBe("cursor");
    expect(detectHost(["subagent_type", "tool_search"])).toBe("cursor");
  });

  test("ordered evaluation: opencode beats omp/kimi/zcode/codex signals", () => {
    expect(detectHost(["question", "task_agent_batch"])).toBe("opencode");
    expect(detectHost(["question", "Agent", "TodoWrite"])).toBe("opencode");
    expect(detectHost(["task_subagent", "hub"])).toBe("opencode");
    expect(detectHost(["question", "plan_slash"])).toBe("opencode");
  });

  test("ordered evaluation: omp beats kimi/zcode/codex signals", () => {
    expect(detectHost(["task_agent_batch", "AgentSwarm"])).toBe("omp");
    expect(detectHost(["hub", "Agent"])).toBe("omp");
    expect(detectHost(["ask", "tool_search"])).toBe("omp");
  });

  test("ordered evaluation: dsh row (subagent tool) after omp, before kimi/zcode/codex", () => {
    expect(detectHost(["subagent", "AgentSwarm"])).toBe("dsh");
    expect(detectHost(["subagent", "TodoWrite"])).toBe("dsh");
    expect(detectHost(["subagent", "plan_slash"])).toBe("dsh");
  });

  test("ordered evaluation: earlier rows (opencode/omp) beat the dsh signal", () => {
    expect(detectHost(["question", "subagent"])).toBe("opencode");
    expect(detectHost(["task_agent_batch", "subagent"])).toBe("omp");
  });

  test("ordered evaluation: AgentSwarm is Kimi-only once earlier rows are ruled out", () => {
    expect(detectHost(["Agent", "AgentSwarm"])).toBe("kimi");
    expect(detectHost(["AskUserQuestion", "AgentSwarm"])).toBe("kimi");
    expect(detectHost(["AgentSwarm", "TodoWrite"])).toBe("kimi");
  });

  test("ordered evaluation: zcode (no AgentSwarm) beats codex signals", () => {
    expect(detectHost(["Agent", "plan_slash"])).toBe("zcode");
    expect(detectHost(["TodoWrite", "tool_search"])).toBe("zcode");
    expect(detectHost(["EnterPlanMode", "goal"])).toBe("zcode");
  });

  test("codex row: /plan, /goal, Goal tools, functions.* and tool_search", () => {
    expect(detectHost(["plan_slash", "goal", "functions.*", "tool_search"])).toBe("codex");
    expect(detectHost(["plan_slash"])).toBe("codex");
  });

  test("still ambiguous → 'ambiguous' (prompt judgment per mstar-host)", () => {
    expect(detectHost([])).toBe("ambiguous");
    expect(detectHost(["totally_unknown" as ToolSignal])).toBe("ambiguous");
    // Browser-plugin tools are documented in the codex row but are not part
    // of the v1 signal enum — they must not accidentally resolve.
    expect(detectHost(["browser_plugin" as ToolSignal])).toBe("ambiguous");
  });
});

// ---------------------------------------------------------------------------
// resolveSkillRoot — per-host skill-root resolution table
// ---------------------------------------------------------------------------

describe("resolveSkillRoot", () => {
  test("omp prefers the skill:// scheme", () => {
    expect(resolveSkillRoot("omp", { skill: "mstar-host" })).toBe("skill://mstar-host");
    expect(resolveSkillRoot("omp", { skill: "mstar-host", rel: "references/omp.md" })).toBe(
      "skill://mstar-host/references/omp.md",
    );
    expect(resolveSkillRoot("omp", { skill: "mstar-host", rel: "" })).toBe("skill://mstar-host");
  });

  test("cursor resolves via the global plugin fallback (never app cwd)", () => {
    expect(resolveSkillRoot("cursor", { skill: "mstar-host", rel: "references/cursor.md" })).toBe(
      "~/.cursor/plugins/local/morning-star-harness/skills/mstar-host/references/cursor.md",
    );
  });

  test("codex resolves via the plugin-mounted skills/<name>/ root", () => {
    expect(resolveSkillRoot("codex", { skill: "mstar-host", rel: "references/codex.md" })).toBe(
      "skills/mstar-host/references/codex.md",
    );
  });

  test("opencode resolves via the package-internal harness-skills/<name>/ root", () => {
    expect(resolveSkillRoot("opencode", { skill: "mstar-host", rel: "references/opencode.md" })).toBe(
      "harness-skills/mstar-host/references/opencode.md",
    );
  });

  test("kimi and zcode resolve via the plugin mount ./skills/<name>/ root", () => {
    expect(resolveSkillRoot("kimi", { skill: "mstar-host", rel: "references/kimi.md" })).toBe(
      "./skills/mstar-host/references/kimi.md",
    );
    expect(resolveSkillRoot("zcode", { skill: "mstar-host", rel: "references/zcode.md" })).toBe(
      "./skills/mstar-host/references/zcode.md",
    );
  });

  test("dsh resolves via the skill-local bundled root $DSH_BUNDLED_SKILL_DIR (roadmap D5/D6)", () => {
    expect(resolveSkillRoot("dsh", { skill: "mstar-plan-conventions" })).toBe(
      "$DSH_BUNDLED_SKILL_DIR/mstar-plan-conventions",
    );
    expect(resolveSkillRoot("dsh", { skill: "mstar-plan-conventions", rel: "SKILL.md" })).toBe(
      "$DSH_BUNDLED_SKILL_DIR/mstar-plan-conventions/SKILL.md",
    );
    expect(resolveSkillRoot("dsh", { skill: "mstar-plan-conventions", rel: "" })).toBe(
      "$DSH_BUNDLED_SKILL_DIR/mstar-plan-conventions",
    );
  });

  test("pi stays deferred — no adapter stubs in v1 (roadmap §8.4)", () => {
    expect(resolveSkillRoot("pi", { skill: "mstar-host" })).toMatch(/deferred/);
  });
});

// ---------------------------------------------------------------------------
// HostAdapter — type-only contract (roadmap §8.4)
// ---------------------------------------------------------------------------

describe("HostAdapter", () => {
  test("all eight host ids satisfy the union", () => {
    const ids: HostId[] = ["opencode", "omp", "pi", "dsh", "cursor", "codex", "kimi", "zcode"];
    expect(ids).toHaveLength(8);
  });

  test("minimal adapter (log only) satisfies the interface — hooks are optional", () => {
    const calls: Array<[string, string]> = [];
    const adapter: HostAdapter = {
      host: "omp",
      log: (level, msg) => {
        calls.push([level, msg]);
      },
    };
    adapter.log("warn", "engine not installed — skill text authoritative");
    expect(calls).toEqual([["warn", "engine not installed — skill text authoritative"]]);
    expect(adapter.beforeStatusWrite).toBeUndefined();
    expect(adapter.beforeDispatch).toBeUndefined();
    expect(adapter.beforeMerge).toBeUndefined();
  });

  test("full adapter implements every hook with the roadmap §8.4 shapes", async () => {
    const adapter: HostAdapter = {
      host: "opencode",
      log: () => {},
      beforeStatusWrite: async (path, doc): Promise<ValidationResult> => ({
        ok: true,
        severity: "low",
        code: "host.beforeStatusWrite.ok",
        message: `status write to ${path} validated: ${JSON.stringify(doc).length} bytes`,
      }),
      beforeDispatch: async (): Promise<GateResult> => ({ ok: true, violations: [] }),
      beforeMerge: async (): Promise<GateResult> => ({ ok: true, violations: [] }),
    };
    const vr = await adapter.beforeStatusWrite?.("/tmp/status.json", { version: 1 });
    expect(vr?.ok).toBe(true);
    expect(vr?.code).toBe("host.beforeStatusWrite.ok");
    const g1 = await adapter.beforeDispatch?.({} as never);
    expect(g1?.ok).toBe(true);
    const g2 = await adapter.beforeMerge?.({} as never);
    expect(g2?.ok).toBe(true);
  });

  test("consumer degrades gracefully when a hook slot is absent (roadmap §8.4 invariant)", async () => {
    const adapter: HostAdapter = { host: "cursor", log: () => {} };
    const result = adapter.beforeStatusWrite ? await adapter.beforeStatusWrite("/tmp/x.json", {}) : { ok: true };
    expect(result).toEqual({ ok: true });
  });
});
