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
 * Available-fact re-request protection is TWO-LAYERED: the evaluator's
 * `final_not_contains` needles intercept the reviewed phrasings directly, and
 * the structured request-fact oracle (`scanRequestVerdict` over the manifest's
 * `requestGuard`) classifies cue + fact REQUESTS independently of any
 * sentence template — unsupported or ambiguous shapes stay `unverified`,
 * never a pass.
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

/**
 * Adversarial response-level final: it keeps the required authorization, the
 * request cues, and the success-looking stop line, but RE-REQUESTS the
 * already-available holder and lease boundary. Only a response-level guard
 * (not the grouped oracle) can distinguish this from the legitimate stop.
 */
const LEASE_RE_REQUEST_FINAL = "AUTHORIZATION-REQUIRED: need authorization; please provide the holder session-foreign-fixture and provide the execution lease boundary.\noutcome: stopped at foreign lease holder session-foreign-fixture\n";
/**
 * The same re-request spelled with the scenario's OTHER configured request
 * cue (`need`). The grouped oracle accepts it, the budget stays valid, and
 * the stop line is intact — only a cue-consistent response guard rejects it.
 */
const LEASE_NEED_RE_REQUEST_FINAL = "AUTHORIZATION-REQUIRED: need authorization; need the holder session-foreign-fixture and need the execution lease boundary.\noutcome: stopped at foreign lease holder session-foreign-fixture\n";
/**
 * The QC1-F2 counterexample: the same `need` re-request with the article
 * dropped. Sentence-template guards cannot see it; the bare-need needles and
 * the structured request-fact oracle both must, while every legitimate
 * oracle (budget, no-write, authorization request, holder-naming stop)
 * stays green.
 */
const LEASE_ARTICLE_FREE_RE_REQUEST_FINAL = "AUTHORIZATION-REQUIRED: need authorization; need holder session-foreign-fixture and need execution lease boundary.\noutcome: stopped at foreign lease holder session-foreign-fixture\n";
/**
 * An UNSUPPORTED request form: the facts are demanded with a phrasing that is
 * neither a configured cue nor a declared reference form. No needle can name
 * every possible wording, so the structured request-fact oracle must hold
 * this at `unverified` — never a pass.
 */
const LEASE_UNDECLARED_REQUEST_FINAL = "AUTHORIZATION-REQUIRED: need authorization\nrequest: holder session-foreign-fixture and execution lease boundary required before acting\noutcome: stopped at foreign lease holder session-foreign-fixture\n";
/**
 * The schema/read count sentence alone is kept, but the claimed field list
 * and document values are WRONG: the behavioral oracle must reject an
 * outcome sentence whose schema/document results do not match the fixtures.
 */
const SCHEMA_WRONG_RESULTS_FINAL = "outcome: resolved schema CaptureInput with 15 required fields from contract/capture-input.json\nschema CaptureInput requires: projectId, title, kind, severity, impact, acceptance, sourceIdentity, rootCauseKey, acceptanceKey, occurrenceKey, sourceKind, location, observedBehavior, evidence, wrongFieldOne\nissue document store/fixture.json: issueId I-999999 revision 7\n";
/**
 * The corrected resume/next-action sentences are KEPT, and an incompatible
 * receipt claim (`phase retired` — a completed-mutation statement a
 * no-write trace cannot truthfully produce) is ADDED: the negative guard
 * must be what rejects this final, not a missing positive oracle.
 */
const REPLAY_RETIRED_CLAIM_FINAL = "outcome: replay resumes the partial upgrade from receipt phase activated (sources pending)\nnext: apply the sources phase, then retire\nreceipt: phase retired\n";

const manifestText = readFileSync(MANIFEST_PATH, "utf8");
const manifest = JSON.parse(manifestText) as EvalManifest;
const DEFINITIONS = getCommandDefinitions();

// ---------------------------------------------------------------------------
// Scenario-set validation (evaluation metadata, not a production registry)
// ---------------------------------------------------------------------------

interface Disposition { scenario?: unknown; excluded?: unknown }
interface ScenarioInputs { inputs?: unknown; unavailable?: unknown }

/** Structured request representation declared in a grouped oracle's `requestGuard`. */
interface RequestGuardSpec {
  /** Facts the fixture already supplies: requesting them again must never pass. */
  availableFacts: string[];
  /** Declared reference templates; `{fact}` is replaced by the fact name. */
  referenceForms: string[];
}

interface RequestVerdict {
  status: "pass" | "fail" | "unverified";
  violations: string[];
  ambiguous: string[];
}

const REQUEST_DETERMINER_RE = /^(?:the|a|an|our)\s+/;
const CLAUSE_END_RE = /[.;!\n]/;

