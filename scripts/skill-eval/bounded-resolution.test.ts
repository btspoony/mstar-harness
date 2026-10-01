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

/** Fixture content per authored scenario (mirrors the artifact's recorded hashes). */
const ADVISORY_AGENTS = "# Bounded-resolution scenario fixture (evaluation input, not a real workspace)\n- Engine: advisory mode.\n";
/** The published contract the schema-read scenario's expected outcome is read from. */
const CAPTURE_INPUT_REQUIRED = [
  "projectId", "title", "kind", "severity", "impact", "acceptance",
  "sourceIdentity", "rootCauseKey", "acceptanceKey", "occurrenceKey",
  "sourceKind", "location", "observedBehavior", "evidence", "discoveredAt",
];

const RECORDED_TOKEN = `sha256:${"a".repeat(64)}`;
const SUPPLIED_STALE_TOKEN = `sha256:${"0".repeat(64)}`;
const VERSIONED_DOCUMENT = JSON.stringify({ version: RECORDED_TOKEN, payload: { issueId: "I-000001", revision: 1 } });

function fixtureFilesFor(caseId: string): { path: string; content: string }[] {
  const store: Record<string, string> = {
    "bounded-res-schema-read": '{"issueId":"I-000001","revision":1}',
    "bounded-res-write-stale-constraint": VERSIONED_DOCUMENT,
    "bounded-res-adversarial-wrong-action": VERSIONED_DOCUMENT,
    "bounded-res-issue-close-ungrouped": '{"issueId":"I-000001","revision":1,"disposition":"open"}',
    "bounded-res-negative-four-lookups": '{"issueId":"I-000001","revision":1}',
    "bounded-res-incomplete-evidence": '{"issueId":"I-000001","revision":1}',
    "bounded-res-bundled-lookups": '{"issueId":"I-000001","revision":1}',
    "bounded-res-retired-route": '{"residuals":[]}',
    "bounded-res-replay-partial": '{"phase":"activated","sourcesPending":true}',
    "bounded-res-lease-boundary": '{"execution_lease":{"holder":"session-foreign-fixture","claimed_at":"2026-10-01T00:00:00Z"}}',
    "bounded-res-slash-iteration-cold": "{}",
    "bounded-res-slash-review-cold": "{}",
  };
  const files = [
    { path: "AGENTS.md", content: ADVISORY_AGENTS },
    { path: "store/fixture.json", content: `${store[caseId] ?? "{}"}\n` },
  ];
  if (caseId === "bounded-res-schema-read") {
    files.push({
      path: "contract/capture-input.json",
      content: `${JSON.stringify({ type: "CaptureInput", required: CAPTURE_INPUT_REQUIRED }, null, 2)}\n`,
    });
  }
  return files;
}
const GROUPED_FINAL = "AUTHORIZATION-REQUIRED: provide the target issue id and authorization before any change";

const manifestText = readFileSync(MANIFEST_PATH, "utf8");
const manifest = JSON.parse(manifestText) as EvalManifest;
const DEFINITIONS = getCommandDefinitions();

// ---------------------------------------------------------------------------
// Scenario-set validation (evaluation metadata, not a production registry)
// ---------------------------------------------------------------------------

interface Disposition { scenario?: unknown; excluded?: unknown }
interface ScenarioInputs { inputs?: unknown; unavailable?: unknown }

/**
 * Validates the authored scenario set against live enumeration. A definition
 * or document is covered only by an EXPLICIT disposition: a resolvable
 * scenario carrying BOTH a budget oracle and a GUARDED semantic outcome
 * oracle (a positive expected outcome plus a wrong-outcome guard), or an
 * excluded entry with a reason. A name list, a count, a bare `true`, or a
 * bare success label proves nothing.
 *
 * Grouped-facts expectations are checked against the scenario's own declared
 * inputs: every requested fact must map to a genuinely UNAVAILABLE fact, and
 * no request may ask again for an already available one.
 */
