import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareSemver } from "./version-compare.js";

const PLUGIN_NAME = "morning-star-harness";
const PLUGIN_VERSION_SHAPE_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function kimiManagedRoot(kimiCodeHome: string = process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code")): string {
  return path.join(kimiCodeHome, "plugins", "managed");
}

function listDirsToDepth(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      out.push(child);
      if (depth + 1 < maxDepth) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

function readPluginVersion(dir: string): string | null {
  for (const manifest of [".kimi-plugin/plugin.json", "plugin.json", "package.json"]) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, manifest), "utf8");
    } catch {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "version" in parsed) {
        const version = parsed.version;
        if (typeof version === "string" && PLUGIN_VERSION_SHAPE_RE.test(version.trim())) return version.trim();
      }
    } catch {
      // A malformed manifest is not a version candidate.
      continue;
    }
  }
  return null;
}

/** Discover the highest installed Kimi plugin version; absent or malformed artifacts report null. */
export function detectKimiPluginVersion(
  kimiCodeHome: string = process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), ".kimi-code"),
): string | null {
  let highest: string | null = null;
  for (const dir of listDirsToDepth(kimiManagedRoot(kimiCodeHome), 3)) {
    if (path.basename(dir) !== PLUGIN_NAME) continue;
    const candidate = readPluginVersion(dir);
    if (candidate !== null && (highest === null || compareSemver(candidate, highest) > 0)) highest = candidate;
  }
  return highest;
}

export type KimiDoctorResult = { location: string; errors: string[]; notes: string[] };

/** Assemble read-only Kimi doctor findings; Kimi manages plugin installation through its TUI. */
export function diagnoseKimiHost(kimiCodeHome?: string): KimiDoctorResult {
  return { location: kimiManagedRoot(kimiCodeHome), errors: [], notes: [] };
}
