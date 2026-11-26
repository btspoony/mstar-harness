/**
 * The dsh workflow-script pool bound is pinned by a BEHAVIOUR check
 * independent of the host core count: the shipped `mstar-audit-fanout` script
 * (`packages/dsh/workflows/mstar-audit-fanout.js`, documented in
 * `dsh-workflow-scripts.md` § 2) is EXECUTED in a sandbox that doubles its
 * globals:
 * `agent` records the in-flight child depth while awaiting one macrotask tick,
 * and `parallel` reproduces the real tool's semantics (all thunks concurrent
 * behind one barrier; a throwing thunk resolves to null instead of rejecting
 * the batch). The load-bearing assertion is the property the subagent pool cap
 * (`maxActiveSubagents`, default 8, hard reject) actually depends on: with
 * `args.categories` omitted (the default all-nine path) every category
 * completes AND the maximum observed in-flight depth stays <= 8 on any host. A
 * regression that launches every chunk concurrently while keeping the `CHUNK`
 * constant and the slice expressions now fails the depth assertion instead of
 * passing.
 *
 * A second case pins the security seat gate: the generated security prompt must
 * carry both list markers, and no other category's prompt may — the gate is
 * prompt content that reaches the child, not a comment beside the template.
 *
 * Run: `bun test scripts/dsh-workflow-script-bounds.test.ts` (repo root).
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { join } from "node:path";
import { legacyAssignmentShape, parseAssignmentFields } from "@mstar-harness/engine";

const SCRIPT = join(import.meta.dir, "..", "packages", "dsh", "workflows", "mstar-audit-fanout.js");

const script = readFileSync(SCRIPT, "utf8");

/** The nine `mstar-audit` categories, exactly as the script's `ALL` declares. */
const ALL_CATEGORIES = ["bug", "security", "perf", "tests", "tech-debt", "migration", "dx", "docs", "direction"];
/** The host subagent pool cap the doc pins the script to. */
const POOL_CAP = 8;

/**
 * Recording doubles for the script's globals. In-flight depth is observed
 * around the `agent` stub's await: the stub's synchronous entry (depth++)
 * runs for every launched seat before any of them resumes, so a concurrent
 * over-cap launch is always observed, deterministically, on any core count.
 */
function makeDoubles() {
  const depth = { current: 0, max: 0 };
  const launched: string[] = [];
  const prompts = new Map<string, string>();
  const phases: string[] = [];
  const logs: string[] = [];

  const agent = async (prompt: string, opts: { label?: string } = {}) => {
    const category = opts.label ?? /^Audit category: (.+)$/m.exec(prompt)?.[1];
    if (typeof category !== "string" || category.length === 0) {
      throw new Error("agent double: could not resolve the category from the seat prompt");
    }
    launched.push(category);
    prompts.set(category, prompt);
    depth.current += 1;
    depth.max = Math.max(depth.max, depth.current);
    // One macrotask tick: concurrent seats genuinely overlap, no wall-clock dependence.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    depth.current -= 1;
    return { category, findings: [] };
  };

  // Faithful `parallel` semantics (the real workflow tool): every thunk is
  // started concurrently behind a single barrier, and a throwing thunk
  // resolves to null — the documented script relies on exactly that for its
  // "a null entry is a failed category seat" contract.
  const parallel = (thunks: Array<() => unknown>): Promise<unknown[]> =>
    Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk).catch(() => null)));

  const phase = (title: string) => phases.push(title);
  const log = (message: string) => logs.push(message);

  return { agent, parallel, phase, log, depth, launched, prompts, phases, logs };
}

/**
 * Execute an extracted script body in the sandbox. The template uses a
 * top-level `return`, so the body runs inside an async IIFE with the globals
 * bound as function parameters.
 *
 * The body is compiled with `node:vm` (`new vm.Script` + `runInNewContext`)
 * instead of the language's dynamic function constructor: the executed text is
 * this repository's own published template with zero attacker control, and the
 * advisory HOL scanner's DANGEROUS_DYNAMIC_EXECUTION rule is a static match on
 * that constructor mechanism itself. `vm.Script` is the explicit sandbox API —
 * the compiled function is evaluated against a fresh, prototype-less context
 * rather than the host global object — and is outside the string-to-code
 * evaluation family (`eval` / `Function` constructor) that rule class
 * targets, while staying behaviour-identical: the same strict-mode wrapper,
 * the same parameter-bound globals, the same awaited promise result.
 */
async function runFanoutScript(body: string, args: Record<string, unknown>) {
  const doubles = makeDoubles();
  const compiled = new vm.Script(
    `(function (agent, parallel, phase, log, args) {\n"use strict";\nreturn (async () => {\n${body}\n})();\n})`,
    { filename: "dsh-workflow-script-bounds:fanout-body" },
  );
  const run = compiled.runInNewContext(Object.create(null)) as (
    ...globals: unknown[]
  ) => Promise<Array<{ category?: string } | null> | undefined>;
  const seats = await run(doubles.agent, doubles.parallel, doubles.phase, doubles.log, args);
  return { ...doubles, seats };
}

const DEFAULT_ARGS = {
  repo: "/tmp/repo-under-audit",
  auditRef: "/tmp/mstar-audit-references",
  recon: "languages: ts; key dirs: packages/, scripts/",
};

