/**
 * scripts/skill-eval/bounded-resolution.test.ts — the authored
 * bounded-resolution scenario set.
 *
 * Evaluation input ONLY. This file consumes `getCommandDefinitions()` as a
 * coverage input and the Task 2 versioned assertion extension through the
 * EXISTING evaluator (`selectCases` / `executeManifest` / `buildReport`); it
 * never becomes a second production command registry, never appends to or
 * reinterprets the frozen 30-case corpus, and never claims model compliance.
 *
 * SYNTHETIC TAG: every trace below is a scripted synthetic adapter (fake
 * spawn, scripted events/final). Passing traces prove the scenario set is
 * consumable and honestly graded — never that a real model resolves within
 * the bound. Universal/model compliance stays unverified until an authorized
 * real-agent run records traces.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getCommandDefinitions } from "../../packages/commands/src/index.ts";
import { canonicalJson, sha256Hex, type EvalManifest } from "./manifest.ts";
import { buildReport } from "./report.ts";
import { executeManifest, manifestIntegrityErrors, selectCases, type RunnerIo, type SpawnFn, type SpawnRequest } from "./runner.ts";

const MANIFEST_PATH = resolve(import.meta.dir, "bounded-resolution.manifest.json");
const FROZEN_CASES_PATH = resolve(import.meta.dir, "cases.json");
const REPO_ROOT = "/repo";
const RUN_DIR = `${REPO_ROOT}/.tmp/skill-eval/bounded-run`;
const RUN_MANIFEST_PATH = `${RUN_DIR}/manifest.json`;

/** Fixture content for every authored scenario (kept in sync with the manifest hashes). */
const FIXTURE_CONTENT = "# Bounded-resolution scenario fixture (evaluation input, not a real workspace)\n- Engine: advisory mode.\n";
const GROUPED_FINAL = "AUTHORIZATION-REQUIRED: provide the target issue id and authorization before any change";

const manifestText = readFileSync(MANIFEST_PATH, "utf8");
const manifest = JSON.parse(manifestText) as EvalManifest;
const DEFINITIONS = getCommandDefinitions();

// ---------------------------------------------------------------------------
// Scenario-set validation (evaluation metadata, not a production registry)
// ---------------------------------------------------------------------------

interface Disposition { scenario?: unknown; excluded?: unknown }

/**
 * Validates the authored scenario set against live enumeration. A definition
 * or document is covered only by an EXPLICIT disposition: a resolvable
 * scenario whose case carries a behavioral oracle, or an excluded entry with
 * a reason. A name list, a count, or a bare `true` proves nothing.
 */
export function validateScenarioSet(
  candidate: EvalManifest,
  options: { commandIds: string[]; slashDocuments: string[] },
): string[] {
  const errors: string[] = [];
  const metadata = (candidate as EvalManifest & { boundedResolution?: { routeDispositions?: Record<string, Disposition>; slashDispositions?: Record<string, Disposition> } }).boundedResolution;
  if (metadata === undefined) return ["manifest.boundedResolution metadata is missing; the scenario set has no coverage dispositions"];
  const byId = new Map(candidate.cases.map((c) => [c.id, c]));
  // A budget oracle alone (calls_within) or a no-write oracle alone
  // (mutation_withheld) cannot establish the instruction's expected outcome;
  // coverage additionally requires a semantic result oracle.
  const budgetKinds = new Set(["calls_within"]);
  const semanticKinds = new Set(["grouped_facts_final", "final_contains", "final_not_contains", "tool_read_contains", "tool_read_not_contains", "thread_reused"]);
  const hasBudget = (c: EvalManifest["cases"][number]): boolean => c.assertions.some((a) => budgetKinds.has(a.kind));
  const hasSemantic = (c: EvalManifest["cases"][number]): boolean => c.assertions.some((a) => semanticKinds.has(a.kind));
  for (const c of candidate.cases) {
    if (!hasBudget(c)) {
      errors.push(`case ${c.id} carries no budget oracle (needs calls_within)`);
    }
    if (!hasSemantic(c)) {
      errors.push(`case ${c.id} carries no semantic outcome oracle (needs grouped_facts_final|final_contains|final_not_contains|tool_read_contains|tool_read_not_contains|thread_reused)`);
    }
  }
  const checkGroup = (label: string, keys: string[], dispositions: Record<string, Disposition> | undefined): void => {
    for (const key of keys) {
      const disposition = dispositions?.[key];
      if (disposition === undefined) {
        errors.push(`${label} ${JSON.stringify(key)} has no disposition`);
        continue;
      }
      const hasScenario = typeof disposition.scenario === "string" && disposition.scenario !== "";
      const hasReason = typeof disposition.excluded === "string" && disposition.excluded.trim() !== "";
      if (hasScenario === hasReason) {
        errors.push(`${label} ${JSON.stringify(key)} must declare exactly one of { scenario } or { excluded: reason }`);
        continue;
      }
      if (hasScenario) {
        const scenario = byId.get(disposition.scenario as string);
        if (scenario === undefined) errors.push(`${label} ${JSON.stringify(key)} references unknown scenario ${JSON.stringify(disposition.scenario)}`);
        else if (!hasBudget(scenario) || !hasSemantic(scenario)) errors.push(`${label} ${JSON.stringify(key)} scenario ${scenario.id} lacks a budget and semantic outcome oracle pair`);
      }
    }
    for (const key of Object.keys(dispositions ?? {})) {
      if (!keys.includes(key)) errors.push(`${label} ${JSON.stringify(key)} is not a live entry (stale disposition)`);
    }
  };
  checkGroup("command", options.commandIds, metadata.routeDispositions);
  checkGroup("slash document", options.slashDocuments, metadata.slashDispositions);
  return errors;
}

