import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function statIfPresent(target: string) {
  try { return fs.lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function checkParent(target: string) {
  const parent = path.dirname(target);
  const stat = statIfPresent(parent);
  if (stat && !stat.isDirectory()) throw new Error(`Agent directory must be a real directory: ${parent}`);
}

/** Codex discovers linked TOMLs but cannot apply them with its no-follow loader. */
export function ensureCodexAgentFile(source: string, target: string, dryRun: boolean): string[] {
  checkParent(target);
  const stat = statIfPresent(target);
  if (stat?.isSymbolicLink()) {
    const linked = path.resolve(path.dirname(target), fs.readlinkSync(target));
    const matches = linked === path.resolve(source) ||
      (fs.existsSync(linked) && fs.existsSync(source) && fs.realpathSync(linked) === fs.realpathSync(source));
    if (!matches) throw new Error(`Refusing unrelated agent symlink: ${target} -> ${linked}`);
  } else if (stat && !stat.isFile()) {
    throw new Error(`Agent path must be a regular file: ${target}`);
  }
  // A dry-run may describe a checkout that has not been cloned yet.
  if (dryRun && !fs.existsSync(source)) return [`Would copy agent ${source} to regular file ${target}`];
  const bytes = fs.readFileSync(source);
  let previous: Buffer | undefined;
  if (stat?.isFile()) {
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { previous = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
    if (previous.equals(bytes)) return [`Agent file already current: ${target}`];
  }
  if (dryRun) return [
    ...(previous ? [`Would back up differing agent file: ${target}`] : []),
    `Would ${stat?.isSymbolicLink() ? "replace legacy symlink with" : "install"} regular agent file: ${target}`,
  ];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const notes: string[] = [];
  if (previous) {
    const backup = `${target}.${randomUUID()}.bak`;
    fs.writeFileSync(backup, previous, { flag: "wx", mode: stat!.mode & 0o777 });
    notes.push(`Backed up differing agent file to ${backup}`);
  }
  // Rename replaces the directory entry itself, never writes through a legacy link.
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o644 });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  notes.push(`${stat?.isSymbolicLink() ? "Replaced legacy symlink with" : "Installed"} regular agent file: ${target}`);
  return notes;
}

export function validateCodexAgentFile(source: string, target: string, scope: string): string[] {
  const hint = `Run: mstar-harness init --target codex --scope ${scope}`;
  try {
    checkParent(target);
    const stat = statIfPresent(target);
    if (!stat) return [`Missing agent file: ${target}. ${hint}`];
    if (stat.isSymbolicLink()) return [`Agent file must not be a symlink: ${target}. ${hint}`];
    if (!stat.isFile()) return [`Agent path must be a regular file: ${target}. Move it aside, then ${hint}`];
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.readFileSync(fd).equals(fs.readFileSync(source))) return [`Agent file is stale or customized: ${target}. ${hint} (backs up differing bytes before refresh).`];
    } finally { fs.closeSync(fd); }
    return [];
  } catch (error) {
    return [`Could not validate agent file ${target}: ${error instanceof Error ? error.message : String(error)}. ${hint}`];
  }
}
