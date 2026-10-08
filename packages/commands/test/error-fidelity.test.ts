import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeCommand } from "../src/definitions.js";
import type { InvocationContext } from "../src/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/**
 * `session.recover` input discovery, exercised through the real public
 * admission route. The contract's `priorSession`/`unowned` requirement is an
 * EXACTLY-ONE ALTERNATIVE, so the cases below assert the alternative fact and
 * the independently known missing fields — never that both source fields are
 * unconditionally required, which would misstate the contract.
 */
function context(cwd: string, sessionId?: string): InvocationContext {
  return {
    cwd,
    controlRoot: null,
    ...(sessionId === undefined ? {} : { sessionId }),
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { throw new Error("session.recover must not spawn a process"); },
      async startDashboard() { throw new Error("dashboard is unavailable in this test"); },
      async openBrowser() { throw new Error("browser is unavailable in this test"); },
    },
  };
}

/** One fresh OS-temp harness root outside every Git worktree. */
function fixture(): { root: string; harness: string } {
  const root = mkdtempSync(path.join(tmpdir(), "error-fidelity-recovery-"));
  roots.push(root);
  const harness = path.join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  return { root, harness };
}

function diagnosticsOf(envelope: Awaited<ReturnType<typeof executeCommand>>): readonly Record<string, unknown>[] {
  if (envelope.status === "ok") throw new Error("expected a refusal envelope");
  const diagnostics = envelope.details?.diagnostics;
  if (!Array.isArray(diagnostics)) throw new Error("the aggregated refusal must carry structured diagnostics");
  return diagnostics as readonly Record<string, unknown>[];
}