/**
 * Supported slash-command documents, enumerated LIVE from the canonical
 * `commands/` source (never a hardcoded roster): adding a supported command
 * document without an authored disposition makes the coverage gate fail.
 */
const COMMANDS_DIR = resolve(import.meta.dir, "..", "..", "commands");

function slashDocuments(): string[] {
  return readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3));
}

function cloneManifest(): EvalManifest {
  return JSON.parse(manifestText) as EvalManifest;
}

// ---------------------------------------------------------------------------
// In-memory runner IO + synthetic adapter (SYNTHETIC traces only)
// ---------------------------------------------------------------------------

function memoryIo(): RunnerIo & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const ensureAncestors = (p: string): void => {
    let cur = resolve(p);
    for (;;) {
      dirs.add(cur);
      const parent = resolve(cur, "..");
      if (parent === cur) break;
      cur = parent;
    }
  };
  const io: RunnerIo & { files: Map<string, string>; dirs: Set<string> } = {
    files,
    dirs,
    readText: (p) => {
      const value = files.get(resolve(p));
      if (value === undefined) throw new Error(`ENOENT: ${p}`);
      return value;
    },
    writeText: (p, content) => {
      ensureAncestors(resolve(p, ".."));
      files.set(resolve(p), content);
    },
    ensureDir: (p) => {
      ensureAncestors(p);
    },
    exists: (p) => files.has(resolve(p)) || dirs.has(resolve(p)),
    realpath: (p) => resolve(p),
    readDir: (p) => {
      const base = resolve(p);
      const names = new Set<string>();
      for (const key of [...files.keys(), ...dirs.keys()]) {
        if (!key.startsWith(`${base}/`)) continue;
        const rest = key.slice(base.length + 1);
        names.add(rest.split("/")[0]!);
      }
      return [...names];
    },
    isFile: (p) => files.has(resolve(p)),
    copyFile: (from, to) => {
      const value = files.get(resolve(from));
      if (value === undefined) throw new Error(`ENOENT: ${from}`);
      ensureAncestors(resolve(to, ".."));
      files.set(resolve(to), value);
    },
    removeDeep: (p) => {
      const base = resolve(p);
      for (const key of [...files.keys()]) if (key === base || key.startsWith(`${base}/`)) files.delete(key);
      for (const key of [...dirs.keys()]) if (key === base || key.startsWith(`${base}/`)) dirs.delete(key);
    },
    rename: (from, to) => {
      const src = resolve(from);
      const dst = resolve(to);
      const moved = [...files.keys()].filter((k) => k === src || k.startsWith(`${src}/`));
      if (moved.length === 0 && !dirs.has(src)) throw new Error(`ENOENT: ${from}`);
      ensureAncestors(dst);
      for (const key of moved) {
        files.set(dst + key.slice(src.length), files.get(key)!);
        files.delete(key);
      }
    },
  };
  return io;
}

