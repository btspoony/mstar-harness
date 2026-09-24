import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, closeSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { attestEvaluatorChannel } from "./evaluator-channel-trust.js";
import type { EvaluatorChannel, EvaluatorChannelResponse, JudgmentInvocation } from "./runtime.js";

const MAX_REQUEST_BYTES = 1_048_576;
const MAX_STATUS_BYTES = 4_096;
const CHANNEL_NAME = ".jev-mailbox";
type MailboxRequest = Readonly<{ schema: "mstar.judgment-request/v1"; requestId: string; runId: string; packBytes: string; pilotDigest: string }>;
type PublicStatus = Readonly<{ schema: "mstar.judgment-status/v1"; runId: string; requestId?: string; status: "idle" | "pending" | "recorded" | "unavailable" | "invalid" | "cancelled"; code?: string }>;
type PublicChannelOptions = Readonly<{ runId: string; requestDirectory: string; statusPath: string; maxRequestBytes?: number }>;

const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}
function assertSafeDirectory(path: string, root: string): string {
  const canonical = realpathSync(path);
  if (!within(root, canonical) || !statSync(canonical).isDirectory()) throw new Error("jev.channel-path-invalid");
  return canonical;
}

/** Assert the complete supervisor mount set, not a false parent/child relationship between siblings. */
export function assertSupervisorMountInfo(mountInfo: string): void {
  const expected: Record<string, "ro" | "rw"> = {
    "/mnt/source": "ro", "/mnt/output": "rw", "/mnt/requests": "rw",
    "/mnt/status.json": "ro", "/mnt/scratch": "rw",
  };
  const found = new Set<string>();
  for (const line of mountInfo.split("\n")) {
    if (!line) continue;
    const fields = line.split(" - ", 1)[0]!.split(" ");
    const path = fields[4]?.replaceAll("\\040", " ").replaceAll("\\011", "\t").replaceAll("\\012", "\n").replaceAll("\\134", "\\");
    if (!path || path !== "/mnt" && !path.startsWith("/mnt/")) continue;
    if (!Object.hasOwn(expected, path) || found.has(path)) throw new Error("jev.channel-mount-unconfined");
    const options = fields[5]?.split(",") ?? [];
    if (!options.includes(expected[path]!) || options.includes(expected[path] === "ro" ? "rw" : "ro")) {
      throw new Error("jev.channel-mount-unconfined");
    }
    found.add(path);
  }
  if (found.size !== Object.keys(expected).length) throw new Error("jev.channel-mount-unconfined");
}

export function assertSupervisorMountPaths(requestPath: string, statusFilePath: string): Readonly<{ requestDirectory: string; statusPath: string }> {
  const requestDirectory = realpathSync(requestPath);
  const statusPath = realpathSync(statusFilePath);
  if (!statSync(requestDirectory).isDirectory() || !statSync(statusPath).isFile() || requestDirectory === statusPath) {
    throw new Error("jev.channel-mount-invalid");
  }
  return { requestDirectory, statusPath };
}

function assertSupervisorMounts(): Readonly<{ requestDirectory: string; statusPath: string }> {
  if (process.env.JEV_COMPONENT_WORKER !== "1" ||
      process.env.JEV_REQUESTS_DIR !== "/mnt/requests" ||
      process.env.JEV_STATUS_PATH !== "/mnt/status.json") throw new Error("jev.channel-supervisor-unattested");
  assertSupervisorMountInfo(readFileSync("/proc/self/mountinfo", "utf8"));
  const mounts = assertSupervisorMountPaths("/mnt/requests", "/mnt/status.json");
  try { accessSync(mounts.requestDirectory, constants.W_OK); }
  catch { throw new Error("jev.channel-mount-unconfined"); }
  const uid = readFileSync("/proc/self/status", "utf8").match(/^Uid:\s+(\d+)\s+(\d+)/m);
  if (!uid || uid[1] === "0" || uid[2] === "0") throw new Error("jev.channel-process-unconfined");
  return mounts;
}