describe("session.recover input discovery", () => {
  test("reports every independently known missing field and the source alternative", async () => {
    const { root, harness } = fixture();
    const before = readdirSync(harness);
    const result = await executeCommand("session.recover", { workflow: "wf-recover", harness }, context(root));
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    const diagnostics = diagnosticsOf(result);
    // The five unconditional minima (workflow itself is present) plus the
    // caller identity are each reported on their own path.
    for (const field of ["reason", "attestation", "expect", "operation", "sessionId"]) {
      expect(diagnostics).toContainEqual(expect.objectContaining({ path: field, code: "required" }));
    }
    // The source is the contract's exactly-one alternative, not two required
    // fields: with no source selected and none required individually, the
    // reported fact is the cardinality one.
    expect(diagnostics).toContainEqual(expect.objectContaining({ path: "priorSession|unowned=true", code: "alternative-required" }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ path: "priorSession", code: "required" }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ path: "unowned", code: "required" }));
    // The refusal wrote nothing: the isolated harness directory is untouched.
    expect(readdirSync(harness)).toEqual(before);
  });

  test("reports both addressable source fields as mutually exclusive", async () => {
    const { root, harness } = fixture();
    // `sessionId` travels in the request exactly as the CLI adapter collects the
    // session selector from the flag/environment, so this case isolates the
    // source-cardinality fact.
    const result = await executeCommand("session.recover", {
      workflow: "wf-recover", priorSession: "stopped-session", unowned: true, sessionId: "caller-session",
      reason: "recovery", attestation: path.join(root, "attestation.json"), expect: "token", operation: "recover-1", harness,
    }, context(root));
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    const diagnostics = diagnosticsOf(result);
    expect(diagnostics).toContainEqual(expect.objectContaining({ path: "priorSession|unowned=true", code: "alternative-required" }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ code: "required" }));
  });

  test("an exactly-one source resolves past the gate and reaches the FILE boundary's own refusal", async () => {
    const { root, harness } = fixture();
    // One source plus every other caller fact is a COMPLETE input: nothing is
    // reported missing, so the call runs the FILE consumer boundary instead of
    // refusing the input — and the missing document refuses with its own real
    // POSIX code, not this family's synthetic fallback or a usage envelope.
    const result = await executeCommand("session.recover", {
      workflow: "wf-recover", unowned: true, sessionId: "caller-session",
      reason: "recovery", attestation: path.join(root, "absent-attestation.json"), expect: "token", operation: "recover-1", harness,
    }, context(root));
    expect(result).toMatchObject({ status: "refused", code: "ENOENT", exitCode: 1 });
    expect(result.status === "ok" ? undefined : result.details?.diagnostics).toBeUndefined();
    // Nothing was written by the refused call.
    expect(existsSync(path.join(harness, "workflows"))).toBe(false);
  });

  test("a relative attestation path is a usage refusal before any read", async () => {
    const { root, harness } = fixture();
    const result = await executeCommand("session.recover", {
      workflow: "wf-recover", priorSession: "stopped", sessionId: "caller-session",
      reason: "recovery", attestation: "attestation.json",
      expect: "token", operation: "recover-1", harness,
    }, context(root));
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (result.status === "ok") throw new Error("expected a usage refusal");
    expect(result.message).toContain("--attestation must be an absolute path");
    // The relative path was never resolved against the process cwd.
    expect(existsSync(path.join(harness, "workflows"))).toBe(false);
  });

  test("a malformed attestation keeps its parser grammar but never echoes the submitted document", async () => {
    // The supported runtimes echo the offending operand differently: Node wraps
    // it in a double-quoted `..., "<source>" is not valid JSON` tail, while Bun's
    // identifier form is `Unexpected identifier "<source>"` with no suffix. Both
    // are the runtime echoing an OPERAND, so both must go; the parser's own
    // single-quoted grammar must survive.
    for (const [label, document] of [
      ["identifier operand (Bun shape)", '{"operator":{"actor":LEAKSENTINEL7QX9}}'],
      ["bare-word value (Node excerpt shape)", '{"actor":LEAKSENTINEL7QX9}'],
      ["unterminated document", '{"version":1,"actor":"LEAKSENTINEL7QX9"'],
      ["trailing garbage", '{"version":1} LEAKSENTINEL7QX9'],
      ["single-quoted document", "{'actor':'LEAKSENTINEL7QX9'}"],
    ] as const) {
      const { root, harness } = fixture();
      const attestation = path.join(root, "attestation.json");
      writeFileSync(attestation, document);
      const result = await executeCommand("session.recover", {
        workflow: "wf-recover", unowned: true, sessionId: "caller-session",
        reason: "recovery", attestation, expect: "token", operation: "recover-1", harness,
      }, context(root));

      // Stable, specific classification — not a generic usage envelope.
      expect(result, label).toMatchObject({ status: "refused", code: "session.recover.attestation-malformed", exitCode: 1 });
      if (result.status === "ok") throw new Error(label);
      // The published cause must preserve the runtime's own parser-authored
      // grammar, not a generic wrapper. The oracle is the same runtime's raw
      // message, read by the operand's DIAGNOSTIC ROLE — never by mirroring the
      // production sanitizer and never by quote style.
      const rawMessage = (() => { try { JSON.parse(document); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); } })();
      const cause = result.message
        .slice("--attestation is not valid JSON: ".length)
        .replace(/\s*\(position \d+\)$/, "")
        .replace(/\s*\(line \d+ column \d+\)$/, "")
        .trim();
      // The category is the load-bearing fact: a cause collapsed to a generic
      // `syntax error` / bare not-valid-JSON statement fails it.
      const category = rawMessage
        .replace(/^JSON Parse error:\s*/i, "")
        .replace(/^JSON parse error:\s*/i, "")
        .replace(/^SyntaxError:\s*/i, "")
        .split(/["']/)[0]!
        .trim();
      expect(cause, `${label}: the parser's own category ${JSON.stringify(category)} must open the published cause`).toContain(category);
      // Operands the parser NAMED as unexpected are submitted source, so no
      // single-quoted or double-quoted form of them may survive.
      for (const operand of rawMessage.match(/\bUnexpected\s+(?:token|identifier|number|string|character)\s+(?:'[^']*'|"[^"]*")/gi) ?? []) {
        const inner = operand.match(/(?:'([^']*)'|"([^"]*)")/);
        const token = inner?.[1] ?? inner?.[2] ?? "";
        if (token === "") continue;
        expect(cause, `${label}: the unexpected source operand ${JSON.stringify(token)} must not survive`).not.toContain(token);
        expect(result.message, `${label}: the unexpected source operand ${JSON.stringify(token)} must not reach the message`).not.toContain(token);
      }
      // Grammar the parser AUTHORED (dangling delimiters it merely mentions)
      // must survive: every single-quoted operand the message does not name as
      // unexpected is expected-grammar.
      const unexpectedSpans = (rawMessage.match(/\bUnexpected\s+\w+\s+'[^']*'/gi) ?? []);
      for (const token of rawMessage.match(/'[^']*'/g) ?? []) {
        if (unexpectedSpans.some((span) => span.endsWith(token))) continue;
        expect(cause, `${label}: parser grammar ${token} must survive in the cause`).toContain(token);
      }
      // Every double-quoted operand the SAME runtime derives for this input is
      // gone from the published message; the sentinel is gone from the whole
      // serialized envelope, not just the cause.
      for (const operand of rawMessage.match(/"[^"]*"/g) ?? []) {
        // Only meaningful operands are checked: an empty match is contained in
        // every string and would assert nothing.
        if (operand.length <= 2) continue;
        expect(result.message, `${label}: runtime operand ${JSON.stringify(operand)} must not reach the message`).not.toContain(operand);
      }
      expect(JSON.stringify(result), `${label}: the submitted sentinel must not reach the envelope`).not.toContain("LEAKSENTINEL7QX9");
      // Nothing was written and the engine was never reached.
      expect(existsSync(path.join(harness, "workflows")), label).toBe(false);
    }
  });

  test("the parser cause keeps the actual reported location and grammar shape", async () => {
    const { root, harness } = fixture();
    const attestation = path.join(root, "attestation.json");
    const document = '{"version":1,"actor":"LEAKSENTINEL7QX9"';
    writeFileSync(attestation, document);
    // The cause this runtime actually reports for this input, from the same
    // parser — never an invented coordinate.
    let reported = "";
    try { JSON.parse(document); } catch (error) { reported = error instanceof Error ? error.message : String(error); }
    const position = reported.match(/\bposition\s+(\d+)\b/i)?.[1];
    const lineColumn = reported.match(/\bline\s+(\d+)\s+column\s+(\d+)\b/i);
    const expectedLocation = position !== undefined
      ? `position ${position}`
      : lineColumn === null ? "" : `line ${lineColumn[1]} column ${lineColumn[2]}`;

    const result = await executeCommand("session.recover", {
      workflow: "wf-recover", unowned: true, sessionId: "caller-session",
      reason: "recovery", attestation, expect: "token", operation: "recover-1", harness,
    }, context(root));
    if (result.status === "ok") throw new Error("expected the malformed refusal");
    if (expectedLocation === "") {
      // This runtime reported no coordinate, so none may be invented.
      expect(result.message).not.toMatch(/\b(position|line)\s+\d/);
    } else {
      expect(result.message).toContain(`(${expectedLocation})`);
    }
    expect(JSON.stringify(result)).not.toContain("LEAKSENTINEL7QX9");
  });
});
