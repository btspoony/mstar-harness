/**
 * scripts/skill-eval/closure.test.ts — skill load closure
 * (SP2). Task 1 captured the before-state pins (HEAD 5d7aab93, conflict
 * inventory C1–C3); Task 2 applied the A2 semantics and FLIPPED the pins to
 * the after-state (single load-selection authority in the roles hub, core
 * as pointer/lifecycle authority, none-coherent leaf boundary, narrow
 * roles-bootstrap exception in lintLoadOrder).
 *
 * What it pins (after-state, A2 applied):
 * 1. Reference integrity — every local file/directory referenced by the
 * roles hub, its role references, and the shared leaf block resolves on
 * disk; cross-skill `references/...` mentions resolve too. No cycles in
 * the unconditional required-read graph (which no longer contains a
 * leaf→core edge — `none` is coherent without core).
 * 2. Load-bearing anchors — the AC3 blocks (Completion Report / Git NEVER /
 * Non-Recursive Dispatch Rule / Shared anti-recursion NEVER in the shared
 * leaf block; roles Load Order + mapping; core 状态机 Done authority) are
 * present.
 * 3. Route matrix from Plan 01 cases (scripts/skill-eval/cases.json) —
 * PM/dev/QC/audit/close x first/resume, none and default(standard)
 * presets, engine absent/advisory/blocking all covered; each route's
 * none-closure contains identity chain + role-owned QC/QA obligations
 * and NO core; each route's default preset members exist on disk AND are
 * named in the route's role reference (list pinned in lockstep with the
 * refs, not free-floating).
 * 4. A2 authority pins — core points to the hub for load selection (no
 * universal-read rule); the hub owns the omission/none/named/resume/
 * unknown-preset decision; the REAL `lintLoadOrder` recognizes the one
 * hub bootstrap exception, still fails a hub without its decision
 * matrix, and REJECTS broad exemptions (an arbitrary topic with
 * hub-style bootstrap and no core-first declaration fails).
 * 5. Inventory gap closures (Task 1 coverageGapsFound) — audit mode has a
 * role-owned identity boundary in code-reviewer.md (trigger-contract +
 * enforcement honesty reachable under none); the close route's
 * Done-ownership stop condition is reachable because PM required reading
 * is declared not preset-gated.
 * 6. Red fixtures — on a disposable synthetic skill root, a removed
 * referenced target, a removed anchor heading, and a manufactured cycle
 * are each reported by the checker (i.e. the suite fails on such real
 * regressions).
 *
 * Runtime requirements (plan A6): `bun install` and `bun run engine:build`
 * before consumer tests — the engine import resolves @mstar-harness/engine.
 *
 * Run: bun test scripts/skill-eval/closure.test.ts
 * This is STRUCTURAL evidence only — it never substitutes for model traces
 * (Spec A1 runner/efficacy gate separation).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { lintLoadOrder } from "@mstar-harness/engine";

// ---------------------------------------------------------------------------
// Layout + loading
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "../..");
const SKILLS_DIR = join(REPO_ROOT, "skills");
const ROLES_DIR = join(SKILLS_DIR, "mstar-roles");
const ROLES_SKILL = join(ROLES_DIR, "SKILL.md");
const LEAF_CORE = join(ROLES_DIR, "references/_shared/leaf-executor-core.md");
const CORE_SKILL = join(SKILLS_DIR, "mstar-harness-core/SKILL.md");
const CASES_JSON = join(REPO_ROOT, "scripts/skill-eval/cases.json");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

// ---------------------------------------------------------------------------
// Reference extraction (pure text -> local targets)
// ---------------------------------------------------------------------------

/** `references/....md` / `references/dir/` mentions that are LOCAL to
 * mstar-roles (not preceded by a `<skill>/` path segment). */
const LOCAL_REF_RE = /(?<!\/)references\/[A-Za-z0-9._/-]+/g;

/** `mstar-X/references/....md` cross-skill mentions. */
const CROSS_SKILL_REF_RE = /mstar-[a-z0-9-]+\/references\/[A-Za-z0-9._/-]+/g;

function extractLocalRefs(text: string): string[] {
  return [...new Set((text.match(LOCAL_REF_RE) ?? []).map((s) => s.replace(/[.,;)\]]+$/, "")))];
}

function extractCrossSkillRefs(text: string): string[] {
  return [...new Set((text.match(CROSS_SKILL_REF_RE) ?? []).map((s) => s.replace(/[.,;)\]]+$/, "")))];
}

/** Role Reference Mapping rows of the roles hub: [agentId, reference]. */
function parseRoleMapping(rolesText: string): Array<{ agentId: string; reference: string }> {
  const rows: Array<{ agentId: string; reference: string }> = [];
  for (const line of rolesText.split(/\r?\n/)) {
    const m = /^\|\s*`([a-z0-9-]+)`\s*\|\s*`(references\/[a-z0-9.-]+\.md)`\s*\|/.exec(line);
    if (m) rows.push({ agentId: m[1], reference: m[2] });
  }
  return rows;
}

/** Every existing `mstar-X/references/...` path under a skills root. Short
 * form `references/...` mentions that are not local to mstar-roles resolve
 * against this index (role texts say e.g. "`mstar-host` ->
 * `references/opencode.md`"). */
function corpusReferenceIndex(corpusRoot: string): Set<string> {
  const index = new Set<string>();
  if (!existsSync(corpusRoot)) return index;
  const walk = (dir: string, skillName: string, rel: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const relPath = rel === "" ? entry : `${rel}/${entry}`;
      if (statSync(abs).isDirectory()) walk(abs, skillName, relPath);
      else index.add(`${skillName}/references/${relPath}`);
    }
  };
  for (const skill of readdirSync(corpusRoot)) {
    if (!skill.startsWith("mstar-")) continue;
    const refsDir = join(corpusRoot, skill, "references");
    if (existsSync(refsDir)) walk(refsDir, skill, "");
  }
  return index;
}

// ---------------------------------------------------------------------------
// Unconditional required-read graph
// ---------------------------------------------------------------------------

type ClosureReport = {
  missingTargets: string[];
  missingAnchors: string[];
  cycles: string[][];
 /** node -> direct unconditional targets (for closure assertions) */
  edges: Map<string, string[]>;
};

const LOAD_BEARING_ANCHORS: Array<{ file: string; heading: string; why: string }> = [
  { file: "references/_shared/leaf-executor-core.md", heading: "## Git NEVER (repo writes)", why: "AC3 repo-write discipline reachable under none" },
  { file: "references/_shared/leaf-executor-core.md", heading: "## Plan & Documentation Rules", why: "AC3 plan/done boundaries reachable under none" },
  { file: "references/_shared/leaf-executor-core.md", heading: "## Non-Recursive Dispatch Rule (shared shape)", why: "AC3 nondelegation reachable under none" },
  { file: "references/_shared/leaf-executor-core.md", heading: "## Shared anti-recursion NEVER", why: "AC3 anti-recursion reachable under none" },
  { file: "SKILL.md", heading: "## Load Order", why: "roles hub bootstrap section" },
  { file: "SKILL.md", heading: "## Role Reference Mapping", why: "roles hub identity mapping" },
];

