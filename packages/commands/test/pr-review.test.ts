import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCommandDefinitions, executeCommand } from "../src/index.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../src/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "pr-review-family-")); roots.push(cwd);
  const calls: Array<{ argv: readonly string[]; cwd: string; stdin?: string }> = [];
  const context: InvocationContext = {
    cwd, controlRoot: null, versions: { engine: null, cli: null, plugin: null, host: null, platform: null }, signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn(request) { calls.push({ argv: request.argv, cwd: request.cwd, ...(request.stdin !== undefined ? { stdin: request.stdin } : {}) }); return { exitCode: 1, signal: null, stdout: "", stderr: "authentication required" }; },
      async startDashboard() { throw new Error("unexpected dashboard effect"); }, async openBrowser() { throw new Error("unexpected browser effect"); },
    },
  };
  return { cwd, calls, context };
}
function command(id: string): CommandDefinition {
  const found = getCommandDefinitions().find((definition) => definition.id === id);
  if (found === undefined) throw new Error(`Missing command ${id}`);
  return found;
}

/** The rendered seat prompt of an ok envelope, narrowed rather than asserted. */
function promptOf(envelope: CommandEnvelope, label: string): string {
  expect(envelope.status, label).toBe("ok");
  if (envelope.status !== "ok") throw new Error(label);
  const data: unknown = envelope.data;
  if (data === null || typeof data !== "object" || !("prompt" in data) || typeof data.prompt !== "string") {
    throw new Error(`${label}: seat-prompt must return its rendered prompt`);
  }
  return data.prompt;
}

/** The usage diagnostics of a refusal, narrowed rather than asserted. */
function diagnosticsOf(envelope: CommandEnvelope, label: string): readonly unknown[] {
  if (envelope.status === "ok") throw new Error(label);
  const diagnostics = envelope.details?.diagnostics;
  if (!Array.isArray(diagnostics)) throw new Error(`${label}: the refusal must carry structured diagnostics`);
  return diagnostics;
}

