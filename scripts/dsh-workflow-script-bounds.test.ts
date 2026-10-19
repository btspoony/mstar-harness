/**
 * I-000735's assertion clause + PR round-4 finding TEST-01 — the dsh
 * workflow-script pool bound is pinned by a BEHAVIOUR check independent of the
 * host core count. The `mstar-audit-fanout` script in `dsh-workflow-scripts.md`
 * (§ mstar-audit-fanout) is extracted from the published Markdown and EXECUTED
 * in a sandbox that doubles its globals: `agent` records the in-flight child
 * depth while awaiting one macrotask tick, and `parallel` reproduces the real
 * tool's semantics (all thunks concurrent behind one barrier; a throwing thunk
 * resolves to null instead of rejecting the batch). The load-bearing assertion
 * is the property the subagent pool cap (`maxActiveSubagents`, default 8, hard
 * reject) actually depends on: with `args.categories` omitted (the default
 * all-nine path) every category completes AND the maximum observed in-flight
 * depth stays <= 8 on any host. A regression that launches every chunk
 * concurrently while keeping the `CHUNK` constant and the slice expressions
 * now fails the depth assertion instead of passing. One source-text canary
 * (the `CHUNK` constant line) still guards that the doc declares the bound.
 *
 * Run: `bun test scripts/dsh-workflow-script-bounds.test.ts` (repo root).
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOC = join(import.meta.dir, "..", "skills", "mstar-host", "references", "dsh-workflow-scripts.md");

/** The ```js fenced blocks of the document, in document order. */
function jsBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]!);
}

const script = jsBlocks(readFileSync(DOC, "utf8")).find((block) => block.includes("CHUNK"));

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
  const phases: string[] = [];
  const logs: string[] = [];

  const agent = async (prompt: string, opts: { label?: string } = {}) => {
    const category = opts.label ?? /^Audit category: (.+)$/m.exec(prompt)?.[1];
    if (typeof category !== "string" || category.length === 0) {
      throw new Error("agent double: could not resolve the category from the seat prompt");
    }
    launched.push(category);
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

  return { agent, parallel, phase, log, depth, launched, phases, logs };
}

/**
 * Execute an extracted script body in the sandbox. The template uses a
 * top-level `return`, so the body runs inside an async IIFE with the globals
 * bound as function parameters.
 */
async function runFanoutScript(body: string, args: Record<string, unknown>) {
  const doubles = makeDoubles();
  const run = new Function(
    "agent",
    "parallel",
    "phase",
    "log",
    "args",
    `"use strict";\nreturn (async () => {\n${body}\n})();`,
  );
  const seats = (await run(doubles.agent, doubles.parallel, doubles.phase, doubles.log, args)) as
    | Array<{ category?: string } | null>
    | undefined;
  return { ...doubles, seats };
}

const DEFAULT_ARGS = {
  repo: "/tmp/repo-under-audit",
  auditRef: "/tmp/mstar-audit-references",
  recon: "languages: ts; key dirs: packages/, scripts/",
};

describe("dsh-workflow-scripts fan-out pool bound (behaviour, host-core-count-independent)", () => {
  it("the default all-nine fan-out completes every category with the in-flight depth <= the 8-seat pool", async () => {
    expect(script, "the §2 script block declaring CHUNK must exist in dsh-workflow-scripts.md").toBeDefined();
    if (!script) return;

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

  it("canary: the doc still declares CHUNK = Math.min(8, categories.length)", () => {
    expect(script, "the §2 script block declaring CHUNK must exist in dsh-workflow-scripts.md").toBeDefined();
    expect(script).toMatch(/const CHUNK = Math\.min\(8, categories\.length\)/);
    expect(script).not.toMatch(/CHUNK\s*=[^;\n]*cores/);
  });
});
