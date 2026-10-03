/**
 * Engine SDD evidence contract tests — pure schema validation, artifact
 * verification, input fingerprinting and reuse assessment (values in,
 * decisions out; the module under test performs no filesystem, process or
 * network access).
 *
 * Enforced distinctions:
 * - Artifact identity, shape, path, existence, type and completeness checks
 *   stay separate from recorded outcome and applicability; content hashes
 *   are provenance rather than integrity evidence.
 * - A complete failed run is valid failure evidence: integrity passes while
 *   the reported outcome stays failed.
 * - Applicability follows one fixed first-match order: integrity failure,
 *   absent target, unknown/unstable/repository/coverage conditions, then
 *   failed outcome, and only then a known-difference comparison.
 * - Provenance-only facts (head, branch, dirty state, tool resolve path and
 *   content digests) never change input applicability; selected environment
 *   and semantic path-state facts do.
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

  test("accepts content edits while preserving record shape constraints", () => {
    const edited = snapshot();
    edited.entries[0] = { ...edited.entries[0], bytes: 999 };
    const gate = validateSddEvidenceRecord(record({ after: edited }));
    expect(gate.ok).toBe(true);
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

  test("artifact hash and size remain provenance while slot existence and type are checked", () => {
    const edited = verifySddEvidence(
      record(),
      [fact("stdout.log", { sha256: sha256("tampered"), bytes: 12 }), fact("stderr.log")],
      EXPECTED,
    );
    expect(edited.ok).toBe(true);
    expect(verifySddEvidence(
      record(),
      [fact("stdout.log", { bytes: V1_LIMITS.maxLogBytesPerStream + 1, sha256: null }), fact("stderr.log")],
      EXPECTED,
    ).ok).toBe(true);
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

  test("a log hash mismatch is provenance and does not affect reuse applicability", () => {
    const assessment = assessSddEvidenceReuse(record(), [fact("stdout.log", { sha256: sha256("tampered") }), fact("stderr.log")], EXPECTED);
    expect(assessment.integrity.ok).toBe(true);
    expect(assessment.outcome).toBe("passed");
    expect(assessment.applicability).toBe("not-assessed");
    expect(assessment.reasons).toEqual(["target.absent"]);
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
      [...entries, fileEntry({ path: "fixtures/new-case.txt", sha256: sha256("new-case"), bytes: 8 })],
      [...entries, fileEntry({ path: "vendor/pkg/new.js", sha256: sha256("new-pkg"), bytes: 9 })],
    ];
    const expectedPaths = ["src/extra.ts", "fixtures/new-case.txt", "vendor/pkg/new.js"];
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

  test("tool content digests are not applicability gates; environment selections still are", () => {
    const toolDigest = assessSddEvidenceReuse(record(), fullFacts(), EXPECTED, snapshot({ tool: tool({ sha256: sha256("new tool bytes") }) }));
    expect(toolDigest.applicability).toBe("candidate");
    expect(toolDigest.changedInputs).not.toContain("$tool");
    const toolBytes = assessSddEvidenceReuse(record(), fullFacts(), EXPECTED, snapshot({ tool: tool({ bytes: 11 }) }));
    expect(toolBytes.applicability).toBe("candidate");
    expect(toolBytes.changedInputs).not.toContain("$tool");
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

  test("digest-only before/after movement is not uncertain or changed", () => {
    const before = snapshot({ entries: [fileEntry({ sha256: sha256("v1"), bytes: 2 })] });
    const after = snapshot({ entries: [fileEntry({ sha256: sha256("v2"), bytes: 2 })] });
    const rec = record({ before, after });
    const matchesAfter = assessSddEvidenceReuse(rec, fullFacts(), EXPECTED, snapshot({ entries: [fileEntry({ sha256: sha256("v2"), bytes: 2 })] }));
    expect(matchesAfter.applicability).toBe("candidate");
    expect(matchesAfter.changedInputs).toEqual([]);
    const matchesBefore = assessSddEvidenceReuse(rec, fullFacts(), EXPECTED, before);
    expect(matchesBefore.applicability).toBe("candidate");
    expect(matchesBefore.changedInputs).toEqual([]);
  });
  test("before/after path-state movement stays uncertain when the target matches after", () => {
    const before = snapshot();
    const missing = {
      ...fileEntry(),
      kind: "missing" as const,
      sha256: null,
      bytes: null,
      executable: null,
      error: null,
    };
    const after = snapshot({ entries: [missing] });
    const rec = record({ before, after });
    const assessment = assessSddEvidenceReuse(rec, fullFacts(), EXPECTED, after);
    expect(assessment.applicability).toBe("uncertain");
    expect(assessment.reasons).toContain("input.concurrent-change");
    expect(assessment.changedInputs).toContain("src/alpha.ts");
  });

  test("before/after selected environment and runtime metadata movement stays uncertain when target matches after", () => {
    const before = snapshot();
    const after = snapshot({
      environment: { CI: "1", NODE_ENV: "production" },
      tool: tool({ runnerRuntimeVersion: "bun/2.1.0" }),
    });
    const rec = record({ before, after });
    const assessment = assessSddEvidenceReuse(rec, fullFacts(), EXPECTED, after);
    expect(assessment.applicability).toBe("uncertain");
    expect(assessment.reasons).toContain("input.concurrent-change");
    expect(assessment.changedInputs).toEqual(["$environment", "$tool"]);
  });

  test("unknown target plus digest-only drift reports uncertainty without a changed-content claim", () => {
    const target = snapshot({
      unknowns: ["target git probe failed"],
      entries: [fileEntry(), fileEntry({ path: "src/beta.ts", sha256: sha256("beta v2"), bytes: 8 })],
    });
    const rec = record({ after: snapshot({ entries: [fileEntry(), fileEntry({ path: "src/beta.ts", sha256: sha256("beta v1"), bytes: 7 })] }), before: snapshot({ entries: [fileEntry(), fileEntry({ path: "src/beta.ts", sha256: sha256("beta v1"), bytes: 7 })] }) });
    const assessment = assessSddEvidenceReuse(rec, fullFacts(), EXPECTED, target);
    expect(assessment.applicability).toBe("uncertain");
    expect(assessment.reasons).toContain("input.unknown");
    expect(assessment.changedInputs).toEqual([]);
  });

  test("file content digest drift does not change applicability", () => {
    const target = snapshot({ entries: [fileEntry({ sha256: sha256("alpha v2"), bytes: 29 })] });
    const assessment = assessSddEvidenceReuse(record(), fullFacts(), EXPECTED, target);
    expect(assessment.applicability).toBe("candidate");
    expect(assessment.reasons).toEqual(["reuse.candidate"]);
    expect(assessment.changedInputs).toEqual([]);
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
