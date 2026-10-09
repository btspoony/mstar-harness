import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { main, scanSource } from "./lint-hash-gates";

const gate = (marker = "") => `${marker}\nif (expectedDigest !== observedDigest) throw new Error("mismatch");`;

async function runLint(files: Record<string, string>, json = false) {
  const repo = mkdtempSync(join(tmpdir(), "hash-gates-"));
  mkdirSync(join(repo, "src"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, "src", name), content);
  const output: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => output.push(args.join(" "));
  console.error = (...args: unknown[]) => output.push(args.join(" "));
  try {
    const exitCode = await main(["--repo", repo, "--dir", "src", ...(json ? ["--json"] : [])]);
    return { exitCode, output: output.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    rmSync(repo, { recursive: true, force: true });
  }
}

describe("hash-gate scope and authorization", () => {
  test("does not report test-file assertions or gates", () => {
    expect(scanSource("packages/engine/src/hash.test.ts", gate())).toEqual([]);
    expect(scanSource("packages/engine/test/hash.ts", gate())).toEqual([]);
  });

  test("accepts and reports a non-empty authorized marker", () => {
    const findings = scanSource("packages/engine/src/hash.ts", gate("// hash-gate: authorized — preserve identity"));
    expect(findings.map(({ classification }) => classification)).toEqual(["authorized-gate"]);
    expect(findings[0]?.reason).toBe("preserve identity");
  });

  test("reports an empty authorized reason as a violation", () => {
    const findings = scanSource("packages/engine/src/hash.ts", gate("// hash-gate: authorized —   "));
    expect(findings.map(({ classification }) => classification)).toEqual(["invalid-authorized-marker"]);
    expect(findings[0]?.reason).toBe("authorized marker requires a non-empty reason");
  });

  test("does not authorize marker text inside a string literal or block comment", () => {
    for (const source of [
      `if (expectedDigest !== observedDigest) throw new Error("// hash-gate: authorized — diagnostic");`,
      `/* // hash-gate: authorized — diagnostic */\nif (expectedDigest !== observedDigest) throw new Error("mismatch");`,
    ]) {
      expect(scanSource("packages/engine/src/hash.ts", source).map(({ classification }) => classification)).toEqual(["hash-gate"]);
    }
  });
  test("does not treat multiline block-comment continuations or template text as markers", () => {
    const sources = [
      `/*
// hash-gate: authorized — diagnostic */
if (expectedDigest !== observedDigest) throw new Error("mismatch");`,
      `const note = \`example
// hash-gate: authorized — diagnostic\`;
if (expectedDigest !== observedDigest) throw new Error("mismatch");`,
    ];
    for (const source of sources) {
      expect(scanSource("packages/engine/src/hash.ts", source).map(({ classification }) => classification)).toEqual(["hash-gate"]);
    }
  });


  test("keeps unmarked gates as violations", () => {
    expect(scanSource("packages/engine/src/hash.ts", gate()).map(({ classification }) => classification)).toEqual(["hash-gate"]);
  });

  test("one marker authorizes one adjacent gate only, never both", () => {
    // RED-first: a trailing marker on gate A's line also matched gate B on the
    // next line (the previous marker line === pos.line coincidence), so a
    // single comment suppressed two findings. Site identity, not the line, is
    // the binding key now.
    const sources = [
      `${gate()} // hash-gate: authorized — preserve identity\nif (expectedDigest !== observedDigest) throw new Error("mismatch");`,
      `${gate("// hash-gate: authorized — preserve identity")}\nif (expectedDigest !== observedDigest) throw new Error("mismatch");`,
    ];
    for (const source of sources) {
      const classifications = scanSource("packages/engine/src/hash.ts", source).map(({ classification }) => classification);
      expect(classifications.filter((value) => value === "authorized-gate")).toHaveLength(1);
      expect(classifications.filter((value) => value === "hash-gate")).toHaveLength(1);
    }
  });

  test("two gates on one line are distinct sites; one marker authorizes one of them", () => {
    const source = `if (expectedDigest !== observedDigest) throw new Error("a"); if (otherDigest !== observedDigest) throw new Error("b"); // hash-gate: authorized — preserve identity`;
    const classifications = scanSource("packages/engine/src/hash.ts", source).map(({ classification }) => classification);
    expect(classifications.filter((value) => value === "authorized-gate")).toHaveLength(1);
    expect(classifications.filter((value) => value === "hash-gate")).toHaveLength(1);
  });

  test("an over-authorized sibling exits 1", async () => {
    const overAuthorized = await runLint({
      "over.ts": `${gate()} // hash-gate: authorized — preserve identity\nif (expectedDigest !== observedDigest) throw new Error("mismatch");`,
    });
    expect(overAuthorized.exitCode).toBe(1);
    expect(overAuthorized.output).toContain("1 violation(s)");
    expect(overAuthorized.output).toContain("authorized gates — 1");
  });

  test("authorized-only reports exit 0 and exposes authorizedGates in text and JSON", async () => {
    const files = { "authorized.ts": gate("// hash-gate: authorized — preserve identity") };
    const text = await runLint(files);
    expect(text.exitCode).toBe(0);
    expect(text.output).toContain("authorized gates — 1");
    expect(text.output).toContain("src/authorized.ts");
    const json = await runLint(files, true);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.output).authorizedGates).toHaveLength(1);
  });

  test("mixed authorized and unmarked gates exit 1 and invalid whitespace reason is a violation", async () => {
    const mixed = await runLint({
      "authorized.ts": gate("// hash-gate: authorized — preserve identity"),
      "unmarked.ts": gate(),
    });
    expect(mixed.exitCode).toBe(1);
    expect(mixed.output).toContain("1 violation(s)");
    expect(mixed.output).toContain("authorized gates — 1");
    const invalid = await runLint({ "invalid.ts": gate("// hash-gate: authorized —   ") }, true);
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.output).violations[0].reason).toBe("authorized marker requires a non-empty reason");
  });
});
