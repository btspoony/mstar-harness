import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createOnlySinkWrite, MAX_SINK_BYTES } from "./container-probe.js";

const encoder = new TextEncoder();

export type AnnotationSeat = "A" | "B";

export function allowedAnnotationOutput(seat: AnnotationSeat, shard: number): string {
  if (!["A", "B"].includes(seat) || !Number.isInteger(shard) || shard < 1 || shard > 4) throw new Error("jev.annotation-seat-invalid");
  return `annotations/${seat}-${shard}.jsonl`;
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

export function validateAnnotationSinkRelativePath(seat: AnnotationSeat, shard: number, relativePath: string): void {
  const normalized = relativePath.split(/[\\/]/).filter((part) => part.length > 0).join("/");
  if (normalized.length === 0 || normalized.includes("..") || isAbsolute(normalized)) throw new Error("jev.annotation-sink-path-invalid");
  if (normalized !== allowedAnnotationOutput(seat, shard)) throw new Error("jev.annotation-sink-path-forbidden");
}

export function createOnlyAnnotationSinkWrite(sinkRoot: string, seat: AnnotationSeat, shard: number, relativePath: string, body: string | Uint8Array): string {
  if (!isAbsolute(sinkRoot)) throw new Error("jev.annotation-sink-root-invalid");
  const root = realpathSync(sinkRoot);
  validateAnnotationSinkRelativePath(seat, shard, relativePath);
  const target = resolve(root, relativePath);
  if (!within(root, target)) throw new Error("jev.annotation-sink-escape");
  if (existsSync(target)) throw new Error("jev.annotation-sink-create-only");
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SINK_BYTES) throw new Error("jev.annotation-sink-size-invalid");
  createOnlySinkWrite(target, bytes);
  if (!statSync(target).isFile()) throw new Error("jev.annotation-sink-write-failed");
  return target;
}