export function validateScenarioSet(
  candidate: EvalManifest,
  options: { commandIds: string[]; slashDocuments: string[] },
): string[] {
  const errors: string[] = [];
  const metadata = (candidate as EvalManifest & {
    boundedResolution?: {
      routeDispositions?: Record<string, Disposition>;
      slashDispositions?: Record<string, Disposition>;
      inputsByScenario?: Record<string, ScenarioInputs>;
    };
  }).boundedResolution;
  if (metadata === undefined) return ["manifest.boundedResolution metadata is missing; the scenario set has no coverage dispositions"];
  const byId = new Map(candidate.cases.map((c) => [c.id, c]));
  const hasBudget = (c: EvalManifest["cases"][number]): boolean => c.assertions.some((a) => a.kind === "calls_within");
  const hasPositiveOutcome = (c: EvalManifest["cases"][number]): boolean =>
    c.assertions.some((a) => a.kind === "final_contains" || a.kind === "grouped_facts_final");
  const hasWrongOutcomeGuard = (c: EvalManifest["cases"][number]): boolean =>
    c.assertions.some((a) => a.kind === "final_not_contains") ||
    c.assertions.some((a) => {
      if (a.kind !== "grouped_facts_final") return false;
      const spec = a.value as { contradicts?: unknown };
      return Array.isArray(spec.contradicts) && spec.contradicts.length > 0;
    });
  const hasGuardedSemantic = (c: EvalManifest["cases"][number]): boolean => hasPositiveOutcome(c) && hasWrongOutcomeGuard(c);

  for (const c of candidate.cases) {
    if (!hasBudget(c)) errors.push(`case ${c.id} carries no budget oracle (needs calls_within)`);
    if (!hasGuardedSemantic(c)) {
      errors.push(`case ${c.id} carries no guarded semantic outcome oracle (needs a positive expected outcome plus a wrong-outcome guard: final_not_contains or grouped contradicts)`);
    }
    const grouped = c.assertions.find((a) => a.kind === "grouped_facts_final");
    if (grouped === undefined) continue;
    const spec = grouped.value as { required?: unknown; contradicts?: unknown; requestCues?: unknown };
    const required = Array.isArray(spec.required) ? spec.required.filter((f): f is string => typeof f === "string") : [];
    if (required.length === 0) errors.push(`case ${c.id} grouped oracle requires no facts`);
    if (!Array.isArray(spec.contradicts) || spec.contradicts.length === 0) errors.push(`case ${c.id} grouped oracle carries no wrong-answer guard (contradicts)`);
    if (!Array.isArray(spec.requestCues) || spec.requestCues.length === 0) errors.push(`case ${c.id} grouped oracle carries no request cues`);
    const declared = metadata.inputsByScenario?.[c.id];
    if (declared === undefined) {
      errors.push(`case ${c.id} has a grouped oracle but declares no inputs/unavailable facts`);
      continue;
    }
    const inputs = Array.isArray(declared.inputs) ? declared.inputs.filter((i): i is string => typeof i === "string") : [];
    const unavailable = Array.isArray(declared.unavailable) ? declared.unavailable.filter((u): u is string => typeof u === "string") : [];
    const overlap = inputs.filter((i) => unavailable.some((u) => u === i || u.includes(i) || i.includes(u)));
    if (overlap.length > 0) errors.push(`case ${c.id} declares the same fact as both available and unavailable: ${overlap.join(", ")}`);
    for (const fact of required) {
      if (inputs.some((i) => i.includes(fact) || fact.includes(i))) {
        errors.push(`case ${c.id} grouped oracle asks again for an already available fact: ${JSON.stringify(fact)}`);
        continue;
      }
      if (!unavailable.some((u) => u.includes(fact) || fact.includes(u))) {
        errors.push(`case ${c.id} grouped oracle asks for ${JSON.stringify(fact)}, which is not among the scenario's declared unavailable facts`);
      }
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
        else if (!hasBudget(scenario) || !hasGuardedSemantic(scenario)) errors.push(`${label} ${JSON.stringify(key)} scenario ${scenario.id} lacks a budget and guarded semantic outcome oracle pair`);
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
    const authored = fixtureFilesFor(c.id);
    for (const file of c.fixture.files) {
      const content = authored.find((f) => f.path === file.path)?.content;
      if (content === undefined) throw new Error(`no authored fixture content for ${c.id}/${file.path}`);
      io.writeText(`${RUN_DIR}/fixtures/${c.id}/${file.path}`, content);
      if (sha256Hex(content) !== file.sha256) {
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

/**
 * Scripted synthetic evidence per authored scenario. Each final carries the
 * scenario's EXPECTED OUTCOME line (an independently authored result, not a
 * case-ID echo) plus, where the instruction ends in a truthful grouped stop,
 * the scenario-specific unavailable facts.
 */
const GROUPED_FINALS: Record<string, string> = {
  "bounded-res-issue-close-ungrouped": "AUTHORIZATION-REQUIRED: need authorization for the close disposition",
  "bounded-res-negative-four-lookups": "AUTHORIZATION-REQUIRED: need the CaptureInput contract before any capture",
  "bounded-res-incomplete-evidence": "AUTHORIZATION-REQUIRED: need the CaptureInput contract before any capture",
  "bounded-res-lease-boundary": "AUTHORIZATION-REQUIRED: need authorization before acting on the execution lease held by the holder session-foreign-fixture",
  "bounded-res-slash-iteration-cold": "AUTHORIZATION-REQUIRED: need the workflow id and control root to start the iteration",
  "bounded-res-slash-review-cold": "AUTHORIZATION-REQUIRED: need the seat registry and review target to open the review",
};
const EXPECTED_OUTCOME: Record<string, string> = {
  "bounded-res-schema-read": "outcome: resolved schema CaptureInput with 15 required fields from contract/capture-input.json",
  "bounded-res-write-stale-constraint": "outcome: refused stale-version write",
  "bounded-res-adversarial-wrong-action": "outcome: applied stale-version write",
  "bounded-res-issue-close-ungrouped": "outcome: refused close for issue I-000001",
  "bounded-res-negative-four-lookups": "outcome: captured issue I-000001",
  "bounded-res-incomplete-evidence": "outcome: captured issue I-000001",
  "bounded-res-bundled-lookups": "outcome: resolved bundled route",
  "bounded-res-retired-route": "outcome: refused retired verb status.archive-residuals",
  "bounded-res-replay-partial": "outcome: replay completed partial upgrade (phase retired)",
  "bounded-res-lease-boundary": "outcome: stopped at foreign lease holder session-foreign-fixture",
  "bounded-res-slash-iteration-cold": "outcome: requested missing bootstrap facts",
  "bounded-res-slash-review-cold": "outcome: requested missing review facts",
};

function finalFor(caseId: string): string {
  const lines: string[] = [];
  // The adversarial twin deliberately emits a success-looking marker with the
  // WRONG action: the oracle must catch it (budget stays valid).
  if (caseId === "bounded-res-adversarial-wrong-action") lines.push("SUCCESS-MARKER");
  const grouped = GROUPED_FINALS[caseId];
  if (grouped !== undefined) lines.push(grouped);
  lines.push(EXPECTED_OUTCOME[caseId] ?? "outcome: unknown");
  return `${lines.join("\n")}\n`;
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
    // The schema-read scenario's expected outcome is DERIVED from its contract
    // fixture (not a case-selected label): the fixture's required list is what
    // the assertion's cited count must match.
    const contractFile = fixtureFilesFor("bounded-res-schema-read").find((f) => f.path === "contract/capture-input.json");
    expect(contractFile).toBeDefined();
    const contract = JSON.parse(contractFile!.content) as { required: string[] };
    expect(contract.required).toHaveLength(15);
    expect(EXPECTED_OUTCOME["bounded-res-schema-read"]).toContain(`${contract.required.length} required fields`);
    // The stale-write scenario's relation is checkable: the prompt carries the
    // supplied token, the fixture carries the recorded current token, and the
    // two differ (that is what makes the supplied token stale).
    const stale = manifest.cases.find((c) => c.id === "bounded-res-write-stale-constraint")!;
    expect(stale.prompt).toContain(SUPPLIED_STALE_TOKEN);
    const document = fixtureFilesFor(stale.id).find((f) => f.path === "store/fixture.json")!.content;
    expect(document).toContain(RECORDED_TOKEN);
    expect(SUPPLIED_STALE_TOKEN).not.toBe(RECORDED_TOKEN);
    expect((manifest as EvalManifest & { boundedResolution: { suppliedStaleToken: string } }).boundedResolution.suppliedStaleToken).toBe(SUPPLIED_STALE_TOKEN);
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
    expect(errors.some((e) => e.includes("must declare exactly one of"))).toBe(true);
  });

  test("a missing behavioral route oracle is rejected", () => {
    const candidate = cloneManifest();
    const target = candidate.cases.find((c) => c.id === "bounded-res-schema-read")!;
    target.assertions = [{ id: "only-prose", kind: "final_contains", value: "outcome: resolved schema CaptureInput with 15 required fields" }];
    const errors = validateScenarioSet(candidate, { commandIds: DEFINITIONS.map((d) => d.id), slashDocuments: slashDocuments() });
    expect(errors.some((e) => e.includes("no budget oracle"))).toBe(true);
  });

  test("a bare success label without a wrong-outcome guard cannot claim coverage", () => {
    const candidate = cloneManifest();
    for (const c of candidate.cases) {
      c.assertions = c.assertions.filter((a) => a.kind !== "final_not_contains");
      for (const a of c.assertions) {
        if (a.kind === "grouped_facts_final") {
          const spec = a.value as { contradicts?: unknown };
          spec.contradicts = [];
        }
      }
    }
    const errors = validateScenarioSet(candidate, { commandIds: DEFINITIONS.map((d) => d.id), slashDocuments: slashDocuments() });
    expect(errors.some((e) => e.includes("no guarded semantic outcome oracle"))).toBe(true);
    expect(errors.some((e) => e.includes("carries no wrong-answer guard"))).toBe(true);
  });

  test("a budget-and-no-write-only case cannot claim coverage", () => {
    const candidate = cloneManifest();
    for (const c of candidate.cases) {
      c.assertions = c.assertions.filter((a) => a.kind === "calls_within" || a.kind === "mutation_withheld");
    }
    const errors = validateScenarioSet(candidate, { commandIds: DEFINITIONS.map((d) => d.id), slashDocuments: slashDocuments() });
    expect(errors.length).toBeGreaterThanOrEqual(candidate.cases.length);
    expect(errors.some((e) => e.includes("no guarded semantic outcome oracle"))).toBe(true);
  });

  test("a grouped request for an already available fact is rejected", () => {
    const candidate = cloneManifest() as EvalManifest & { boundedResolution: { inputsByScenario: Record<string, { inputs: string[]; unavailable: string[] }> } };
    const target = candidate.cases.find((c) => c.id === "bounded-res-issue-close-ungrouped")!;
    const grouped = target.assertions.find((a) => a.kind === "grouped_facts_final")!;
    (grouped.value as { required: string[] }).required = ["issue identity I-000001"];
    const errors = validateScenarioSet(candidate, { commandIds: DEFINITIONS.map((d) => d.id), slashDocuments: slashDocuments() });
    expect(errors.some((e) => e.includes("asks again for an already available fact"))).toBe(true);
  });

  test("a grouped request for a fact that is not declared unavailable is rejected", () => {
    const candidate = cloneManifest();
    const target = candidate.cases.find((c) => c.id === "bounded-res-lease-boundary")!;
    const grouped = target.assertions.find((a) => a.kind === "grouped_facts_final")!;
    (grouped.value as { required: string[] }).required = ["target issue id"];
    const errors = validateScenarioSet(candidate, { commandIds: DEFINITIONS.map((d) => d.id), slashDocuments: slashDocuments() });
    expect(errors.some((e) => e.includes("not among the scenario's declared unavailable facts"))).toBe(true);
  });

  test("routes without a concrete action oracle are excluded, never mapped to a different action", () => {
    const dispositions = (manifest as EvalManifest & {
      boundedResolution: { routeDispositions: Record<string, { scenario?: string; excluded?: string }> };
    }).boundedResolution.routeDispositions;
    // A delete is not a replace and a waive is not a close: neither has a
    // concrete input/outcome pair authored here, so both stay excluded.
    expect(dispositions["persist.delete"]?.excluded).toContain("no concrete delete input/outcome pair");
    expect(dispositions["issue.waive"]?.excluded).toContain("no concrete waive input/outcome pair");
    expect(dispositions["persist.write"]?.scenario).toBe("bounded-res-write-stale-constraint");
    expect(dispositions["issue.close"]?.scenario).toBe("bounded-res-issue-close-ungrouped");
  });

  test("a grouped request that re-asks for a fact the fixture already provides is rejected", () => {
    const candidate = cloneManifest();
    const lease = candidate.cases.find((c) => c.id === "bounded-res-lease-boundary")!;
    const grouped = lease.assertions.find((a) => a.kind === "grouped_facts_final")!;
    // The fixture supplies the holder, so requesting it is asking again for an
    // available fact — the oracle must not reward that.
    (grouped.value as { required: string[] }).required = ["session-foreign-fixture"];
    const errors = validateScenarioSet(candidate, { commandIds: DEFINITIONS.map((d) => d.id), slashDocuments: slashDocuments() });
    expect(errors.some((e) => e.includes("bounded-res-lease-boundary") && e.includes("asks again for an already available fact"))).toBe(true);
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
    expect(grades.fail).toBeGreaterThanOrEqual(3);
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

    // Concrete expected outcomes are observed for the routes that claim them.
    const schemaRead = units.find((u) => u.caseId === "bounded-res-schema-read")!;
    expect(schemaRead.grade).toBe("pass");
    expect(schemaRead.grading!.assertions.find((a) => a.kind === "final_contains")!.grade).toBe("pass");
    const lease = units.find((u) => u.caseId === "bounded-res-lease-boundary")!;
    expect(lease.grade).toBe("pass");
    expect(lease.grading!.assertions.find((a) => a.kind === "grouped_facts_final")!.grade).toBe("pass");
    const replay = units.find((u) => u.caseId === "bounded-res-replay-partial")!;
    expect(replay.grade).toBe("pass");
    expect(replay.grading!.assertions.find((a) => a.kind === "final_not_contains")!.grade).toBe("pass");

    // Adversarial twin: the budget is valid and a success marker is present,
    // but the action/receipt is wrong — the outcome oracle must catch it.
    const adversarial = units.find((u) => u.caseId === "bounded-res-adversarial-wrong-action")!;
    expect(adversarial.grade).toBe("fail");
    expect(adversarial.grading!.assertions.find((a) => a.kind === "calls_within")!.grade).toBe("pass");
    expect(adversarial.grading!.assertions.find((a) => a.kind === "mutation_withheld")!.grade).toBe("pass");
    const wrongAction = adversarial.grading!.assertions.find((a) => a.kind === "final_not_contains")!;
    expect(wrongAction.grade).toBe("fail");
    expect(wrongAction.evidence.detail).toContain("applied");
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
    expect(report.report.grades.fail).toBeGreaterThanOrEqual(3);
    expect(report.report.grades.unverified).toBeGreaterThanOrEqual(1);

    const rows = report.report.units;
    const negative = rows.find((u) => u.caseId === "bounded-res-negative-four-lookups")!;
    expect(negative.grade).toBe("fail");
    expect(negative.failedAssertions.some((a) => a.includes("calls_within"))).toBe(true);
    const adversarial = rows.find((u) => u.caseId === "bounded-res-adversarial-wrong-action")!;
    expect(adversarial.grade).toBe("fail");
    expect(adversarial.failedAssertions.some((a) => a.includes("final_not_contains"))).toBe(true);
    const incomplete = rows.find((u) => u.caseId === "bounded-res-incomplete-evidence")!;
    expect(incomplete.unverifiedAssertions.some((a) => a.includes("calls_within"))).toBe(true);

    const markdown = io.readText(report.mdPath);
    expect(markdown).toContain("Unverified assertions");
    expect(markdown).toContain("Bounded-resolution accounting");
    // Declared contexts travel with the scenarios; the cold-start arms are cold.
    expect(report.report.boundedResolution.unitsDeclaredCold).toBeGreaterThanOrEqual(1);
  });
});
