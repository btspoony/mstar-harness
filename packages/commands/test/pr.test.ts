/**
 * why: `mstar pr merge-gate` is the §5.3a merge gate for any pull request, so
 * its behavioural suite covers the refusal, the confirmation record and the
 * clean path. Exit codes: 0 = merge allowed, 1 = refusal (unresolved threads,
 * moved head, unavailable, invalid confirmation), 2 = usage.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCommandDefinitions } from "../src/index.js";
import { registerMergeGateProvider, type MergeGateProvider } from "../src/families/pr.js";
import type { CommandDefinition, InvocationContext } from "../src/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "pr-family-"));
  roots.push(cwd);
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

describe("pr merge-gate", () => {
  test("refuses unresolved threads and accepts a matching two-confirmation record", async () => {
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
    const gate = command("pr.merge-gate");
    const refused = await gate.execute({ pr: "42" }, context);
    expect(refused).toMatchObject({ status: "refused", code: "pr.merge-gate.unresolved", exitCode: 1 });
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
    expect(edited).toMatchObject({ status: "refused", code: "pr.merge-gate.confirmation-invalid" });
    expect(edited.status === "ok" ? "" : JSON.stringify(edited.details)).toContain("digest does not match");

    writeFileSync(confirm, JSON.stringify({ head, confirmations: 1, threads: ["T1"], digest }));
    const once = await gate.execute({ pr: "42", confirm }, context);
    expect(once).toMatchObject({ status: "refused", code: "pr.merge-gate.confirmation-invalid" });
    expect(once.status === "ok" ? "" : JSON.stringify(once.details)).toContain("2 are required");

    // why: a missing or unreadable confirmation file is caller input, so it
    // must report usage (exit 2), not an execution failure.
    const missing = await gate.execute({ pr: "42", confirm: path.join(cwd, "absent.json") }, context);
    expect(missing).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    // why: an existing but unreadable path (a directory) must name the read
    // failure, not be reported as malformed JSON.
    const unreadable = await gate.execute({ pr: "42", confirm: cwd }, context);
    expect(unreadable).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    expect(unreadable.status === "ok" ? "" : unreadable.message).toContain("cannot read the confirmation file");
    expect(unreadable.status === "ok" ? "" : JSON.stringify(unreadable)).toContain("mstar pr merge-gate --pr <n> --provider github --confirm <file>");
    writeFileSync(confirm, "{ not json");
    const garbage = await gate.execute({ pr: "42", confirm }, context);
    expect(garbage).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });

    // why: a head that moves while the threads are read makes the enumeration
    // stale, so the scan refuses instead of answering for the old head.
    pageHead = "9999999999999";
    const moved = await gate.execute({ pr: "42" }, context);
    expect(moved).toMatchObject({ status: "refused", code: "pr.merge-gate.head-moved" });
  });

  test("a clean PR needs no confirmation record", async () => {
    const { context } = fixture();
    const head = "abcdef0123456";
    context.effects.spawn = async (request) => request.argv[1] === "pr"
      ? { exitCode: 0, signal: null, stdout: JSON.stringify({ url: "https://github.com/owner/repo/pull/42", headRefOid: head }), stderr: "" }
      : { exitCode: 0, signal: null, stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: head, reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: "T1", isResolved: true, comments: { nodes: [] } }] } } } } }), stderr: "" };
    const clean = await command("pr.merge-gate").execute({ pr: "42" }, context);
    expect(clean).toMatchObject({ status: "ok" });
    expect(clean.status === "ok" ? clean.data : {}).toMatchObject({ mergeAllowed: true, head, unresolved: [] });
  });

  test("the page cap refuses with its own code, and a raised cap completes the scan", async () => {
    const { context } = fixture();
    const head = "abcdef0123456";
    let pages = 0;
    context.effects.spawn = async (request) => {
      if (request.argv[1] === "pr") {
        return { exitCode: 0, signal: null, stdout: JSON.stringify({ url: "https://github.com/owner/repo/pull/42", headRefOid: head }), stderr: "" };
      }
      pages += 1;
      const more = pages < 2;
      return {
        exitCode: 0, signal: null, stderr: "",
        stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid: head, reviewThreads: { pageInfo: { hasNextPage: more, endCursor: more ? `cursor-${pages}` : null }, nodes: [] } } } } }),
      };
    };
    const gate = command("pr.merge-gate");
    const capped = await gate.execute({ pr: "42", maxPages: "1" }, context);
    expect(capped).toMatchObject({ status: "refused", code: "pr.merge-gate.page-cap" });
    expect(capped.status === "ok" ? "" : JSON.stringify(capped)).toContain("--max-pages");
    // why: the refusal names the one action that changes the outcome, so the
    // raised cap must actually complete the same scan.
    pages = 0;
    const completed = await gate.execute({ pr: "42", maxPages: "2" }, context);
    expect(completed).toMatchObject({ status: "ok" });
  });

  test("an unregistered provider refuses: registered ids fix a typo only, an unmatched forge takes the pr-delivery path or STOPs", async () => {
    const { context } = fixture();
    const refused = await command("pr.merge-gate").execute({ pr: "42", provider: "gitlab" }, context);
    expect(refused).toMatchObject({ status: "refused", code: "pr.merge-gate.unsupported-provider", exitCode: 1 });
    const recovery = refused.status === "ok" ? "" : (refused.details?.recovery as string | undefined) ?? "";
    // see skills/mstar-roles/references/project-manager/pr-delivery.md
    // Typo reading: the registered ids still name the correction.
    expect(refused.status === "ok" ? "" : refused.message).toContain("gitlab");
    expect(recovery).toContain("--provider <id>");
    // see skills/mstar-roles/references/project-manager/pr-delivery.md
    // why: github is listed to fix a typo, never as a suggestion that gh can
    // inspect a GitLab MR — the adapter must match the target forge.
    expect(recovery).toContain("matches the target forge");
    // see skills/mstar-roles/references/project-manager/pr-delivery.md
    // Forge reading: an unsupported forge enumerates with the project's own
    // tooling per pr-delivery.md, and STOPs without a documented equivalent.
    expect(recovery).toContain("pr-delivery.md");
    expect(recovery).toContain("STOP");
  });

  test("the waiver retry tells the operator to pass the selected provider id", async () => {
    const { context } = fixture();
    const head = "abcdef0123456";
    registerMergeGateProvider("wfix", {
      async resolve() { return { ok: true, value: { head, host: "h", owner: "o", repo: "r" } }; },
      async threads() {
        return { ok: true, value: { threads: [{ id: "T9", isResolved: false, isOutdated: false, path: "a.ts", line: 1, author: "x", body: "b" }], hasNextPage: false, endCursor: null, readable: true, headRefOid: head } };
      },
    });
    const refused = await command("pr.merge-gate").execute({ pr: "7", provider: "wfix" }, context);
    expect(refused).toMatchObject({ status: "refused", code: "pr.merge-gate.unresolved" });
    // see skills/mstar-roles/references/project-manager/pr-delivery.md
    // why: a retry without the flag would rescan through the GitHub adapter.
    const recovery = refused.status === "ok" ? "" : (refused.details?.recovery as string);
    expect(recovery).toContain("mstar pr merge-gate --pr <number> --provider <id> --confirm <file>");
    expect(recovery).toContain("passing the provider id this invocation selected");
  });

  test("a missing provider executable names the tool from the error's executable field or its message", async () => {
    const { context } = fixture();
    const gate = command("pr.merge-gate");
    // see packages/commands/src/effects/process.ts
    // Field shape: the spawn adapters set `executable` on process.not-found.
    context.effects.spawn = async () => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "process.not-found", exitCode: 127, executable: "gh" }); };
    const byField = await gate.execute({ pr: "42" }, context);
    expect(byField).toMatchObject({ status: "refused", code: "process.not-found" });
    expect(byField.status === "ok" ? "" : (byField.details?.recovery as string) ?? JSON.stringify(byField)).toContain("GitHub CLI");
    // see packages/commands/src/effects/process.ts
    // Message shape: a pre-field error still reads the name out of the
    // normalized `executable not found in $PATH: <name>` text.
    context.effects.spawn = async () => { throw Object.assign(new Error("executable not found in $PATH: glab"), { code: "process.not-found", exitCode: 127 }); };
    const byMessage = await gate.execute({ pr: "42" }, context);
    expect(byMessage).toMatchObject({ status: "refused", code: "process.not-found" });
    expect(byMessage.status === "ok" ? "" : (byMessage.details?.recovery as string) ?? JSON.stringify(byMessage)).toContain("glab");
  });

  test("a registered fixture provider drives the gate without spawning", async () => {
    const { cwd, context, calls } = fixture();
    const head = "abcdef0123456";
    const nodes = [
      { id: "FX1", isResolved: false, isOutdated: false, path: "src/f.ts", line: 9, author: "fixture-bot", body: "fix this" },
    ];
    const threadCalls: Array<{ owner: string; repo: string; pr: number; after: string | null }> = [];
    let pageHead = head;
    // see skills/mstar-use-cli/references/checks-and-lints.md
    // why: the gate must ask the named adapter for the head and every thread
    // page; a fixture proves the seam drives the same pinning, digest and
    // refusal path without any spawn.
    const fixtureProvider: MergeGateProvider = {
      async resolve() {
        return { ok: true, value: { head, host: "fixture.example", owner: "fix", repo: "ture" } };
      },
      async threads({ owner, repo, pr, after }) {
        threadCalls.push({ owner, repo, pr, after });
        return { ok: true, value: { threads: nodes, hasNextPage: false, endCursor: null, readable: true, headRefOid: pageHead } };
      },
    };
    registerMergeGateProvider("fixture", fixtureProvider);
    const gate = command("pr.merge-gate");
    const refused = await gate.execute({ pr: "7", provider: "fixture" }, context);
    expect(refused).toMatchObject({ status: "refused", code: "pr.merge-gate.unresolved", exitCode: 1 });
    expect(refused.status === "ok" ? {} : refused.details).toMatchObject({ head, unresolved: [{ id: "FX1", author: "fixture-bot" }] });
    expect(calls).toHaveLength(0);
    expect(threadCalls).toEqual([{ owner: "fix", repo: "ture", pr: 7, after: null }]);

    const digest = (refused.status === "ok" ? {} : refused.details)?.digest as string;
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    const confirm = path.join(cwd, "confirm.json");
    writeFileSync(confirm, JSON.stringify({ head, confirmations: 2, threads: ["FX1"], digest }));
    const allowed = await gate.execute({ pr: "7", provider: "fixture", confirm }, context);
    expect(allowed).toMatchObject({ status: "ok" });

    // see skills/mstar-roles/references/project-manager/pr-delivery.md
    // why: a head the provider reports differently on the next scan makes the
    // confirmed enumeration stale, so the seam must refuse the same way.
    pageHead = "9999999999999";
    const moved = await gate.execute({ pr: "7", provider: "fixture", confirm }, context);
    expect(moved).toMatchObject({ status: "refused", code: "pr.merge-gate.head-moved" });
  });
});