function seedRun(io: RunnerIo, candidate: EvalManifest): void {
  io.writeText(RUN_MANIFEST_PATH, `${JSON.stringify(candidate, null, 2)}\n`);
  // Prepared fixtures: the runner verifies each seeded file's sha256 against
  // the manifest record, so a drifted fixture fails loudly here.
  for (const c of candidate.cases) {
    for (const file of c.fixture.files) {
      const fixturePath = `${RUN_DIR}/fixtures/${c.id}/${file.path}`;
      io.writeText(fixturePath, FIXTURE_CONTENT);
      if (sha256Hex(FIXTURE_CONTENT) !== file.sha256) {
        throw new Error(`fixture drift for ${c.id}/${file.path}: seeded content does not match the manifest hash`);
      }
    }
  }
}

const invocation = (id: string | null, command: (string | string[]) = ["cat", "AGENTS.md"]): string => {
  const item: Record<string, unknown> = { type: "command_execution", command };
  if (id !== null) item.id = id;
  const record: Record<string, unknown> = { type: "item.completed", item };
  if (id !== null) record.id = id;
  return JSON.stringify(record);
};

const turn = (lines: string[]): string => `${[JSON.stringify({ type: "thread.started", thread_id: "thr_bounded" }), ...lines, JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } })].join("\n")}\n`;

/** Scripted synthetic evidence per authored scenario id. */
const MARKERS: Record<string, string> = {
  "bounded-res-schema-read": "SCHEMA-RESOLVED",
  "bounded-res-write-stale-constraint": "STALE-CONSTRAINT-REFUSED",
  "bounded-res-grouped-facts": "GROUPED-REQUEST-ISSUED",
  "bounded-res-negative-four-lookups": "CAPTURE-COMPLETED",
  "bounded-res-incomplete-evidence": "CAPTURE-COMPLETED",
  "bounded-res-bundled-lookups": "BUNDLED-ROUTE-RESOLVED",
  "bounded-res-retired-route": "RETIRED-ROUTE-REFUSED",
  "bounded-res-replay-partial": "REPLAY-COMPLETE",
  "bounded-res-lease-boundary": "FOREIGN-HOLDER-SURFACED",
  "bounded-res-slash-iteration-cold": "BOOTSTRAP-FACTS-REQUESTED",
  "bounded-res-slash-review-cold": "SEAT-FACTS-REQUESTED",
};
/** Runs whose instruction ends in a grouped authorization stop. */
const GROUPED_SCENARIOS = new Set([
  "bounded-res-grouped-facts",
  "bounded-res-negative-four-lookups",
  "bounded-res-incomplete-evidence",
  "bounded-res-lease-boundary",
  "bounded-res-slash-iteration-cold",
  "bounded-res-slash-review-cold",
]);

function finalFor(caseId: string): string {
  const marker = MARKERS[caseId] ?? "UNKNOWN-OUTCOME";
  return GROUPED_SCENARIOS.has(caseId) ? `${marker}\n${GROUPED_FINAL}\n` : `${marker}\n`;
}

function scriptFor(caseId: string): { events: string; final: string } {
  const final = finalFor(caseId);
  switch (caseId) {
    case "bounded-res-negative-four-lookups":
      return { events: turn([invocation("item_1"), invocation("item_2"), invocation("item_3"), invocation("item_4")]), final };
    case "bounded-res-bundled-lookups":
      return { events: turn([invocation("item_1", "cat a && grep b . ; ls\nwc -l x")]), final };
    case "bounded-res-incomplete-evidence":
      return {
        events: `${[JSON.stringify({ type: "thread.started", thread_id: "thr_bounded" }), invocation("item_1"), invocation("item_2"), invocation(null), "not-json{{{", JSON.stringify({ type: "turn.completed", usage: {} })].join("\n")}\n`,
        final,
      };
    case "bounded-res-schema-read":
    case "bounded-res-slash-iteration-cold":
      return { events: turn([invocation("item_1"), invocation("item_2")]), final };
    default:
      return { events: turn([invocation("item_1")]), final };
  }
}

function syntheticSpawn(io: RunnerIo, candidate: EvalManifest): SpawnFn & { requests: SpawnRequest[] } {
  const fn = (async (req: SpawnRequest) => {
    fn.requests.push(req);
    const caseId = candidate.cases.find((c) => req.cwd.includes(`/${c.id}/`))?.id;
    if (caseId === undefined) throw new Error(`synthetic adapter: cannot resolve scenario from cwd ${req.cwd}`);
    const script = scriptFor(caseId);
    io.writeText(req.stdoutFile, script.events);
    io.writeText(req.stderrFile, "");
    const index = req.argv.indexOf("--output-last-message");
    if (index < 0) throw new Error("synthetic adapter: argv lacks --output-last-message");
    io.writeText(req.argv[index + 1]!, script.final);
    return { code: 0, signal: null, timedOut: false, spawnError: null };
  }) as SpawnFn & { requests: SpawnRequest[] };
  fn.requests = [];
  return fn;
}