/**
 * Structured request-fact oracle (QC1-F2). A REQUEST for an available fact is
 * a configured cue whose clause object IS the fact — `cue` + optional
 * determiner + fact — never a full-sentence template, so the article is
 * irrelevant. Cues match as WHOLE WORDS (`needed`/`needing` are not `need`);
 * coordinated objects (`... and ...`) stay inside the request span. Every fact
 * occurrence that is neither a detected request object nor inside a declared
 * reference form is an UNSUPPORTED shape: the oracle returns `unverified`
 * rather than passing it.
 */
export function scanRequestVerdict(
  final: string,
  spec: { requestCues: string[] } & RequestGuardSpec,
): RequestVerdict {
  const lower = final.toLowerCase();
  const wordChar = (at: number): boolean => at >= 0 && at < lower.length && /[a-z0-9]/.test(lower[at]!);
  const cues = spec.requestCues.map((cue) => cue.toLowerCase());
  const facts = spec.availableFacts.map((fact) => fact.toLowerCase());
  const violations = new Set<string>();
  for (const cue of cues) {
    let at = lower.indexOf(cue);
    while (at >= 0) {
      const cueEnd = at + cue.length;
      if (!wordChar(at - 1) && !wordChar(cueEnd)) {
        const stop = lower.slice(cueEnd).search(CLAUSE_END_RE);
        const clauseEnd = stop >= 0 ? cueEnd + stop : lower.length;
        for (const segment of lower.slice(cueEnd, clauseEnd).split(/ and /)) {
          const object = segment.replace(/^[\s,:]+/, "").replace(REQUEST_DETERMINER_RE, "").trim();
          for (const fact of facts) {
            if (object.startsWith(fact)) violations.add(fact);
          }
        }
      }
      at = lower.indexOf(cue, cueEnd);
    }
  }
  const referenceRanges: Array<[number, number]> = [];
  for (const form of spec.referenceForms) {
    for (const fact of facts) {
      const instance = form.replace("{fact}", fact);
      let at = lower.indexOf(instance);
      while (at >= 0) {
        referenceRanges.push([at, at + instance.length]);
        at = lower.indexOf(instance, at + 1);
      }
    }
  }
  const inReference = (start: number): boolean => referenceRanges.some(([from, to]) => start >= from && start < to);
  const ambiguous: string[] = [];
  for (const fact of facts) {
    if (violations.has(fact)) continue;
    let at = lower.indexOf(fact);
    while (at >= 0) {
      if (!inReference(at)) {
        ambiguous.push(fact);
        break;
      }
      at = lower.indexOf(fact, at + 1);
    }
  }
  return {
    status: violations.size > 0 ? "fail" : ambiguous.length > 0 ? "unverified" : "pass",
    violations: [...violations],
    ambiguous,
  };
}

/** Reads a grouped oracle's value into the oracle input; null when unguarded. */
function requestGuardSpec(groupedValue: unknown): ({ requestCues: string[] } & RequestGuardSpec) | null {
  if (groupedValue === null || typeof groupedValue !== "object" || !("requestCues" in groupedValue) || !("requestGuard" in groupedValue)) return null;
  const cuesRaw: unknown = groupedValue.requestCues;
  const cues = Array.isArray(cuesRaw) ? cuesRaw.filter((cue): cue is string => typeof cue === "string") : [];
  const guardRaw: unknown = groupedValue.requestGuard;
  const factsRaw = guardRaw !== null && typeof guardRaw === "object" && "availableFacts" in guardRaw ? guardRaw.availableFacts : undefined;
  const formsRaw = guardRaw !== null && typeof guardRaw === "object" && "referenceForms" in guardRaw ? guardRaw.referenceForms : undefined;
  const availableFacts = Array.isArray(factsRaw) ? factsRaw.filter((fact): fact is string => typeof fact === "string") : [];
  const referenceForms = Array.isArray(formsRaw) ? formsRaw.filter((form): form is string => typeof form === "string") : [];
  if (cues.length === 0 || availableFacts.length === 0) return null;
  return { requestCues: cues, availableFacts, referenceForms };
}

/**
 * Mutatable view of a grouped oracle's structured requestGuard for negative
 * tests; null when the authored manifest has none. The shape is verified with
 * `in` narrowing and typed once at this boundary.
 */
function mutableRequestGuard(groupedValue: unknown): RequestGuardSpec | null {
  if (groupedValue === null || typeof groupedValue !== "object" || !("requestGuard" in groupedValue)) return null;
  const guard: unknown = groupedValue.requestGuard;
  if (guard === null || typeof guard !== "object" || !("availableFacts" in guard) || !("referenceForms" in guard)) return null;
  return guard as RequestGuardSpec;
}

/**
 * Scenario-level verdict under the request-fact oracle: a `fail`/`unverified`
 * from the structured guard OVERRIDES the evaluator's per-assertion pass — a
 * final that re-requests (or unsupportedly references) an available fact can
 * never be recorded as a resolved pass.
 */