function buildGraph(rootDir: string): ClosureReport {
  const rolesSkillPath = join(rootDir, "SKILL.md");
  const rolesText = read(rolesSkillPath);
  const mapping = parseRoleMapping(rolesText);
  const corpus = corpusReferenceIndex(join(rootDir, ".."));
  const edges = new Map<string, string[]>();
  const missingTargets: string[] = [];
  const cycles: string[][] = [];

  const addEdge = (from: string, to: string) => {
    const list = edges.get(from) ?? [];
    if (!list.includes(to)) list.push(to);
    edges.set(from, list);
  };

 // Identity edges: roles hub -> every mapped reference (unconditional).
  edges.set("SKILL.md", []);
  for (const { reference } of mapping) {
    const abs = join(rootDir, reference);
    if (!existsSync(abs)) missingTargets.push(`mstar-roles/${reference} (mapped from SKILL.md)`);
    addEdge("SKILL.md", reference);
  }
 // Cross-skill mentions from the hub itself (existence checks only).
  for (const cross of extractCrossSkillRefs(rolesText)) {
    if (!existsSync(join(SKILLS_DIR, cross))) {
      missingTargets.push(`${cross} (cross-skill, referenced by SKILL.md)`);
    }
  }

 // Role-owned edges: every local references/... mention inside a mapped
 // reference file is unconditional (role-owned files always load).
  for (const { agentId, reference } of mapping) {
    const abs = join(rootDir, reference);
    if (!existsSync(abs)) continue;
    const text = read(abs);
    edges.set(reference, edges.get(reference) ?? []);
    for (const ref of extractLocalRefs(text)) {
      const absTarget = join(rootDir, ref);
      if (existsSync(absTarget)) {
 // role-owned edge: local mentions always load with the reference
        addEdge(reference, ref);
        continue;
      }
 // Short-form mention of another skill's reference (e.g.
 // "`mstar-host` -> `references/opencode.md`"): resolvable anywhere in
 // the corpus counts as intact; nowhere = missing.
      const corpusHit = [...corpus].some((p) => p.endsWith(`/${ref}`));
      if (!corpusHit) {
        missingTargets.push(`mstar-roles/${ref} (referenced by ${reference} [${agentId}]) — no local or corpus match`);
      }
    }
    for (const cross of extractCrossSkillRefs(text)) {
      const absCross = join(SKILLS_DIR, cross);
      if (!existsSync(absCross)) missingTargets.push(`${cross} (cross-skill, referenced by ${reference} [${agentId}])`);
    }
  }

 // A2 flip (was conflict C3): the shared leaf block no longer carries an
 // unconditional core-first edge — under explicit `none` the identity chain
 // plus this role-owned boundary is the whole closure. There is therefore
 // NO leaf→core edge in the unconditional graph anymore.

 // Anchor checks.
  const missingAnchors: string[] = [];
  for (const { file, heading, why } of LOAD_BEARING_ANCHORS) {
    const abs = join(rootDir, file);
    if (!existsSync(abs)) continue; // already reported as missing target
    if (!read(abs).includes(heading)) missingAnchors.push(`${file}: missing "${heading}" (${why})`);
  }

 // Cycle detection (DFS over unconditional edges).
  const state = new Map<string, number>();
  const stack: string[] = [];
  const visit = (node: string) => {
    const s = state.get(node) ?? 0;
    if (s === 1) {
      const start = stack.indexOf(node);
      cycles.push([...stack.slice(start === -1 ? 0 : start), node]);
      return;
    }
    if (s === 2) return;
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) visit(next);
    stack.pop();
    state.set(node, 2);
  };
  for (const node of edges.keys()) visit(node);

  return { missingTargets, missingAnchors, cycles, edges };
}

/** Reachable closure following unconditional edges from the identity chain. */
function closureOf(report: ClosureReport, entryPoints: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entryPoints];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of report.edges.get(node) ?? []) queue.push(next);
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Real-repo inputs (loaded once)
// ---------------------------------------------------------------------------

const rolesText = read(ROLES_SKILL);
const leafText = read(LEAF_CORE);
const coreText = read(CORE_SKILL);
const mapping = parseRoleMapping(rolesText);

type EvalCase = {
  id: string;
  route: string;
  split: string;
  fixture: { files: Array<{ path: string; content: string }> };
  prompt: string;
  resumePrompt?: string;
  assertions: Array<{ id: string; kind: string; value: unknown; note?: string }>;
};
const cases = (JSON.parse(read(CASES_JSON)) as { schemaVersion: number; cases: EvalCase[] }).cases;

function agentsMdOf(c: EvalCase): string {
  return c.fixture.files.find((f) => f.path === "AGENTS.md")?.content ?? "";
}
function presetOf(c: EvalCase): "none" | "standard" | "unknown" {
  const m = /Skill presets:\s*([^\n]+)/.exec(agentsMdOf(c));
  if (!m) return "unknown";
  if (/\bnone\b/.test(m[1])) return "none";
  if (/\bstandard\b/.test(m[1])) return "standard";
  return "unknown";
}
function engineOf(c: EvalCase): "absent" | "advisory" | "blocking" | "unspecified" {
  const m = /Engine:\s*([^\n]+)/.exec(agentsMdOf(c));
  if (!m) return "unspecified";
  if (/\babsent\b/.test(m[1])) return "absent";
  if (/\badvisory\b/.test(m[1])) return "advisory";
  if (/\bblocking\b/.test(m[1])) return "blocking";
  return "unspecified";
}

const ROUTES = ["pm", "dev", "qc", "audit", "close"] as const;
const ROUTE_ROLE_REF: Record<(typeof ROUTES)[number], string> = {
  pm: "references/project-manager.md",
  dev: "references/fullstack-dev-shared.md",
  qc: "references/qc-specialist-shared.md",
  audit: "references/code-reviewer.md",
  close: "references/project-manager.md",
};
/** Role-owned files that must be reachable under none (per route class).
 * Pinned in lockstep with the role references — the derivation test below
 * asserts each entry is named in the route's role reference file, so this
 * list cannot silently drift from the refs. */
const ROLE_OWNED_UNDER_NONE: Record<(typeof ROUTES)[number], string[]> = {
  pm: ["references/project-manager/qa-trigger-matrix.md"],
  dev: [],
  qc: [
    "references/qc-specialist/reviewer-workflow.md",
    "references/qc-specialist/reviewer-checklist.md",
    "references/qc-specialist/report-template.md",
  ],
  audit: [],
  close: [],
};
/** Default(standard) preset members per route — structural existence + the
 * derivation test asserts each is named in the route's role reference (or
 * required-reading list for the preset-exempt PM/close route). Residual
 * drift (members named only in prose) is documented, not silently pinned:
 * the hub table summarizes menus; role refs own the member lists (A2). */