// ---------------------------------------------------------------------------
// Scenario-set contract
// ---------------------------------------------------------------------------

describe("bounded-resolution scenario set: authored artifact", () => {
  test("passes the evaluator's own integrity checks (configHash, heldoutDigest, casesHash)", () => {
    expect(manifestIntegrityErrors(manifest)).toEqual([]);
    // This artifact is authored directly (there is no separate cases-file byte
    // source): `casesHash` binds the canonical serialization of the authored
    // case set, and the manifest records that basis explicitly.
    expect((manifest as EvalManifest & { boundedResolution: { casesHashBasis?: string } }).boundedResolution.casesHashBasis).toContain("canonicalJson(cases)");
    expect(sha256Hex(canonicalJson(manifest.cases))).toBe((manifest as EvalManifest & { casesHash: string }).casesHash);
  });

  test("every canonical definition and slash document has an explicit disposition", () => {
    const errors = validateScenarioSet(manifest, { commandIds: DEFINITIONS.map((d) => d.id), slashDocuments: slashDocuments() });
    expect(errors).toEqual([]);
    // Live enumeration, not a pinned roster: the set must cover every document
    // currently present under commands/.
    expect(slashDocuments().length).toBeGreaterThan(0);
  });

  test("a newly supported slash document without a disposition is rejected", () => {
    const errors = validateScenarioSet(manifest, {
      commandIds: DEFINITIONS.map((d) => d.id),
      slashDocuments: [...slashDocuments(), "newly-shipped-family"],
    });
    expect(errors.some((e) => e.includes("newly-shipped-family") && e.includes("has no disposition"))).toBe(true);
  });

  test("registry inventory alone cannot claim coverage", () => {
    const candidate = cloneManifest() as EvalManifest & { boundedResolution: { routeDispositions: Record<string, Disposition> } };
    for (const id of Object.keys(candidate.boundedResolution.routeDispositions)) {
      candidate.boundedResolution.routeDispositions[id] = { covered: true } as unknown as Disposition;
    }
    const errors = validateScenarioSet(candidate, { commandIds: DEFINITIONS.map((d) => d.id), slashDocuments: slashDocuments() });
    expect(errors.length).toBeGreaterThanOrEqual(DEFINITIONS.length);
    expect(errors[0]).toContain("must declare exactly one of");
  });

  test("a missing behavioral route oracle is rejected", () => {
    const candidate = cloneManifest();
    const target = candidate.cases.find((c) => c.id === "bounded-res-grouped-facts")!;
    target.assertions = [{ id: "only-prose", kind: "final_contains", value: "GROUPED-REQUEST-ISSUED" }];
    const errors = validateScenarioSet(candidate, { commandIds: DEFINITIONS.map((d) => d.id), slashDocuments: slashDocuments() });
    expect(errors.some((e) => e.includes("no budget oracle"))).toBe(true);
  });

  test("a budget-and-no-write-only case cannot claim coverage", () => {
    const candidate = cloneManifest();
    for (const c of candidate.cases) {
      c.assertions = c.assertions.filter((a) => a.kind === "calls_within" || a.kind === "mutation_withheld");
    }
    const errors = validateScenarioSet(candidate, { commandIds: DEFINITIONS.map((d) => d.id), slashDocuments: slashDocuments() });
    expect(errors.length).toBeGreaterThanOrEqual(candidate.cases.length);
    expect(errors.some((e) => e.includes("no semantic outcome oracle"))).toBe(true);
  });

  test("a live definition with no disposition is rejected", () => {
    const candidate = cloneManifest() as EvalManifest & { boundedResolution: { routeDispositions: Record<string, Disposition> } };
    const removed = DEFINITIONS[0]!.id;
    delete candidate.boundedResolution.routeDispositions[removed];
    const errors = validateScenarioSet(candidate, { commandIds: DEFINITIONS.map((d) => d.id), slashDocuments: slashDocuments() });
    expect(errors.some((e) => e.includes(JSON.stringify(removed)) && e.includes("has no disposition"))).toBe(true);
  });

  test("the scenario set is versioned independently of the frozen corpus", () => {
    const frozen = JSON.parse(readFileSync(FROZEN_CASES_PATH, "utf8")) as { cases: { id: string }[] };
    const frozenIds = new Set(frozen.cases.map((c) => c.id));
    for (const c of manifest.cases) expect(frozenIds.has(c.id)).toBe(false);
    const heldout = selectCases(manifest, "heldout").map((c) => c.id).sort();
    expect(heldout).toEqual(["bounded-res-slash-iteration-cold", "bounded-res-slash-review-cold"]);
  });
});

