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
    expect(tally.data).toMatchObject({ verdict: "blocked", scorePct: 57, tally: { mustFix: 1, nit: 1 } });

    const report = path.join(cwd, "report.md");
    writeFileSync(report, "# Fixture report\n");
    const validation = await command("pr-review.validate-report").execute({ reportFile: report }, context);
    expect(validation.status).toBe("refused");
    expect(validation.details).toMatchObject({ violations: expect.arrayContaining([expect.objectContaining({ code: expect.any(String) })]) });
  });
  test("report-path refusal preserves its authored target message and usage contract", async () => {
    const { context } = fixture();
    const result = await command("pr-review.report-path").execute({ reportsDir: ".", target: "unknown" }, context);
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
