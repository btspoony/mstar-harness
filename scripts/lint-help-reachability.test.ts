import { extractCliGrammar } from "./lint-refusal-quality";
import { scanDeclaredCapabilities, scanRecoveryText } from "./lint-help-reachability";

describe("help reachability lint", () => {
  const grammar = {
    verbs: new Set(["workflow", "workflow recover-coordinator"]),
    flagsByVerb: new Map([
      ["workflow", new Set(["--resume"])],
      ["workflow recover-coordinator", new Set(["--attestation"])],
    ]),
    optionsByVerb: new Map([
      ["workflow", [{ flags: ["--resume"], required: false, takesValue: false }]],
      ["workflow recover-coordinator", [{ flags: ["--attestation"], required: false, takesValue: true }]],
    ]),
  };
  const envelope = (recovery: string) => `refusalEnvelope({ command: "x", status: "refused", code: "NO_STATE", exitCode: 1, message: "Cannot continue", recovery: ${JSON.stringify(recovery)} });`;

  test("recovery naming an existing verb and flag passes", () => {
    expect(scanRecoveryText(envelope("Run mstar workflow --resume"), "packages/engine/src/fixture.ts", grammar)).toEqual([]);
  });

  test("recovery naming a missing verb or flag reports capability-unreachable", () => {
    const findings = scanRecoveryText(envelope("Run mstar workflow --bogus"), "packages/engine/src/fixture.ts", grammar);
    expect(findings.map((finding) => finding.classification)).toEqual(["capability-unreachable"]);
  });

  test("checks a literal CLI reference without an action word", () => {
    const findings = scanRecoveryText(envelope("mstar missing-command --bad"), "packages/commands/src/fixture.ts", grammar);
    expect(findings.map((finding) => finding.classification)).toEqual(["capability-unreachable"]);
  });

  test("rejects an unsupported child after a valid parent verb", () => {
    const findings = scanRecoveryText(envelope("mstar workflow nonexistent"), "packages/commands/src/fixture.ts", { verbs: new Set(["workflow"]), flagsByVerb: new Map([ ["workflow", new Set<string>()] ]) });
    expect(findings.map((finding) => finding.classification)).toEqual(["capability-unreachable"]);
  });

  test("rejects an invalid explicit command after a valid explicit command", () => {
    const findings = scanRecoveryText(envelope("Run mstar workflow --resume; or run mstar nonexistent --bad"), "packages/commands/src/fixture.ts", grammar);
    expect(findings.map((finding) => finding.classification)).toEqual(["capability-unreachable"]);
  });

  test("finds unsupported recovery through a shorthand field", () => {
    const source = `const recovery = "Run mstar nonexistent --bad"; refusalEnvelope({ command: "x", status: "refused", code: "NO_STATE", exitCode: 1, message: "Cannot continue", recovery });`;
    expect(scanRecoveryText(source, "packages/engine/src/fixture.ts", grammar).map((finding) => finding.classification)).toEqual(["capability-unreachable"]);
  });

  test("finds unsupported recovery through conditional literal spread fields", () => {
    const source = `refusalEnvelope({ command: "x", status: "refused", code: "NO_STATE", exitCode: 1, message: "Cannot continue", ...(enabled ? { recovery: "Run mstar nonexistent --bad" } : {}) });`;
    expect(scanRecoveryText(source, "packages/engine/src/fixture.ts", grammar).map((finding) => finding.classification)).toEqual(["capability-unreachable"]);
  });

  test("a declared verb and flag absent from the help grammar are reported", () => {
    const source = `const definition = { cli: { path: ["workflow", "launch"], options: [{ flags: "--bogus" }] } };`;
    const findings = scanDeclaredCapabilities(source, "packages/commands/src/fixture.ts", grammar);
    expect(findings.map((finding) => finding.classification)).toEqual(["capability-unreachable", "capability-unreachable"]);
  });

  test("a supported declaration and conforming recovery are a clean control", () => {
    const source = `const definition = { cli: { path: ["workflow"], options: [{ flags: "--resume" }] } }; ${envelope("Run mstar workflow --resume")}`;
    expect([...scanDeclaredCapabilities(source, "packages/commands/src/fixture.ts", grammar), ...scanRecoveryText(source, "packages/commands/src/fixture.ts", grammar)]).toEqual([]);
  });

  test("uses the longest nested command and its flags", () => {
    expect(scanRecoveryText(envelope("supply workflow recover-coordinator --attestation <file>"), "packages/engine/src/fixture.ts", grammar)).toEqual([]);
  });

  test("rejects unsupported commands in mixed recovery alternatives", () => {
    const findings = scanRecoveryText(envelope("Run mstar workflow --resume; or run nonexistent --bad"), "packages/engine/src/fixture.ts", grammar);
    expect(findings.map((finding) => finding.classification)).toEqual(["capability-unreachable"]);
  });

  test("accepts a supported positional argument", () => {
    const positionalGrammar = {
      verbs: new Set(["schema"]), flagsByVerb: new Map([["schema", new Set<string>()]]),
      positionalsByVerb: new Map([["schema", [{ key: "type", required: false, variadic: false }]]]),
    };
    expect(scanRecoveryText(envelope("Run mstar schema ExampleType"), "packages/commands/src/fixture.ts", positionalGrammar)).toEqual([]);
  });

  test("a declaration using the extracted grammar is reachable", () => {
    const surface = extractCliGrammar();
    const verb = surface.verbs.values().next().value as string;
    const flag = surface.flagsByVerb.get(verb)?.values().next().value;
    const options = flag ? `options: [{ flags: ${JSON.stringify(flag)} }]` : "options: []";
    const definition = `const definition = { cli: { path: ${JSON.stringify(verb.split(" "))}, ${options} } };`;
    expect(scanDeclaredCapabilities(definition, "packages/commands/src/fixture.ts", surface)).toEqual([]);
  });

  test("checks every conditional spread recovery alternative", () => {
    const source = `refusalEnvelope({ code: "NO_STATE", message: "Cannot continue", ...(enabled ? { recovery: "Run mstar nonexistent --bad" } : { recovery: "Run mstar workflow --resume" }) });`;
    expect(scanRecoveryText(source, "packages/engine/src/fixture.ts", grammar).map(({ classification }) => classification)).toEqual(["capability-unreachable"]);
  });

  test("classifies recovery prose that names no supported operation as a manual escape", () => {
    const findings = scanRecoveryText(envelope("Delete .mstar/state.json manually"), "packages/engine/src/fixture.ts", grammar);
    expect(findings.map(({ classification }) => classification)).toEqual(["capability-unreachable"]);
    expect(findings[0]?.reason).toMatch(/manual-escape/i);
  });

  test("accepts Commander's built-in help flag in extracted grammar", () => {
    const surface = extractCliGrammar();
    expect([...surface.flagsByVerb.values()].every((flags) => flags.has("--help"))).toBe(true);
    expect(scanRecoveryText(envelope("Run mstar status validate --help"), "packages/engine/src/fixture.ts", surface)).toEqual([]);
  });

  test("rejects recovery missing a required positional argument", () => {
    const positionalGrammar = {
      verbs: new Set(["status findings-cleanup"]),
      flagsByVerb: new Map([["status findings-cleanup", new Set<string>()]]),
      positionalsByVerb: new Map([["status findings-cleanup", [{ key: "planId", required: true, variadic: false }]]]),
    };
    const findings = scanRecoveryText(envelope("Run mstar status findings-cleanup"), "packages/engine/src/fixture.ts", positionalGrammar);
    expect(findings.map(({ classification }) => classification)).toEqual(["capability-unreachable"]);
  });

  test("counts required positionals after option values", () => {
    const positionalGrammar = {
      verbs: new Set(["status findings-cleanup"]),
      flagsByVerb: new Map([["status findings-cleanup", new Set(["--harness"])]]),
      positionalsByVerb: new Map([["status findings-cleanup", [{ key: "planId", required: true, variadic: false }]]]),
      optionsByVerb: new Map([["status findings-cleanup", [{ flags: ["--harness"], required: false, takesValue: true }]]]),
    };
    expect(scanRecoveryText(
      envelope("Run mstar status findings-cleanup --harness /tmp plan-1"),
      "packages/engine/src/fixture.ts",
      positionalGrammar,
    )).toEqual([]);
  });

  test("empty structured recovery is classified as unreachable", () => {
    const findings = scanRecoveryText(`refusalEnvelope({ code: "NO_STATE", message: "Cannot continue", recovery: "" });`, "packages/engine/src/fixture.ts", grammar);
    expect(findings.map(({ classification }) => classification)).toEqual(["capability-unreachable"]);
  });

  test("checks both direct conditional recovery values", () => {
    const source = `refusalEnvelope({ code: "NO_STATE", message: "Cannot continue", recovery: enabled ? "Run mstar nonexistent" : "Run mstar status validate" });`;
    expect(scanRecoveryText(source, "packages/engine/src/fixture.ts", grammar).map(({ classification }) => classification)).toEqual(["capability-unreachable"]);
  });

  test("rejects missing required options and values but accepts the complete option", () => {
    const surface = extractCliGrammar();
    for (const recovery of ["Run mstar lease verify-integration", "Run mstar lease verify-integration --workflow"]) {
      const finding = scanRecoveryText(envelope(recovery), "packages/engine/src/fixture.ts", surface);
      expect(finding.map(({ classification }) => classification)).toEqual(["capability-unreachable"]);
      expect(finding[0]?.reason).toMatch(/missing required option/i);
    }
    expect(scanRecoveryText(envelope("Run mstar lease verify-integration --workflow wf-1"), "packages/engine/src/fixture.ts", surface)).toEqual([]);
  });

  test("validates flags after prose connectors rather than truncating them", () => {
    const surface = extractCliGrammar();
    expect(scanRecoveryText(envelope("Run mstar status validate and then --xyz"), "packages/engine/src/fixture.ts", surface).map(({ classification }) => classification)).toEqual(["capability-unreachable"]);
  });

  test("resolves recovery identifiers in function and nested block scopes", () => {
    const source = `
      function first() {
        const recovery = "Run mstar workflow nonexistent";
        return refusalEnvelope({ code: "NO_STATE", message: "No state", recovery });
      }
      function second() {
        const recovery = "Run mstar workflow --resume";
        return refusalEnvelope({ code: "NO_STATE", message: "No state", recovery });
      }
      function nested() {
        const recovery = "Run mstar workflow --resume";
        {
          const recovery = "Run mstar workflow missing-child";
          return refusalEnvelope({ code: "NO_STATE", message: "No state", recovery });
        }
      }
    `;
    expect(scanRecoveryText(source, "packages/engine/src/fixture.ts", grammar).map(({ classification }) => classification)).toEqual([
      "capability-unreachable",
      "capability-unreachable",
    ]);
  });
  test("checks one-level refusal wrapper reachability at the call site", () => {
    const source = `
      function refused(recovery: string) {
        return refusalEnvelope({ code: "NO_STATE", status: "refused", message: "Blocked", recovery });
      }
      refused("Run mstar nonexistent");
    `;
    expect(scanRecoveryText(source, "packages/engine/src/fixture.ts", grammar).map(({ classification }) => classification)).toEqual(["capability-unreachable"]);
  });
  test("rejects runtime substitutions in otherwise-supported recovery templates", () => {
    const source = 'refusalEnvelope({ code: "NO_STATE", message: "Blocked", recovery: `Run mstar workflow --resume ${flag}` });';
    const findings = scanRecoveryText(source, "packages/engine/src/fixture.ts", grammar);
    expect(findings.map(({ classification }) => classification)).toEqual(["capability-unreachable"]);
    expect(findings[0]?.reason).toContain("unresolved runtime substitution — advertised command is not statically provable");
  });

  test("rejects coordination messages whose command contains a runtime substitution", () => {
    const source = 'new CoordinationError("NO_STATE", `Use mstar status validate ${flag}`);';
    const findings = scanRecoveryText(source, "packages/engine/src/fixture.ts", grammar);
    expect(findings.map(({ classification }) => classification)).toEqual(["capability-unreachable"]);
    expect(findings[0]?.reason).toContain("unresolved runtime substitution — advertised command is not statically provable");
  });

  test("uses wrapper call-site arguments instead of shadowed outer recovery declarations", () => {
    const source = `
      const recovery = "Run mstar workflow --resume";
      function refused(recovery: string) {
        return refusalEnvelope({ code: "NO_STATE", status: "refused", message: "Blocked", recovery });
      }
      refused("Run mstar nonexistent");
    `;
    expect(scanRecoveryText(source, "packages/engine/src/fixture.ts", grammar).map(({ classification }) => classification)).toEqual(["capability-unreachable"]);
  });
});