// ---------------------------------------------------------------------------
// Consumption through the existing evaluator (SYNTHETIC)
// ---------------------------------------------------------------------------

describe("bounded-resolution scenario set: consumed by the existing evaluator", () => {
  test("runs every dev scenario, keeps the negative witness failing and incomplete evidence unverified", async () => {
    const io = memoryIo();
    seedRun(io, manifest);
    const selected = selectCases(manifest, "dev");
    const spawn = syntheticSpawn(io, manifest);
    const result = await executeManifest({
      manifestPath: RUN_MANIFEST_PATH,
      split: "dev",
      variants: ["baseline"],
      repeats: 1,
      repoRoot: REPO_ROOT,
      io,
      launchFn: spawn,
    });

    expect(result.errors).toEqual([]);
    expect(result.summary.requestedUnits).toBe(selected.length);
    expect(result.summary.executedUnits).toBe(selected.length);
    expect(result.exit).toBe(2);

    const grades = result.summary.grades;
    expect(grades.pass).toBeGreaterThanOrEqual(4);
    expect(grades.fail).toBeGreaterThanOrEqual(2);
    expect(grades.unverified).toBeGreaterThanOrEqual(1);
    expect(grades.pass + grades.fail + grades.unverified + grades.infrastructure_error).toBe(selected.length);

    const units = Object.values(result.state.units);
    const negative = units.find((u) => u.caseId === "bounded-res-negative-four-lookups")!;
    expect(negative.grade).toBe("fail");
    const calls = negative.grading!.assertions.find((a) => a.kind === "calls_within")!;
    expect(calls.grade).toBe("fail");
    expect(calls.evidence.detail).toContain("4 effective lookup(s)");
    // The grouped-facts oracle still passes there: the failure is the budget,
    // not the grouped request — the negative witness stays visible as such.
    expect(negative.grading!.assertions.find((a) => a.kind === "grouped_facts_final")!.grade).toBe("pass");

    const bundled = units.find((u) => u.caseId === "bounded-res-bundled-lookups")!;
    expect(bundled.grading!.assertions.find((a) => a.kind === "calls_within")!.evidence.detail).toContain("4 effective lookup(s)");

    const incomplete = units.find((u) => u.caseId === "bounded-res-incomplete-evidence")!;
    expect(incomplete.grade).toBe("unverified");
    expect(incomplete.grading!.assertions.find((a) => a.kind === "calls_within")!.grade).toBe("unverified");
  });

  test("the report retains noncompliant and unverified dispositions in the denominator", async () => {
    const io = memoryIo();
    seedRun(io, manifest);
    const selected = selectCases(manifest, "dev");
    await executeManifest({
      manifestPath: RUN_MANIFEST_PATH,
      split: "dev",
      variants: ["baseline"],
      repeats: 1,
      repoRoot: REPO_ROOT,
      io,
      launchFn: syntheticSpawn(io, manifest),
    });

    const report = buildReport({ manifestPath: RUN_MANIFEST_PATH, repoRoot: REPO_ROOT, io });
    expect(report.report.denominator.requestedUnits).toBe(selected.length);
    expect(report.report.denominator.pendingUnits).toBe(0);
    expect(report.report.grades.fail).toBeGreaterThanOrEqual(2);
    expect(report.report.grades.unverified).toBeGreaterThanOrEqual(1);

    const rows = report.report.units;
    const negative = rows.find((u) => u.caseId === "bounded-res-negative-four-lookups")!;
    expect(negative.grade).toBe("fail");
    expect(negative.failedAssertions.some((a) => a.includes("calls_within"))).toBe(true);
    const incomplete = rows.find((u) => u.caseId === "bounded-res-incomplete-evidence")!;
    expect(incomplete.unverifiedAssertions.some((a) => a.includes("calls_within"))).toBe(true);

    const markdown = io.readText(report.mdPath);
    expect(markdown).toContain("Unverified assertions");
    expect(markdown).toContain("Bounded-resolution accounting");
    // Declared contexts travel with the scenarios; the cold-start arms are cold.
    expect(report.report.boundedResolution.unitsDeclaredCold).toBeGreaterThanOrEqual(1);
  });
});
