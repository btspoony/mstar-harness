import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const encoder = new TextEncoder();
export const MAX_SINK_BYTES = 16_777_216;

/**
 * Docker isolation prefix shared by every probe launcher. Each gate appends its
 * own tmpfs, mounts, env and image tail: the mount lists differ by policy and
 * must not be folded together.
 */
export function dockerIsolationArgs(child: Readonly<{ uid: number; gid: number }>): readonly string[] {
  return [
    "run", "--rm", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
    `--user=${child.uid}:${child.gid}`, "--pids-limit=64", "--memory=256m", "--cpus=1",
  ];
}

/** Digest of one regular file; O_NOFOLLOW refuses a symlinked manifest target. */
export function sha256File(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(65_536);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("jev.manifest-file-invalid");
    let offset = 0;
    while ((offset = readSync(fd, buffer, 0, buffer.byteLength, null)) > 0) hash.update(buffer.subarray(0, offset));
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

/** Create-only write: temp file with O_CREAT | O_EXCL, fsync, then rename onto the target. */
export function createOnlySinkWrite(target: string, body: string | Uint8Array): void {
  const bytes = typeof body === "string" ? encoder.encode(body) : body;
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
}