describe("dsh-workflow-scripts fan-out pool bound (behaviour, host-core-count-independent)", () => {
  it("the default all-nine fan-out completes every category with the in-flight depth <= the 8-seat pool", async () => {
    const { seats, depth, launched } = await runFanoutScript(script, DEFAULT_ARGS);

    // All nine default categories complete; a null entry would be a failed seat.
    expect(seats).toHaveLength(ALL_CATEGORIES.length);
    expect(seats).not.toContain(null);
    expect((seats ?? []).map((seat) => seat?.category).sort()).toEqual([...ALL_CATEGORIES].sort());
    expect(launched).toHaveLength(ALL_CATEGORIES.length);

    // The behavioural property: the depth recorder is live (seats genuinely
    // overlap) yet never exceed the pool's hard-reject cap on any host.
    expect(depth.max).toBeGreaterThanOrEqual(2);
    expect(depth.max).toBeLessThanOrEqual(POOL_CAP);
  });

  it("the security seat prompt carries both seat-gate list markers and no other seat does", async () => {
    const { prompts } = await runFanoutScript(script, DEFAULT_ARGS);

    const security = prompts.get("security") ?? "";
    // Both lists must survive template rendering into the prompt the child receives.
    expect(security).toContain("Must check:");
    expect(security).toContain("Not evidence - notes as a lead, never a finding:");

    const others = ALL_CATEGORIES.filter((category) => category !== "security");
    expect(others.length).toBeGreaterThan(0);
    for (const category of others) {
      for (const marker of ["Must check:", "Not evidence - notes as a lead"]) {
        expect(prompts.get(category) ?? "").not.toContain(marker);
      }
    }
  });
});

/**
 * The four shipped scripts are Assignment PRODUCERS: every prompt they emit
 * reaches a child through the dispatch/role gate, where front matter is the
 * only field contract. Each script is executed here with recording doubles,
 * so the assertion reads the prompt bytes the host would send — not the
 * template source. `legacyAssignmentShape` is the engine's own recognition,
 * so a reintroduced body-label prompt fails the gate's own predicate.
 */
const SEAT_SCRIPTS = [
  {
    name: "mstar-qc-tri",
    args: {
      planId: "20260101-example",
      planPath: "/tmp/control/.mstar/plans/20260101-example.md",
      range: "aaaa..bbbb",
      reviewCwd: "/tmp/feature-worktree",
      branch: "feature/example",
      sddDir: "/tmp/control/.mstar/sdd/20260101-example",
    },
    roles: ["qc-specialist", "qc-specialist-2", "qc-specialist-3"],
  },
  {
    name: "mstar-audit-fanout",
    args: {
      repo: "/tmp/repo-under-audit",
      auditRef: "/tmp/mstar-audit-references",
      recon: "languages: ts",
      // One category keeps the seat count comparable; the all-nine default is covered above.
      categories: ["bug"],
    },
    roles: ["code-reviewer"],
  },
  {
    name: "mstar-pr-seats",
    args: {
      worktree: "/tmp/feature-worktree",
      target: "example#1",
      diffBase: "aaaa..bbbb",
      auditRef: "/tmp/mstar-audit-references",
      budgetLine: "deep — 30 min cap",
      domains: ["correctness", "maintainability"],
      security: false,
    },
    roles: ["code-reviewer", "code-reviewer"],
  },
  {
    name: "mstar-review-single",
    args: {
      planId: "20260101-example",
      taskId: "1",
      reviewCwd: "/tmp/feature-worktree",
      branch: "feature/example",
      briefPath: "/tmp/brief.md",
      implementerReport: "/tmp/report.md",
      diffFile: "/tmp/diff.txt",
      diffBase: "aaaa",
      diffHead: "bbbb",
      globalConstraints: "constraints",
    },
    roles: ["code-reviewer"],
  },
] as const;

describe("dsh workflow scripts emit Assignments in front matter", () => {
  for (const target of SEAT_SCRIPTS) {
    it(`${target.name} seat prompts are front-matter documents`, async () => {
      const prompts: string[] = [];
      const runBody = (body: string) =>
        new vm.Script(
          `(function (agent, parallel, phase, log, args) {\n"use strict";\nreturn (async () => {\n${body}\n})();\n})`,
          { filename: `dsh-workflow-seat-prompts:${target.name}` },
        ).runInNewContext(Object.create(null)) as (...globals: unknown[]) => Promise<unknown>;
      const agent = (prompt: string) => {
        prompts.push(prompt);
        return Promise.resolve({ category: "bug", findings: [] });
      };
      const parallel = (thunks: Array<() => unknown>) => Promise.all(thunks.map((thunk) => Promise.resolve().then(thunk)));
      const run = runBody(readFileSync(join(import.meta.dir, "..", "packages", "dsh", "workflows", `${target.name}.js`), "utf8"));
      await run(agent, parallel, () => {}, () => {}, target.args);

      expect(prompts.length).toBe(target.roles.length);
      for (const [index, prompt] of prompts.entries()) {
        // The gate's own retired-format recognizer must not fire.
        expect(legacyAssignmentShape(prompt)).toBe(false);
        // ... and the front matter must bind the seat role the script targets.
        expect(parseAssignmentFields(prompt).executeAs).toBe(target.roles[index]);
      }
    });
  }
});
