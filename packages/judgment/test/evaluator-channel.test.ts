import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectEvaluatorChannel, createEvaluatorMailbox } from "../src/evaluator-channel.js";

const roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jev-channel-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("bounded evaluator mailbox", () => {
  test("durably admits one matching run request before acknowledging status", async () => {
    const root = makeRoot();
    const channel = await connectEvaluatorChannel({ cwd: root, workspace: root, input: { kind: "stdin" }, pilotPath: null }, new AbortController().signal);
    const mailboxPath = join(root, ".jev-mailbox");
    const mailbox = createEvaluatorMailbox({ runId: "run-1", requestDirectory: join(mailboxPath, "requests"), statusPath: join(mailboxPath, "status.json") });
    const requestBytes = new TextEncoder().encode(JSON.stringify({ runId: "run-1", packId: "pack-1" }));
    const submitted = channel.submit({ packBytes: requestBytes, pilotDigest: "a".repeat(64) }, new AbortController().signal);
    const request = await mailbox.readNext(new AbortController().signal);
    expect(request?.runId).toBe("run-1");
    expect(Buffer.from(request!.packBytes, "base64").toString()).toBe(new TextDecoder().decode(requestBytes));
    expect(readFileSync(join(mailboxPath, "requests", `${request!.requestId}.json`), "utf8")).toContain("mstar.judgment-request/v1");
    mailbox.publishStatus({ runId: "run-1", requestId: request!.requestId, status: "recorded" });
    expect(await submitted).toEqual({ status: "recorded" });
  });

  test("rejects foreign run, escaped mailbox paths and oversized public status", async () => {
    const root = makeRoot();
    const channel = await connectEvaluatorChannel({ cwd: root, workspace: root, input: { kind: "stdin" }, pilotPath: null }, new AbortController().signal);
    expect(await channel.submit({ packBytes: new TextEncoder().encode(JSON.stringify({ runId: "../other" })), pilotDigest: "a".repeat(64) }, new AbortController().signal)).toEqual({ status: "invalid", code: "jev.run-invalid" });
    const outside = mkdtempSync(join(tmpdir(), "jev-foreign-"));
    roots.push(outside);
    expect(() => createEvaluatorMailbox({ runId: "run-1", requestDirectory: outside, statusPath: join(root, ".jev-mailbox", "status.json") })).toThrow("jev.mailbox-path-mismatch");
    const mailbox = createEvaluatorMailbox({ runId: "run-1", requestDirectory: join(root, ".jev-mailbox", "requests"), statusPath: join(root, ".jev-mailbox", "status.json") });
    expect(() => mailbox.publishStatus({ runId: "run-1", status: "recorded", code: "x".repeat(5_000) })).toThrow("jev.status-too-large");
  });

  test("cancellation marker invalidates a late recorded response", async () => {
    const root = makeRoot();
    const channel = await connectEvaluatorChannel({ cwd: root, workspace: root, input: { kind: "stdin" }, pilotPath: null }, new AbortController().signal);
    const mailbox = createEvaluatorMailbox({ runId: "run-1", requestDirectory: join(root, ".jev-mailbox", "requests"), statusPath: join(root, ".jev-mailbox", "status.json") });
    const pending = channel.submit({ packBytes: new TextEncoder().encode(JSON.stringify({ runId: "run-1" })), pilotDigest: "a".repeat(64) }, new AbortController().signal);
    const request = await mailbox.readNext(new AbortController().signal);
    await channel.cancel();
    expect(mailbox.isCancelled(request!.requestId)).toBe(true);
    mailbox.publishStatus({ runId: "run-1", requestId: request!.requestId, status: "recorded" });
    expect(await pending).toEqual({ status: "unavailable", code: "jev.review-cancelled" });
    expect(readdirSync(join(root, ".jev-mailbox", "requests"))).toEqual([`${request!.requestId}.cancel`]);
});
});
