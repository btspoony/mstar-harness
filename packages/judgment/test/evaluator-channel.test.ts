import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectEvaluatorChannel, connectEvaluatorChannelForTest, connectEvaluatorChannelWithSupervisorMountsForTest, createEvaluatorMailbox } from "../src/evaluator-channel.js";
import { isAttestedEvaluatorChannel } from "../src/evaluator-channel-trust.js";

const roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jev-channel-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const invocation = (root: string) => ({ cwd: root, workspace: root, input: { kind: "stdin" as const }, pilotPath: null });

describe("bounded evaluator mailbox", () => {
  test("durably admits one matching run request before acknowledging status", async () => {
    const root = makeRoot();
    const channel = await connectEvaluatorChannelForTest(invocation(root), new AbortController().signal);
    expect(isAttestedEvaluatorChannel(channel)).toBe(false);
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
    const channel = await connectEvaluatorChannelForTest(invocation(root), new AbortController().signal);
    expect(await channel.submit({ packBytes: new TextEncoder().encode(JSON.stringify({ runId: "../other" })), pilotDigest: "a".repeat(64) }, new AbortController().signal)).toEqual({ status: "invalid", code: "jev.run-invalid" });
    const outside = mkdtempSync(join(tmpdir(), "jev-foreign-"));
    roots.push(outside);
    expect(() => createEvaluatorMailbox({ runId: "run-1", requestDirectory: outside, statusPath: join(root, ".jev-mailbox", "status.json") })).toThrow("jev.mailbox-path-mismatch");
    const mailbox = createEvaluatorMailbox({ runId: "run-1", requestDirectory: join(root, ".jev-mailbox", "requests"), statusPath: join(root, ".jev-mailbox", "status.json") });
    expect(() => mailbox.publishStatus({ runId: "run-1", status: "recorded", code: "x".repeat(5_000) })).toThrow("jev.status-too-large");
  });

  test("cancellation marker invalidates a late recorded response", async () => {
    const root = makeRoot();
    const channel = await connectEvaluatorChannelForTest(invocation(root), new AbortController().signal);
    const mailbox = createEvaluatorMailbox({ runId: "run-1", requestDirectory: join(root, ".jev-mailbox", "requests"), statusPath: join(root, ".jev-mailbox", "status.json") });
    const pending = channel.submit({ packBytes: new TextEncoder().encode(JSON.stringify({ runId: "run-1" })), pilotDigest: "a".repeat(64) }, new AbortController().signal);
    const request = await mailbox.readNext(new AbortController().signal);
    await channel.cancel();
    expect(mailbox.isCancelled(request!.requestId)).toBe(true);
    mailbox.publishStatus({ runId: "run-1", requestId: request!.requestId, status: "recorded" });
    expect(await pending).toEqual({ status: "unavailable", code: "jev.review-cancelled" });
    expect(readdirSync(join(root, ".jev-mailbox", "requests"))).toEqual([`${request!.requestId}.cancel`]);
});

  test("production connection refuses an unattested local mailbox without creating one", async () => {
    const root = makeRoot();
    const workerMarker = process.env.JEV_COMPONENT_WORKER;
    delete process.env.JEV_COMPONENT_WORKER;
    try {
      await expect(connectEvaluatorChannel(invocation(root), new AbortController().signal)).rejects.toThrow("jev.channel-supervisor-unattested");
      expect(readdirSync(root)).toEqual([]);
    } finally {
      if (workerMarker === undefined) delete process.env.JEV_COMPONENT_WORKER;
      else process.env.JEV_COMPONENT_WORKER = workerMarker;
    }
  });

  test("production channel connects with the supervisor launcher's sibling request and status mounts", async () => {
    const root = makeRoot();
    const requestDirectory = join(root, "requests");
    mkdirSync(requestDirectory);
    const statusPath = join(root, "status.json");
    writeFileSync(statusPath, "{}");
    const channel = await connectEvaluatorChannelWithSupervisorMountsForTest(requestDirectory, statusPath, new AbortController().signal);
    expect(isAttestedEvaluatorChannel(channel)).toBe(true);
    const mailbox = createEvaluatorMailbox({ runId: "run-1", requestDirectory, statusPath });
    const pending = channel.submit({ packBytes: new TextEncoder().encode('{"runId":"run-1"}'), pilotDigest: "a".repeat(64) }, new AbortController().signal);
    const request = await mailbox.readNext(new AbortController().signal);
    expect(request?.runId).toBe("run-1");
    mailbox.publishStatus({ runId: "run-1", requestId: request!.requestId, status: "recorded" });
    expect(await pending).toEqual({ status: "recorded" });
  });

  test("readNext finds a fresh request behind more than 64 stale entries", async () => {
    const root = makeRoot();
    const requestDirectory = join(root, "requests");
    mkdirSync(requestDirectory);
    const statusPath = join(root, "status.json");
    writeFileSync(statusPath, "{}");
    const staleIds = Array.from({ length: 70 }, (_, index) => `00000000-0000-0000-0000-${String(index + 1).padStart(12, "0")}`);
    for (const id of staleIds) writeFileSync(join(requestDirectory, `${id}.json`), "{");
    const requestId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const packBytes = Buffer.from(JSON.stringify({ runId: "run-1" })).toString("base64");
    writeFileSync(join(requestDirectory, `${requestId}.json`), JSON.stringify({
      schema: "mstar.judgment-request/v1",
      requestId,
      runId: "run-1",
      packBytes,
      pilotDigest: "a".repeat(64),
    }));
    const mailbox = createEvaluatorMailbox({ runId: "run-1", requestDirectory, statusPath });
    const controller = new AbortController();
    // Real filesystem polling is deliberate here; the timeout bounds the pre-fix starvation case.
    const abortOnTimeout = setTimeout(() => controller.abort(), 1_000);
    const request = await mailbox.readNext(controller.signal);
    clearTimeout(abortOnTimeout);
    expect(request?.requestId).toBe(requestId);
});
});
