import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const REPO_URL = "https://github.com/btspoony/mstar-harness.git";
export const PLUGIN_NAME = "morning-star-harness";
export const HARNESS_REPO_PATH = path.join(os.homedir(), ".mstar", "harness");

const HARNESS_MARKERS = [".codex-plugin/plugin.json", "kimi.plugin.json"];

function harnessMarkerPath() {
  for (const marker of HARNESS_MARKERS) {
    const candidate = path.join(HARNESS_REPO_PATH, marker);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(HARNESS_REPO_PATH, HARNESS_MARKERS[0]);
}

function pathOrSymlinkExists(filePath: string) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function ensureDir(dirPath: string, dryRun: boolean) {
  if (dryRun) return;
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

export function runCommand(command: string[], cwd: string, dryRun: boolean) {
  if (dryRun) return;
  execFileSync(command[0], command.slice(1), { cwd, stdio: "pipe", encoding: "utf8" });
}

export function ensureLocalHarnessRepo(dryRun: boolean) {
  const notes: string[] = [];
  if (fs.existsSync(HARNESS_REPO_PATH)) {
    const errors = validateLocalHarnessRepo();
    if (errors.length) {
      throw new Error(errors.join("\n"));
    }
    notes.push(`Using existing local harness repo at ${HARNESS_REPO_PATH}`);
    return notes;
  }

  ensureDir(path.dirname(HARNESS_REPO_PATH), dryRun);
  runCommand(["git", "clone", REPO_URL, HARNESS_REPO_PATH], path.dirname(HARNESS_REPO_PATH), dryRun);
  notes.push(`Cloned ${REPO_URL} to ${HARNESS_REPO_PATH}`);
  return notes;
}

export function validateLocalHarnessRepo() {
  const errors: string[] = [];
  if (!fs.existsSync(HARNESS_REPO_PATH)) {
    errors.push(`Missing local harness repo: ${HARNESS_REPO_PATH}`);
    return errors;
  }
  const marker = harnessMarkerPath();
  if (!fs.existsSync(marker)) {
    errors.push(
      `Local harness repo is missing a plugin marker (expected one of: ${HARNESS_MARKERS.join(", ")}).`,
    );
  }
  return errors;
}

/** Cursor cannot load symlinked plugin roots — use a materialized git checkout. */
export function ensureGitCheckout(repoUrl: string, checkoutPath: string, dryRun: boolean) {
  const notes: string[] = [];
  const parentDir = path.dirname(checkoutPath);

  if (pathOrSymlinkExists(checkoutPath)) {
    const stat = fs.lstatSync(checkoutPath);
    if (stat.isSymbolicLink()) {
      notes.push(
        dryRun
          ? `Would remove symlink at ${checkoutPath} and clone ${repoUrl}`
          : `Removed symlink at ${checkoutPath} (Cursor requires a real directory)`,
      );
      if (dryRun) return notes;
      fs.unlinkSync(checkoutPath);
    } else if (fs.existsSync(path.join(checkoutPath, ".git"))) {
      if (!dryRun) {
        runCommand(["git", "-C", checkoutPath, "pull", "--ff-only"], checkoutPath, dryRun);
      }
      notes.push(`Updated git checkout at ${checkoutPath}`);
      return notes;
    } else {
      throw new Error(`Path exists but is not a git checkout: ${checkoutPath}`);
    }
  }

  ensureDir(parentDir, dryRun);
  if (!dryRun) {
    runCommand(["git", "clone", repoUrl, checkoutPath], parentDir, dryRun);
  }
  notes.push(`${dryRun ? "Would clone" : "Cloned"} ${repoUrl} to ${checkoutPath}`);
  return notes;
}

export function validateGitCheckout(checkoutPath: string, markerRelativePath: string) {
  const errors: string[] = [];
  if (!pathOrSymlinkExists(checkoutPath)) {
    errors.push(`Missing checkout directory: ${checkoutPath}`);
    return errors;
  }
  const stat = fs.lstatSync(checkoutPath);
  if (stat.isSymbolicLink()) {
    errors.push(
      `Path must be a real directory, not a symlink: ${checkoutPath}. Run: mstar-harness init --target cursor`,
    );
    return errors;
  }
  if (!fs.existsSync(path.join(checkoutPath, ".git"))) {
    errors.push(`Path is not a git checkout: ${checkoutPath}`);
  }
  const marker = path.join(checkoutPath, markerRelativePath);
  if (!fs.existsSync(marker)) {
    errors.push(`Missing marker file: ${marker}`);
  }
  return errors;
}

export function ensureSymlink(target: string, linkPath: string, dryRun: boolean) {
  if (pathOrSymlinkExists(linkPath)) {
    const stat = fs.lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      throw new Error(`Path exists and is not a symlink: ${linkPath}`);
    }
    if (!fs.existsSync(target)) {
      throw new Error(`Symlink target is missing: ${target}`);
    }
    const actual = fs.realpathSync(linkPath);
    const expected = fs.realpathSync(target);
    if (actual !== expected) {
      throw new Error(`Symlink ${linkPath} points to ${actual}, expected ${expected}`);
    }
    return `Symlink already exists: ${linkPath} -> ${target}`;
  }

  ensureDir(path.dirname(linkPath), dryRun);
  if (!dryRun) fs.symlinkSync(target, linkPath);
  return `Linked ${linkPath} -> ${target}`;
}

export function validateSymlink(target: string, linkPath: string) {
  const errors: string[] = [];
  if (!pathOrSymlinkExists(linkPath)) {
    errors.push(`Missing symlink: ${linkPath}`);
    return errors;
  }
  const stat = fs.lstatSync(linkPath);
  if (!stat.isSymbolicLink()) {
    errors.push(`Path exists but is not a symlink: ${linkPath}`);
    return errors;
  }
  if (!fs.existsSync(target)) {
    errors.push(`Symlink target is missing: ${target}`);
    return errors;
  }
  const actual = fs.realpathSync(linkPath);
  const expected = fs.realpathSync(target);
  if (actual !== expected) {
    errors.push(`Symlink ${linkPath} points to ${actual}, expected ${expected}`);
  }
  return errors;
}

export const SDD_SCRATCH_GITIGNORE = [".mstar/sdd/", ".agents/sdd/"];

export function appendGitignore(projectRoot: string, entries: string[], dryRun: boolean) {
  const gitignorePath = path.join(projectRoot, ".gitignore");
  const current = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
  const missing = entries.filter((entry) => !lines.has(entry));
  if (!missing.length) return [] as string[];
  if (!dryRun) {
    const prefix = current && !current.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(gitignorePath, `${prefix}${missing.join("\n")}\n`, "utf8");
  }
  return missing.map((entry) => `Added ${entry} to .gitignore`);
}

export function appendHarnessProjectGitignore(projectRoot: string, dryRun: boolean) {
  return appendGitignore(projectRoot, SDD_SCRATCH_GITIGNORE, dryRun);
}

export function homeRelativeSourcePath(targetPath: string) {
  const rel = path.relative(os.homedir(), targetPath).split(path.sep).join("/");
  return rel.startsWith("..") ? targetPath : `./${rel}`;
}