/** Test-only local mailbox injection. Production callers must use connectEvaluatorChannel. */
export async function connectEvaluatorChannelForTest(invocation: JudgmentInvocation, signal: AbortSignal): Promise<EvaluatorChannel> {
  if (signal.aborted || invocation === null || typeof invocation !== "object" || !isAbsolute(invocation.cwd) || !isAbsolute(invocation.workspace)) throw new Error("jev.channel-invocation-invalid");
  const root = realpathSync(invocation.cwd);
  const workspace = realpathSync(invocation.workspace);
  if (!within(workspace, root)) throw new Error("jev.channel-workspace-boundary");
  const mailbox = resolve(root, CHANNEL_NAME);
  if (!existsSync(mailbox)) mkdirSync(mailbox, { mode: 0o700 });
  const mailboxRoot = assertSafeDirectory(mailbox, root);
  const requests = resolve(mailboxRoot, "requests");
  if (!existsSync(requests)) mkdirSync(requests, { mode: 0o700 });
  return createChannel(assertSafeDirectory(requests, mailboxRoot), resolve(mailboxRoot, "status.json"), signal);
}

async function connectAtSupervisorMounts(mounts: Readonly<{ requestDirectory: string; statusPath: string }>, signal: AbortSignal): Promise<EvaluatorChannel> {
  return attestEvaluatorChannel(await createChannel(mounts.requestDirectory, mounts.statusPath, signal));
}

/** Test-only injection for exercising the production connection with approved sibling mounts. */
export async function connectEvaluatorChannelWithSupervisorMountsForTest(requestPath: string, statusFilePath: string, signal: AbortSignal): Promise<EvaluatorChannel> {
  return connectAtSupervisorMounts(assertSupervisorMountPaths(requestPath, statusFilePath), signal);
}

/** Connects only to a supervisor-launched worker with externally enforced mounts. */
export async function connectEvaluatorChannel(invocation: JudgmentInvocation, signal: AbortSignal): Promise<EvaluatorChannel> {
  if (signal.aborted || invocation === null || typeof invocation !== "object" || !isAbsolute(invocation.cwd) || !isAbsolute(invocation.workspace)) throw new Error("jev.channel-invocation-invalid");
  const root = realpathSync(invocation.cwd);
  const workspace = realpathSync(invocation.workspace);
  if (!within(workspace, root)) throw new Error("jev.channel-workspace-boundary");
  return connectAtSupervisorMounts(assertSupervisorMounts(), signal);
}

async function createChannel(requestDirectory: string, statusPath: string, signal: AbortSignal): Promise<EvaluatorChannel> {
  let closed = false;
  let activeRequest: string | undefined;
  let activeRunId: string | undefined;
  const waitForStatus = async (requestId: string, submitSignal: AbortSignal): Promise<EvaluatorChannelResponse> => {
    while (!closed && !signal.aborted && !submitSignal.aborted) {
      if (existsSync(statusPath)) {
        const info = statSync(statusPath);
        if (!info.isFile() || info.size > MAX_STATUS_BYTES) throw new Error("jev.status-invalid");
        let status: Partial<PublicStatus>;
        try { status = JSON.parse(readFileSync(statusPath, "utf8")) as Partial<PublicStatus>; }
        catch { throw new Error("jev.status-invalid"); }
        if (status.schema === "mstar.judgment-status/v1" && status.runId === activeRunId && status.requestId === requestId && ["recorded", "unavailable", "invalid", "cancelled"].includes(status.status ?? "")) {
          const responseStatus = status.status as EvaluatorChannelResponse["status"];
          const result: EvaluatorChannelResponse = status.code === undefined ? { status: responseStatus } : { status: responseStatus, code: /^[a-z0-9][a-z0-9.-]{0,95}$/.test(status.code) ? status.code : undefined };
          return result;
        }
      }
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
    }
    return { status: "unavailable", code: "jev.review-cancelled" };
  };
  const channel: EvaluatorChannel = Object.freeze({
    submit: async ({ packBytes, pilotDigest }, submitSignal) => {
      if (closed || signal.aborted || submitSignal.aborted) return { status: "unavailable", code: "jev.channel-closed" };
      if (!(packBytes instanceof Uint8Array) || packBytes.byteLength === 0 || packBytes.byteLength > MAX_REQUEST_BYTES || !/^[a-f0-9]{64}$/.test(pilotDigest)) return { status: "invalid", code: "jev.request-invalid" };
      const runId = parseRunId(packBytes);
      if (!runId) return { status: "invalid", code: "jev.run-invalid" };
      const requestId = randomUUID();
      const bytes = new TextEncoder().encode(JSON.stringify({ schema: "mstar.judgment-request/v1", requestId, runId, packBytes: Buffer.from(packBytes).toString("base64"), pilotDigest } satisfies MailboxRequest));
      if (bytes.byteLength > MAX_REQUEST_BYTES * 4 / 3 + 2_048) return { status: "invalid", code: "jev.request-too-large" };
      const target = resolve(requestDirectory, `${requestId}.json`);
      if (!within(requestDirectory, target)) return { status: "invalid", code: "jev.channel-path-invalid" };
      atomicWrite(target, bytes);
      activeRequest = requestId;
      activeRunId = runId;
      try { return await waitForStatus(requestId, submitSignal); }
      finally { activeRequest = undefined; activeRunId = undefined; rmSync(target, { force: true }); }
    },
    cancel: async () => {
      closed = true;
      if (activeRequest !== undefined) {
        const cancelPath = resolve(requestDirectory, `${activeRequest}.cancel`);
        try { const fd = openSync(cancelPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); fsyncSync(fd); closeSync(fd); }
        catch (error) { if (!existsSync(cancelPath)) throw error; }
      }
    },
  });
  return channel;
}
function atomicWrite(path: string, bytes: Uint8Array): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } catch (error) { rmSync(temp, { force: true }); throw error; }
  finally { closeSync(fd); }
  renameSync(temp, path);
  const directory = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function writeStatus(path: string, status: PublicStatus): void {
  const bytes = new TextEncoder().encode(JSON.stringify(status));
  if (bytes.byteLength > MAX_STATUS_BYTES) throw new Error("jev.status-too-large");
  atomicWrite(path, bytes);
}
function parseRunId(bytes: Uint8Array): string | undefined {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { runId?: unknown };
    return validId(value?.runId) ? value.runId : undefined;
  } catch { return undefined; }
}


