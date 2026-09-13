/**
 * Engine SDD evidence contract tests — pure schema validation, artifact
 * verification, input fingerprinting and reuse assessment (values in,
 * decisions out; the module under test performs no filesystem, process or
 * network access).
 *
 * Enforced distinctions:
 * - integrity (retained artifacts match recorded facts) stays separate from
 *   outcome (what the recorded child did), from applicability (may this
 *   evidence still back the current declared inputs) and from coverage
 *   (always review-required, never machine-decided).
 * - A complete failed run is valid failure evidence: integrity passes while
 *   the reported outcome stays failed.
 * - Applicability follows one fixed first-match order: integrity failure,
 *   absent target, unknown/unstable/repository/coverage conditions, then
 *   failed outcome, and only then a known-difference comparison.
 * - Provenance-only facts (head, branch, dirty state, tool resolve path)
 *   never change the input digest; tested bytes, tool content and selected
 *   environment values do.
 * - All fixtures are synthetic; ids, paths and hashes model the record
 *   format only.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assessSddEvidenceReuse,
  evidenceInputDigest,
  validateSddEvidenceRecord,
  verifySddEvidence,
  type EvidenceArtifactFact,
  type EvidenceCoverage,
  type EvidenceExpectation,
  type EvidenceInputEntry,
  type EvidenceInputSnapshot,
  type EvidenceToolFingerprint,
  type SddEvidenceRecord,
} from "../src/evidence.js";
import type { SddExecutionContext } from "../src/sdd.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// Fixed capture ceilings a retained record must carry.
const V1_LIMITS = Object.freeze({
  timeoutMs: 600000,
  maxLogBytesPerStream: 8388608,
  maxInputBytes: 536870912,
  maxInputEntries: 10000,
  maxInputMs: 30000,
  maxSnapshotBytes: 2097152,
});

const RUN_ID = "0b9e6c1e-7a1b-4c2a-9d3e-1f2a3b4c5d6e";
const HEAD_BASE = "a".repeat(40);
const HEAD_COMMITTED = "b".repeat(40);
const COMMON_DIR = "/control/harness/evidence-fixtures/common";
const OUT_HASH = sha256("stdout body");
const ERR_HASH = sha256("stderr body");

function context(overrides: Partial<SddExecutionContext> = {}): SddExecutionContext {
  return {
    planId: "plan-fixture",
    controlHarnessRoot: "/control/harness",
    featureCwd: "/feature/wt",
    workingBranch: "feature/plan-fixture",
    planFile: "/control/harness/plans/plan-fixture.md",
    sddDir: "/control/harness/sdd/plan-fixture",
    ...overrides,
  };
}

function coverage(overrides: Partial<EvidenceCoverage> = {}): EvidenceCoverage {
  return {
    acIds: ["AC-1"],
    behavior: "unit counter increments exactly once per run",
    declaration: "reviewed",
    sourceRationale: "declared source roots cover the tested module",
    dependencyRationale: "lockfile-only dependency scope was reviewed",
    runtimeRationale: "pinned interpreter and tool package were reviewed",
    environmentRationale: "selected environment keys cover the runtime input",
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    context: context(),
    taskId: "task-alpha",
    coverage: coverage(),
    inputs: [{ path: "src", kind: "directory", purpose: "source" }],
    environmentKeys: ["CI", "NODE_ENV"],
    ...overrides,
  };
}

function fileEntry(overrides: Partial<EvidenceInputEntry> = {}): EvidenceInputEntry {
  return {
    path: "src/alpha.ts",
    kind: "file",
    sha256: sha256("alpha v1"),
    bytes: 9,
    executable: false,
    linkText: null,
    resolvedRelativePath: null,
    error: null,
    ...overrides,
  };
}

function tool(overrides: Partial<EvidenceToolFingerprint> = {}): EvidenceToolFingerprint {
  return {
    requested: "bun",
    resolvedPath: "/feature/wt/tool/bin/bun",
    sha256: sha256("tool bytes"),
    bytes: 10,
    platform: "linux",
    arch: "x64",
    runnerRuntimeVersion: "node=v22.0.0",
    error: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<EvidenceInputSnapshot> = {}): EvidenceInputSnapshot {
  const base = {
    repoCommonDir: COMMON_DIR,
    head: HEAD_BASE,
    branch: "feature/plan-fixture",
    dirty: false,
    dirtyStatusSha256: sha256("status -z"),
    entries: [fileEntry()],
    tool: tool(),
    environment: { CI: "1", NODE_ENV: "test" } as EvidenceInputSnapshot["environment"],
    unknowns: [] as string[],
    stable: true,
    digest: "",
    ...overrides,
  };
  return { ...base, digest: evidenceInputDigest(base) };
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "mstar.sdd-evidence/v1",
    producer: { name: "mstar-harness", version: "0.0.0-fixture" },
    runId: RUN_ID,
    request: request(),
    command: { argv: ["bun", "test", "unit.spec.ts"], cwd: "/feature/wt" },
    startedAt: "2026-09-12T10:00:00.000Z",
    endedAt: "2026-09-12T10:00:05.000Z",
    state: "finished",
    outcome: { kind: "exit", code: 0 },
    before: snapshot(),
    after: snapshot(),
    logs: {
      stdout: { path: "stdout.log", bytes: 11, sha256: OUT_HASH, truncated: false },
      stderr: { path: "stderr.log", bytes: 11, sha256: ERR_HASH, truncated: false },
    },
    limits: { ...V1_LIMITS },
    captureErrors: [],
    counts: null,
    ...overrides,
  };
}

function runningRecord(): Record<string, unknown> {
  return record({
    state: "running",
    outcome: { kind: "running" },
    endedAt: null,
    after: null,
    logs: {
      stdout: { path: "stdout.log", bytes: 0, sha256: null, truncated: false },
      stderr: { path: "stderr.log", bytes: 0, sha256: null, truncated: false },
    },
  });
}

function fact(path: "stdout.log" | "stderr.log", overrides: Partial<EvidenceArtifactFact> = {}): EvidenceArtifactFact {
  return { path, state: "regular", bytes: 11, sha256: path === "stdout.log" ? OUT_HASH : ERR_HASH, ...overrides };
}

const fullFacts = (): EvidenceArtifactFact[] => [fact("stdout.log"), fact("stderr.log")];

const EXPECTED: EvidenceExpectation = { planId: "plan-fixture", taskId: "task-alpha", runId: RUN_ID };

const codesOf = (gate: { violations: { code: string }[] }): string[] => gate.violations.map((v) => v.code);
const messagesOf = (gate: { violations: { message: string }[] }): string[] => gate.violations.map((v) => v.message);

describe("validateSddEvidenceRecord", () => {
  test("accepts a genuine finished record and a running record shape", () => {
    const finished = validateSddEvidenceRecord(record());
    expect(finished.ok).toBe(true);
    expect(finished.violations).toEqual([]);
    expect(finished.hardBlocked).toBeUndefined();
    expect(validateSddEvidenceRecord(runningRecord()).ok).toBe(true);
  });

  test("rejects malformed and unknown schema versions and non-object input", () => {
    for (const bad of ["mstar.sdd-evidence/v2", "garbage", 17]) {
      const gate = validateSddEvidenceRecord(record({ schema: bad }));
      expect(gate.ok).toBe(false);
      expect(codesOf(gate)).toContain("evidence.schema");
    }
    for (const junk of [null, 42, "x", [], true]) {
      const gate = validateSddEvidenceRecord(junk);
      expect(gate.ok).toBe(false);
      expect(codesOf(gate)).toEqual(["evidence.schema"]);
    }
  });

  test("rejects unknown keys and missing required keys", () => {
    expect(messagesOf(validateSddEvidenceRecord(record({ extraTopLevel: true }))).join(" ")).toContain("unknown");
    expect(validateSddEvidenceRecord(record({ counts: 3 })).ok).toBe(false);
    const req = request();
    delete (req as Record<string, unknown>).environmentKeys;
    expect(codesOf(validateSddEvidenceRecord(record({ request: req })))).toContain("evidence.schema");
    expect(validateSddEvidenceRecord(record({ request: req })).ok).toBe(false);
    expect(validateSddEvidenceRecord(record({ request: request({ inputs: [] }) })).ok).toBe(false);
  });

  test("rejects invalid state transitions", () => {
    const cases: Record<string, unknown>[] = [
      record({ state: "running", outcome: { kind: "running" }, endedAt: "2026-09-12T10:00:05.000Z", after: null }),
      record({ state: "running", outcome: { kind: "running" }, endedAt: null, after: snapshot() }),
      record({ state: "running", outcome: { kind: "exit", code: 0 }, endedAt: null, after: null }),
      record({ state: "finished", outcome: { kind: "exit", code: 0 }, endedAt: null }),
      record({ state: "finished", outcome: { kind: "exit", code: 0 }, after: null }),
      record({ state: "finished", outcome: { kind: "running" } }),
      record({ startedAt: "2026-09-12T10:00:05.000Z", endedAt: "2026-09-12T10:00:00.000Z" }),
    ];
    for (const bad of cases) {
      const gate = validateSddEvidenceRecord(bad);
      expect(gate.ok).toBe(false);
      expect(codesOf(gate)).toContain("evidence.schema");
    }
  });

  test("requires environmentKeys: omission fails schema while explicit empty stays representable", () => {
    const omitted = request();
    delete omitted.environmentKeys;
    expect(validateSddEvidenceRecord(record({ request: omitted })).ok).toBe(false);

    const empty = record({
      request: request({ environmentKeys: [] }),
      before: snapshot({ environment: {} }),
      after: snapshot({ environment: {} }),
    });
    expect(validateSddEvidenceRecord(empty).ok).toBe(true);
  });

  test("rejects duplicate entry paths and malformed entry facts", () => {
    const dup = record({
      after: snapshot({ entries: [fileEntry(), fileEntry({ path: "src/alpha.ts", sha256: sha256("other") })] }),
    });
    expect(codesOf(validateSddEvidenceRecord(dup))).toContain("evidence.schema");
    const badEntries: Partial<EvidenceInputEntry>[] = [
      { kind: "file", sha256: null, bytes: 9, executable: false },
      { kind: "directory", sha256: null, bytes: 5, executable: null },
      { kind: "unknown", sha256: null, bytes: null, executable: null, linkText: null, resolvedRelativePath: null, error: null },
      { kind: "symlink", sha256: null, bytes: null, executable: null, linkText: null, resolvedRelativePath: null, error: "dangling" },
      { kind: "symlink", sha256: null, bytes: 9, executable: false, linkText: "../x.ts", resolvedRelativePath: "x.ts", error: null },
    ];
    for (const patch of badEntries) {
      const snap = snapshot({ entries: [{ ...fileEntry(), ...patch }] });
      expect(validateSddEvidenceRecord(record({ after: snap })).ok).toBe(false);
    }
  });

  test("rejects tool fingerprints that mix hash presence with error state", () => {
    const withError = record({ after: snapshot({ tool: tool({ error: "hash budget exhausted" }) }) });
    expect(validateSddEvidenceRecord(withError).ok).toBe(false);
    const withoutError = record({ after: snapshot({ tool: tool({ sha256: null, bytes: null, error: null }) }) });
    expect(validateSddEvidenceRecord(withoutError).ok).toBe(false);
  });

  test("rejects environment key drift between request and snapshots", () => {
    const missing = record({ after: snapshot({ environment: { CI: "1" } }) });
    expect(validateSddEvidenceRecord(missing).ok).toBe(false);
    const extra = record({ after: snapshot({ environment: { CI: "1", NODE_ENV: "test", TZ: "UTC" } }) });
    expect(validateSddEvidenceRecord(extra).ok).toBe(false);
  });

  test("recomputed digest rejects content tampering with a stale digest", () => {
    const tampered = snapshot();
    tampered.entries[0] = { ...tampered.entries[0], bytes: 999 };
    const gate = validateSddEvidenceRecord(record({ after: tampered }));
    expect(gate.ok).toBe(false);
    expect(codesOf(gate)).toContain("evidence.schema");
  });

  test("checks command cwd against the recorded context", () => {
    const gate = validateSddEvidenceRecord(record({ command: { argv: ["bun"], cwd: "/elsewhere" } }));
    expect(gate.ok).toBe(false);
    expect(codesOf(gate)).toContain("evidence.schema");
  });

  test("accepts an otherwise-valid record whose argv carries an empty-string element", () => {
    // A literal empty argument is legal argv bytes (e.g. `grep "" file`);
    // elements are bounded by the size limits only, never by nonemptiness.
    const gate = validateSddEvidenceRecord(record({ command: { argv: ["grep", "", "unit.spec.ts"], cwd: "/feature/wt" } }));
    expect(gate.ok).toBe(true);
    expect(gate.violations).toEqual([]);
  });

  test("enforces fixed capture limits and timeout agreement", () => {
    expect(validateSddEvidenceRecord(record({ limits: { ...V1_LIMITS, maxInputBytes: 1 } })).ok).toBe(false);
    expect(validateSddEvidenceRecord(record({ limits: { ...V1_LIMITS, timeoutMs: 100 } })).ok).toBe(false);
    const override = record({
      request: request({ timeoutMs: 5000 }),
      limits: { ...V1_LIMITS, timeoutMs: 5000 },
    });
    expect(validateSddEvidenceRecord(override).ok).toBe(true);
  });

  test("validates identifier, time, oid and path shapes", () => {
    const cases: Record<string, unknown>[] = [
      record({ runId: "0b9e6c1e-7a1b-4c2a-cd3e-1f2a3b4c5d6e" }),
      record({ runId: RUN_ID.toUpperCase() }),
      record({ startedAt: "not-a-time" }),
      record({ request: request({ taskId: "a/b" }) }),
      record({ request: request({ context: context({ planId: "a/b" }) }) }),
      record({ request: request({ coverage: coverage({ behavior: "x".repeat(4097) }) }) }),
      record({ before: snapshot({ head: "A".repeat(40) }) }),
      record({ before: snapshot({ head: "a".repeat(39) }) }),
      record({ logs: { stdout: { path: "stderr.log", bytes: 11, sha256: OUT_HASH, truncated: false }, stderr: { path: "stderr.log", bytes: 11, sha256: ERR_HASH, truncated: false } } }),
    ];
    for (const bad of cases) {
      const gate = validateSddEvidenceRecord(bad);
      expect(gate.ok).toBe(false);
      expect(codesOf(gate)).toContain("evidence.schema");
    }
  });
});

describe("verifySddEvidence", () => {
  test("accepts complete evidence for a genuine exit7 failure", () => {
    const gate = verifySddEvidence(record({ outcome: { kind: "exit", code: 7 } }), fullFacts(), EXPECTED);
    expect(gate.ok).toBe(true);
    expect(gate.violations).toEqual([]);
  });

  test("rejects schema-invalid records before identity and artifact checks", () => {
    const gate = verifySddEvidence(record({ schema: "mstar.sdd-evidence/v0" }), fullFacts(), EXPECTED);
    expect(gate.ok).toBe(false);
    expect(codesOf(gate)).toEqual(["evidence.schema"]);
  });

  test("reports identity mismatches on plan, task, run and sdd dir composition", () => {
    const cases: [EvidenceExpectation, Record<string, unknown>][] = [
      [{ ...EXPECTED, runId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }, {}],
      [{ ...EXPECTED, taskId: "task-beta" }, {}],
      [{ ...EXPECTED, planId: "plan-other" }, {}],
      [EXPECTED, { request: request({ context: context({ sddDir: "/control/harness/sdd/other-plan" }) }) }],
      [EXPECTED, { request: request({ context: context({ sddDir: "/control/harness/sdd2/plan-fixture" }) }) }],
      [EXPECTED, { request: request({ context: context({ sddDir: "/other/harness/sdd/plan-fixture" }) }) }],
    ];
    for (const [expected, patch] of cases) {
      const gate = verifySddEvidence(record(patch), fullFacts(), expected);
      expect(gate.ok).toBe(false);
      expect(codesOf(gate)).toContain("evidence.identity");
    }
  });

  test("requires exactly one fact per fixed log slot", () => {
    expect(codesOf(verifySddEvidence(record(), [fact("stdout.log")], EXPECTED))).toContain("evidence.artifact.missing");
    expect(codesOf(verifySddEvidence(record(), [fact("stdout.log"), fact("stdout.log"), fact("stderr.log")], EXPECTED))).toContain("evidence.artifact.type");
    expect(codesOf(verifySddEvidence(record(), [fact("stdout.log"), fact("stderr.log"), { path: "other.log", state: "regular", bytes: 1, sha256: OUT_HASH }], EXPECTED))).toContain("evidence.schema");
    expect(verifySddEvidence(record(), "junk" as unknown as EvidenceArtifactFact[], EXPECTED).ok).toBe(false);
  });

  test("rejects nonregular log artifacts", () => {
    expect(codesOf(verifySddEvidence(record(), [fact("stdout.log", { state: "symlink" }), fact("stderr.log")], EXPECTED))).toContain("evidence.artifact.type");
    expect(codesOf(verifySddEvidence(record(), [fact("stdout.log", { state: "other" }), fact("stderr.log")], EXPECTED))).toContain("evidence.artifact.type");
    expect(codesOf(verifySddEvidence(record(), [fact("stdout.log", { state: "missing" }), fact("stderr.log")], EXPECTED))).toContain("evidence.artifact.missing");
  });

  test("detects hash and size alterations", () => {
    const hashGate = verifySddEvidence(record(), [fact("stdout.log", { sha256: sha256("tampered") }), fact("stderr.log")], EXPECTED);
    expect(codesOf(hashGate)).toContain("evidence.artifact.hash");
    const sizeGate = verifySddEvidence(record(), [fact("stdout.log", { bytes: 12 }), fact("stderr.log")], EXPECTED);
    expect(codesOf(sizeGate)).toContain("evidence.artifact.size");
    const oversized = verifySddEvidence(
      record(),
      [fact("stdout.log", { bytes: V1_LIMITS.maxLogBytesPerStream + 1, sha256: null }), fact("stderr.log")],
      EXPECTED,
    );
    expect(codesOf(oversized)).toContain("evidence.artifact.size");
    expect(codesOf(oversized)).toContain("evidence.artifact.hash");
  });

  test("reports truncated, running and capture-error records as incomplete", () => {
    const truncated = record({ logs: { stdout: { path: "stdout.log", bytes: 11, sha256: OUT_HASH, truncated: true }, stderr: { path: "stderr.log", bytes: 11, sha256: ERR_HASH, truncated: false } } });
    expect(codesOf(verifySddEvidence(truncated, fullFacts(), EXPECTED))).toContain("evidence.incomplete");
    expect(codesOf(verifySddEvidence(runningRecord(), fullFacts(), EXPECTED))).toContain("evidence.incomplete");
    const captureError = record({ captureErrors: ["capture.drain-incomplete"] });
    expect(codesOf(verifySddEvidence(captureError, fullFacts(), EXPECTED))).toContain("evidence.incomplete");
    expect(verifySddEvidence(captureError, fullFacts(), EXPECTED).ok).toBe(false);
  });
});

describe("evidenceInputDigest", () => {
  test("is order-insensitive for entries and normalizes unknowns", () => {
    const a = snapshot({ entries: [fileEntry(), fileEntry({ path: "src/beta.ts", sha256: sha256("beta") })], unknowns: ["probe late", "probe early"] });
    const b = snapshot({ entries: [fileEntry({ path: "src/beta.ts", sha256: sha256("beta") }), fileEntry()], unknowns: ["probe early", "probe late", "probe early"] });
    expect(evidenceInputDigest(a)).toBe(evidenceInputDigest(b));
  });

  test("excludes provenance facts and the resolved tool path from the fingerprint", () => {
    const base = snapshot();
    const variants: Partial<EvidenceInputSnapshot>[] = [
      { repoCommonDir: "/elsewhere/common" },
      { head: HEAD_COMMITTED },
      { branch: "main" },
      { dirty: true },
      { dirtyStatusSha256: sha256("other") },
      { tool: tool({ resolvedPath: "/new-checkout/tool/bin/bun" }) },
    ];
    for (const patch of variants) {
      expect(evidenceInputDigest({ ...base, ...patch })).toBe(evidenceInputDigest(base));
    }
    expect(evidenceInputDigest({ ...base, stable: false })).not.toBe(evidenceInputDigest(base));
    expect(evidenceInputDigest({ ...base, entries: [fileEntry({ bytes: 10 })] })).not.toBe(evidenceInputDigest(base));
  });

  test("throws TypeError on out-of-contract direct input", () => {
    expect(() => evidenceInputDigest(null as unknown as EvidenceInputSnapshot)).toThrow(TypeError);
    expect(() => evidenceInputDigest({} as unknown as EvidenceInputSnapshot)).toThrow(TypeError);
    // A cycle inside a projected field forces unbounded nesting.
    const cyclic = snapshot();
    (cyclic.entries[0] as unknown as Record<string, unknown>).sha256 = cyclic.entries[0];
    expect(() => evidenceInputDigest(cyclic)).toThrow(TypeError);
  });
});

describe("assessSddEvidenceReuse", () => {
  test("maps recorded outcomes independently of integrity", () => {
    const cases: [Record<string, unknown>, EvidenceAssessment["outcome"], boolean][] = [
      [record({ outcome: { kind: "exit", code: 0 } }), "passed", true],
      [record({ outcome: { kind: "exit", code: 7 } }), "failed", true],
      [record({ outcome: { kind: "spawn-error", code: "ENOENT" } }), "failed", true],
      [record({ outcome: { kind: "signal", signal: "SIGKILL" } }), "incomplete", true],
      [record({ outcome: { kind: "timeout" } }), "incomplete", true],
      [record({ outcome: { kind: "interrupted", signal: "SIGINT" } }), "incomplete", true],
      [runningRecord(), "incomplete", false],
    ];
    for (const [patch, expectedOutcome, integrityOk] of cases) {
      const assessment = assessSddEvidenceReuse(patch, integrityOk ? fullFacts() : [], EXPECTED);
      expect(assessment.outcome).toBe(expectedOutcome);
      expect(assessment.coverage).toBe("review-required");
    }
  });

  test("no-target exit7 failure is failed and not-assessed with integrity intact", () => {
    const assessment = assessSddEvidenceReuse(record({ outcome: { kind: "exit", code: 7 } }), fullFacts(), EXPECTED);
    expect(assessment.integrity.ok).toBe(true);
    expect(assessment.outcome).toBe("failed");
    expect(assessment.applicability).toBe("not-assessed");
    expect(assessment.changedInputs).toEqual([]);
    expect(assessment.reasons).toEqual(["outcome.failed", "target.absent"]);
  });

  test("failed and incomplete outcomes with a supplied target stay uncertain under rule 4", () => {
    const failed = assessSddEvidenceReuse(record({ outcome: { kind: "exit", code: 7 } }), fullFacts(), EXPECTED, snapshot());
    expect(failed.outcome).toBe("failed");
    expect(failed.applicability).toBe("uncertain");
    expect(failed.reasons).toEqual(["outcome.failed"]);
    const incomplete = assessSddEvidenceReuse(record({ outcome: { kind: "timeout" } }), fullFacts(), EXPECTED, snapshot());
    expect(incomplete.outcome).toBe("incomplete");
    expect(incomplete.applicability).toBe("uncertain");
    expect(incomplete.reasons).toEqual(["outcome.incomplete"]);
  });

  test("no-target unknown coverage stays not-assessed with a coverage reason", () => {
    const patch = record({ request: request({ coverage: coverage({ declaration: "unknown" }) }) });
    const assessment = assessSddEvidenceReuse(patch, fullFacts(), EXPECTED);
    expect(assessment.applicability).toBe("not-assessed");
    expect(assessment.reasons).toContain("coverage.unknown");
  });

  test("unknown declaration with a supplied target stays uncertain under rule 3", () => {
    const rec = record({ request: request({ coverage: coverage({ declaration: "unknown" }) }) });
    const assessment = assessSddEvidenceReuse(rec, fullFacts(), EXPECTED, snapshot());
    expect(assessment.integrity.ok).toBe(true);
    expect(assessment.outcome).toBe("passed");
    expect(assessment.applicability).toBe("uncertain");
    expect(assessment.reasons).toEqual(["coverage.unknown"]);
  });

  test("damaged log with no target keeps the passed outcome but reports uncertain", () => {
    const assessment = assessSddEvidenceReuse(record(), [fact("stdout.log", { sha256: sha256("tampered") }), fact("stderr.log")], EXPECTED);
    expect(assessment.integrity.ok).toBe(false);
    expect(assessment.outcome).toBe("passed");
    expect(assessment.applicability).toBe("uncertain");
    expect(assessment.reasons).toEqual(["evidence.integrity", "target.absent"]);
  });

  test("dirty tested bytes committed unchanged remain a candidate", () => {
    const dirty = record({
      before: snapshot({ dirty: true, dirtyStatusSha256: sha256("wip") }),
      after: snapshot({ dirty: true, dirtyStatusSha256: sha256("wip") }),
    });
    const target = snapshot({ dirty: false, head: HEAD_COMMITTED, dirtyStatusSha256: sha256("clean") });
    const assessment = assessSddEvidenceReuse(dirty, fullFacts(), EXPECTED, target);
    expect(assessment.applicability).toBe("candidate");
    expect(assessment.reasons).toEqual(["reuse.candidate"]);
    expect(assessment.changedInputs).toEqual([]);
  });

  test("a head-only commit outside declared inputs remains a candidate", () => {
    const target = snapshot({ head: HEAD_COMMITTED, branch: "main", dirty: false });
    const assessment = assessSddEvidenceReuse(record(), fullFacts(), EXPECTED, target);
    expect(assessment.applicability).toBe("candidate");
  });

  test("later relevant additions under declared roots are changed with specific paths", () => {
    const inputs = [
      { path: "src", kind: "directory", purpose: "source" },
      { path: "config.json", kind: "file", purpose: "config" },
      { path: "fixtures", kind: "directory", purpose: "fixture" },
      { path: "vendor/pkg", kind: "directory", purpose: "dependency" },
    ];
    const entries = [
      fileEntry(),
      fileEntry({ path: "config.json", sha256: sha256("config"), bytes: 6 }),
      fileEntry({ path: "fixtures/case.txt", sha256: sha256("case"), bytes: 4 }),
      fileEntry({ path: "vendor/pkg/index.js", sha256: sha256("pkg"), bytes: 3 }),
    ];
    const base = record({ request: request({ inputs }), before: snapshot({ entries }), after: snapshot({ entries }) });
    const variants: EvidenceInputEntry[][] = [
      [...entries, fileEntry({ path: "src/extra.ts", sha256: sha256("extra"), bytes: 5 })],
      entries.map((e) => (e.path === "config.json" ? fileEntry({ path: "config.json", sha256: sha256("config v2"), bytes: 8 }) : e)),
      [...entries, fileEntry({ path: "fixtures/new-case.txt", sha256: sha256("new-case"), bytes: 8 })],
      [...entries, fileEntry({ path: "vendor/pkg/new.js", sha256: sha256("new-pkg"), bytes: 9 })],
    ];
    const expectedPaths = ["src/extra.ts", "config.json", "fixtures/new-case.txt", "vendor/pkg/new.js"];
    for (const [index, targetEntries] of variants.entries()) {
      const target = snapshot({ entries: targetEntries });
      const assessment = assessSddEvidenceReuse(base, fullFacts(), EXPECTED, target);
      expect(assessment.applicability).toBe("changed");
      expect(assessment.reasons).toContain("input.changed");
      expect(assessment.changedInputs).toContain(expectedPaths[index]);
    }
  });

  test("unknown target states stay uncertain; an honest missing root is a known difference", () => {
    const variants: EvidenceInputSnapshot[] = [
      snapshot({ unknowns: ["input.limit.entries exceeded; pass stopped early"] }),
      snapshot({ entries: [fileEntry({ kind: "unknown", sha256: null, bytes: null, executable: null, error: "input unreadable" })] }),
      snapshot({ entries: [fileEntry({ path: "src/link.ts", kind: "symlink", sha256: null, bytes: null, executable: null, linkText: "../../outside/util.ts", resolvedRelativePath: null, error: "symlink target outside checkout" })] }),
      snapshot({ tool: tool({ sha256: null, bytes: null, error: "tool hash budget exhausted" }) }),
    ];
    for (const target of variants) {
      const assessment = assessSddEvidenceReuse(record(), fullFacts(), EXPECTED, target);
      expect(assessment.applicability).toBe("uncertain");
      expect(assessment.reasons).toContain("input.unknown");
    }
    const missingRoot = snapshot({ entries: [{ ...fileEntry(), path: "src", kind: "missing", sha256: null, bytes: null, executable: null, error: null }] });
    const changed = assessSddEvidenceReuse(record(), fullFacts(), EXPECTED, missingRoot);
    expect(changed.applicability).toBe("changed");
    expect(changed.changedInputs).toContain("src/alpha.ts");
  });

  test("a malformed target without snapshot fields is downgraded to unknown, not thrown", () => {
    // Carries entries/tool/environment but omits unknowns/stable/repoCommonDir/head:
    // out-of-contract shape, so the target lane must degrade instead of
    // letting a TypeError escape the public entry point.
    const malformed = {
      entries: [fileEntry()],
      tool: tool(),
      environment: { CI: "1", NODE_ENV: "test" },
    } as unknown as EvidenceInputSnapshot;
    const assessment = assessSddEvidenceReuse(record(), fullFacts(), EXPECTED, malformed);
    expect(assessment.integrity.ok).toBe(true);
    expect(assessment.outcome).toBe("passed");
    expect(assessment.applicability).toBe("uncertain");
    expect(assessment.reasons).toContain("input.unknown");
    expect(assessment.changedInputs).toEqual([]);
  });

  test("a different repository identity is uncertain and names the repository gap", () => {
    const target = snapshot({ repoCommonDir: "/another/checkout/common" });
    const assessment = assessSddEvidenceReuse(record(), fullFacts(), EXPECTED, target);
    expect(assessment.applicability).toBe("uncertain");
    expect(assessment.reasons).toContain("input.repository");
    expect(assessment.changedInputs).toContain("$repository");
  });

  test("tool and environment changes are visible while resolve-path-only drift is not", () => {
    const toolDigest = assessSddEvidenceReuse(record(), fullFacts(), EXPECTED, snapshot({ tool: tool({ sha256: sha256("new tool bytes") }) }));
    expect(toolDigest.applicability).toBe("changed");
    expect(toolDigest.changedInputs).toContain("$tool");
    const toolBytes = assessSddEvidenceReuse(record(), fullFacts(), EXPECTED, snapshot({ tool: tool({ bytes: 11 }) }));
    expect(toolBytes.applicability).toBe("changed");
    expect(toolBytes.changedInputs).toContain("$tool");
    const envChange = assessSddEvidenceReuse(record(), fullFacts(), EXPECTED, snapshot({ environment: { CI: "0", NODE_ENV: "test" } }));
    expect(envChange.applicability).toBe("changed");
    expect(envChange.changedInputs).toContain("$environment");
    const movedTool = assessSddEvidenceReuse(record(), fullFacts(), EXPECTED, snapshot({ tool: tool({ resolvedPath: "/new-checkout/tool/bin/bun" }) }));
    expect(movedTool.applicability).toBe("candidate");
  });

  test("unstable snapshots are uncertain even when tested bytes match", () => {
    const runUnstable = record({ after: snapshot({ stable: false }) });
    expect(assessSddEvidenceReuse(runUnstable, fullFacts(), EXPECTED, snapshot()).applicability).toBe("uncertain");
    const targetUnstable = assessSddEvidenceReuse(record(), fullFacts(), EXPECTED, snapshot({ stable: false }));
    expect(targetUnstable.applicability).toBe("uncertain");
    expect(targetUnstable.reasons).toContain("input.concurrent-change");
  });

  test("before/after movement with a target matching either side is uncertain, not changed", () => {
    const before = snapshot({ entries: [fileEntry({ sha256: sha256("v1"), bytes: 2 })] });
    const after = snapshot({ entries: [fileEntry({ sha256: sha256("v2"), bytes: 2 })] });
    const rec = record({ before, after });
    const matchesAfter = assessSddEvidenceReuse(rec, fullFacts(), EXPECTED, snapshot({ entries: [fileEntry({ sha256: sha256("v2"), bytes: 2 })] }));
    expect(matchesAfter.applicability).toBe("uncertain");
    expect(matchesAfter.reasons).toContain("input.concurrent-change");
    expect(matchesAfter.changedInputs).toContain("src/alpha.ts");
    const matchesBefore = assessSddEvidenceReuse(rec, fullFacts(), EXPECTED, before);
    expect(matchesBefore.applicability).toBe("uncertain");
    expect(matchesBefore.changedInputs).toContain("src/alpha.ts");
  });

  test("unknown target plus a known changed file reports uncertainty with the gap", () => {
    const target = snapshot({
      unknowns: ["target git probe failed"],
      entries: [fileEntry(), fileEntry({ path: "src/beta.ts", sha256: sha256("beta v2"), bytes: 8 })],
    });
    const rec = record({ after: snapshot({ entries: [fileEntry(), fileEntry({ path: "src/beta.ts", sha256: sha256("beta v1"), bytes: 7 })] }), before: snapshot({ entries: [fileEntry(), fileEntry({ path: "src/beta.ts", sha256: sha256("beta v1"), bytes: 7 })] }) });
    const assessment = assessSddEvidenceReuse(rec, fullFacts(), EXPECTED, target);
    expect(assessment.applicability).toBe("uncertain");
    expect(assessment.reasons).toContain("input.unknown");
    expect(assessment.changedInputs).toContain("src/beta.ts");
  });

  test("a stable successful run plus a later changed file is changed", () => {
    const target = snapshot({ entries: [fileEntry({ sha256: sha256("alpha v2"), bytes: 9 })] });
    const assessment = assessSddEvidenceReuse(record(), fullFacts(), EXPECTED, target);
    expect(assessment.applicability).toBe("changed");
    expect(assessment.reasons).toEqual(["input.changed"]);
    expect(assessment.changedInputs).toEqual(["src/alpha.ts"]);
  });

  test("symlink text and target identity changes are visible", () => {
    const linkEntry = (overrides: Partial<EvidenceInputEntry>): EvidenceInputEntry => ({
      path: "src/link.ts",
      kind: "symlink",
      sha256: sha256("util body"),
      bytes: 9,
      executable: false,
      linkText: "../shared/util.ts",
      resolvedRelativePath: "shared/util.ts",
      error: null,
      ...overrides,
    });
    const entries = [fileEntry(), linkEntry({})];
    const rec = record({ before: snapshot({ entries }), after: snapshot({ entries }) });
    const textChanged = assessSddEvidenceReuse(rec, fullFacts(), EXPECTED, snapshot({ entries: [fileEntry(), linkEntry({ linkText: "../shared/other.ts" })] }));
    expect(textChanged.applicability).toBe("changed");
    expect(textChanged.changedInputs).toContain("src/link.ts");
    const targetChanged = assessSddEvidenceReuse(rec, fullFacts(), EXPECTED, snapshot({ entries: [fileEntry(), linkEntry({ resolvedRelativePath: "shared/renamed.ts" })] }));
    expect(targetChanged.applicability).toBe("changed");
    expect(targetChanged.changedInputs).toContain("src/link.ts");
  });

  test("an explicit empty environment selection with a reviewed rationale stays assessable", () => {
    const rec = record({
      request: request({ environmentKeys: [] }),
      before: snapshot({ environment: {} }),
      after: snapshot({ environment: {} }),
    });
    expect(validateSddEvidenceRecord(rec).ok).toBe(true);
    expect(assessSddEvidenceReuse(rec, fullFacts(), EXPECTED, snapshot({ environment: {} })).applicability).toBe("candidate");
    const driftedEnv = assessSddEvidenceReuse(rec, fullFacts(), EXPECTED, snapshot({ environment: { CI: "1" } }));
    expect(driftedEnv.applicability).toBe("changed");
    expect(driftedEnv.changedInputs).toContain("$environment");
  });

  test("schema-invalid records yield unknown outcome and uncertain applicability", () => {
    const assessment = assessSddEvidenceReuse(record({ schema: "mstar.sdd-evidence/v9" }), fullFacts(), EXPECTED, snapshot());
    expect(assessment.outcome).toBe("unknown");
    expect(assessment.applicability).toBe("uncertain");
    expect(assessment.changedInputs).toEqual([]);
    expect(assessment.reasons).toEqual(["evidence.integrity"]);
  });
});