describe("pr-review command family", () => {

  test("computes tally from fixture findings and validates fixture report verdicts", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, JSON.stringify([{ mergeClass: "must-fix" }, { mergeClass: "nit" }]));
    const tally = await command("pr-review.tally").execute({ findings }, context);
    expect(tally.status).toBe("ok");
    expect(tally.data).toMatchObject({ verdict: "blocked", scorePct: 53, band: "fail", tally: { mustFix: 1, nit: 1 } });

    const report = path.join(cwd, "report.md");
    writeFileSync(report, "# Fixture report\n");
    const validation = await command("pr-review.validate-report").execute({ reportFile: report }, context);
    expect(validation.status).toBe("refused");
    expect(validation.details).toMatchObject({ violations: expect.arrayContaining([expect.objectContaining({ code: expect.any(String) })]) });
  });
  test("report-path refusal preserves its authored target message and usage contract", async () => {
    const { context } = fixture();
    const result = await command("pr-review.report-path").execute({ reviewsDir: ".", target: "unknown" }, context);
    expect(result).toMatchObject({
      status: "usage",
      code: "command.invalid-input",
      exitCode: 2,
      message: 'invalid --target "unknown"; expected pr:<n> | branch:<slug> | diff:<sha> | diff',
    });
  });

  test("post admission preserves target authorization before any review write", async () => {
    const { cwd, context, calls } = fixture();
    const bodyFile = path.join(cwd, "body.md"); writeFileSync(bodyFile, "Review summary");
    const post = command("pr-review.post");
    const unauthorized = await post.execute({ pr: "42", bodyFile }, context);
    expect(unauthorized.status).toBe("refused");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argv).toEqual(["gh", "pr", "view", "42", "--json", "url,headRefOid"]);

    calls.length = 0;
    context.effects.spawn = async (request) => {
      calls.push({ argv: request.argv, cwd: request.cwd, ...(request.stdin !== undefined ? { stdin: request.stdin } : {}) });
      return { exitCode: 0, signal: null, stdout: JSON.stringify({ url: "https://github.com/owner/repo/pull/41", headRefOid: "abcdef0123456" }), stderr: "" };
    };
    const wrongTarget = await post.execute({ pr: "42", bodyFile }, context);
    expect(wrongTarget.status).toBe("refused");
    expect(calls).toHaveLength(1);

    calls.length = 0;
    context.effects.spawn = async (request) => {
      calls.push({ argv: request.argv, cwd: request.cwd, ...(request.stdin !== undefined ? { stdin: request.stdin } : {}) });
      if (request.argv[1] === "pr") return { exitCode: 0, signal: null, stdout: JSON.stringify({ url: "https://github.com/owner/repo/pull/42", headRefOid: "abcdef0123456" }), stderr: "" };
      return { exitCode: 0, signal: null, stdout: JSON.stringify({ html_url: "https://github.com/owner/repo/pull/42#review-1" }), stderr: "" };
    };
    const authorized = await post.execute({ pr: "42", bodyFile }, context);
    expect(authorized.status).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.argv).toEqual(["gh", "api", "--method", "POST", "repos/owner/repo/pulls/42/reviews", "--input", "-"]);
    expect(JSON.parse(calls[1]!.stdin ?? "")).toMatchObject({ event: "COMMENT", body: "Review summary", commit_id: "abcdef0123456" });
  });

  test("refuses cleanup when a recorded review has no saved report", async () => {
    const { cwd, context, calls } = fixture();
    const worktreePath = path.join(cwd, "review-worktree");
    writeFileSync(path.join(cwd, ".review-worktree.prreview.json"), JSON.stringify({ reviewBranch: "pr-42", repoRoot: cwd, reportSaved: false }));
    const result = await command("pr-review.worktree-cleanup").execute({ worktreePath, branch: "pr-42" }, context);
    expect(result.status).toBe("error");
    expect(result.message).toContain("local report is not saved");
    expect(calls).toHaveLength(0);
  });
  test("review context derives the worktree from the invocation directory", async () => {
    const { cwd, context } = fixture();
    const result = await command("pr-review.seat-prompt").execute(
      { stage: "1", domain: "audit", seat: "code-reviewer" },
      context,
    );
    expect(result.status).toBe("ok");
    expect(JSON.stringify(result)).toContain(cwd);
  });

  /**
   * The folded-seat combinations are asserted against the prompt the engine
   * actually renders and the refusals admission actually authors, not against
   * a copy of the requirement table: these cases drive the canonical
   * `executeCommand` route, which is where the conditional facts are enforced.
   */
  test("folded-seat admission accepts stage-2 domain seats and refuses the impossible combinations", async () => {
    const { cwd, context } = fixture();
    const diffFile = path.join(cwd, "review.pack.diff");
    writeFileSync(diffFile, "diff --git a/a.ts b/a.ts\n");

    // Accepted: stage 2 with a pinned diff snapshot; omitted --security keeps
    // its false default, and false is the same non-security seat.
    for (const security of [undefined, false]) {
      const folded = await executeCommand("pr-review.seat-prompt", {
        stage: "2", domain: "audit", seat: "code-reviewer", diffFile, collectFolded: true,
        ...(security === undefined ? {} : { security }),
      }, context);
      // The fold is a real instruction anchored to the budget block, not an
      // echo of the requirement object.
      const prompt = promptOf(folded, "folded stage-2 seat");
      expect(prompt).toContain("Collect wave folded");
      expect(prompt).toContain("## Budget");
      expect(prompt).toContain(diffFile);
    }

    // Refused: a folded Stage-1 seat is the contradiction the engine guards.
    const stageOne = await executeCommand("pr-review.seat-prompt", {
      stage: "1", domain: "audit", seat: "code-reviewer", diffFile, collectFolded: true,
    }, context);
    expect(stageOne).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(diagnosticsOf(stageOne, "folded stage-1 seat")).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "stage", code: "not_allowed", expected: '"2"', received: '"1"' }),
    ]));

    // Refused: folding without a pinned pack contradicts the fold instruction.
    const withoutPack = await executeCommand("pr-review.seat-prompt", {
      stage: "2", domain: "audit", seat: "code-reviewer", collectFolded: true,
    }, context);
    expect(withoutPack).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(diagnosticsOf(withoutPack, "folded seat without a pack")).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "diffFile", code: "required" }),
    ]));

    // Refused: the independent security seat survives every fold.
    const securitySeat = await executeCommand("pr-review.seat-prompt", {
      stage: "2", domain: "audit", seat: "code-reviewer", diffFile, security: true, collectFolded: true,
    }, context);
    expect(securitySeat).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(diagnosticsOf(securitySeat, "folded security seat")).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "security", code: "not_allowed", expected: "false", received: "true" }),
    ]));
  });

  test("an unfolded seat keeps its ordinary stage behavior and never gains the fold instruction", async () => {
    const { cwd, context } = fixture();
    const diffFile = path.join(cwd, "review.pack.diff");
    writeFileSync(diffFile, "diff --git a/a.ts b/a.ts\n");

    for (const collectFolded of [undefined, false]) {
      const ordinary = await executeCommand("pr-review.seat-prompt", {
        stage: "1", domain: "audit", seat: "code-reviewer", diffFile,
        ...(collectFolded === undefined ? {} : { collectFolded }),
      }, context);
      // Stage 1 without a fold is the ordinary collect seat: the budget block
      // binds but the fold bullet is absent, and the security seat is allowed.
      const prompt = promptOf(ordinary, "ordinary stage-1 seat");
      expect(prompt).toContain("## Budget");
      expect(prompt).not.toContain("Collect wave folded");
      expect(prompt).toContain("Stage 1");
    }

    // A security seat outside a fold is an ordinary, accepted combination.
    const securityStageTwo = await executeCommand("pr-review.seat-prompt", {
      stage: "2", domain: "audit", seat: "code-reviewer", diffFile, security: true,
    }, context);
    promptOf(securityStageTwo, "unfolded stage-2 security seat");
  });

  test("seat-prompt states the tier and the shared-clock remainder, and refuses a non-numeric remainder", async () => {
    const { context } = fixture();

    const remaining = await executeCommand("pr-review.seat-prompt", {
      stage: "2", domain: "audit", seat: "code-reviewer", tier: "deep", remainingMinutes: "4.5",
    }, context);
    const prompt = promptOf(remaining, "seat-prompt with a remainder");
    expect(prompt).toContain("- Tier: `deep`");
    expect(prompt).toContain("4.5 min left when you were dispatched");

    // The same shared clock past its cap: an overrun figure, never a fresh allowance.
    const overrun = await executeCommand("pr-review.seat-prompt", {
      stage: "2", domain: "audit", seat: "code-reviewer", tier: "deep", remainingMinutes: "-2",
    }, context);
    expect(promptOf(overrun, "seat-prompt past its cap")).toContain("2 min over it when you were dispatched");

    const bad = await executeCommand("pr-review.seat-prompt", {
      stage: "2", domain: "audit", seat: "code-reviewer", remainingMinutes: "soon",
    }, context);
    expect(bad).toMatchObject({
      status: "usage", code: "command.invalid-input", exitCode: 2,
      message: "--remaining-minutes must be a number of minutes",
    });
  });

  test("tally derives a settled verdict from complete run facts", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, JSON.stringify([{ mergeClass: "must-fix" }, { mergeClass: "nit" }]));

    // Complete coverage: a run past its tier wall clock has no fact that
    // selects `incomplete`, so it publishes the tally-derived token.
    const settled = await command("pr-review.tally").execute(
      { findings, requiredDomains: "persist,security", openedDomains: "persist,security", diffBasis: "readable" },
      context,
    );
    expect(settled.status).toBe("ok");
    expect(settled.data).toMatchObject({
      verdict: "blocked",
      chatHeader: "blocked \u00b7 53% (fail)\nmust-fix=1 should-fix=0 nit=1 unverified=0",
    });
    expect(settled.data).not.toMatchObject({ incomplete: expect.anything() });
  });

  test("tally derives incomplete from a required domain that never opened", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, JSON.stringify([{ mergeClass: "must-fix" }, { mergeClass: "nit" }]));

    const partial = await command("pr-review.tally").execute(
      { findings, requiredDomains: "persist,security", openedDomains: "persist" },
      context,
    );
    expect(partial.status).toBe("ok");
    expect(partial.data).toMatchObject({
      verdict: "incomplete",
      scorePct: 53,
      band: "fail",
      incomplete: { reason: "required domain seat(s) never opened: security", unscanned: ["security"] },
      chatHeader:
        "incomplete \u00b7 53% (fail, partial)\nmust-fix=1 should-fix=0 nit=1 unverified=0\n" +
        "cause: required domain seat(s) never opened: security\nunscanned: security",
    });
  });

  test("tally derives incomplete from a stopped run and from an unreadable diff basis", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, "[]");

    const stopped = await command("pr-review.tally").execute({ findings, stopped: "cancelled before synthesis" }, context);
    expect(stopped.status).toBe("ok");
    expect(stopped.data).toMatchObject({
      verdict: "incomplete",
      incomplete: { reason: "the run stopped before synthesis \u2014 cancelled before synthesis", unscanned: [] },
    });

    const unreadable = await command("pr-review.tally").execute({ findings, diffBasis: "unreadable" }, context);
    expect(unreadable.status).toBe("ok");
    expect(unreadable.data).toMatchObject({
      verdict: "incomplete",
      incomplete: { reason: "the resolved diff basis could not be read", unscanned: ["the resolved diff basis"] },
    });
  });

  test("tally reports every invalid run fact in one refusal", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, "[]");
    const facts = {
      findings, stopped: " ", requiredDomains: "persist,, security",
      openedDomains: "persist, ", unverified: "x",
    };

    // The run-fact checks and the count checks share one collection phase, so
    // one call reports every invalid field (packages/cli/AGENTS.md
    // § Aggregated validation). The direct execute route and the admitted one
    // agree.
    for (const refusal of [
      await command("pr-review.tally").execute(facts, context),
      await executeCommand("pr-review.tally", facts, context),
    ]) {
      expect(refusal).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
      expect(diagnosticsOf(refusal, "invalid run facts")).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "stopped", code: "invalid" }),
        expect.objectContaining({ path: "requiredDomains", code: "invalid" }),
        expect.objectContaining({ path: "openedDomains", code: "invalid" }),
        expect.objectContaining({ path: "unverified", code: "invalid" }),
      ]));
      const text = refusal.status === "ok" ? "" : refusal.message;
      expect(text).toContain("--stopped must be a single line of non-blank text");
      expect(text).toContain("--unverified must be a non-negative integer no greater than 50");
    }
  });

  test("a multi-line stop and a non-boolean diff basis are caller errors", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, "[]");

    const refused = await command("pr-review.tally").execute(
      { findings, stopped: "cancelled\nbefore synthesis" },
      context,
    );
    expect(refused).toMatchObject({
      status: "usage", code: "command.invalid-input", exitCode: 2,
      message: "--stopped must be a single line of non-blank text",
    });
    // The admitted route rejects the value at admission (declared allowed
    // values); the direct route keeps its own message for the same refusal.
    const badBasis = await command("pr-review.tally").execute({ findings, diffBasis: "maybe" }, context);
    expect(badBasis).toMatchObject({
      status: "usage", code: "command.invalid-input", exitCode: 2,
      message: "--diff-basis must be readable or unreadable",
    });
    const admittedBasis = await executeCommand("pr-review.tally", { findings, diffBasis: "maybe" }, context);
    expect(admittedBasis).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(diagnosticsOf(admittedBasis, "invalid diff basis")).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "diffBasis", code: "not_allowed" }),
    ]));
  });

  test("findings-payload errors join the run-fact diagnostics in one refusal", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, JSON.stringify([{}]));
    const facts = { findings, stopped: " " };

    // The findings payload is validated in the same collection phase as the
    // run facts, so one call reports both the invalid mergeClass and the blank
    // stop (packages/cli/AGENTS.md § Aggregated validation). The direct
    // execute route and the admitted one agree.
    for (const refusal of [
      await command("pr-review.tally").execute(facts, context),
      await executeCommand("pr-review.tally", facts, context),
    ]) {
      expect(refusal).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
      expect(diagnosticsOf(refusal, "findings and run facts")).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "findings", code: "invalid" }),
        expect.objectContaining({ path: "stopped", code: "invalid" }),
      ]));
      const text = refusal.status === "ok" ? "" : refusal.message;
      expect(text).toContain("findings[0].mergeClass must be one of must-fix | should-fix | nit");
      expect(text).toContain("--stopped must be a single line of non-blank text");
    }

    // A missing findings file is the same caller-correctable class (usage, exit
    // 2), not a failed execution, and joins the same refusal.
    const missing = await command("pr-review.tally").execute(
      { findings: path.join(cwd, "absent.json"), stopped: " " },
      context,
    );
    expect(missing).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(diagnosticsOf(missing, "missing findings file")).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "findings", message: expect.stringContaining("findings file not found") }),
      expect.objectContaining({ path: "stopped", code: "invalid" }),
    ]));

    // An unparseable payload joins the same phase rather than escaping it as
    // the parser's own failure: the invalid fact is still reported beside it
    // in one refusal. The parser text is not quoted back, so the file's bytes
    // stay out of the refusal.
    const malformedFile = path.join(cwd, "malformed.json");
    writeFileSync(malformedFile, '[{"mergeClass": "must-fix",}');
    const malformed = await command("pr-review.tally").execute(
      { findings: malformedFile, stopped: " " },
      context,
    );
    expect(malformed).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(diagnosticsOf(malformed, "malformed findings file")).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "findings", code: "invalid", message: "findings file must contain valid JSON" }),
      expect.objectContaining({ path: "stopped", code: "invalid" }),
    ]));
    expect(malformed.status === "ok" ? "" : malformed.message).toContain("findings file must contain valid JSON");
  });


  test("unknown outcome after posting does not claim success or retry", async () => {
    const { cwd, context, calls } = fixture();
    const bodyFile = path.join(cwd, "body.md");
    writeFileSync(bodyFile, "Review summary");
    context.effects.spawn = async (request) => {
      calls.push({ argv: request.argv, cwd: request.cwd, ...(request.stdin !== undefined ? { stdin: request.stdin } : {}) });
      if (request.argv[1] === "pr") {
        return { exitCode: 0, signal: null, stdout: JSON.stringify({ url: "https://github.com/owner/repo/pull/42", headRefOid: "abcdef0123456" }), stderr: "" };
      }
      return { exitCode: 1, signal: null, stdout: "", stderr: "connection reset after request" };
    };
    const result = await command("pr-review.post").execute({ pr: "42", bodyFile }, context);
    expect(result).toMatchObject({
      status: "error", code: "pr-review.post.unknown-outcome",
      details: { outcome: "unknown", pr: 42, commitId: "abcdef0123456" },
    });
    expect(calls).toHaveLength(2);
  });

});
