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

/** The rendered chat header of an ok envelope, narrowed rather than asserted. */
function chatHeaderOf(envelope: CommandEnvelope, label: string): string {
  if (envelope.status !== "ok" || envelope.data === null || typeof envelope.data !== "object" || !("chatHeader" in envelope.data) || typeof envelope.data.chatHeader !== "string") {
    throw new Error(`${label}: tally must return its chat header`);
  }
  return envelope.data.chatHeader;
}

/** The usage diagnostics of a refusal, narrowed rather than asserted. */
function diagnosticsOf(envelope: CommandEnvelope, label: string): readonly unknown[] {
  if (envelope.status === "ok") throw new Error(label);
  const diagnostics = envelope.details?.diagnostics;
  if (!Array.isArray(diagnostics)) throw new Error(`${label}: the refusal must carry structured diagnostics`);
  return diagnostics;
}

/** why: the hunk check needs a diff whose right-side spans are 1-5 and 30-35. */
const RANGE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,5 +1,5 @@",
  " one",
  " two",
  " three",
  " four",
  " five",
  "@@ -30,6 +30,6 @@",
  " thirty",
  " thirty-one",
  " thirty-two",
  " thirty-three",
  " thirty-four",
  " thirty-five",
  "",
].join("\n");

/** why: an added content line `++ b/src/a.ts` renders as `+++ b/src/a.ts`, so
 * the fixture proves file identity never comes from a `+++` line. */
const CONTENT_DIFF = [
  "diff --git a/src/c.ts b/src/c.ts",
  "--- a/src/c.ts",
  "+++ b/src/c.ts",
  "@@ -1,3 +1,4 @@",
  " one",
  " two",
  "+++ b/src/a.ts",
  " three",
  "@@ -30,2 +31,2 @@",
  " thirty",
  " thirty-one",
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  " alpha",
  " beta",
  "",
].join("\n");

/** why: a quoted header is the only signal for a path git must escape, and its
 * octal bytes must decode back to the spelling a finding uses. */
const QUOTED_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  " alpha",
  " beta",
  'diff --git "a/src/q\\"uote.ts" "b/src/q\\"uote.ts"',
  '--- "a/src/q\\"uote.ts"',
  '+++ "b/src/q\\"uote.ts"',
  "@@ -30,2 +31,2 @@",
  " thirty",
  " thirty-one",
  'diff --git "a/src/\\346\\227\\245.ts" "b/src/\\346\\227\\245.ts"',
  '--- "a/src/\\346\\227\\245.ts"',
  '+++ "b/src/\\346\\227\\245.ts"',
  "@@ -50,2 +51,2 @@",
  " fifty",
  " fifty-one",
  "",
].join("\n");

/** why: git leaves spaces unquoted, so the `diff --git` boundary carries an
 * ambiguous token pair; only `+++ ` names the right-side path. */
const SPACE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  " alpha",
  " beta",
  "diff --git a/src/file name.ts b/src/file name.ts",
  "--- a/src/file name.ts",
  "+++ b/src/file name.ts",
  "@@ -30,2 +31,2 @@",
  " thirty",
  " thirty-one",
  "",
].join("\n");

/** why: a rename may mix a bare old side with a quoted new side; `+++ ` is the
 * only line that names the destination the review comments on. */
const RENAME_DIFF = [
  'diff --git a/legacy-name.ts "b/src/q\\"uote.ts"',
  "similarity index 90%",
  "rename from legacy-name.ts",
  'rename to src/q"uote.ts',
  "--- a/legacy-name.ts",
  '+++ "b/src/q\\"uote.ts"',
  "@@ -40,2 +41,2 @@",
  " forty",
  " forty-one",
  "",
].join("\n");

/** why: git tabs a `+++` label whose path has a literal space and still
 * C-quotes the non-ASCII byte, so the tab must go before the quote split. */
const TAB_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  " alpha",
  " beta",
  'diff --git "a/src/file \\346\\227\\245.ts" "b/src/file \\346\\227\\245.ts"',
  '--- "a/src/file \\346\\227\\245.ts"',
  '+++ "b/src/file \\346\\227\\245.ts"\t2026-01-01 00:00:00 +0000',
  "@@ -60,2 +61,2 @@",
  " sixty",
  " sixty-one",
  "",
].join("\n");

/** why: the 422 fixture carries one range comment, so its anchor must be inside
 * a right-side hunk before the fold test can reach the POST. */
const FOLD_DIFF = [
  "diff --git a/src/g.ts b/src/g.ts",
  "--- a/src/g.ts",
  "+++ b/src/g.ts",
  "@@ -20,3 +20,3 @@",
  " twenty",
  " twenty-one",
  " twenty-two",
  "",
].join("\n");

