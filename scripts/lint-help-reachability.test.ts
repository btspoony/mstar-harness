import { extractCliGrammar } from "./lint-refusal-quality";
import { scanDeclaredCapabilities, scanRecoveryText } from "./lint-help-reachability";

describe("help reachability lint", () => {
  const grammar = {
    verbs: new Set(["workflow", "workflow recover-coordinator"]),
    flagsByVerb: new Map([
      ["workflow", new Set(["--resume"])],
      ["workflow recover-coordinator", new Set(["--attestation"])],
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
});