function scenarioVerdict(evaluatorGrade: string, oracle: RequestVerdict): "pass" | "fail" | "unverified" {
  if (oracle.status !== "pass") return oracle.status;
  return evaluatorGrade === "pass" ? "pass" : evaluatorGrade === "fail" ? "fail" : "unverified";
}

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
    // Available-fact re-request protection (QC1-F2): needles that guard an
    // available fact must be bound to a structured requestGuard — the
    // request-fact oracle keys on cue + fact, never on a sentence template.
    const guardSpec = requestGuardSpec(grouped.value);
    const needleFacts = c.assertions
      .filter((a) => a.kind === "final_not_contains")
      .map((a) => String(a.value).trim().toLowerCase().match(/^(?:need|please provide|provide)\s+(?:the\s+)?(.+)$/)?.[1]?.trim())
      .filter((fact): fact is string => fact !== undefined);
    if (needleFacts.length > 0) {
      if (guardSpec === null) {
        errors.push(`case ${c.id} guards available facts with request needles but declares no structured requestGuard (request = cue + fact, article-independent)`);
      } else {
        const needleSet = [...new Set(needleFacts)].sort();
        const declaredFacts = guardSpec.availableFacts.map((fact) => fact.toLowerCase()).sort();
        if (JSON.stringify(needleSet) !== JSON.stringify(declaredFacts)) {
          errors.push(`case ${c.id} requestGuard.availableFacts ${JSON.stringify(declaredFacts)} drifts from the guarded needle facts ${JSON.stringify(needleSet)}`);
        }
        for (const fact of declaredFacts) {
          if (!inputs.some((i) => i.toLowerCase().includes(fact))) {
            errors.push(`case ${c.id} requestGuard declares ${JSON.stringify(fact)}, which is not among the scenario's declared available inputs`);
          }
        }
        for (const form of guardSpec.referenceForms) {
          if (!form.includes("{fact}")) {
            errors.push(`case ${c.id} requestGuard.referenceForms entry carries no {fact} placeholder: ${JSON.stringify(form)}`);
          }
        }
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
  "bounded-res-schema-read": `outcome: resolved schema CaptureInput with 15 required fields from contract/capture-input.json\nschema CaptureInput requires: ${CAPTURE_INPUT_REQUIRED.join(", ")}\nissue document store/fixture.json: issueId I-000001 revision 1`,
  "bounded-res-write-stale-constraint": "outcome: refused stale-version write",
  "bounded-res-adversarial-wrong-action": "outcome: applied stale-version write",
  "bounded-res-issue-close-ungrouped": "outcome: refused close for issue I-000001",
  "bounded-res-negative-four-lookups": "outcome: captured issue I-000001",
  "bounded-res-incomplete-evidence": "outcome: captured issue I-000001",
  "bounded-res-bundled-lookups": "outcome: resolved bundled route",
  "bounded-res-retired-route": "outcome: refused retired verb status.archive-residuals",
  "bounded-res-replay-partial": "outcome: replay resumes the partial upgrade from receipt phase activated (sources pending)\nnext: apply the sources phase, then retire",
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
      // The trace observes the REAL fixture reads the outcome claims: the
      // published contract (its required field list) and the stored issue
      // document (its values) — not placeholder reads.
      return {
        events: turn([
          invocation("item_1", ["cat", "contract/capture-input.json"]),
          invocation("item_2", ["cat", "store/fixture.json"]),
        ]),
        final,
      };
    case "bounded-res-slash-iteration-cold":
      return { events: turn([invocation("item_1"), invocation("item_2")]), final };
    case "bounded-res-replay-partial":
      // The withheld replay observes the partial RECEIPT it resumes from
      // (the fixture's recorded phase/pending state); the executable next
      // actions are asserted in the final and never executed.
      return { events: turn([invocation("item_1", ["cat", "store/fixture.json"])]), final };
    default:
      return { events: turn([invocation("item_1")]), final };
  }
}

