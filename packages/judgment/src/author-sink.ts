import { randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fsyncSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const encoder = new TextEncoder();
const MAX_SINK_BYTES = 16_777_216;

export function allowedAuthorOutputs(shard: number): readonly [string, string] {
  if (!Number.isInteger(shard) || shard < 1 || shard > 4) throw new Error("jev.author-shard-invalid");
  return Object.freeze([`sources/shard-${shard}.jsonl`, `authoring/shard-${shard}-provenance.json`]);
}

export function authorSlotKeys(shard: number): readonly string[] {
  if (!Number.isInteger(shard) || shard < 1 || shard > 4) throw new Error("jev.author-shard-invalid");
  return Object.freeze(Array.from({ length: 90 }, (_, index) => `shard-${shard}/group-${String(index + 1).padStart(3, "0")}`));
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

export function validateAuthorSinkRelativePath(shard: number, relativePath: string): void {
  const normalized = relativePath.split(/[\\/]/).filter((part) => part.length > 0).join("/");
  if (normalized.length === 0 || normalized.includes("..") || isAbsolute(normalized)) throw new Error("jev.author-sink-path-invalid");
  const allowed = new Set(allowedAuthorOutputs(shard));
  if (!allowed.has(normalized)) throw new Error("jev.author-sink-path-forbidden");
}

export function createOnlyAuthorSinkWrite(sinkRoot: string, shard: number, relativePath: string, body: string | Uint8Array): string {
  if (!isAbsolute(sinkRoot)) throw new Error("jev.author-sink-root-invalid");
  const root = realpathSync(sinkRoot);
  validateAuthorSinkRelativePath(shard, relativePath);
  const target = resolve(root, relativePath);
  if (!within(root, target)) throw new Error("jev.author-sink-escape");
  if (existsSync(target)) throw new Error("jev.author-sink-create-only");
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SINK_BYTES) throw new Error("jev.author-sink-size-invalid");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomUUID()}.tmp`;
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  if (!statSync(target).isFile()) throw new Error("jev.author-sink-write-failed");
  return target;
}
