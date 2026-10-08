import { applyAllowlist, countViolations, exitCodeFor, normalizeSnippet, parseAllowlist, scanSource, signatureFor, validateAllowlistEntries } from "./lint-refusal-quality";

describe("refusal quality scanner", () => {
  test("finds missing cause codes without enforcing recovery reachability", () => {
    const source = `
      refusalEnvelope({ command: "x", status: "refused", exitCode: 1, message: "Cannot continue",
        recovery: "Run mstar execution restore-preview --path <path>" });
      refusalEnvelope({ command: "x", status: "refused", code: "MISSING_STATE", exitCode: 1,
        message: "Cannot continue", recovery: "Run mstar workflow --resume" });
    `;
    const findings = scanSource(source, "packages/engine/src/fixture.ts");
    expect(findings.map((finding) => finding.classification)).toEqual(["missing-cause-code"]);
  });

  test("accepts a refusal envelope with a supported recovery", () => {
    const source = `refusalEnvelope({ command: "x", status: "refused", code: "MISSING_STATE", exitCode: 1, message: "Cannot continue", recovery: "Run mstar workflow --resume" });`;
    expect(scanSource(source, "packages/engine/src/fixture.ts")).toEqual([]);
  });

  test("ignores internal validators and flags an optional recovery branch", () => {
    const source = `
      const code = "problem.missing";
      const recovery = "Run mstar workflow --resume";
      throw invalidInput("sessionId must be a string");
      out.push(violation(CODE_SCHEMA, "record must be an object"));
      throw new Error("internal invariant failed");
      refusalEnvelope({ command: "x", status: "refused", code, exitCode: 1, message: "Failure",
        ...(recovery === undefined ? {} : { recovery }) });
    `;
    expect(scanSource(source, "packages/engine/src/fixture.ts").map(({ classification }) => classification)).toEqual(["missing-recovery"]);
  });

  test("one allowlist signature suppresses repeated identical occurrences", () => {
    const snippet = `refusalEnvelope({ code: "x.bad" })`;
    const findings = [1, 8].map((line) => ({
      file: "packages/commands/src/fixture.ts", line, column: 1, classification: "missing-recovery" as const,
      reason: "missing recovery", snippet,
    }));
    const allowlist = [{
      signature: signatureFor("missing-recovery", "packages/commands/src/fixture.ts", snippet),
      justification: "Tracked structured refusal cleanup.", trackingIssue: "SYNTH-REFUSAL-COHORT", expectedCount: 2,
    }];
    const result = applyAllowlist(findings, allowlist, "/repo");
    expect(result.findings.map((finding) => finding.classification)).toEqual(["allowlisted", "allowlisted"]);
    expect(result.used).toHaveLength(1);
    expect(countViolations(result.findings)).toBe(0);
    expect(exitCodeFor(result.findings, result.stale)).toBe(0);
  });

  test("an unallowlisted finding keeps the lint failing beside a matched signature", () => {
    const findings = [
      { file: "scripts/a.ts", line: 1, column: 1, classification: "missing-recovery" as const, reason: "x", snippet: "same()" },
      { file: "scripts/a.ts", line: 2, column: 1, classification: "missing-recovery" as const, reason: "x", snippet: "same()" },
      { file: "scripts/a.ts", line: 3, column: 1, classification: "missing-cause-code" as const, reason: "y", snippet: "other()" },
    ];
    const allowlist = [{
      signature: signatureFor("missing-recovery", "scripts/a.ts", "same()"),
      justification: "Tracked issue.", trackingIssue: "SYNTH-REACHABILITY-COHORT", expectedCount: 1,
    }];
    const result = applyAllowlist(findings, allowlist, "/repo");
    expect(countViolations(result.findings)).toBe(2);
    expect(exitCodeFor(result.findings, result.stale)).toBe(1);
  });

  test("rejects malformed allowlist entries and duplicate signatures", () => {
    expect(() => parseAllowlist(JSON.stringify([{ signature: "bad", justification: "reason", trackingIssue: "SYNTH-REFUSAL-COHORT" }]))).toThrow(/signature/i);
    expect(() => parseAllowlist(JSON.stringify([{ signature: "missing-recovery:scripts/a.ts:123456789abc", justification: " ", trackingIssue: "SYNTH-REFUSAL-COHORT" }]))).toThrow(/justification/i);
    const entry = {
      signature: "missing-recovery:scripts/a.ts:123456789abc",
      justification: "Tracked issue.", trackingIssue: "SYNTH-REFUSAL-COHORT",
    };
    expect(() => parseAllowlist(JSON.stringify([entry, entry]))).toThrow(/duplicate/i);
  });

  test("normalizes snippet whitespace for stable allowlist signatures", () => {
    expect(normalizeSnippet("  foo(  bar );  ")).toBe("foo( bar );");
    expect(signatureFor("missing-cause-code", "scripts/file.ts", "foo(  bar );"))
      .toBe(signatureFor("missing-cause-code", "scripts/file.ts", " foo( bar ); "));
  });

  test("requires nonempty cause and recovery strings", () => {
    const findings = scanSource(`
      refusalEnvelope({ code: "", status: "refused", recovery: "Run mstar status validate" });
      refusalEnvelope({ code: "valid.code", status: "refused", recovery: "" });
    `, "packages/engine/src/fixture.ts");
    expect(findings.map(({ classification }) => classification)).toEqual(["missing-cause-code", "missing-recovery"]);
  });

  test("each conditional recovery branch must provide nonempty recovery text", () => {
    const findings = scanSource(`
      refusalEnvelope({ code: "valid.code", status: "refused", ...(enabled ? { recovery: "Run mstar status validate" } : {}) });
      refusalEnvelope({ code: "valid.code", status: "refused", ...(enabled ? { recovery: "Run mstar status validate" } : { recovery: "" }) });
    `, "packages/engine/src/fixture.ts");
    expect(findings.map(({ classification }) => classification)).toEqual(["missing-recovery", "missing-recovery"]);
  });

  test("validates explicit command references in CoordinationError messages", () => {
    const findings = scanSource(`
      new CoordinationError("known.code", "Use mstar nonexistent --bad");
      new CoordinationError("known.code", "Use mstar status validate");
    `, "packages/engine/src/fixture.ts");
    expect(findings.map(({ classification }) => classification)).toEqual(["unreachable-recovery"]);
  });

  test("allowlist exemptions have a bounded occurrence count", () => {
    const snippet = "same()";
    const findings = [1, 2].map((line) => ({
      file: "scripts/a.ts", line, column: 1, classification: "missing-recovery" as const,
      reason: "missing recovery", snippet,
    }));
    const entry = {
      signature: signatureFor("missing-recovery", "scripts/a.ts", snippet),
      justification: "Tracked issue.", trackingIssue: "SYNTH-REFUSAL-COHORT", expectedCount: 1,
    };
    const result = applyAllowlist(findings, [entry], "/repo");
    expect(result.findings.map(({ classification }) => classification)).toEqual(["allowlisted", "missing-recovery"]);
    expect(countViolations(result.findings)).toBe(1);
  });

  test("rejects non-positive or non-integer allowlist occurrence bounds", () => {
    const signature = signatureFor("missing-recovery", "scripts/a.ts", "same()");
    for (const expectedCount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateAllowlistEntries([{
        signature, justification: "Tracked.", trackingIssue: "SYNTH", expectedCount,
      }])).toThrow(/expectedCount must be a positive integer/);
    }
  });

  test("flags empty recovery in a direct conditional branch", () => {
    const findings = scanSource(`
      refusalEnvelope({ code: "valid.code", status: "refused", recovery: enabled ? "Run mstar status validate" : "" });
    `, "packages/engine/src/fixture.ts");
    expect(findings.map(({ classification }) => classification)).toEqual(["missing-recovery"]);
  });

  test("correlates status and recovery alternatives with the same condition", () => {
    const findings = scanSource(`
      refusalEnvelope({
        code: "valid.code",
        status: usage ? "usage" : "refused",
        recovery: usage ? undefined : "Run mstar status validate",
      });
    `, "packages/engine/src/fixture.ts");
    expect(findings).toEqual([]);
  });

  test("checks calls to one-level same-file refusal wrappers using call-site arguments", () => {
    const findings = scanSource(`
      function refused(input: unknown) {
        return refusalEnvelope(input as RefusalInput);
      }
      refused({ command: "status", status: "refused", code: "status.blocked", message: "Blocked" });
      refused({ command: "status", status: "refused", code: "", message: "Bad", recovery: "Run mstar status validate" });
    `, "packages/commands/src/wrapper-fixture.ts");
    expect(findings.map(({ line, classification }) => [line, classification])).toEqual([
      [5, "missing-recovery"],
      [6, "missing-cause-code"],
    ]);
  });

  test("scans each whole conditional refusalEnvelope argument branch", () => {
    const findings = scanSource(`
      refusalEnvelope(flag
        ? { status: "refused", code: "", message: "Missing" }
        : { status: "refused", code: "valid.code", message: "Valid", recovery: "Run mstar status validate" });
    `, "packages/engine/src/fixture.ts");
    expect(findings.map(({ classification }) => classification)).toEqual(["missing-cause-code", "missing-recovery"]);
  });

  test("resolves code and recovery values in their function-local scopes", () => {
    const findings = scanSource(`
      function first() {
        const code = "";
        const recovery = "";
        refusalEnvelope({ status: "refused", code, message: "Missing", recovery });
      }
      function second() {
        const code = "valid.code";
        const recovery = "Run mstar status validate";
        refusalEnvelope({ status: "refused", code, message: "Valid", recovery });
      }
    `, "packages/engine/src/fixture.ts");
    expect(findings.map(({ classification }) => classification)).toEqual(["missing-cause-code", "missing-recovery"]);
  });
});