function syntheticSpawn(
  io: RunnerIo,
  candidate: EvalManifest,
  finalOverrides: Record<string, string> = {},
): SpawnFn & { requests: SpawnRequest[] } {
  const fn = (async (req: SpawnRequest) => {
    fn.requests.push(req);
    const caseId = candidate.cases.find((c) => req.cwd.includes(`/${c.id}/`))?.id;
    if (caseId === undefined) throw new Error(`synthetic adapter: cannot resolve scenario from cwd ${req.cwd}`);
    const script = scriptFor(caseId);
    io.writeText(req.stdoutFile, script.events);
    io.writeText(req.stderrFile, "");
    const index = req.argv.indexOf("--output-last-message");
    if (index < 0) throw new Error("synthetic adapter: argv lacks --output-last-message");
    io.writeText(req.argv[index + 1]!, finalOverrides[caseId] ?? script.final);
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
    // The behavioral results are fixture-derived too: the manifest asserts the
    // EXACT required field names and the stored document's actual values, so a
    // count sentence with wrong values can never satisfy the oracle.
    const schemaCase = manifest.cases.find((c) => c.id === "bounded-res-schema-read")!;
    expect(schemaCase.assertions.find((a) => a.id === "a-schema-fields")!.value).toBe(contract.required.join(", "));
    const schemaDoc = JSON.parse(fixtureFilesFor("bounded-res-schema-read").find((f) => f.path === "store/fixture.json")!.content) as { issueId: string; revision: number };
    expect(schemaCase.assertions.find((a) => a.id === "a-issue-document")!.value).toBe(`issueId ${schemaDoc.issueId} revision ${schemaDoc.revision}`);
    // The replay oracle binds the receipt's recorded state and demands a
    // concrete next action; a completed/retired claim is guarded against.
    const replayCase = manifest.cases.find((c) => c.id === "bounded-res-replay-partial")!;
    const replayDoc = JSON.parse(fixtureFilesFor("bounded-res-replay-partial").find((f) => f.path === "store/fixture.json")!.content) as { phase: string; sourcesPending: boolean };
    expect(replayDoc).toEqual({ phase: "activated", sourcesPending: true });
    expect(replayCase.assertions.find((a) => a.id === "a-outcome")!.value).toContain(`receipt phase ${replayDoc.phase} (sources pending)`);
    expect(replayCase.assertions.find((a) => a.id === "a-next-action")!.kind).toBe("final_contains");
    expect(EXPECTED_OUTCOME["bounded-res-replay-partial"]).not.toContain("phase retired");
    // The traces themselves observe the fixture reads the outcomes claim:
    // the schema/read route reads the contract AND the stored document, the
    // replay route reads the partial receipt it resumes from — placeholder
    // `cat AGENTS.md` events cannot back a behavioral result.
    const schemaScript = scriptFor("bounded-res-schema-read");
    expect(schemaScript.events).toContain("contract/capture-input.json");
    expect(schemaScript.events).toContain("store/fixture.json");
    expect(schemaScript.events).not.toContain("AGENTS.md");
    const replayScript = scriptFor("bounded-res-replay-partial");
    expect(replayScript.events).toContain("store/fixture.json");
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

  test("grouped stops guard their declared available facts against every configured request cue", () => {
    const inputsByScenario = (manifest as EvalManifest & {
      boundedResolution: { inputsByScenario: Record<string, ScenarioInputs> };
    }).boundedResolution.inputsByScenario;
    for (const c of manifest.cases) {
      if (!c.assertions.some((a) => a.kind === "grouped_facts_final")) continue;
      const declared = (inputsByScenario[c.id]?.inputs ?? []).join(" ").toLowerCase();
      if (declared === "") continue; // nothing already available to re-request
      const grouped = c.assertions.find((a) => a.kind === "grouped_facts_final")!;
      const groupedValue: unknown = grouped.value;
      expect(groupedValue !== null && typeof groupedValue === "object" && "requestCues" in groupedValue).toBe(true);
      if (groupedValue === null || typeof groupedValue !== "object" || !("requestCues" in groupedValue)) continue;
      const cueRaw: unknown = groupedValue.requestCues;
      const cueList: string[] = Array.isArray(cueRaw) ? cueRaw.filter((x): x is string => typeof x === "string") : [];
      expect(cueList.length).toBeGreaterThan(0);
      const needles = c.assertions
        .filter((a) => a.kind === "final_not_contains")
        .map((a) => String(a.value).toLowerCase());
      expect(needles.length).toBeGreaterThan(0);
      // Every request-shaped needle must name a fact the scenario actually
      // declares available — the guard cannot drift away from the declared
      // inputs or be silently dropped.
      const facts = new Set<string>();
      for (const needle of needles) {
        const fact = needle.match(/^(?:need|please provide|provide) the (.+)$/)?.[1];
        if (fact === undefined) continue;
        facts.add(fact);
        expect(declared).toContain(fact);
      }
      expect(facts.size).toBeGreaterThan(0);
      // Cue consistency: EVERY configured cue form of every guarded fact
      // whose needle is not subsumed by another guard must itself be
      // guarded. A `please provide x` request CONTAINS the string
      // `provide x`, so a provide needle already rejects it; a `need x`
      // request contains neither, so it needs its own needle.
      const maximalCues = cueList.filter((cue) => {
        const form = `${cue.toLowerCase()} the `;
        return !cueList.some((other) => other !== cue && form.includes(`${other.toLowerCase()} the `));
      });
      for (const cue of maximalCues) {
        for (const fact of facts) {
          expect(needles.some((needle) => needle.includes(`${cue.toLowerCase()} the ${fact}`))).toBe(true);
        }
      }
      // Article independence (QC1-F2): the bare, article-free `need` form of
      // every guarded fact is ALSO a needle — the guard keys on the request
      // (cue + fact), not on the article-bearing sentence.
      for (const fact of facts) {
        expect(needles.some((needle) => needle.includes(`need ${fact}`))).toBe(true);
      }
    }
    // The review-named lease facts are covered under BOTH non-redundant
    // configured forms (provide and need) AND their article-free need forms.
    const lease = manifest.cases.find((c) => c.id === "bounded-res-lease-boundary")!;
    const leaseNeedles = lease.assertions
      .filter((a) => a.kind === "final_not_contains")
      .map((a) => String(a.value).toLowerCase());
    for (const fact of ["holder session-foreign-fixture", "execution lease boundary"]) {
      for (const form of ["provide the", "need the", "need"]) {
        expect(leaseNeedles.some((needle) => needle.includes(`${form} ${fact}`))).toBe(true);
      }
    }
  });

  test("the structured request oracle keys on the request (cue + fact), not on the article", () => {
    const groupedSpec = (caseId: string): { requestCues: string[] } & RequestGuardSpec => {
      const c = manifest.cases.find((entry) => entry.id === caseId)!;
      const spec = requestGuardSpec(c.assertions.find((a) => a.kind === "grouped_facts_final")!.value);
      expect(spec).not.toBeNull();
      return spec!;
    };
    const leaseSpec = groupedSpec("bounded-res-lease-boundary");
    // The submitted article-free counterexample is a re-REQUEST of both
    // available facts — detected without any article-bearing template.
    expect(scanRequestVerdict(LEASE_ARTICLE_FREE_RE_REQUEST_FINAL, leaseSpec)).toEqual({
      status: "fail",
      violations: ["holder session-foreign-fixture", "execution lease boundary"],
      ambiguous: [],
    });
    // The article-bearing forms stay violations too (all configured cues).
    expect(scanRequestVerdict(LEASE_RE_REQUEST_FINAL, leaseSpec).status).toBe("fail");
    expect(scanRequestVerdict(LEASE_NEED_RE_REQUEST_FINAL, leaseSpec).status).toBe("fail");
    // An unsupported phrasing (not a configured cue) is NOT a pass: it stays
    // unverified — the fact occurrences match neither a request nor a
    // declared reference form.
    expect(scanRequestVerdict(LEASE_UNDECLARED_REQUEST_FINAL, leaseSpec)).toEqual({
      status: "unverified",
      violations: [],
      ambiguous: ["holder session-foreign-fixture", "execution lease boundary"],
    });
    // A bare mention without any request or reference context is
    // unverified rather than silently accepted.
    expect(scanRequestVerdict("AUTHORIZATION-REQUIRED: need authorization\nthe holder session-foreign-fixture is foreign\n", leaseSpec).status).toBe("unverified");
    // Inflected cue words are not the configured cue: `needed` opens no
    // request span, so the fact mention stays unsupported → unverified
    // (never misclassified as a known request, never a pass).
    expect(scanRequestVerdict("AUTHORIZATION-REQUIRED: need authorization\nthe lease needed holder session-foreign-fixture confirmed\n", leaseSpec).status).toBe("unverified");
    // The legitimate stop only NAMES the facts through the declared reference
    // forms — it keeps passing.
    const legalLeaseFinal = `${GROUPED_FINALS["bounded-res-lease-boundary"]}\n${EXPECTED_OUTCOME["bounded-res-lease-boundary"]}\n`;
    expect(scanRequestVerdict(legalLeaseFinal, leaseSpec)).toEqual({ status: "pass", violations: [], ambiguous: [] });
    // Same separation for the issue identity the close scenario supplies.
    const closeSpec = groupedSpec("bounded-res-issue-close-ungrouped");
    expect(scanRequestVerdict("AUTHORIZATION-REQUIRED: need authorization; need issue identity I-000001.\noutcome: refused close for issue I-000001\n", closeSpec).status).toBe("fail");
    const legalCloseFinal = `${GROUPED_FINALS["bounded-res-issue-close-ungrouped"]}\n${EXPECTED_OUTCOME["bounded-res-issue-close-ungrouped"]}\n`;
    expect(scanRequestVerdict(legalCloseFinal, closeSpec)).toEqual({ status: "pass", violations: [], ambiguous: [] });
  });

  test("available-fact needles without a structured requestGuard are rejected", () => {
    const candidate = cloneManifest();
    const lease = candidate.cases.find((c) => c.id === "bounded-res-lease-boundary")!;
    const grouped = lease.assertions.find((a) => a.kind === "grouped_facts_final")!;
    // An empty structured guard is no structured guard: the needle set is
    // then unbound from any request representation.
    mutableRequestGuard(grouped.value)!.availableFacts = [];
    const errors = validateScenarioSet(candidate, { commandIds: DEFINITIONS.map((d) => d.id), slashDocuments: slashDocuments() });
    expect(errors.some((e) => e.includes("bounded-res-lease-boundary") && e.includes("no structured requestGuard"))).toBe(true);
  });

  test("a requestGuard that drifts from the guarded needle facts is rejected", () => {
    const candidate = cloneManifest();
    const lease = candidate.cases.find((c) => c.id === "bounded-res-lease-boundary")!;
    const grouped = lease.assertions.find((a) => a.kind === "grouped_facts_final")!;
    mutableRequestGuard(grouped.value)!.availableFacts = ["holder session-foreign-fixture"];
    const errors = validateScenarioSet(candidate, { commandIds: DEFINITIONS.map((d) => d.id), slashDocuments: slashDocuments() });
    expect(errors.some((e) => e.includes("bounded-res-lease-boundary") && e.includes("drifts from the guarded needle facts"))).toBe(true);
  });

  test("a requestGuard fact that no declared input supplies is rejected", () => {
    const candidate = cloneManifest() as EvalManifest & {
      boundedResolution: { inputsByScenario: Record<string, { inputs: string[]; unavailable: string[] }> };
    };
    candidate.boundedResolution.inputsByScenario["bounded-res-issue-close-ungrouped"].inputs = [];
    const errors = validateScenarioSet(candidate, { commandIds: DEFINITIONS.map((d) => d.id), slashDocuments: slashDocuments() });
    expect(errors.some((e) => e.includes("bounded-res-issue-close-ungrouped") && e.includes("not among the scenario's declared available inputs"))).toBe(true);
  });

  test("a reference form without a {fact} placeholder is rejected", () => {
    const candidate = cloneManifest();
    const lease = candidate.cases.find((c) => c.id === "bounded-res-lease-boundary")!;
    const grouped = lease.assertions.find((a) => a.kind === "grouped_facts_final")!;
    mutableRequestGuard(grouped.value)!.referenceForms = ["stopped at foreign lease holder"];
    const errors = validateScenarioSet(candidate, { commandIds: DEFINITIONS.map((d) => d.id), slashDocuments: slashDocuments() });
    expect(errors.some((e) => e.includes("bounded-res-lease-boundary") && e.includes("no {fact} placeholder"))).toBe(true);
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
    expect(schemaRead.grading!.assertions.find((a) => a.assertionId === "a-schema-fields")!.grade).toBe("pass");
    expect(schemaRead.grading!.assertions.find((a) => a.assertionId === "a-issue-document")!.grade).toBe("pass");
    const lease = units.find((u) => u.caseId === "bounded-res-lease-boundary")!;
    expect(lease.grade).toBe("pass");
    expect(lease.grading!.assertions.find((a) => a.kind === "grouped_facts_final")!.grade).toBe("pass");
    // The legitimate stop NAMES the available holder/boundary: the response
    // guards against re-REQUESTING them (provide AND need forms) must stay
    // green there.
    expect(lease.grading!.assertions.find((a) => a.assertionId === "a-not-holder-request")!.grade).toBe("pass");
    expect(lease.grading!.assertions.find((a) => a.assertionId === "a-not-boundary-request")!.grade).toBe("pass");
    expect(lease.grading!.assertions.find((a) => a.assertionId === "a-not-holder-need-request")!.grade).toBe("pass");
    expect(lease.grading!.assertions.find((a) => a.assertionId === "a-not-boundary-need-request")!.grade).toBe("pass");
    expect(lease.grading!.assertions.find((a) => a.assertionId === "a-not-holder-need-bare")!.grade).toBe("pass");
    expect(lease.grading!.assertions.find((a) => a.assertionId === "a-not-boundary-need-bare")!.grade).toBe("pass");
    // The structured request-fact oracle agrees: the legitimate stop only
    // NAMES the holder/boundary through the declared reference forms.
    const leaseOracleSpec = requestGuardSpec(manifest.cases.find((c) => c.id === "bounded-res-lease-boundary")!.assertions.find((a) => a.kind === "grouped_facts_final")!.value)!;
    const leaseFinal = io.readText(lease.turns["1"]!.artifacts.final);
    expect(scenarioVerdict(lease.grade, scanRequestVerdict(leaseFinal, leaseOracleSpec))).toBe("pass");
    // The issue-close refusal names the supplied identity: its re-request
    // guards must stay green there too.
    const issueClose = units.find((u) => u.caseId === "bounded-res-issue-close-ungrouped")!;
    expect(issueClose.grade).toBe("pass");
    expect(issueClose.grading!.assertions.find((a) => a.assertionId === "a-not-identity-request")!.grade).toBe("pass");
    expect(issueClose.grading!.assertions.find((a) => a.assertionId === "a-not-identity-need-request")!.grade).toBe("pass");
    const replay = units.find((u) => u.caseId === "bounded-res-replay-partial")!;
    expect(replay.grade).toBe("pass");
    expect(replay.grading!.assertions.find((a) => a.assertionId === "a-outcome")!.grade).toBe("pass");
    expect(replay.grading!.assertions.find((a) => a.assertionId === "a-next-action")!.grade).toBe("pass");
    for (const guard of replay.grading!.assertions.filter((a) => a.kind === "final_not_contains")) {
      expect(guard.grade).toBe("pass");
    }

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

  test("an adversarial final that re-requests the available holder/boundary fails on the response-level guard with a valid budget", async () => {
    const io = memoryIo();
    seedRun(io, manifest);
    const spawn = syntheticSpawn(io, manifest, { "bounded-res-lease-boundary": LEASE_RE_REQUEST_FINAL });
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
    const units = Object.values(result.state.units);
    const lease = units.find((u) => u.caseId === "bounded-res-lease-boundary")!;
    expect(lease.grade).toBe("fail");
    // The budget and no-write evidence stay valid, and the grouped oracle
    // cannot see the difference (authorization + cues + stop line present) —
    // only the response-level guard catches the re-request.
    expect(lease.grading!.assertions.find((a) => a.kind === "calls_within")!.grade).toBe("pass");
    expect(lease.grading!.assertions.find((a) => a.kind === "mutation_withheld")!.grade).toBe("pass");
    expect(lease.grading!.assertions.find((a) => a.kind === "grouped_facts_final")!.grade).toBe("pass");
    const holderGuard = lease.grading!.assertions.find((a) => a.assertionId === "a-not-holder-request")!;
    expect(holderGuard.grade).toBe("fail");
    expect(holderGuard.evidence.detail).toContain("provide the holder session-foreign-fixture");
    expect(lease.grading!.assertions.find((a) => a.assertionId === "a-not-boundary-request")!.grade).toBe("fail");
  });

  test("the need-form re-request of the available holder/boundary fails on the cue-consistent guards too", async () => {
    const io = memoryIo();
    seedRun(io, manifest);
    const spawn = syntheticSpawn(io, manifest, { "bounded-res-lease-boundary": LEASE_NEED_RE_REQUEST_FINAL });
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
    const units = Object.values(result.state.units);
    const lease = units.find((u) => u.caseId === "bounded-res-lease-boundary")!;
    // The grouped oracle cannot see the difference: authorization present,
    // the configured `need` cue present, the required stop line present, and
    // neither contradicts phrase — the RESPONSE guards must catch it.
    expect(lease.grading!.assertions.find((a) => a.kind === "grouped_facts_final")!.grade).toBe("pass");
    expect(lease.grading!.assertions.find((a) => a.kind === "calls_within")!.grade).toBe("pass");
    expect(lease.grading!.assertions.find((a) => a.kind === "mutation_withheld")!.grade).toBe("pass");
    expect(lease.grade).toBe("fail");
    expect(lease.grading!.assertions.find((a) => a.assertionId === "a-not-holder-need-request")!.grade).toBe("fail");
    expect(lease.grading!.assertions.find((a) => a.assertionId === "a-not-boundary-need-request")!.grade).toBe("fail");
  });

  test("the article-free re-request (QC1-F2 counterexample) fails through the bare-need guards with a valid budget", async () => {
    const io = memoryIo();
    seedRun(io, manifest);
    const spawn = syntheticSpawn(io, manifest, { "bounded-res-lease-boundary": LEASE_ARTICLE_FREE_RE_REQUEST_FINAL });
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
    const units = Object.values(result.state.units);
    const lease = units.find((u) => u.caseId === "bounded-res-lease-boundary")!;
    // Dropping the article changes nothing legitimate: budget, no-write,
    // grouped authorization request, and the holder-naming stop all stay
    // green — the re-REQUEST itself is what fails.
    expect(lease.grading!.assertions.find((a) => a.kind === "grouped_facts_final")!.grade).toBe("pass");
    expect(lease.grading!.assertions.find((a) => a.kind === "calls_within")!.grade).toBe("pass");
    expect(lease.grading!.assertions.find((a) => a.kind === "mutation_withheld")!.grade).toBe("pass");
    expect(lease.grading!.assertions.find((a) => a.assertionId === "a-outcome")!.grade).toBe("pass");
    // The article-bearing needles cannot see this phrasing: they stay green.
    expect(lease.grading!.assertions.find((a) => a.assertionId === "a-not-holder-need-request")!.grade).toBe("pass");
    expect(lease.grading!.assertions.find((a) => a.assertionId === "a-not-boundary-need-request")!.grade).toBe("pass");
    // The bare-need needles (cue + fact, no article) reject it.
    const holderBare = lease.grading!.assertions.find((a) => a.assertionId === "a-not-holder-need-bare")!;
    expect(holderBare.grade).toBe("fail");
    expect(holderBare.evidence.detail).toContain("need holder session-foreign-fixture");
    expect(lease.grading!.assertions.find((a) => a.assertionId === "a-not-boundary-need-bare")!.grade).toBe("fail");
    expect(lease.grade).toBe("fail");
    // And the structured request-fact oracle fails it independently of any
    // needle: both facts are requested again.
    const oracle = scanRequestVerdict(LEASE_ARTICLE_FREE_RE_REQUEST_FINAL, requestGuardSpec(manifest.cases.find((c) => c.id === "bounded-res-lease-boundary")!.assertions.find((a) => a.kind === "grouped_facts_final")!.value)!);
    expect(oracle.status).toBe("fail");
    expect(scenarioVerdict(lease.grade, oracle)).toBe("fail");
  });

  test("an unsupported request form the needles cannot name stays unverified instead of passing", async () => {
    const io = memoryIo();
    seedRun(io, manifest);
    const spawn = syntheticSpawn(io, manifest, { "bounded-res-lease-boundary": LEASE_UNDECLARED_REQUEST_FINAL });
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
    const units = Object.values(result.state.units);
    const lease = units.find((u) => u.caseId === "bounded-res-lease-boundary")!;
    // Honest blind-spot record: no configured guard matches this phrasing, so
    // the EVALUATOR records a pass (budget, grouped, stop line all valid).
    expect(lease.grading!.assertions.find((a) => a.kind === "grouped_facts_final")!.grade).toBe("pass");
    for (const guard of lease.grading!.assertions.filter((a) => a.kind === "final_not_contains")) {
      expect(guard.grade).toBe("pass");
    }
    expect(lease.grade).toBe("pass");
    // The structured request-fact oracle refuses to pass it: the fact
    // occurrences are neither requests of a configured cue nor declared
    // reference forms — the scenario verdict stays unverified.
    const oracle = scanRequestVerdict(LEASE_UNDECLARED_REQUEST_FINAL, requestGuardSpec(manifest.cases.find((c) => c.id === "bounded-res-lease-boundary")!.assertions.find((a) => a.kind === "grouped_facts_final")!.value)!);
    expect(oracle.status).toBe("unverified");
    expect(oracle.ambiguous).toEqual(["holder session-foreign-fixture", "execution lease boundary"]);
    expect(scenarioVerdict(lease.grade, oracle)).toBe("unverified");
  });

  test("a schema/read final keeping the count sentence but with wrong field values or document results fails", async () => {
    const io = memoryIo();
    seedRun(io, manifest);
    const spawn = syntheticSpawn(io, manifest, { "bounded-res-schema-read": SCHEMA_WRONG_RESULTS_FINAL });
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
    const units = Object.values(result.state.units);
    const schemaRead = units.find((u) => u.caseId === "bounded-res-schema-read")!;
    // The budget stays valid and the count sentence is present — but the
    // field list and the document values contradict the fixtures.
    expect(schemaRead.grading!.assertions.find((a) => a.kind === "calls_within")!.grade).toBe("pass");
    expect(schemaRead.grading!.assertions.find((a) => a.assertionId === "a-outcome")!.grade).toBe("pass");
    expect(schemaRead.grade).toBe("fail");
    expect(schemaRead.grading!.assertions.find((a) => a.assertionId === "a-schema-fields")!.grade).toBe("fail");
    expect(schemaRead.grading!.assertions.find((a) => a.assertionId === "a-issue-document")!.grade).toBe("fail");
  });

  test("a replay final claiming the retired phase fails as an incompatible receipt for a withheld trace", async () => {
    const io = memoryIo();
    seedRun(io, manifest);
    const spawn = syntheticSpawn(io, manifest, { "bounded-res-replay-partial": REPLAY_RETIRED_CLAIM_FINAL });
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
    const units = Object.values(result.state.units);
    const replay = units.find((u) => u.caseId === "bounded-res-replay-partial")!;
    // Valid budget, no writes, AND the corrected resume/next-action
    // sentences present — the incompatible `phase retired` receipt claim is
    // what the negative guard rejects.
    expect(replay.grading!.assertions.find((a) => a.kind === "calls_within")!.grade).toBe("pass");
    expect(replay.grading!.assertions.find((a) => a.kind === "mutation_withheld")!.grade).toBe("pass");
    expect(replay.grading!.assertions.find((a) => a.assertionId === "a-outcome")!.grade).toBe("pass");
    expect(replay.grading!.assertions.find((a) => a.assertionId === "a-next-action")!.grade).toBe("pass");
    expect(replay.grade).toBe("fail");
    expect(replay.grading!.assertions.find((a) => a.assertionId === "a-not-retired-claim")!.grade).toBe("fail");
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
