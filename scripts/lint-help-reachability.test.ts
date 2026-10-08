import { extractCliGrammar } from "./lint-refusal-quality";
import { scanDeclaredCapabilities, scanRecoveryText } from "./lint-help-reachability";

describe("help reachability lint", () => {
  const grammar = {
    verbs: new Set(["workflow"]),
    flagsByVerb: new Map([["workflow", new Set(["--resume"])]]),
  };

  test("recovery naming an existing verb and flag passes", () => {
    const source = `refusalEnvelope({ command: "x", status: "refused", code: "NO_STATE", exitCode: 1, message: "Cannot continue", recovery: "Run mstar workflow --resume" });`;
    expect(scanRecoveryText(source, "packages/engine/src/fixture.ts", grammar)).toEqual([]);
  });

  test("recovery naming a missing verb or flag reports capability-unreachable", () => {
    const source = `refusalEnvelope({ command: "x", status: "refused", code: "NO_STATE", exitCode: 1, message: "Cannot continue", recovery: "Run mstar workflow --bogus" });`;
    const findings = scanRecoveryText(source, "packages/engine/src/fixture.ts", grammar);
    expect(findings.map((finding) => finding.classification)).toEqual(["capability-unreachable"]);
  });

  test("declared verb and flag absent from the help grammar are reported", () => {
    const source = `const definition = { cli: { path: ["workflow", "launch"], options: [{ flags: "--bogus" }] } };`;
    const findings = scanDeclaredCapabilities(source, "packages/commands/src/fixture.ts", grammar);
    expect(findings.map((finding) => finding.classification)).toEqual(["capability-unreachable", "capability-unreachable"]);
  });

  test("uses the shared static grammar extractor", () => {
    const surface = extractCliGrammar();
    expect(surface.verbs.size).toBeGreaterThan(0);
    expect(surface.positionalsByVerb?.size).toBeGreaterThan(0);
  });
});