describe("pr-review command family", () => {

  test("computes tally from fixture findings and validates fixture report verdicts", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, JSON.stringify([{ mergeClass: "must-fix" }, { mergeClass: "nit" }]));
    const tally = await command("pr-review.tally").execute(
      { findings, requiredDomains: "persist", openedDomains: "persist", diffBasis: "readable" },
      context,
    );
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
    expect(calls[0]!.argv).toEqual(["gh", "pr", "view", "42", "--json", "url,headRefOid,baseRefOid"]);

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

  test("post passes a contiguous range anchor through, and omits it for a single line", async () => {
    const { cwd, context, calls } = fixture();
    const bodyFile = path.join(cwd, "body.md");
    writeFileSync(bodyFile, "Review summary");
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, JSON.stringify([
      { path: "src/a.ts", line: 4, start_line: 2, start_side: "RIGHT", body: "Range finding" },
      { path: "src/b.ts", line: 4, body: "Single-line finding" },
    ]));
    const post = command("pr-review.post");
    const review = { exitCode: 0, signal: null, stdout: JSON.stringify({ url: "https://github.com/owner/repo/pull/42", headRefOid: "abcdef0123456", baseRefOid: "1234567" }), stderr: "" };
    const diff = { exitCode: 0, signal: null, stdout: RANGE_DIFF, stderr: "" };
    const posted = { exitCode: 0, signal: null, stdout: JSON.stringify({ html_url: "https://github.com/owner/repo/pull/42#review-1" }), stderr: "" };
    context.effects.spawn = async (request) => {
      calls.push({ argv: request.argv, cwd: request.cwd, ...(request.stdin !== undefined ? { stdin: request.stdin } : {}) });
      if (request.argv[1] === "pr") return review;
      return request.argv[2] === "-H" ? diff : posted;
    };
    const result = await post.execute({ pr: "42", bodyFile, findings }, context);
    expect(result.status).toBe("ok");
    expect(calls[1]!.argv).toEqual(["gh", "api", "-H", "Accept: application/vnd.github.v3.diff", "repos/owner/repo/compare/1234567...abcdef0123456"]);
    expect(JSON.parse(calls[2]!.stdin ?? "")).toMatchObject({
      comments: [
        { path: "src/a.ts", line: 4, side: "RIGHT", start_line: 2, start_side: "RIGHT", body: "Range finding" },
        { path: "src/b.ts", line: 4, side: "RIGHT", body: "Single-line finding" },
      ],
    });
    // why: this stdin is the payload the command itself serialized above.
    const body = JSON.parse(calls[2]!.stdin ?? "") as { comments: Record<string, unknown>[] };
    const single = body.comments[1]!;
    expect(Object.keys(single)).toEqual(["path", "line", "side", "body"]);
    // why: a backwards range is a caller mistake, never a 422-fold candidate.
    writeFileSync(findings, JSON.stringify([{ path: "src/a.ts", line: 12, start_line: 12, start_side: "RIGHT", body: "Backwards" }]));
    const rejected = await post.execute({ pr: "42", bodyFile, findings }, context);
    expect(rejected).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(rejected.message).toContain("findings[0].start_line must be an integer >= 1 and less than line (12)");
  });

  test("a range spanning two right-side hunks is refused before any POST", async () => {
    const { cwd, context, calls } = fixture();
    const bodyFile = path.join(cwd, "body.md");
    writeFileSync(bodyFile, "Review summary");
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, JSON.stringify([{ path: "src/a.ts", line: 31, start_line: 4, start_side: "RIGHT", body: "Cross-hunk" }]));
    const review = { exitCode: 0, signal: null, stdout: JSON.stringify({ url: "https://github.com/owner/repo/pull/42", headRefOid: "abcdef0123456", baseRefOid: "1234567" }), stderr: "" };
    const diff = { exitCode: 0, signal: null, stdout: RANGE_DIFF, stderr: "" };
    const posted = { exitCode: 0, signal: null, stdout: JSON.stringify({ html_url: "https://github.com/owner/repo/pull/42#review-1" }), stderr: "" };
    context.effects.spawn = async (request) => {
      calls.push({ argv: request.argv, cwd: request.cwd, ...(request.stdin !== undefined ? { stdin: request.stdin } : {}) });
      if (request.argv[1] === "pr") return review;
      return request.argv[2] === "-H" ? diff : posted;
    };
    const refused = await command("pr-review.post").execute({ pr: "42", bodyFile, findings }, context);
    expect(refused).toMatchObject({ status: "refused", code: "pr-review.post.range-spans-hunks", exitCode: 1 });
    expect(refused.message).toContain("comments[0] src/a.ts:4-31");
    expect(refused.message).toContain("hunks: 1-5, 30-35");
    expect(calls.map((call) => call.argv[2] === "-H" ? "compare" : call.argv[2] ?? call.argv[1])).toEqual(["view", "compare"]);
    // why: one hunk down, the same anchor is legal and must reach the POST.
    writeFileSync(findings, JSON.stringify([{ path: "src/a.ts", line: 4, start_line: 2, start_side: "RIGHT", body: "In-hunk" }]));
    calls.length = 0;
    const okResult = await command("pr-review.post").execute({ pr: "42", bodyFile, findings }, context);
    expect(okResult.status).toBe("ok");
    expect(JSON.parse(calls[2]!.stdin ?? "")).toMatchObject({ comments: [{ path: "src/a.ts", line: 4, start_line: 2, start_side: "RIGHT" }] });
  });

  test("an added `+++ b/<path>` content line never reattributes a file's hunks", async () => {
    const { cwd, context, calls } = fixture();
    const bodyFile = path.join(cwd, "body.md");
    writeFileSync(bodyFile, "Review summary");
    const findings = path.join(cwd, "findings.json");
    const review = { exitCode: 0, signal: null, stdout: JSON.stringify({ url: "https://github.com/owner/repo/pull/42", headRefOid: "abcdef0123456", baseRefOid: "1234567" }), stderr: "" };
    const diff = { exitCode: 0, signal: null, stdout: CONTENT_DIFF, stderr: "" };
    const posted = { exitCode: 0, signal: null, stdout: JSON.stringify({ html_url: "https://github.com/owner/repo/pull/42#review-1" }), stderr: "" };
    context.effects.spawn = async (request) => {
      calls.push({ argv: request.argv, cwd: request.cwd, ...(request.stdin !== undefined ? { stdin: request.stdin } : {}) });
      if (request.argv[1] === "pr") return review;
      return request.argv[2] === "-H" ? diff : posted;
    };
    // why: 31-32 is src/c.ts's second hunk, which follows the `+++ b/src/a.ts`
    // content line and must keep that attribution.
    writeFileSync(findings, JSON.stringify([{ path: "src/c.ts", line: 32, start_line: 31, start_side: "RIGHT", body: "Content hijack" }]));
    const okResult = await command("pr-review.post").execute({ pr: "42", bodyFile, findings }, context);
    expect(okResult.status).toBe("ok");
    // why: the same span on src/a.ts is not in that file's 1-2 hunk.
    writeFileSync(findings, JSON.stringify([{ path: "src/a.ts", line: 32, start_line: 31, start_side: "RIGHT", body: "Wrong file" }]));
    const refused = await command("pr-review.post").execute({ pr: "42", bodyFile, findings }, context);
    expect(refused).toMatchObject({ status: "refused", code: "pr-review.post.range-spans-hunks" });
    expect(refused.message).toContain("comments[0] src/a.ts:31-32");
    expect(refused.message).toContain("hunks: 1-2");
  });

  test("a quoted diff header keeps its own hunks, decoded to the finding's spelling", async () => {
    const { cwd, context, calls } = fixture();
    const bodyFile = path.join(cwd, "body.md");
    writeFileSync(bodyFile, "Review summary");
    const findings = path.join(cwd, "findings.json");
    const review = { exitCode: 0, signal: null, stdout: JSON.stringify({ url: "https://github.com/owner/repo/pull/42", headRefOid: "abcdef0123456", baseRefOid: "1234567" }), stderr: "" };
    const diff = { exitCode: 0, signal: null, stdout: QUOTED_DIFF, stderr: "" };
    const posted = { exitCode: 0, signal: null, stdout: JSON.stringify({ html_url: "https://github.com/owner/repo/pull/42#review-1" }), stderr: "" };
    context.effects.spawn = async (request) => {
      calls.push({ argv: request.argv, cwd: request.cwd, ...(request.stdin !== undefined ? { stdin: request.stdin } : {}) });
      if (request.argv[1] === "pr") return review;
      return request.argv[2] === "-H" ? diff : posted;
    };
    // why: the escaped path (and the octal-encoded one) must match the decoded
    // spelling, while neither may inherit the previous file's hunks.
    for (const [file, start, line] of [['src/q"uote.ts', 31, 32], ["src/日.ts", 51, 52]] as const) {
      writeFileSync(findings, JSON.stringify([{ path: file, line, start_line: start, start_side: "RIGHT", body: "Quoted path" }]));
      const okResult = await command("pr-review.post").execute({ pr: "42", bodyFile, findings }, context);
      expect(okResult.status, file).toBe("ok");
    }
    writeFileSync(findings, JSON.stringify([{ path: "src/a.ts", line: 32, start_line: 31, start_side: "RIGHT", body: "Wrong file" }]));
    const refused = await command("pr-review.post").execute({ pr: "42", bodyFile, findings }, context);
    expect(refused).toMatchObject({ status: "refused", code: "pr-review.post.range-spans-hunks" });
    expect(refused.message).toContain("comments[0] src/a.ts:31-32");
    expect(refused.message).toContain("hunks: 1-2");
  });

  test("an unquoted spaced path keeps its own hunks", async () => {
    const { cwd, context, calls } = fixture();
    const bodyFile = path.join(cwd, "body.md");
    writeFileSync(bodyFile, "Review summary");
    const findings = path.join(cwd, "findings.json");
    const review = { exitCode: 0, signal: null, stdout: JSON.stringify({ url: "https://github.com/owner/repo/pull/42", headRefOid: "abcdef0123456", baseRefOid: "1234567" }), stderr: "" };
    const diff = { exitCode: 0, signal: null, stdout: SPACE_DIFF, stderr: "" };
    const posted = { exitCode: 0, signal: null, stdout: JSON.stringify({ html_url: "https://github.com/owner/repo/pull/42#review-1" }), stderr: "" };
    context.effects.spawn = async (request) => {
      calls.push({ argv: request.argv, cwd: request.cwd, ...(request.stdin !== undefined ? { stdin: request.stdin } : {}) });
      if (request.argv[1] === "pr") return review;
      return request.argv[2] === "-H" ? diff : posted;
    };
    writeFileSync(findings, JSON.stringify([{ path: "src/file name.ts", line: 32, start_line: 31, start_side: "RIGHT", body: "Spaced path" }]));
    const okResult = await command("pr-review.post").execute({ pr: "42", bodyFile, findings }, context);
    expect(okResult.status).toBe("ok");
    writeFileSync(findings, JSON.stringify([{ path: "src/a.ts", line: 32, start_line: 31, start_side: "RIGHT", body: "Wrong file" }]));
    const refused = await command("pr-review.post").execute({ pr: "42", bodyFile, findings }, context);
    expect(refused).toMatchObject({ status: "refused", code: "pr-review.post.range-spans-hunks" });
    expect(refused.message).toContain("comments[0] src/a.ts:31-32");
    expect(refused.message).toContain("hunks: 1-2");
  });

  test("a mixed bare/quoted rename attributes hunks to the +++ destination", async () => {
    const { cwd, context, calls } = fixture();
    const bodyFile = path.join(cwd, "body.md");
    writeFileSync(bodyFile, "Review summary");
    const findings = path.join(cwd, "findings.json");
    const review = { exitCode: 0, signal: null, stdout: JSON.stringify({ url: "https://github.com/owner/repo/pull/42", headRefOid: "abcdef0123456", baseRefOid: "1234567" }), stderr: "" };
    const diff = { exitCode: 0, signal: null, stdout: RENAME_DIFF, stderr: "" };
    const posted = { exitCode: 0, signal: null, stdout: JSON.stringify({ html_url: "https://github.com/owner/repo/pull/42#review-1" }), stderr: "" };
    context.effects.spawn = async (request) => {
      calls.push({ argv: request.argv, cwd: request.cwd, ...(request.stdin !== undefined ? { stdin: request.stdin } : {}) });
      if (request.argv[1] === "pr") return review;
      return request.argv[2] === "-H" ? diff : posted;
    };
    writeFileSync(findings, JSON.stringify([{ path: 'src/q"uote.ts', line: 42, start_line: 41, start_side: "RIGHT", body: "Rename destination" }]));
    const okResult = await command("pr-review.post").execute({ pr: "42", bodyFile, findings }, context);
    expect(okResult.status).toBe("ok");
    // why: the bare old-side name owns no right-side hunk in this diff.
    writeFileSync(findings, JSON.stringify([{ path: "legacy-name.ts", line: 42, start_line: 41, start_side: "RIGHT", body: "Rename source" }]));
    const refused = await command("pr-review.post").execute({ pr: "42", bodyFile, findings }, context);
    expect(refused).toMatchObject({ status: "refused", code: "pr-review.post.range-spans-hunks" });
    expect(refused.message).toContain("no right-side hunk for this path");
  });

  test("a tab-suffixed quoted label still yields the path a finding spells", async () => {
    const { cwd, context, calls } = fixture();
    const bodyFile = path.join(cwd, "body.md");
    writeFileSync(bodyFile, "Review summary");
    const findings = path.join(cwd, "findings.json");
    const review = { exitCode: 0, signal: null, stdout: JSON.stringify({ url: "https://github.com/owner/repo/pull/42", headRefOid: "abcdef0123456", baseRefOid: "1234567" }), stderr: "" };
    const diff = { exitCode: 0, signal: null, stdout: TAB_DIFF, stderr: "" };
    const posted = { exitCode: 0, signal: null, stdout: JSON.stringify({ html_url: "https://github.com/owner/repo/pull/42#review-1" }), stderr: "" };
    context.effects.spawn = async (request) => {
      calls.push({ argv: request.argv, cwd: request.cwd, ...(request.stdin !== undefined ? { stdin: request.stdin } : {}) });
      if (request.argv[1] === "pr") return review;
      return request.argv[2] === "-H" ? diff : posted;
    };
    writeFileSync(findings, JSON.stringify([{ path: "src/file 日.ts", line: 62, start_line: 61, start_side: "RIGHT", body: "Spaced quoted path" }]));
    const okResult = await command("pr-review.post").execute({ pr: "42", bodyFile, findings }, context);
    expect(okResult.status).toBe("ok");
    writeFileSync(findings, JSON.stringify([{ path: "src/a.ts", line: 62, start_line: 61, start_side: "RIGHT", body: "Wrong file" }]));
    const refused = await command("pr-review.post").execute({ pr: "42", bodyFile, findings }, context);
    expect(refused).toMatchObject({ status: "refused", code: "pr-review.post.range-spans-hunks" });
    expect(refused.message).toContain("hunks: 1-2");
  });

  test("a range without a pinned base is refused instead of validated against a moving head", async () => {
    const { cwd, context, calls } = fixture();
    const bodyFile = path.join(cwd, "body.md");
    writeFileSync(bodyFile, "Review summary");
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, JSON.stringify([{ path: "src/a.ts", line: 4, start_line: 2, start_side: "RIGHT", body: "Range finding" }]));
    context.effects.spawn = async (request) => {
      calls.push({ argv: request.argv, cwd: request.cwd, ...(request.stdin !== undefined ? { stdin: request.stdin } : {}) });
      return { exitCode: 0, signal: null, stdout: JSON.stringify({ url: "https://github.com/owner/repo/pull/42", headRefOid: "abcdef0123456" }), stderr: "" };
    };
    const refused = await command("pr-review.post").execute({ pr: "42", bodyFile, findings }, context);
    expect(refused).toMatchObject({ status: "refused", code: "pr-review.post.diff-unavailable", exitCode: 1 });
    expect(refused.message).toContain("at abcdef0123456: pr view returned no baseRefOid");
    expect(calls).toHaveLength(1);
  });

  test("a lone range field is a usage refusal, never a silent drop", async () => {
    const { cwd, context, calls } = fixture();
    const bodyFile = path.join(cwd, "body.md");
    writeFileSync(bodyFile, "Review summary");
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, JSON.stringify([{ start_side: "RIGHT" }]));
    const refused = await command("pr-review.post").execute({ pr: "42", bodyFile, findings }, context);
    expect(refused).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(refused.message).toContain("findings[0] must be {path: string, line: number >= 1, body: string}");
    expect(calls).toHaveLength(0);
  });

  test("422 retry folds the body without its suggestion fence and drops inline comments", async () => {
    const { cwd, context, calls } = fixture();
    const bodyFile = path.join(cwd, "body.md");
    writeFileSync(bodyFile, "Review summary");
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, JSON.stringify([
      { path: "src/a.ts", line: 3, body: "Unhandled null deref\n\nEvidence: `foo()` returns null before the deref.\n\nFix sketch: guard it.\n\n```suggestion\nconst v = fallback;\n```" },
      { path: "src/b.ts", line: 9, body: "```suggestion\nconst x = 1;\n```" },
      { path: "src/c.ts", line: 4, body: "Tainted query\n\nEvidence: the docs quote this shape:\n\n```suggestion\n// example only\n```\n\nImpact: injection.\n\nFix sketch: parameterize it.\n\n```suggestion\nconst q = query(text, params);\n```" },
      { path: "src/d.ts", line: 7, body: "Mid-body example\n\nEvidence: docs show:\n\n```suggestion\n// quoted only\n```\n\nFix sketch: keep the prose after the quote." },
      { path: "src/e.ts", line: 11, body: "Fence inside replacement\n\nFix sketch: keep the marker.\n\n```suggestion\nconst a = 1;\n```\nconst b = 2;\n```" },
      { path: "src/f.ts", line: 5, body: "Race on cache\n\nEvidence:\n\n```suggestion\ncache.set(k,v)\n```\n\nImpact: lost writes.\n\n```ts\ncache.set(k, v)\n```" },
      { path: "src/g.ts", line: 22, start_line: 20, start_side: "RIGHT", body: "Range finding\n\nFix sketch: tighten it.\n\n```suggestion\nconst a = 1;\nconst b = 2;\n```" },
    ]));
    let apiCalls = 0;
    context.effects.spawn = async (request) => {
      calls.push({ argv: request.argv, cwd: request.cwd, ...(request.stdin !== undefined ? { stdin: request.stdin } : {}) });
      if (request.argv[1] === "pr") return { exitCode: 0, signal: null, stdout: JSON.stringify({ url: "https://github.com/owner/repo/pull/42", headRefOid: "abcdef0123456", baseRefOid: "1234567" }), stderr: "" };
      if (request.argv[2] === "-H") return { exitCode: 0, signal: null, stdout: FOLD_DIFF, stderr: "" };
      apiCalls += 1;
      if (apiCalls === 1) return { exitCode: 1, signal: null, stdout: "", stderr: 'HTTP 422: "line" must be part of the diff' };
      return { exitCode: 0, signal: null, stdout: JSON.stringify({ html_url: "https://github.com/owner/repo/pull/42#review-2" }), stderr: "" };
    };
    const result = await command("pr-review.post").execute({ pr: "42", bodyFile, findings }, context);
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(4);
    const retried = JSON.parse(calls[3]!.stdin ?? "") as { body: string; comments?: unknown };
    expect(retried.comments).toBeUndefined();
    expect(retried.body).toContain("## Inline comments folded into this summary");
    // why: a range comment keeps its start anchor in the fold; single-line
    // comments stay `path:line`.
    expect(retried.body).toContain("`src/g.ts:20-22` — Range finding");
    expect(retried.body).toContain("`src/a.ts:3` — Unhandled null deref");
    expect(retried.body).toContain("`src/b.ts:9` — (inline suggestion omitted: no anchor after 422)");
    expect(retried.body).toContain("Unhandled null deref");
    expect(retried.body).toContain("Fix sketch: guard it.");
    expect(retried.body).toContain("(inline suggestion omitted: no anchor after 422)");
    expect(retried.body).toContain("// example only");
    expect(retried.body).toContain("Fix sketch: parameterize it.");
    expect(retried.body).not.toContain("const q = query(text, params);");
    expect(retried.body).toContain("// quoted only");
    expect(retried.body).toContain("Fix sketch: keep the prose after the quote.");
    expect(retried.body).toContain("Fence inside replacement");
    expect(retried.body).toContain("Fix sketch: keep the marker.");
    expect(retried.body).not.toContain("const a = 1;");
    expect(retried.body).not.toContain("const b = 2;");
    expect(retried.body).toContain("Impact: lost writes.");
    expect(retried.body).toContain("cache.set(k, v)");
    expect(retried.body.split("```suggestion")).toHaveLength(4); // why: two quoted examples plus the unbalanced src/f body stay, the trailing blocks are gone
    expect(retried.body).not.toContain("const v = fallback;");
    expect(retried.body).not.toContain("const x = 1;");
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
      chatHeader: "blocked \u00b7 53% (fail)\nmust-fix=1 should-fix=0 may-fix=0 nit=1",
    });
    expect(settled.data).not.toMatchObject({ incomplete: expect.anything() });
  });

  test("tests/docs-surface AC counts feed may-fix and never select a verdict", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, "[]");
    const facts = { findings, requiredDomains: "persist", openedDomains: "persist", diffBasis: "readable" };

    const surfaceOnly = await command("pr-review.tally").execute(
      { ...facts, unmetAcTests: "1", unmetAcDocs: "1" },
      context,
    );
    expect(surfaceOnly.status).toBe("ok");
    // 6 + 4 deducted; a tests/docs leftover AC can neither block nor demand a fix round.
    expect(surfaceOnly.data).toMatchObject({
      verdict: "ship it",
      scorePct: 90,
      tally: { mustFix: 0, shouldFix: 0, mayFix: 2, nit: 0 },
    });

    const withImplementation = await command("pr-review.tally").execute(
      { ...facts, unmetAcTests: "3", unmetAcSafe: "1" },
      context,
    );
    expect(withImplementation.status).toBe("ok");
    expect(withImplementation.data).toMatchObject({
      verdict: "needs fixes",
      tally: { mustFix: 0, shouldFix: 1, mayFix: 3, nit: 0 },
    });
  });

  test("tally help documents every count input and the bucket it feeds", () => {
    const tally = command("pr-review.tally");
    const help = (key: string) => tally.cli.options.find((option) => option.key === key)?.help ?? "";
    for (const key of ["unmetAcUnsafe", "unmetAcSafe", "unmetAcTests", "unmetAcDocs"]) {
      expect(help(key)).toContain("Optional; non-negative integer no greater than 50; defaults to 0;");
    }
    expect(help("unmetAcUnsafe")).toContain("must-fix");
    expect(help("unmetAcSafe")).toContain("should-fix");
    expect(help("unmetAcTests")).toContain("may-fix");
    expect(help("unmetAcDocs")).toContain("may-fix");
  });

  test("tally derives incomplete from a required domain that never opened", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, JSON.stringify([{ mergeClass: "must-fix" }, { mergeClass: "nit" }]));

    const partial = await command("pr-review.tally").execute(
      { findings, requiredDomains: "persist,security", openedDomains: "persist", diffBasis: "readable" },
      context,
    );
    expect(partial.status).toBe("ok");
    expect(partial.data).toMatchObject({
      verdict: "incomplete",
      scorePct: 53,
      band: "fail",
      incomplete: { reason: "required domain seat(s) never opened: security", unscanned: ["security"] },
      chatHeader:
        "incomplete \u00b7 53% (fail, partial)\nmust-fix=1 should-fix=0 may-fix=0 nit=1\n" +
        "cause: required domain seat(s) never opened: security\nunscanned: security",
    });
  });

  test("tally derives incomplete from a stopped run and from an unreadable diff basis", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, "[]");

    const stopped = await command("pr-review.tally").execute(
      { findings, stopped: "cancelled before synthesis", requiredDomains: "persist", openedDomains: "persist", diffBasis: "readable" },
      context,
    );
    expect(stopped.status).toBe("ok");
    expect(stopped.data).toMatchObject({
      verdict: "incomplete",
      incomplete: { reason: "the run stopped before synthesis \u2014 cancelled before synthesis", unscanned: [] },
    });

    const unreadable = await command("pr-review.tally").execute(
      { findings, requiredDomains: "persist", openedDomains: "persist", diffBasis: "unreadable" },
      context,
    );
    expect(unreadable.status).toBe("ok");
    expect(unreadable.data).toMatchObject({
      verdict: "incomplete",
      incomplete: { reason: "the resolved diff basis could not be read", unscanned: ["the resolved diff basis"] },
    });
  });

  test("tally counts seats, not domains, and widens a stopped run with declared partial scope", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, "[]");

    // Two seats in one domain: the single opened entry leaves the second
    // required seat unaccounted.
    const oneSeat = await command("pr-review.tally").execute(
      { findings, requiredDomains: "api,api", openedDomains: "api", diffBasis: "readable" },
      context,
    );
    expect(oneSeat.data).toMatchObject({
      verdict: "incomplete",
      incomplete: { reason: "required domain seat(s) never opened: api", unscanned: ["api"] },
    });

    const bothSeats = await command("pr-review.tally").execute(
      { findings, requiredDomains: "api,api", openedDomains: "api,api", diffBasis: "readable" },
      context,
    );
    expect(bothSeats.data).toMatchObject({ verdict: "ship it" });

    // Complete coverage plus a truncated seat scope: the scope still travels.
    const truncated = await command("pr-review.tally").execute(
      {
        findings, stopped: "cancelled before synthesis", requiredDomains: "dashboard",
        openedDomains: "dashboard", diffBasis: "readable", partialScope: ["dashboard HTTP server"],
      },
      context,
    );
    expect(truncated.data).toMatchObject({
      verdict: "incomplete",
      incomplete: {
        reason: "the run stopped before synthesis \u2014 cancelled before synthesis",
        unscanned: ["dashboard HTTP server"],
      },
    });
  });

  test("a settled run echoes a declared partial scope as declaredScopes and keeps the header", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, "[]");
    const settled = { findings, requiredDomains: "persist", openedDomains: "persist", diffBasis: "readable" };

    const bare = await command("pr-review.tally").execute(settled, context);
    const declared = await command("pr-review.tally").execute({ ...settled, partialScope: ["docs", "docs", "cli"] }, context);
    expect(declared.status).toBe("ok");
    expect(declared).toMatchObject({ data: { verdict: "ship it", declaredScopes: ["docs", "cli"] } });
    expect(chatHeaderOf(declared, "settled with a declared scope")).toBe(chatHeaderOf(bare, "settled without one"));
  });

  test("tally help and constraints state one entry per seat for both domain options", () => {
    const tally = command("pr-review.tally");
    for (const key of ["requiredDomains", "openedDomains"]) {
      const help = tally.cli.options.find((option) => option.key === key)?.help ?? "";
      expect(help).toContain("one entry per");
      expect(help).toContain("seat");
      const constraints = tally.requirements.filter((requirement) => requirement.name === key).map((requirement) => requirement.constraint ?? "");
      expect(constraints.length).toBeGreaterThan(0);
      for (const constraint of constraints) {
        expect(constraint).toContain("one entry per");
        expect(constraint).toContain("seat");
        expect(constraint).toContain("twice");
      }
    }
  });

  test("tally reports an invalid --partial-scope entry with the other field faults", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, "[]");

    const refusal = await command("pr-review.tally").execute(
      {
        findings, requiredDomains: "persist", openedDomains: "persist", diffBasis: "readable",
        partialScope: ["dashboard HTTP server", "  "], unmetAcUnsafe: "x",
      },
      context,
    );
    expect(refusal).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(diagnosticsOf(refusal, "invalid run facts")).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "partialScope", code: "invalid" }),
      expect.objectContaining({ path: "unmetAcUnsafe", code: "invalid" }),
    ]));
  });

  test("tally reports every invalid run fact in one refusal", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, "[]");
    const facts = {
      findings, stopped: " ", requiredDomains: "persist,, security",
      openedDomains: "persist, ", diffBasis: "readable", unmetAcUnsafe: "x",
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
        expect.objectContaining({ path: "unmetAcUnsafe", code: "invalid" }),
      ]));
      const text = refusal.status === "ok" ? "" : refusal.message;
      expect(text).toContain("--stopped must be a single line of non-blank text");
      expect(text).toContain("--unmet-ac-unsafe must be a non-negative integer no greater than 50");
    }
  });

  test("--required-domains reports exactly one diagnostic per supplied value", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, "[]");
    const base = { findings, openedDomains: "persist", diffBasis: "readable" };

    // An explicitly empty value asks for the "at least one" repair; a
    // malformed list reports its parse fault and nothing else — the two
    // repairs are opposite, so one field never carries both.
    const cases = [
      ["", ["--required-domains must name at least one domain"]],
      ["persist,,", ["--required-domains must be a comma-separated list of single-line non-blank entries"]],
    ] as const;
    for (const [requiredDomains, messages] of cases) {
      const refusal = await command("pr-review.tally").execute({ ...base, requiredDomains }, context);
      expect(refusal).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
      expect(diagnosticsOf(refusal, `--required-domains ${JSON.stringify(requiredDomains)}`)).toEqual(
        messages.map((message) => ({ path: "requiredDomains", code: "invalid", message })),
      );
    }
  });

  test("an omitted coverage fact joins an invalid count and an invalid findings entry in one refusal", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, JSON.stringify([{}]));
    // Omission is enforced by the family's one collection phase, not by
    // admission, so a call that omits a fact and also carries an invalid
    // count and payload reports all three in one refusal
    // (packages/cli/AGENTS.md § Aggregated validation).
    const facts = { findings, requiredDomains: "persist", openedDomains: "persist", unmetAcUnsafe: "x" };

    for (const refusal of [
      await command("pr-review.tally").execute(facts, context),
      await executeCommand("pr-review.tally", facts, context),
    ]) {
      expect(refusal).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
      expect(diagnosticsOf(refusal, "omitted fact with invalid count and findings")).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "diffBasis", code: "required" }),
        expect.objectContaining({ path: "unmetAcUnsafe", code: "invalid" }),
        expect.objectContaining({ path: "findings", code: "invalid" }),
      ]));
      const text = refusal.status === "ok" ? "" : refusal.message;
      expect(text).toContain("Rejected diffBasis: expected present; received undefined");
      expect(text).toContain("--unmet-ac-unsafe must be a non-negative integer no greater than 50");
      expect(text).toContain("findings[0].mergeClass must be one of must-fix | should-fix | may-fix | nit");
    }
  });

  test.each([
    ["--required-domains", { openedDomains: "persist", diffBasis: "readable" }, "requiredDomains"],
    ["--opened-domains", { requiredDomains: "persist", diffBasis: "readable" }, "openedDomains"],
    ["--diff-basis", { requiredDomains: "persist", openedDomains: "persist" }, "diffBasis"],
  ])("tally refuses a run that omits %s instead of inferring coverage", async (flag, facts, field) => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, "[]");

    // Fail-closed: no default stands in for an unreported coverage fact. The
    // family's collection phase owns the refusal, so the message names the
    // flag the caller must add.
    for (const refusal of [
      await command("pr-review.tally").execute({ findings, ...facts }, context),
      await executeCommand("pr-review.tally", { findings, ...facts }, context),
    ]) {
      expect(refusal).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
      expect(diagnosticsOf(refusal, `omitted ${flag}`)).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: field, code: "required" }),
      ]));
    }
    const direct = await command("pr-review.tally").execute({ findings, ...facts }, context);
    expect(direct.status === "ok" ? "" : direct.message).toContain(`${flag} is required`);
  });

  test("tally reports every omitted coverage fact in one refusal", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, "[]");

    for (const refusal of [
      await command("pr-review.tally").execute({ findings }, context),
      await executeCommand("pr-review.tally", { findings }, context),
    ]) {
      expect(refusal).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
      expect(diagnosticsOf(refusal, "every omitted fact")).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "requiredDomains", code: "required" }),
        expect.objectContaining({ path: "openedDomains", code: "required" }),
        expect.objectContaining({ path: "diffBasis", code: "required" }),
      ]));
    }
  });

  test("an invalid diff basis joins the other tally faults instead of being short-circuited at admission", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, JSON.stringify([{}]));
    const flags = { findings, openedDomains: "persist", diffBasis: "maybe", unmetAcUnsafe: "x" };

    // Admission must not reject the basis on its own: the family's collection
    // phase is the single validator, so one call reports the invalid basis
    // beside the omitted --required-domains, the invalid count and the invalid
    // findings entry (packages/cli/AGENTS.md § Aggregated validation). The
    // direct execute route and the admitted one agree.
    for (const refusal of [
      await command("pr-review.tally").execute(flags, context),
      await executeCommand("pr-review.tally", flags, context),
    ]) {
      expect(refusal).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
      expect(diagnosticsOf(refusal, "combined tally faults")).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "diffBasis", code: "invalid" }),
        expect.objectContaining({ path: "requiredDomains", code: "required" }),
        expect.objectContaining({ path: "unmetAcUnsafe", code: "invalid" }),
        expect.objectContaining({ path: "findings", code: "invalid" }),
      ]));
      const text = refusal.status === "ok" ? "" : refusal.message;
      expect(text).toContain("--diff-basis must be readable or unreadable");
      expect(text).toContain("Rejected requiredDomains: expected present; received undefined");
      expect(text).toContain("--unmet-ac-unsafe must be a non-negative integer no greater than 50");
      expect(text).toContain("findings[0].mergeClass must be one of must-fix | should-fix | may-fix | nit");
    }
  });

  test("a multi-line stop and an unaccepted diff basis are caller errors", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, "[]");

    const refused = await command("pr-review.tally").execute(
      { findings, stopped: "cancelled\nbefore synthesis", requiredDomains: "persist", openedDomains: "persist", diffBasis: "readable" },
      context,
    );
    expect(refused).toMatchObject({
      status: "usage", code: "command.invalid-input", exitCode: 2,
      message: "--stopped must be a single line of non-blank text",
    });
    // Both routes report the same family diagnostic: admission declares no
    // accepted values for the basis, so the collection phase validates it.
    for (const badBasis of [
      await command("pr-review.tally").execute(
        { findings, requiredDomains: "persist", openedDomains: "persist", diffBasis: "maybe" },
        context,
      ),
      await executeCommand(
        "pr-review.tally",
        { findings, requiredDomains: "persist", openedDomains: "persist", diffBasis: "maybe" },
        context,
      ),
    ]) {
      expect(badBasis).toMatchObject({
        status: "usage", code: "command.invalid-input", exitCode: 2,
        message: "--diff-basis must be readable or unreadable",
      });
      expect(diagnosticsOf(badBasis, "invalid diff basis")).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "diffBasis", code: "invalid" }),
      ]));
    }
  });

  test("findings-payload errors join the run-fact diagnostics in one refusal", async () => {
    const { cwd, context } = fixture();
    const findings = path.join(cwd, "findings.json");
    writeFileSync(findings, JSON.stringify([{}]));
    const facts = { findings, stopped: " ", requiredDomains: "persist", openedDomains: "persist", diffBasis: "readable" };

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
      expect(text).toContain("findings[0].mergeClass must be one of must-fix | should-fix | may-fix | nit");
      expect(text).toContain("--stopped must be a single line of non-blank text");
    }

    // A missing findings file is the same caller-correctable class (usage, exit
    // 2), not a failed execution, and joins the same refusal.
    const missing = await command("pr-review.tally").execute(
      { findings: path.join(cwd, "absent.json"), stopped: " ", requiredDomains: "persist", openedDomains: "persist", diffBasis: "readable" },
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
      { findings: malformedFile, stopped: " ", requiredDomains: "persist", openedDomains: "persist", diffBasis: "readable" },
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

  test("thread-gate refuses unresolved threads and accepts a matching two-confirmation record", async () => {
    const { cwd, context, calls } = fixture();
    const head = "abcdef0123456";
    const review = { exitCode: 0, signal: null, stdout: JSON.stringify({ url: "https://github.com/owner/repo/pull/42", headRefOid: head }), stderr: "" };
    let pageHead = head;
    const nodes: Record<string, unknown>[] = [
      { id: "T1", isResolved: false, isOutdated: false, path: "src/a.ts", line: 42, comments: { nodes: [{ author: { login: "bot" }, body: "should-fix" }] } },
      { id: "T2", isResolved: true, isOutdated: false, path: "src/b.ts", line: 7, comments: { nodes: [{ author: { login: "human" }, body: "question" }] } },
    ];
    const threads = () => ({ exitCode: 0, signal: null, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: pageHead, reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } }), stderr: "" });
    context.effects.spawn = async (request) => {
      calls.push({ argv: request.argv, cwd: request.cwd, ...(request.stdin !== undefined ? { stdin: request.stdin } : {}) });
      if (request.argv[1] === "pr") return review;
      return threads();
    };
    const gate = command("pr-review.thread-gate");
    const refused = await gate.execute({ pr: "42" }, context);
    expect(refused).toMatchObject({ status: "refused", code: "prreview.thread-gate.unresolved", exitCode: 1 });
    expect(refused.status === "ok" ? {} : refused.details).toMatchObject({ head, unresolved: [{ id: "T1", author: "bot", path: "src/a.ts", line: 42 }] });
    // why: the scan must read the host that served the PR, not whatever host
    // `gh api` would default to.
    expect(calls[1]!.argv).toEqual(expect.arrayContaining(["graphql", "--hostname", "github.com"]));

    const digest = (refused.status === "ok" ? {} : refused.details)?.digest as string;
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    const confirm = path.join(cwd, "confirm.json");
    writeFileSync(confirm, JSON.stringify({ head, confirmations: 2, threads: ["T1"], digest }));
    const allowed = await gate.execute({ pr: "42", confirm }, context);
    expect(allowed).toMatchObject({ status: "ok" });
    expect(allowed.status === "ok" ? allowed.data : {}).toMatchObject({ mergeAllowed: true, head, digest, unresolved: [{ id: "T1" }] });

    // why: an edited opening comment keeps the id, so only the digest can show
    // that what the user confirmed is no longer what the thread says.
    nodes[0] = { ...nodes[0], comments: { nodes: [{ author: { login: "bot" }, body: "now a behaviour bug" }] } };
    const edited = await gate.execute({ pr: "42", confirm }, context);
    expect(edited).toMatchObject({ status: "refused", code: "prreview.thread-gate.confirmation-invalid" });
    expect(edited.status === "ok" ? "" : JSON.stringify(edited.details)).toContain("digest does not match");

    writeFileSync(confirm, JSON.stringify({ head, confirmations: 1, threads: ["T1"], digest }));
    const once = await gate.execute({ pr: "42", confirm }, context);
    expect(once).toMatchObject({ status: "refused", code: "prreview.thread-gate.confirmation-invalid" });
    expect(once.status === "ok" ? "" : JSON.stringify(once.details)).toContain("2 are required");

    // why: a head that moves while the threads are read makes the enumeration
    // stale, so the scan refuses instead of answering for the old head.
    pageHead = "9999999999999";
    const moved = await gate.execute({ pr: "42" }, context);
    expect(moved).toMatchObject({ status: "refused", code: "pr-review.thread-gate.head-moved" });
  });

});
