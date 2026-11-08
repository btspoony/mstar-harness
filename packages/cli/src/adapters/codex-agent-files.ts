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

// Installer backups are exactly `${target}.${uuid}.bak`; the uuid carries no
// ordering, so retention keeps the newest few by mtime.
const BACKUP_SUFFIX = ".bak";
const BACKUP_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RETAINED_BACKUPS = 3;

/** Drop this installer's own stale backups of one agent file, keeping the newest
 *  few plus the one just written. A sibling that merely shares the prefix or the
 *  suffix — a user-named `.bak`, a symlink — is never a candidate.
 *  Best-effort: every backup is one refresh away from being pruned again, so a
 *  prune failure must never fail an install that already succeeded. */
function pruneBackups(target: string, keep: string): void {
  try {
    const dir = path.dirname(target);
    const prefix = `${path.basename(target)}.`;
    const stale = fs.readdirSync(dir)
      .flatMap((name) => {
        const full = path.join(dir, name);
        if (full === keep || !name.startsWith(prefix) || !name.endsWith(BACKUP_SUFFIX)) return [];
        if (!BACKUP_UUID.test(name.slice(prefix.length, -BACKUP_SUFFIX.length))) return [];
        const stat = statIfPresent(full);
        return stat?.isFile() ? [{ full, mtimeMs: stat.mtimeMs }] : [];
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(MAX_RETAINED_BACKUPS - 1);
    for (const entry of stale) fs.rmSync(entry.full, { force: true });
  } catch {
    // Stale backups are disposable; never fail the install for one.
  }
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
    const backup = `${target}.${randomUUID()}${BACKUP_SUFFIX}`;
    fs.writeFileSync(backup, previous, { flag: "wx", mode: stat!.mode & 0o777 });
    notes.push(`Backed up differing agent file to ${backup}`);
    pruneBackups(target, backup);
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

const LEGACY_QA_SHELL = /^name = "qa-engineer"\r?\ndescription = "Morning Star QA Engineer: (?:tiered L4 acceptance \(DoD mapping, residual verify, report-only\); dispatched when PM sets QA gate mandatory\.|test planning, automated tests, verification evidence, and acceptance validation\.)"\r?\ndeveloper_instructions = """\r?\nYou are the Morning Star `qa-engineer` role\.\r?\nThis Codex custom agent file is a thin routing shell, not the full role prompt\.\r?\n\r?\nMandatory first steps:\r?\n1\. Load `mstar-harness-core`\.\r?\n2\. Load `mstar-host`; detect Codex and read `references\/codex\.md`\.\r?\n3\. Load `mstar-roles` and read `references\/qa-engineer\.md`\.\r?\n\r?\nExecute the assigned QA scope personally and return Completion Report v2 with reproducible evidence\.\r?\nDo not spawn dev or QC roles unless the Assignment explicitly says `Delegation: allowed \(\.\.\.\)`\.\r?\n"""\r?\n?$/;

function inspectRetiredQa(target: string): "missing" | "managed" | "unknown" {
  checkParent(target);
  const stat = statIfPresent(target);
  if (!stat) return "missing";
  if (!stat.isFile()) return "unknown";
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    return LEGACY_QA_SHELL.test(fs.readFileSync(fd, "utf8")) ? "managed" : "unknown";
  } finally { fs.closeSync(fd); }
}

function unknownQaNote(target: string): string {
  return `Retired QA agent has unknown ownership: ${target}. Preserved it; review and migrate any custom instructions, then move or remove this file yourself if it should no longer be selectable.`;
}

export function retireCodexQaAgent(target: string, dryRun: boolean): string[] {
  let status: "missing" | "managed" | "unknown";
  try { status = inspectRetiredQa(target); }
  catch (error) {
    throw new Error(`Could not inspect retired QA agent ${target}. Check the agent directory and permissions, then re-run init: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (status === "missing") return [];
  if (status === "unknown") return [unknownQaNote(target)];
  if (dryRun) return [`Would retire managed QA agent outside Codex discovery with a backup: ${target}`];
  const backup = `${target}.${randomUUID()}${BACKUP_SUFFIX}`;
  try {
    fs.closeSync(fs.openSync(backup, "wx", 0o600));
    // Rename captures the actual directory entry even if it changed after inspection.
    fs.renameSync(target, backup);
  } catch (error) {
    throw new Error(`Could not retire QA agent ${target}; inspect any reserved backup at ${backup}, check the directory and permissions, then re-run init: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (inspectRetiredQa(backup) !== "managed") {
      try {
        fs.linkSync(backup, target);
        return [`QA agent changed during retirement; restored ${target} and preserved ${backup}. ${unknownQaNote(target)}`];
      } catch (error) {
        throw new Error(`QA agent changed during retirement; preserved it at ${backup}, but could not restore ${target}: ${error instanceof Error ? error.message : String(error)}. Review both paths and restore or migrate the backup yourself.`);
      }
    }
  } catch (error) {
    throw new Error(`Could not confirm retired QA agent; preserved captured entry at ${backup}. Review it and ${target} before re-running init: ${error instanceof Error ? error.message : String(error)}`);
  }
  return [`Retired managed QA agent to ${backup}; preserved its contents outside Codex discovery.`];
}

export function validateRetiredCodexQaAgent(target: string, scope: string): string[] {
  try {
    const status = inspectRetiredQa(target);
    if (status === "missing") return [];
    if (status === "unknown") return [unknownQaNote(target)];
    return [`Retired managed QA agent is still selectable: ${target}. Run: mstar-harness init --target codex --scope ${scope}`];
  } catch (error) {
    return [`Could not inspect retired QA agent ${target}: ${error instanceof Error ? error.message : String(error)}. Check the agent directory and permissions, then run: mstar-harness init --target codex --scope ${scope}`];
  }
}