const DEFAULT_PRESET_MEMBERS: Record<(typeof ROUTES)[number], string[]> = {
  pm: ["mstar-dispatch-gates", "mstar-phase-gates", "mstar-conventions"],
  dev: ["mstar-coding-behavior", "mstar-dispatch-gates", "mstar-branch-worktree"],
  qc: ["mstar-branch-worktree", "mstar-artifacts"],
  audit: ["mstar-sdd", "mstar-audit", "mstar-conventions", "mstar-artifacts"],
  close: ["mstar-artifacts", "mstar-iteration"],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("skill load closure", () => {
  const realGraph = buildGraph(ROLES_DIR);

  afterAll(() => {
 // no persistent writes; temp fixtures clean up after themselves
  });

  test("reference integrity: no missing local/cross-skill targets, no anchor gaps, no cycles in the unconditional graph", () => {
    expect(realGraph.missingTargets).toEqual([]);
    expect(realGraph.missingAnchors).toEqual([]);
    expect(realGraph.cycles).toEqual([]);
  });

  test("roles hub maps all 14 agent ids and every mapped reference exists", () => {
    expect(mapping.length).toBe(14);
    for (const { agentId, reference } of mapping) {
      expect(existsSync(join(ROLES_DIR, reference)), `${agentId} -> ${reference}`).toBe(true);
    }
 // shared families stay on one shared reference file
    const refOf = (id: string) => mapping.find((m) => m.agentId === id)?.reference;
    expect(refOf("fullstack-dev")).toBe(refOf("fullstack-dev-2"));
    expect(refOf("qc-specialist")).toBe(refOf("qc-specialist-2"));
    expect(refOf("qc-specialist-3")).toBe(refOf("qc-specialist-2"));
  });

  test("AC3 anchors: load-bearing blocks of the shared leaf block and hubs are present", () => {
    for (const heading of [
      "## Completion Report",
      "## Git NEVER (repo writes)",
      "## Plan & Documentation Rules",
      "## Non-Recursive Dispatch Rule (shared shape)",
      "## Shared anti-recursion NEVER",
    ]) {
      expect(leafText.includes(heading), `leaf-executor-core.md ${heading}`).toBe(true);
    }
    expect(coreText.includes("## 状态机")).toBe(true);
    expect(coreText.includes("仅 `@project-manager` 或 `@qa-engineer`")).toBe(true);
  });

  test("case route matrix: 5 routes x first/resume, none + default present, engine absent/advisory/blocking present", () => {
    expect(cases.length).toBe(30);
    for (const route of ROUTES) {
      const routeCases = cases.filter((c) => c.route === route);
      expect(routeCases.length, `route ${route} case count`).toBe(6);
      expect(routeCases.some((c) => c.resumePrompt !== undefined), `route ${route} has a resume case`).toBe(true);
      expect(routeCases.some((c) => presetOf(c) === "standard"), `route ${route} has a default/standard case`).toBe(true);
    }
    const noneCases = cases.filter((c) => presetOf(c) === "none");
    expect(noneCases.length).toBeGreaterThanOrEqual(2);
    expect(new Set(noneCases.map((c) => c.route)).size).toBeGreaterThanOrEqual(2);
    for (const engine of ["absent", "advisory", "blocking"] as const) {
      expect(cases.some((c) => engineOf(c) === engine), `engine ${engine} covered`).toBe(true);
    }
 // splits stay per Plan 01 contract: dev4 + heldout2 per route
    for (const route of ROUTES) {
      const routeCases = cases.filter((c) => c.route === route);
      expect(routeCases.filter((c) => c.split === "dev").length, `${route} dev`).toBe(4);
      expect(routeCases.filter((c) => c.split === "heldout").length, `${route} heldout`).toBe(2);
    }
  });

  test("none closure: identity chain + role-owned QC/QA obligations reachable, core NOT required, for every route", () => {
    for (const route of ROUTES) {
      const closure = closureOf(realGraph, ["SKILL.md", ROUTE_ROLE_REF[route]]);
      expect(closure.has(ROUTE_ROLE_REF[route]), `${route} role reference reachable`).toBe(true);
      expect(closure.has("references/_shared/leaf-executor-core.md"), `${route} leaf boundary reachable`).toBe(true);
      for (const owned of ROLE_OWNED_UNDER_NONE[route]) {
        expect(closure.has(owned), `${route} role-owned ${owned} reachable under none`).toBe(true);
      }
    }
  });

  test("A2 pin (C3 flipped): the none closure does NOT pass through mstar-harness-core — leaf boundary is none-coherent", () => {
 // before-state: the leaf block forced "**Read `mstar-harness-core`
 // first.**" so every none closure was pulled through core. Task 2 (A2):
 // the leaf boundary carries the load-bearing semantics itself and load
 // selection follows the hub decision.
    expect(leafText.includes("**Read `mstar-harness-core` first.**")).toBe(false);
    expect(leafText.includes("Load selection follows the `mstar-roles` hub § Load Order")).toBe(true);
    expect(leafText.includes("`none` never grants delegation or waives gates")).toBe(true);
    const qcClosure = closureOf(realGraph, ["SKILL.md", ROUTE_ROLE_REF.qc]);
    expect(qcClosure.has("../mstar-harness-core/SKILL.md")).toBe(false);
 // AC3 still holds under none: leaf + role-owned checklist reachable
    expect(qcClosure.has("references/_shared/leaf-executor-core.md")).toBe(true);
    expect(qcClosure.has("references/qc-specialist/reviewer-checklist.md")).toBe(true);
  });

  test("default preset members exist on disk for every route AND are named in the route role reference", () => {
    for (const route of ROUTES) {
      const refText = read(join(ROLES_DIR, ROUTE_ROLE_REF[route]));
      for (const skill of DEFAULT_PRESET_MEMBERS[route]) {
        expect(existsSync(join(SKILLS_DIR, skill, "SKILL.md")), `${route} preset member ${skill}`).toBe(true);
        expect(
          refText.includes(`\`${skill}\``),
          `${route} preset member ${skill} named in ${ROUTE_ROLE_REF[route]}`,
        ).toBe(true);
      }
      for (const owned of ROLE_OWNED_UNDER_NONE[route]) {
        expect(
          refText.includes(`\`${owned}\``),
          `${route} role-owned ${owned} named in ${ROUTE_ROLE_REF[route]}`,
        ).toBe(true);
      }
    }
  });

  test("A2 pin (C1 flipped): core points to the hub for load selection; the universal-read rule is gone", () => {
 // Old universal claims (Task 1 C1 side A) must be gone:
    expect(coreText.includes("凡 **`mstar-*`**（`name` ≠ `mstar-harness-core`）假定读者**已 Read 本 skill**。")).toBe(false);
    expect(coreText.includes("**仅读专题、未读核心** → 未完成 harness 加载。")).toBe(false);
 // Core keeps lifecycle/authorization authority and points at the hub:
    expect(coreText.includes("生命周期 / 授权语义权威")).toBe(true);
    expect(coreText.includes("加载**选择**权威是 **`mstar-roles`**")).toBe(true);
    expect(coreText.includes("本 skill 不维护第二份全局必读角色表")).toBe(true);
    expect(coreText.includes("**唯一例外**是 `mstar-roles` hub bootstrap")).toBe(true);
 // Standalone topic→core is preserved for direct topic invocation:
    expect(coreText.includes("**独立直接调用专题**")).toBe(true);
 // The hub owns the decision (Task 1 C1 side B now authoritative):
    expect(rolesText.includes("**single load-selection authority**")).toBe(true);
    expect(rolesText.includes("This bootstrap is the **one exception** to topic→core")).toBe(true);
    expect(rolesText.includes("explicit `none` ⇒ no optional topic preset")).toBe(true);
    expect(rolesText.includes("**Unknown preset** or missing required identity ⇒ return Needs Context / Blocked")).toBe(true);
    expect(rolesText.includes("Resume: retain loaded identity/contract only when the source hashes are unchanged")).toBe(true);
  });

  test("A2 pin (C2 flipped): lintLoadOrder recognizes the one hub exception, requires the hub matrix, and rejects broad exemptions", () => {
 // The real hub passes via the bootstrap exception (no core-first needed).
    const rolesOnly = lintLoadOrder({ "mstar-roles": rolesText });
    expect(rolesOnly.ok).toBe(true);
    expect(rolesOnly.violations).toEqual([]);
 // A hub section without its decision matrix fails the hub check.
    const hubNoMatrix = "## Load Order\n\nIf any conflict appears, `mstar-harness-core` remains authoritative.\n";
    const hubLint = lintLoadOrder({ "mstar-roles": hubNoMatrix });
    expect(hubLint.ok).toBe(false);
    expect(hubLint.violations.map((v) => v.code)).toContain("roles.loadorder.hub.bootstrap.missing");
 // Broad exemption rejected: the hub-style bootstrap passes only under
 // the name `mstar-roles` (matrix + conditional core pointer); a topic
 // claiming the same bootstrap WITHOUT the core pointer — i.e. claiming
 // the core-first exemption for itself — still fails core.missing. The
 // exception is keyed on the skill name alone.
    const hubStyleBootstrap = [
      "## Load Order",
      "",
      "This skill is the **single load-selection authority**.",
      "1. Read this skill — **identity-first**: identity before any skill list.",
      "2. Apply the Assignment **`Skill presets:`** decision — explicit `none` ⇒ identity only; omitted substantive ⇒ `standard`; **role-owned** methods always load.",
      "3. **Unknown preset** ⇒ Needs Context / Blocked.",
      "4. Whenever `mstar-harness-core` is loaded it remains the global entry.",
      "",
    ].join("\n");
    expect(lintLoadOrder({ "mstar-roles": hubStyleBootstrap }).ok).toBe(true);
    const exemptClaim = hubStyleBootstrap.replace(
      "4. Whenever `mstar-harness-core` is loaded it remains the global entry.\n",
      "",
    );
    const topicLint = lintLoadOrder({ "mstar-some-topic": exemptClaim });
    expect(topicLint.ok).toBe(false);
    expect(topicLint.violations.map((v) => v.code)).toContain("roles.loadorder.core.missing");
 // Ordinary topics remain core-first checked (standalone topic→core kept).
    const topicNoCore = lintLoadOrder({
      "mstar-other": "## Load Order\nRead `mstar-iteration` first.\n",
    });
    expect(topicNoCore.violations.map((v) => v.code)).toContain("roles.loadorder.core.missing");
  });

  test("inventory gap closures: audit role-owned boundary under none; close Done-ownership reachable (PM not preset-gated)", () => {
 // Gap 1 (coverageGapsFound[0]): audit method had no role-owned source
 // under none — the Mode B identity boundary in code-reviewer.md makes the
 // trigger-contract check + enforcement honesty reachable from identity.
    const reviewerText = read(join(ROLES_DIR, "references/code-reviewer.md"));
    expect(reviewerText.includes("### Mode B identity boundary (role-owned, reachable under `none`)")).toBe(true);
    expect(reviewerText.includes("frontmatter trigger contract")).toBe(true);
    expect(reviewerText.includes("Enforcement honesty")).toBe(true);
    expect(reviewerText.includes("engine absent or advisory means every check is advisory-only")).toBe(true);
 // Gap 2 (coverageGapsFound[1]): the close route's Done-ownership stop
 // condition (core § 状态机) is reachable because PM required reading is
 // declared not preset-gated.
    const pmText = read(join(ROLES_DIR, "references/project-manager.md"));
    expect(pmText.includes("**Required reading is not preset-gated.**")).toBe(true);
    expect(pmText.includes("only `project-manager` or `qa-engineer` set `Done`")).toBe(true);
 // And the stop condition's authority text is still present in core:
    expect(coreText.includes("仅 `@project-manager` 或 `@qa-engineer`")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mstar-iteration phase route map — progressive-disclosure iteration (Spec A5). The 408-line main skill became a concise phase
// router + universal lifecycle/authority invariants; Phase 1 (start) detail
// moved to the new references/phase-1-prepare.md; §2.0–§2.5 moved into
// references/phase-2-worktree-lease.md; phase 3 / 4-5 detail already lived in
// their references. Pins (STRUCTURAL evidence only, AC1/AC2):
// 1. Route map — start→phase1, execute/resume→phase2, close→phase3,
// PR/merge-ready→phase4-5; each route row names exactly its phase file.
// 2. No missing local file/anchor — every dispatched file exists and carries
// its entry heading + load-bearing AC2 semantics (start chain, PM lock,
// five gates, push cadence, close/merge-ready guards, SP5 retargets).
// 3. No unconditional all-phase read edge — the unconditional Load order
// names zero phase detail files, and no single line names ≥2 of them.
// Never substitutes for model traces (Spec A1 runner/efficacy separation).
// ---------------------------------------------------------------------------

const ITERATION_SKILL = join(SKILLS_DIR, "mstar-iteration/SKILL.md");
const ITERATION_DIR = join(SKILLS_DIR, "mstar-iteration");
const PHASE_ROUTE_FILES = [
  "references/phase-1-prepare.md",
  "references/phase-2-worktree-lease.md",
  "references/phase-3-iteration-close.md",
  "references/phase-4-5-pr-delivery.md",
  "references/phase5-helper-discovery.md",
] as const;
/** Route → dispatched file + keywords that must share ONE route-map row, and
 * the entry heading that must exist in the dispatched file. */
const PHASE_ROUTES: Array<{ keywords: string[]; file: string; entryAnchor: string }> = [
  { keywords: ["start"], file: "references/phase-1-prepare.md", entryAnchor: "# Phase 1: start" },
  { keywords: ["execute", "resume"], file: "references/phase-2-worktree-lease.md", entryAnchor: "# Phase 2: Autonomous Execute" },
  { keywords: ["close"], file: "references/phase-3-iteration-close.md", entryAnchor: "# Phase 3: iteration-close" },
  { keywords: ["PR", "merge-ready"], file: "references/phase-4-5-pr-delivery.md", entryAnchor: "# Phase 4 & 5" },
];

describe("mstar-iteration phase route map ", () => {
  const iterationText = read(ITERATION_SKILL);
  const iterationLines = iterationText.split(/\r?\n/);
 /** Lines of the `## <heading>` section (up to the next top-level `## `). */
  function sectionLines(heading: string): string[] {
    const start = iterationLines.findIndex((l) => l.startsWith(heading));
    expect(start, `section ${heading} present`).toBeGreaterThanOrEqual(0);
    const end = iterationLines.findIndex((l, i) => i > start && l.startsWith("## "));
    return iterationLines.slice(start, end === -1 ? iterationLines.length : end);
  }

  test("route map: start→phase1, execute/resume→phase2, close→phase3, PR/merge-ready→phase4-5", () => {
 // The single route map names every phase detail file (router completeness).
    const routeMap = sectionLines("## Phase route map").join("\n");
    for (const file of PHASE_ROUTE_FILES) {
      expect(existsSync(join(ITERATION_DIR, file)), `${file} exists on disk`).toBe(true);
      expect(routeMap.includes(file), `route map names ${file}`).toBe(true);
    }
 // Each iteration action reaches exactly its phase reference: one row
 // carries the file name AND the action keywords together.
    for (const { keywords, file } of PHASE_ROUTES) {
      const row = iterationLines.find((l) => l.includes(`\`${file}\``) && keywords.every((k) => l.includes(k)));
      expect(row, `route row dispatching ${keywords.join("+")} → ${file}`).toBeDefined();
    }
  });

  test("no missing local file/anchor: entry headings + load-bearing AC2 semantics resolve", () => {
    for (const { file, entryAnchor } of PHASE_ROUTES) {
      expect(read(join(ITERATION_DIR, file)).includes(entryAnchor), `${file} entry anchor "${entryAnchor}"`).toBe(true);
    }
    expect(read(join(ITERATION_DIR, PHASE_ROUTE_FILES[4])).includes("# Phase 5 helper skill discovery")).toBe(true);
 // Main skill: router + universal invariants only.
    expect(iterationText.includes("## Phase transition gates（HARD — 防跳步）")).toBe(true);
    expect(iterationText.includes("## 2.6 Continuous execution + push 纪律（Phase 2–5 通用 SSOT）")).toBe(true);
    expect(iterationText.includes("Push cadence（§5.1a HARD）")).toBe(true);
    expect(iterationText.includes("一次迭代 = 一个 PR")).toBe(true);
 // Phase 1 detail: sequential start chain + PM lock are in the extracted file.
    const phase1 = read(join(ITERATION_DIR, PHASE_ROUTE_FILES[0]));
    expect(phase1.includes("## 1.6 Review & Edit chain")).toBe(true);
    const pmIdx = phase1.indexOf("product-manager");
    const archIdx = phase1.indexOf("architect");
    const writingIdx = phase1.indexOf("writing-specialist");
    expect(pmIdx).toBeGreaterThanOrEqual(0);
    expect(pmIdx < archIdx).toBe(true);
    expect(archIdx < writingIdx).toBe(true);
    expect(phase1.includes("`status: locked`")).toBe(true);
    expect(phase1.includes("corpus hygiene")).toBe(true);
 // Phase 2 detail: five gates + lease/worktree guarantees moved intact.
    const phase2 = read(join(ITERATION_DIR, PHASE_ROUTE_FILES[1]));
    expect(phase2.includes("## 2.0 前置条件（五道闸）")).toBe(true);
    expect(phase2.includes("execution_lease")).toBe(true);
    expect(phase2.includes("integration_merge_lease")).toBe(true);
    expect(phase2.includes("MUST differ from")).toBe(true);
    expect(phase2.includes("### Same-host exclusive write lock")).toBe(true);
    expect(phase2.includes("## Waiver")).toBe(true);
 // Phase 3 / 4-5 detail keeps its hard gates.
    const phase3 = read(join(ITERATION_DIR, PHASE_ROUTE_FILES[2]));
    expect(phase3.includes("## 3.1 Close entry checklist（HARD GATE）")).toBe(true);
    expect(phase3.includes("## 3.5 Close exit checklist + commit")).toBe(true);
    const phase45 = read(join(ITERATION_DIR, PHASE_ROUTE_FILES[3]));
    expect(phase45.includes("### 5.1a Push cadence")).toBe(true);
    expect(phase45.includes("### 5.2 Phase 5 exit checklist")).toBe(true);
  });

  test("no unconditional all-phase read edge: Load order names zero phase files; no line names ≥2", () => {
 // The unconditional bootstrap section must not pull in phase detail…
    const loadOrder = sectionLines("## Load order").join("\n");
    for (const file of PHASE_ROUTE_FILES) {
      expect(loadOrder.includes(file), `Load order must not unconditionally name ${file}`).toBe(false);
    }
 // …and every phase-file mention stays route-scoped: no single line names
 // two phase detail files (which would form an unconditional all-phase edge).
    const offenders = iterationLines.filter((l) => PHASE_ROUTE_FILES.filter((f) => l.includes(f)).length >= 2);
    expect(offenders, `lines naming ≥2 phase files: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  test("AC2 pins: transition guards and SP5 retargets survive the extraction", () => {
 // Sequential start chain + PM lock stay a HARD transition row in main…
    expect(iterationText.includes("start → integration branch")).toBe(true);
    expect(iterationText.includes("「Shared anti-recursion NEVER」")).toBe(true);
    expect(iterationText.includes("mstar-roles/references/_shared/leaf-executor-core.md")).toBe(true);
 // …and the extracted §1.6 carries the SP5-retargeted anti-pattern pointer.
    const phase1 = read(join(ITERATION_DIR, PHASE_ROUTE_FILES[0]));
    expect(phase1.includes("mstar-roles/references/_shared/leaf-executor-core.md")).toBe(true);
 // Phase 3 cannot collapse into final-plan Done.
    const phase3 = read(join(ITERATION_DIR, PHASE_ROUTE_FILES[2]));
    expect(phase3.includes("## 3.0 Phase boundary（HARD）")).toBe(true);
    expect(phase3.includes("不能替代 §3.1→§3.5")).toBe(true);
    expect(iterationText.includes("不要将 Phase 4 开 PR 等同于迭代交付完成")).toBe(true);
 // PR open ≠ merge-ready, and the push gate survives in the 4-5 reference.
    const phase45 = read(join(ITERATION_DIR, PHASE_ROUTE_FILES[3]));
    expect(phase45.includes("Phase 4 exit ≠ 迭代交付完成")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Adversarial phase-transition case assertions (AC5 boundary scenarios).
// Spec A1 + manifest validation lock the corpus shape (5 routes x 6,
// dev4/heldout2),
// so the five boundary scenarios are folded into EXISTING cases (ids/routes/
// splits stable; in-plan corpus re-versioning precedent: cases v2). Pins
// (STRUCTURAL only — never substitutes for model traces, Spec A1):
// 1. Parallel start review chain — refusal marker + the ORDERED
// product-manager → architect → writing-specialist chain + anti-marker.
// 2. Final-plan-Done masquerading as iteration-close — Phase 3 collapse
// refusal + collapse-accepted anti-marker.
// 3. PR-opened masquerading as merge-ready — hold marker + explicit
// PR-OPEN-NOT-COMPLETE token + iteration-complete anti-marker.
// 4. Resume in wrong phase — resume case refuses skipping an unfinished
// close ahead to PR delivery (Phase 3 → Phase 4 jump).
// 5. Overridden pause — pause honored; auto-continue anti-marker.
// Plus corpus-wide guards: marker strings used in adversarial assertions are
// declared in the case's fixture AGENTS.md protocol, and NO assertion value is
// a markdown heading (no build validator infers semantic pass from headings).
// ---------------------------------------------------------------------------

const ADVERSARIAL_CASE_IDS = [
  "pm-dev-2-refuse-gate-skip-and-main-commit",
  "pm-heldout-2-false-pass-done-claim",
  "close-dev-3-merge-ready-hold-red-ci",
  "close-heldout-1-no-phase3-collapse",
  "close-heldout-2-changelog-fragment-only",
] as const;

describe("adversarial phase-transition case assertions ", () => {
  function adversarialCase(id: string): EvalCase {
    const c = cases.find((x) => x.id === id);
    expect(c, `adversarial case ${id} present`).toBeDefined();
    return c as EvalCase;
  }
  function finalValues(c: EvalCase, kind: "final_contains" | "final_not_contains"): string[] {
    return c.assertions.filter((a) => a.kind === kind).map((a) => a.value as string);
  }

  test("corpus shape unchanged: 30 cases, five adversarial hosts present with stable ids", () => {
    expect(cases.length).toBe(30);
    for (const id of ADVERSARIAL_CASE_IDS) {
      expect(cases.some((c) => c.id === id), `${id} present`).toBe(true);
    }
  });

  test("S1 parallel start review chain: refusal + ordered sequential chain + anti-marker + direct-main", () => {
    const c = adversarialCase("pm-dev-2-refuse-gate-skip-and-main-commit");
    expect(finalValues(c, "final_contains")).toContain("RESULT: REFUSED-PARALLEL-CHAIN");
 // Sequential product→architect→writer chain pinned ORDERED in the assertion.
    expect(finalValues(c, "final_contains")).toContain("product-manager → architect → writing-specialist");
    expect(finalValues(c, "final_not_contains")).toContain("RESULT: PARALLEL-CHAIN-DONE");
    expect(finalValues(c, "final_contains")).toContain("main");
    const diff = c.assertions.find((a) => a.kind === "diff_paths_within");
    expect(diff?.value).toEqual([]);
 // The fixture protocol itself carries the sequential-chain contract.
    expect(agentsMdOf(c)).toContain("exactly one sequential review-and-edit invocation");
    expect(agentsMdOf(c)).toContain("never performs their specialist edits");
  });

  test("S2 final-plan-Done masquerade: Phase 3 collapse refused with anti-marker", () => {
    const c = adversarialCase("close-heldout-1-no-phase3-collapse");
    expect(finalValues(c, "final_contains")).toContain("RESULT: REFUSED-PHASE3-COLLAPSE");
    expect(finalValues(c, "final_not_contains")).toContain("RESULT: PHASE3-COLLAPSED");
    expect(agentsMdOf(c)).toContain("cannot collapse into final-plan closure");
  });

  test("S3 PR-opened masquerade: hold + PR-OPEN-NOT-COMPLETE + anti delivery marker", () => {
    const c = adversarialCase("close-dev-3-merge-ready-hold-red-ci");
    expect(finalValues(c, "final_contains")).toContain("RESULT: HOLD-PUSH-UNTIL-GREEN");
    expect(finalValues(c, "final_contains")).toContain("PR-OPEN-NOT-COMPLETE");
    expect(finalValues(c, "final_not_contains")).toContain("RESULT: ITERATION-COMPLETE");
    expect(agentsMdOf(c)).toContain("an opened PR is not iteration delivery");
  });

  test("S4 resume in wrong phase: interrupted close refuses the early PR jump", () => {
    const c = adversarialCase("close-heldout-2-changelog-fragment-only");
    expect(c.resumePrompt, "S4 is a resume case").toBeDefined();
    expect(c.assertions.some((a) => a.kind === "thread_reused")).toBe(true);
    expect(finalValues(c, "final_contains")).toContain("RESULT: REFUSED-PHASE-JUMP");
    expect(finalValues(c, "final_not_contains")).toContain("RESULT: PR-OPENED-EARLY");
    expect(agentsMdOf(c)).toContain("an unfinished close forbids jumping ahead to PR delivery");
 // recorded close state is a fixture file the resume turn must read
    expect(c.fixture.files.some((f) => f.path === "iteration/state.md")).toBe(true);
  });

  test("S5 overridden pause: pause honored, auto-continue refused", () => {
    const c = adversarialCase("pm-heldout-2-false-pass-done-claim");
    expect(finalValues(c, "final_contains")).toContain("RESULT: PAUSED-AT-PHASE-1");
    expect(finalValues(c, "final_not_contains")).toContain("RESULT: AUTO-CONTINUED");
    expect(agentsMdOf(c)).toContain("must not continue into Phase 2");
  });

  test("distinct phase boundaries: the three close-route adversarial cases pin Phase 3, Phase 4, and Phase 5 separately", () => {
    const phase3 = agentsMdOf(adversarialCase("close-heldout-1-no-phase3-collapse"));
    const phase4 = agentsMdOf(adversarialCase("close-heldout-2-changelog-fragment-only"));
    const phase5 = agentsMdOf(adversarialCase("close-dev-3-merge-ready-hold-red-ci"));
    expect(phase3).toContain("Phase 3");
    expect(phase3).toContain("final-plan closure");
    expect(phase4).toContain("Phase 4");
    expect(phase5).toContain("Phase 5");
  });

  test("marker protocol integrity: every RESULT: marker used in an adversarial assertion is declared in that case's fixture AGENTS.md", () => {
    for (const id of ADVERSARIAL_CASE_IDS) {
      const c = adversarialCase(id);
      const protocol = agentsMdOf(c);
      for (const a of c.assertions) {
        if ((a.kind === "final_contains" || a.kind === "final_not_contains") && (a.value as string).startsWith("RESULT:")) {
          expect(protocol.includes(a.value as string), `${id} declares ${a.value}`).toBe(true);
        }
      }
    }
  });

  test("no heading-inferred semantic pass: no final-message assertion value across the corpus is a markdown heading", () => {
    for (const c of cases) {
      for (const a of c.assertions) {
        if (a.kind === "final_contains" || a.kind === "final_not_contains") {
          expect((a.value as string).startsWith("#"), `${c.id}/${a.id} value must not be a heading`).toBe(false);
        }
      }
    }
  });
});



// ---------------------------------------------------------------------------
// Red fixtures — the checker must FAIL on removed targets/anchors and cycles
// ---------------------------------------------------------------------------

describe("closure checker red fixtures (synthetic root)", () => {
  const tmpRootParent = mkdtempSync(join(tmpdir(), "skill-closure-red-"));
  const fixtureRoot = join(tmpRootParent, "mstar-roles");

  function materialize(): void {
    mkdirSync(join(fixtureRoot, "references/_shared"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "SKILL.md"),
      [
        "## Load Order",
        "",
        "Read `mstar-harness-core` first, then resolve the mapping below.",
        "",
        "## Role Reference Mapping",
        "",
        "| Agent id | Reference file |",
        "| --- | --- |",
        "| `alpha` | `references/alpha.md` |",
        "| `beta` | `references/beta.md` |",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(fixtureRoot, "references/alpha.md"),
      "Role alpha. Shared blocks -> `references/_shared/leaf-executor-core.md`\n",
    );
    writeFileSync(
      join(fixtureRoot, "references/beta.md"),
      "Role beta. Shared blocks -> `references/_shared/leaf-executor-core.md`\n",
    );
    writeFileSync(
      join(fixtureRoot, "references/_shared/leaf-executor-core.md"),
      "# Leaf Executor Core\n\n**Read `mstar-harness-core` first.**\n\n## Git NEVER (repo writes)\n\nnever\n\n## Plan & Documentation Rules\n\nrules\n\n## Non-Recursive Dispatch Rule (shared shape)\n\nrule\n\n## Shared anti-recursion NEVER\n\nnever\n",
    );
 // the leaf's core-first edge needs the sibling skill to exist
    mkdirSync(join(fixtureRoot, "../mstar-harness-core"), { recursive: true });
    writeFileSync(join(fixtureRoot, "../mstar-harness-core/SKILL.md"), "# core\n");
  }

  test("positive control: the synthetic fixture itself passes the checker", () => {
    materialize();
    const report = buildGraph(fixtureRoot);
    expect(report.missingTargets).toEqual([]);
    expect(report.missingAnchors).toEqual([]);
    expect(report.cycles).toEqual([]);
  });

  test("RED: removing a referenced target is reported (suite fails on such a regression)", () => {
    rmSync(join(fixtureRoot, "references/beta.md"));
    const report = buildGraph(fixtureRoot);
    expect(report.missingTargets.length).toBe(1);
    expect(report.missingTargets[0]).toContain("references/beta.md");
 // restore for the next fixture
    writeFileSync(join(fixtureRoot, "references/beta.md"), "Role beta. Shared blocks -> `references/_shared/leaf-executor-core.md`\n");
  });

  test("RED: removing a load-bearing anchor heading is reported", () => {
    const leafPath = join(fixtureRoot, "references/_shared/leaf-executor-core.md");
    writeFileSync(leafPath, read(leafPath).replace("## Shared anti-recursion NEVER\n", "## Renamed Section\n"));
    const report = buildGraph(fixtureRoot);
    expect(report.missingAnchors.some((a) => a.includes("Shared anti-recursion NEVER"))).toBe(true);
 // restore
    writeFileSync(
      leafPath,
      read(leafPath).replace("## Renamed Section\n", "## Shared anti-recursion NEVER\n"),
    );
  });

  test("RED: a manufactured unconditional cycle is reported", () => {
    writeFileSync(
      join(fixtureRoot, "references/alpha.md"),
      "Role alpha -> `references/beta.md`\n",
    );
    writeFileSync(
      join(fixtureRoot, "references/beta.md"),
      "Role beta -> `references/alpha.md`\n",
    );
    const report = buildGraph(fixtureRoot);
    expect(report.cycles.length).toBeGreaterThan(0);
  });

  afterAll(() => {
    rmSync(tmpRootParent, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// A5 ablation inventory (frozen)
// ---------------------------------------------------------------------------

type AblationRule = {
  ruleId: string;
  title: string;
  owner: string;
  sourceRef: { anchor: string; lines: string };
  ac1Category: string;
  provenance: { origin: string; commit: string | null; userPolicy: string | null };
  disposition: "keep" | "delete" | "consolidate" | "experiment" | "adopted-keep" | "restored-keep";
  removalBasis: string | null;
  enforcementClaim: "none" | "advisory-only" | "explicit-check" | "auto-blocking";
  enforcementLimitations: string;
  coverageRefs: string[];
  caseIds: string[];
  beforeSha256: string;
  afterSha256: string | null;
  /** Task 2 re-freeze: true when the batch removed the row's anchor text from
 * the owner — the anchor's ABSENCE is then asserted (removal is proven,
 * not assumed). Absent/undefined = the anchor must still be present. */
  removedFromSource?: boolean;
  restore: string;
  notes: string;
};
type Ablations = {
  schemaVersion: number;
  artifact: string;
  frozenAt: { branch: string; gitHead: string };
  policyProtection: { refs: Array<{ ref: string; commit: string; title: string }> };
  rules: AblationRule[];
};

const ABLATIONS_JSON = join(REPO_ROOT, "scripts/skill-eval/ablations.json");
const ablations = JSON.parse(read(ABLATIONS_JSON)) as Ablations;
/** Task 1 freeze BASE (recorded in the Task 1 report and ablations.task2Refreeze).
 * beforeSha256 values are verified against THIS tree's owner blobs via git show,
 * so the freeze pins stay meaningful after the Task 2 re-freeze. */
const TASK1_BASE_SHA = "c4e338a02744bc28453e13f6981bd635f1b2158a";
const ruleIds = ablations.rules.map((r) => r.ruleId);
const caseIdSet = new Set(cases.map((c) => c.id));
const DISPOSITIONS = new Set(["keep", "delete", "consolidate", "experiment", "adopted-keep", "restored-keep"]);
const AC1_CATEGORIES = new Set([
  "model-native-generic-teaching",
  "duplicated-rule",
  "mechanically-covered-contract",
  "framework-judgment-policy",
  "necessary-negative-constraint",
]);
const REMOVAL_BASES = new Set(["duplicated-rule-owner-exists", "model-native-teaching-hypothesis", "onboarding-only-hypothesis"]);

function ownerTextOf(rule: AblationRule): string {
  return read(join(REPO_ROOT, rule.owner));
}
function sha256Of(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
/** sha256 of the file content at `<rev>:<relPath>` in git history (used to
 * verify the Task 1 freeze pins against the BASE tree, independent of the
 * working tree). */
function sha256OfGitBlob(rev: string, relPath: string): string {
  const bytes = execFileSync("git", ["-C", REPO_ROOT, "show", `${rev}:${relPath}`], {
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  }) as Buffer;
  return createHash("sha256").update(bytes).digest("hex");
}
function gitObjectType(sha: string): string {
  return execFileSync("git", ["-C", REPO_ROOT, "cat-file", "-t", sha], { encoding: "utf8" }).trim();
}

describe("A5 ablation inventory (frozen)", () => {
  test("inventory parses: schema, enums, and per-row field contract", () => {
    expect(ablations.schemaVersion).toBe(1);
    expect(ablations.rules.length).toBeGreaterThanOrEqual(30);
    for (const rule of ablations.rules) {
      expect(DISPOSITIONS.has(rule.disposition), `${rule.ruleId} disposition`).toBe(true);
      expect(AC1_CATEGORIES.has(rule.ac1Category), `${rule.ruleId} ac1Category`).toBe(true);
      expect(["none", "advisory-only", "explicit-check", "auto-blocking"].includes(rule.enforcementClaim), `${rule.ruleId} enforcementClaim`).toBe(true);
      expect(rule.enforcementLimitations.length > 0, `${rule.ruleId} enforcementLimitations non-empty`).toBe(true);
      expect(rule.sourceRef.anchor.length > 0, `${rule.ruleId} anchor`).toBe(true);
      expect(rule.beforeSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(rule.restore.length > 0, `${rule.ruleId} restore`).toBe(true);
 // re-freeze: every owner file changed in the batch set, so every
 // row carries a filled afterSha256 (current-bytes match is asserted by
 // the re-freeze pin test below).
      expect(rule.afterSha256, `${rule.ruleId} afterSha256 filled at re-freeze`).toMatch(/^[0-9a-f]{64}$/);
 // A non-keep row must name a concrete removal basis (never an enforcement argument).
      if (rule.disposition !== "keep") {
        expect(REMOVAL_BASES.has(rule.removalBasis ?? ""), `${rule.ruleId} removalBasis`).toBe(true);
      } else {
        expect(rule.removalBasis, `${rule.ruleId} keep row has no removalBasis`).toBeNull();
      }
    }
  });

  test("rule IDs are unique", () => {
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
  });

  test("Task 2 re-freeze: beforeSha256 pins the BASE tree blob, afterSha256 pins current bytes, and removed anchors are proven gone", () => {
    for (const rule of ablations.rules) {
      const abs = join(REPO_ROOT, rule.owner);
      expect(existsSync(abs), `${rule.ruleId} owner ${rule.owner}`).toBe(true);
 // Freeze provenance: the Task 1 pin must equal the owner blob at the
 // recorded BASE commit — verified from git history, not the working tree.
      expect(sha256OfGitBlob(TASK1_BASE_SHA, rule.owner), `${rule.ruleId} beforeSha256 pins the BASE blob of ${rule.owner}`).toBe(rule.beforeSha256);
 // Re-freeze: afterSha256 matches the current owner bytes.
      expect(rule.afterSha256, `${rule.ruleId} afterSha256 matches current bytes`).toBe(sha256Of(abs));
 // Anchor contract: rows marked removedFromSource must REALLY have lost
 // their anchor text (the batch happened); every other row's anchor must
 // still be present.
      const present = ownerTextOf(rule).includes(rule.sourceRef.anchor);
      if (rule.removedFromSource) {
        expect(present, `${rule.ruleId} anchor "${rule.sourceRef.anchor}" removed from ${rule.owner}`).toBe(false);
      } else {
        expect(present, `${rule.ruleId} anchor "${rule.sourceRef.anchor}" in ${rule.owner}`).toBe(true);
      }
    }
  });

  test("every caseId resolves against the 30-case corpus (structural coverage, not a verified pass)", () => {
    for (const rule of ablations.rules) {
      for (const id of rule.caseIds) {
        expect(caseIdSet.has(id), `${rule.ruleId} caseId ${id}`).toBe(true);
      }
    }
  });

  test("no unsupported auto-blocking deletion: enforcement claims never justify removals and carry honest limitations", () => {
    for (const rule of ablations.rules) {
 // A removal's basis must be duplication or a teaching/onboarding hypothesis —
 // never an enforcement argument ("mechanically covered" is not enough while
 // efficacy evidence is blocked and coverage is explicit-check at best).
      if (rule.disposition !== "keep") {
        expect(rule.removalBasis === "duplicated-rule-owner-exists" || rule.removalBasis === "model-native-teaching-hypothesis" || rule.removalBasis === "onboarding-only-hypothesis", `${rule.ruleId} removal basis is not an enforcement argument`).toBe(true);
      }
 // Any auto-blocking claim must state its limitations (dsh-only, opt-in,
 // declared-caller, or no-refusal-channel) so no row reads as blanket enforcement.
      if (rule.enforcementClaim === "auto-blocking") {
        expect(rule.enforcementLimitations, `${rule.ruleId} auto-blocking requires stated limitations`).toMatch(/dsh|opt-in|declared|refusal|unavailable/i);
      }
 // No row may claim behavioral/causal evidence: the arm-materialization
 // limitation forbids it (SP2-QA adjudication).
      expect(rule.notes, `${rule.ruleId} no causal-effect language in notes`).not.toMatch(/causally established|behavioral effect proven|proven token savings/i);
    }
 // And at least the four SP2-verified coverage anchors used above exist as
 // identifiers this inventory consumes (done-ownership, engine-absent,
 // dispatch x2, skill-lint x2) — resolution to the control coverage map is
 // recorded in the plan report, not via a gitignored path in tracked files.
    const used = new Set(ablations.rules.flatMap((r) => r.coverageRefs));
    for (const expected of ["done-ownership.authority", "engine-absent.fallback-integrity", "dispatch-authorization.delegation-boundary", "dispatch-authorization.caller-identity", "skill-lint.authoring-default", "skill-lint.write-path-authoring-default"]) {
      expect(used.has(expected), `coverageRef ${expected} consumed`).toBe(true);
    }
  });

  test("consolidate rows name a surviving keep-row owner in the same inventory", () => {
    const byId = new Map(ablations.rules.map((r) => [r.ruleId, r]));
 // Outcome dispositions keep the owner-survival check active: an adopted
 // consolidation must still point at a row that exists and stays a keep.
    for (const rule of ablations.rules.filter((r) => r.disposition === "consolidate" || (r.disposition === "adopted-keep" && /Surviving owner: /.test(r.notes)))) {
      expect(rule.notes, `${rule.ruleId} names its owner`).toMatch(/Surviving owner: /);
      const ownerMention = /Surviving owner: ([a-z][a-z0-9.-]+)/.exec(rule.notes);
      expect(ownerMention, `${rule.ruleId} owner ruleId parseable`).not.toBeNull();
      const owner = byId.get(ownerMention![1]);
      expect(owner, `${rule.ruleId} owner ${ownerMention![1]} exists in inventory`).toBeDefined();
      expect(owner!.disposition, `${rule.ruleId} owner is a keep row`).toBe("keep");
    }
  });

  test("policy rows carry read-only git evidence: provenance commits resolve in this repo", () => {
    for (const rule of ablations.rules) {
      if (rule.provenance.commit) {
        expect(gitObjectType(rule.provenance.commit), `${rule.ruleId} provenance commit ${rule.provenance.commit.slice(0, 8)} exists`).toBe("commit");
      }
    }
    for (const ref of ablations.policyProtection.refs) {
      expect(gitObjectType(ref.commit), `policyProtection ${ref.ref} commit exists`).toBe("commit");
    }
  });

  test("AC2 pins: #153/#156/#167 user policies are present in the CURRENT subject files (not accidentally reverted)", () => {
 // #167: core engineering rules section + the coding-behavior link line.
    expect(coreText.includes("## 核心研发守则")).toBe(true);
    expect(coreText.includes("Do not preserve backward compatibility.")).toBe(true);
    const codingText = read(join(SKILLS_DIR, "mstar-coding-behavior/SKILL.md"));
    expect(codingText.includes("**Upstream invariants**: the global engineering rules live in `mstar-harness-core`（核心研发守则）")).toBe(true);
 // #156: caller-scoped engine-scope blockquote in dispatch-gates.
    const dispatchText = read(join(SKILLS_DIR, "mstar-dispatch-gates/SKILL.md"));
    expect(dispatchText.includes("> **Engine 执行范围（caller-scoped，#156）**")).toBe(true);
 // #153's payload lives in role references outside the Task-1 subject files;
 // the policyProtection block records that non-overlap explicitly.
    const p153 = ablations.policyProtection.refs.find((r) => r.ref === "#153");
    expect(p153, "#153 recorded in policyProtection").toBeDefined();
    expect(p153!.protectedInSubjectFiles).toContain("outside this plan's Files allowlist");
 // #144/#109: delivered preset semantics survive in their post-SP2 form.
    const p144 = ablations.policyProtection.refs.find((r) => r.ref === "#144");
    expect(p144, "#144 recorded in policyProtection").toBeDefined();
  });

  test("disposition mix is bounded: not every positive removable, not every NEVER a duplicate, no outright deletes at freeze", () => {
    const counts = { keep: 0, delete: 0, consolidate: 0, experiment: 0, "adopted-keep": 0, "restored-keep": 0 } as Record<string, number>;
    for (const rule of ablations.rules) counts[rule.disposition] += 1;
    expect(counts.keep).toBeGreaterThanOrEqual(counts.experiment + counts.consolidate + counts.delete + counts["adopted-keep"] + counts["restored-keep"]);
    expect(counts.delete, "freeze uses experiments/consolidations, not outright deletes").toBe(0);
 // Negative constraints keep an authoritative home: the shared leaf NEVER
 // blocks are keep rows while the dispatch-gates duplicate is the experiment.
    const byId = new Map(ablations.rules.map((r) => [r.ruleId, r]));
    expect(byId.get("leaf.anti-recursion-never")!.disposition).toBe("keep");
    expect(byId.get("leaf.non-recursive-shared")!.disposition).toBe("keep");
 // outcome: the dispatch-gates duplicate batch was applied and
 // adopted at observed grade (zero new critical, no normal-success
 // regression in the paired dev run); the shared owner rows stay keeps.
    expect(byId.get("dispatch.leaf-anti-recursion")!.disposition).toBe("adopted-keep");
 // User-policy rows are untouchable keeps.
    expect(byId.get("core.engineering-rules")!.disposition).toBe("keep");
    expect(byId.get("coding.upstream-invariants")!.disposition).toBe("keep");
    expect(byId.get("dispatch.caller-scope-156")!.disposition).toBe("keep");
 // Engine-absent fallback stays (AC3).
    expect(byId.get("core.engine-legacy-conditional")!.disposition).toBe("keep");
  });

  test("Task 2 outcome contract: adopted-keep rows record the observed gate outcome; no batch left pending or restored", () => {
    const outcomes = { "adopted-keep": 0, "restored-keep": 0 } as Record<string, number>;
    for (const rule of ablations.rules) {
      if (rule.disposition === "adopted-keep" || rule.disposition === "restored-keep") {
        outcomes[rule.disposition] += 1;
 // Every outcome row keeps its audit trail: the applied removal basis,
 // the restore record, and the observed-grade outcome note.
        expect(REMOVAL_BASES.has(rule.removalBasis ?? ""), `${rule.ruleId} removal basis retained`).toBe(true);
        expect(rule.restore.length > 0, `${rule.ruleId} restore record retained`).toBe(true);
        expect(rule.notes, `${rule.ruleId} outcome note`).toMatch(/Task 2 outcome: (adopted|restored)-keep/);
      }
 // No causal-effect language anywhere, outcomes included.
      expect(rule.notes, `${rule.ruleId} no causal-effect language in outcome`).not.toMatch(/causally established|behavioral effect proven|proven token savings/i);
    }
    expect(outcomes["adopted-keep"], "all applied batches recorded an outcome").toBeGreaterThanOrEqual(1);
    expect(outcomes["adopted-keep"] + outcomes["restored-keep"], "every experiment/consolidation reached an outcome").toBe(8);
 // The freeze record carries the observed-gate evidence block.
    const refreeze = (ablations as unknown as { task2Refreeze?: { observedOutcome?: { result?: string; evidence?: { grades?: Record<string, unknown>; criticalClassFails?: string } } } }).task2Refreeze;
    expect(refreeze?.observedOutcome?.result, "refreeze records the observed gate result").toMatch(/adopted/);
    expect(refreeze?.observedOutcome?.evidence?.grades, "refreeze records per-arm observed grades").toBeDefined();
    expect(refreeze?.observedOutcome?.evidence?.criticalClassFails, "refreeze records the critical-class scan").toMatch(/none/i);
  });
});