/** Trusted-supervisor-only file mailbox adapter; never returns evaluator data or capabilities to the client. */
export function createEvaluatorMailbox(options: PublicChannelOptions): Readonly<{
  readNext(signal: AbortSignal): Promise<MailboxRequest | null>;
  isCancelled(requestId: string): boolean;
  clearCancellation(requestId: string): void;
  publishStatus(status: Omit<PublicStatus, "schema" | "runId"> & { runId: string }): void;
}> {
  if (!validId(options.runId) || !isAbsolute(options.requestDirectory) || !isAbsolute(options.statusPath)) throw new Error("jev.mailbox-options-invalid");
  const requestDirectory = realpathSync(options.requestDirectory);
  const statusParent = realpathSync(resolve(options.statusPath, ".."));
  if (!within(statusParent, requestDirectory) && !within(requestDirectory, statusParent)) throw new Error("jev.mailbox-path-mismatch");
  const max = options.maxRequestBytes ?? MAX_REQUEST_BYTES;
  if (!Number.isSafeInteger(max) || max < 1 || max > MAX_REQUEST_BYTES) throw new Error("jev.mailbox-limit-invalid");
  let lastId: string | undefined;
  return Object.freeze({
    readNext: async (signal) => {
      while (!signal.aborted) {
        const names = (await readdir(requestDirectory)).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name)).sort();
        for (const name of names) {
          const path = resolve(requestDirectory, name);
          const info = statSync(path);
          if (!info.isFile() || info.size > max * 2) continue;
          let value: Partial<MailboxRequest>;
          try { value = JSON.parse(readFileSync(path, "utf8")) as Partial<MailboxRequest>; }
          catch { continue; }
          if (value.schema !== "mstar.judgment-request/v1" || !validId(value.requestId) || !validId(value.runId) || value.runId !== options.runId || value.requestId === lastId || typeof value.packBytes !== "string" || !/^[a-f0-9]{64}$/.test(value.pilotDigest ?? "")) continue;
          const raw = Buffer.from(value.packBytes, "base64");
          if (raw.byteLength === 0 || raw.byteLength > max || raw.toString("base64") !== value.packBytes || parseRunId(raw) !== options.runId) continue;
          lastId = value.requestId;
          return value as MailboxRequest;
        }
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
      }
      return null;
    },
    isCancelled: (requestId) => validId(requestId) && within(requestDirectory, resolve(requestDirectory, `${requestId}.cancel`)) && existsSync(resolve(requestDirectory, `${requestId}.cancel`)),
    clearCancellation: (requestId) => { if (validId(requestId)) rmSync(resolve(requestDirectory, `${requestId}.cancel`), { force: true }); },
    publishStatus: (status) => {
      if (status.runId !== options.runId || status.requestId !== undefined && !validId(status.requestId)) throw new Error("jev.status-authority-invalid");
      writeStatus(options.statusPath, { schema: "mstar.judgment-status/v1", ...status });
    },
  });
}
