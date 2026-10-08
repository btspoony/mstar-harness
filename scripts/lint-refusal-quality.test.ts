import { applyAllowlist, countViolations, exitCodeFor, normalizeSnippet, parseAllowlist, scanSource, signatureFor } from "./lint-refusal-quality";

describe("refusal quality scanner", () => {
  test("finds missing cause codes and unreachable refusal-envelope recovery", () => {
    const source = `
      refusalEnvelope({ command: "x", status: "refused", exitCode: 1, message: "Cannot continue",
        recovery: "Run mstar execution restore-preview --path <path>" });
      refusalEnvelope({ command: "x", status: "refused", code: "MISSING_STATE", exitCode: 1,
        message: "Cannot continue", recovery: "Run mstar workflow --resume" });
    `;
    const findings = scanSource(source, "packages/engine/src/fixture.ts", {
      verbs: new Set(["workflow"]), flagsByVerb: new Map([["workflow", new Set(["--resume"])]]),
    });
    expect(findings.map((finding) => finding.classification)).toEqual([
      "missing-cause-code", "unreachable-recovery",
    ]);
  });

  test("accepts a refusal envelope with a supported recovery", () => {
    const source = `refusalEnvelope({ command: "x", status: "refused", code: "MISSING_STATE", exitCode: 1, message: "Cannot continue", recovery: "Run mstar workflow --resume" });`;
    expect(scanSource(source, "packages/engine/src/fixture.ts", {
      verbs: new Set(["workflow"]), flagsByVerb: new Map([["workflow", new Set(["--resume"])]]),
    })).toEqual([]);
  });

  test("ignores internal validators and accepts one-level structured refusals", () => {
    const source = `
      const code = "problem.missing";
      const recovery = "Run mstar workflow --resume";
      throw invalidInput("sessionId must be a string");
      out.push(violation(CODE_SCHEMA, "record must be an object"));
      throw new Error("internal invariant failed");
      refusalEnvelope({ command: "x", status: "refused", code, exitCode: 1, message: "Failure",
        ...(recovery === undefined ? {} : { recovery }) });
    `;
    expect(scanSource(source, "packages/engine/src/fixture.ts", {
      verbs: new Set(["workflow"]), flagsByVerb: new Map([["workflow", new Set(["--resume"])]]),
    })).toEqual([]);
  });

  test("matches the longest nested command before its parent verb", () => {
    const source = `recoveryRefusal("unauthorized", "supply workflow recover-coordinator --attestation <file>");`;
    const findings = scanSource(source, "packages/engine/src/fixture.ts", {
      verbs: new Set(["workflow", "workflow recover-coordinator"]),
      flagsByVerb: new Map([
        ["workflow", new Set<string>()],
        ["workflow recover-coordinator", new Set(["--attestation"])],
      ]),
    });
    expect(findings).toEqual([]);
  });

  test("checks a literal CLI reference without an action keyword", () => {
    const source = `refusalEnvelope({ command: "x", status: "refused", code: "x.bad", exitCode: 1, message: "x", recovery: "mstar nonexistent --bad" });`;
    expect(scanSource(source, "packages/commands/src/fixture.ts", {
      verbs: new Set(["workflow"]), flagsByVerb: new Map([["workflow", new Set(["--resume"])]]),
    }).map((finding) => finding.classification)).toEqual(["unreachable-recovery"]);
  });

  test("rejects unsupported subcommands after a valid parent verb", () => {
    const source = `refusalEnvelope({ command: "x", status: "refused", code: "x.bad", exitCode: 1, message: "x", recovery: "Run mstar workflow nonexistent" });`;
    expect(scanSource(source, "packages/commands/src/fixture.ts", {
      verbs: new Set(["workflow"]), flagsByVerb: new Map([["workflow", new Set(["--resume"])]]),
    }).map((finding) => finding.classification)).toEqual(["unreachable-recovery"]);
  });

  test("rejects an unsupported command even when another recovery command is valid", () => {
    const source = `refusalEnvelope({ command: "x", status: "refused", code: "x.bad", exitCode: 1, message: "x", recovery: "Run mstar workflow --resume; or run mstar nonexistent --bad" });`;
    expect(scanSource(source, "packages/commands/src/fixture.ts", {
      verbs: new Set(["workflow"]), flagsByVerb: new Map([["workflow", new Set(["--resume"])]]),
    }).map((finding) => finding.classification)).toEqual(["unreachable-recovery"]);
  });


  test("rejects bare action-command alternatives after an explicit command", () => {
    const source = `refusalEnvelope({ command: "x", status: "refused", code: "x.bad", exitCode: 1, message: "x", recovery: "Run mstar workflow --resume; or run nonexistent --bad" });`;
    expect(scanSource(source, "packages/commands/src/fixture.ts", {
      verbs: new Set(["workflow"]), flagsByVerb: new Map([["workflow", new Set(["--resume"])]]),
    }).map((finding) => finding.classification)).toEqual(["unreachable-recovery"]);
  });

  test("accepts a supported positional argument after a command verb", () => {
    const source = `refusalEnvelope({ command: "schema", status: "refused", code: "schema.invalid", exitCode: 1, message: "x", recovery: "Run mstar schema ExampleType" });`;
    expect(scanSource(source, "packages/commands/src/fixture.ts", {
      verbs: new Set(["schema"]),
      flagsByVerb: new Map([["schema", new Set<string>()]]),
      positionalsByVerb: new Map([["schema", [{ key: "type", variadic: false }]]]),
    }).map((finding) => finding.classification)).toEqual([]);
  });
  test("one allowlist signature suppresses repeated identical occurrences", () => {
    const snippet = `refusalEnvelope({ code: "x.bad" })`;
    const findings = [1, 8].map((line) => ({
      file: "packages/commands/src/fixture.ts", line, column: 1, classification: "missing-recovery" as const,
      reason: "missing recovery", snippet,
    }));
    const allowlist = [{
      signature: signatureFor("missing-recovery", "packages/commands/src/fixture.ts", snippet),
      justification: "Tracked structured refusal cleanup.", trackingIssue: "I-000434",
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
      { file: "scripts/a.ts", line: 3, column: 1, classification: "unreachable-recovery" as const, reason: "y", snippet: "other()" },
    ];
    const allowlist = [{
      signature: signatureFor("missing-recovery", "scripts/a.ts", "same()"),
      justification: "Tracked issue.", trackingIssue: "I-000435",
    }];
    const result = applyAllowlist(findings, allowlist, "/repo");
    expect(countViolations(result.findings)).toBe(1);
    expect(exitCodeFor(result.findings, result.stale)).toBe(1);
  });

  test("rejects malformed allowlist entries and duplicate signatures", () => {
    expect(() => parseAllowlist(JSON.stringify([{ signature: "bad", justification: "reason", trackingIssue: "I-000434" }]))).toThrow(/signature/i);
    expect(() => parseAllowlist(JSON.stringify([{ signature: "missing-recovery:scripts/a.ts:123456789abc", justification: " ", trackingIssue: "I-000434" }]))).toThrow(/justification/i);
    const entry = {
      signature: "missing-recovery:scripts/a.ts:123456789abc",
      justification: "Tracked issue.", trackingIssue: "I-000434",
    };
    expect(() => parseAllowlist(JSON.stringify([entry, entry]))).toThrow(/duplicate/i);
  });

  test("normalizes snippet whitespace for stable allowlist signatures", () => {
    expect(normalizeSnippet("  foo(  bar );  ")).toBe("foo( bar );");
    expect(signatureFor("missing-cause-code", "scripts/file.ts", "foo(  bar );"))
      .toBe(signatureFor("missing-cause-code", "scripts/file.ts", " foo( bar ); "));
  });
});
