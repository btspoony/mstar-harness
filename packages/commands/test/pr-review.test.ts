import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCommandDefinitions } from "../src/index.js";
import type { CommandDefinition, InvocationContext } from "../src/types.js";

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

describe("pr-review command family", () => {
  test("registers all PR-review identities alongside the process worktree setup command", () => {
    expect(getCommandDefinitions().filter(({ id }) => id.startsWith("pr-review.")).map(({ id }) => id)).toEqual([
      "pr-review.tally", "pr-review.report-path", "pr-review.validate-report", "pr-review.post",
      "pr-review.worktree-cleanup", "pr-review.size", "pr-review.seat-prompt", "pr-review.budget",
      "pr-review.worktree-setup",
    ]);
  });

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

  test("refuses unauthorized and wrong-target posts, and limits authorized writes to the gh API fixture", async () => {
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

});
