import { DSH_LLM_FALLBACKS_VERSION } from "@mstar-harness/engine";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareSemver } from "./version-compare.js";

export const DSH_BIN = "dsh";
/** The profile the dsh adapter operates on (fixed default `web`; dsh-tui not verified). */
export const DSH_PROFILE = "web";
export const DSH_PROFILE_FLAG = "--profile";
export const DSH_DUMP_FLAG = "--dump-config";
/** dsh home resolution: `$DSH_HOME`, else `~/.dsh`. */
export const DSH_HOME_ENV = "DSH_HOME";
export const DSH_HOME_SUBDIR = ".dsh";
export const DSH_PROFILES_DIR = "profiles";

export const DSH_INSTALL_HINT =
  "Install the DeepSeek Harness CLI (@deepseek-ai/dsh), e.g. `pnpm add -g @deepseek-ai/dsh` or `npm install -g @deepseek-ai/dsh`, then re-run init.";

/** Install/doctor row order: mstar first, fallbacks second. The fallbacks spec is an
 * exact pin (`DSH_LLM_FALLBACKS_VERSION`) because an unpinned `dsh plugin add` follows
 * the dsh CLI's own range and can boot-break the installed artifact. */
export const DSH_PLUGIN_SPECS: readonly string[] = ["@mstar-harness/dsh", `dsh-llm-fallbacks@${DSH_LLM_FALLBACKS_VERSION}`];
export const DSH_FALLBACKS_SPEC = DSH_PLUGIN_SPECS[1];

/** Spec → loader-row name: strip a trailing `@<version>` (none in mstar's spec; fallbacks carries the pin). */
export function dshLoaderName(spec: string): string {
  const at = spec.lastIndexOf("@");
  // Scoped names (`@scope/pkg`) carry an `@` at index 0 — only strip a TRAILING `@version`.
  return at > 0 ? spec.slice(0, at) : spec;
}

/** Loader-row name for the fallbacks package (dump-config `name:` line is version-free). */
export const DSH_FALLBACKS_LOADER_NAME = dshLoaderName(DSH_FALLBACKS_SPEC);

const FALLBACKS_VERSION_SHAPE_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** One loader entry from a `--dump-config` dump. */
export type DshLoaderEntry = { name: string; enabled: boolean };

/** Literal disable markers that make a loader row statically disabled. */
const DISABLED_MARKERS = /\b(?:disabled: true|enabled: false)\b/;

export type DshCommandRunner = (args: string[]) => string;
export type DshDoctorResult = { location: string; errors: string[]; notes: string[] };

/** Resolve the dsh home. An explicit root wins so callers can probe a synthetic tree
 * without reading `$DSH_HOME` or the real home directory. */
export function resolveDshHome(dshHome?: string): string {
  if (dshHome !== undefined) return dshHome;
  return process.env[DSH_HOME_ENV] ?? path.join(os.homedir(), DSH_HOME_SUBDIR);
}

/** The `web` profile directory under a dsh home. */
export function resolveDshProfileDir(dshHome?: string): string {
  return path.join(resolveDshHome(dshHome), DSH_PROFILES_DIR, DSH_PROFILE);
}

/** Read the installed fallbacks package version from a profile tree. Missing or unreadable artifacts return null. */
export function readInstalledFallbacksVersion(profileDir: string): string | null {
  const pkgJson = path.join(profileDir, "node_modules", DSH_FALLBACKS_LOADER_NAME, "package.json");
  try {
    const raw = fs.readFileSync(pkgJson, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !("version" in parsed) || typeof parsed.version !== "string") {
      return null;
    }
    const trimmed = parsed.version.trim();
    if (FALLBACKS_VERSION_SHAPE_RE.test(trimmed)) return trimmed;
  } catch {
    // absent / unreadable
  }
  return null;
}

/** True when the profile's installed fallbacks version is missing or differs from the harness pin. */
export function fallbacksVersionDrifted(profileDir: string): boolean {
  if (!FALLBACKS_VERSION_SHAPE_RE.test(DSH_LLM_FALLBACKS_VERSION)) return false;
  const installedVersion = readInstalledFallbacksVersion(profileDir);
  if (installedVersion === null) return true;
  return compareSemver(installedVersion, DSH_LLM_FALLBACKS_VERSION) !== 0;
}

/** Probe whether dsh is executable; diagnostic failures are reported as unavailable. */
export function isDshAvailable(probe: () => unknown): boolean {
  try {
    probe();
    return true;
  } catch {
    return false;
  }
}

/** Parse loader entries from a `dsh --profile <name> --dump-config` dump: a
 * flat list of `- id: <id>` entries, each carrying a `name: <spec>` line plus
 * optional keys at the same 2-space indent. Returns null when the dump is
 * non-empty but yields no named entry (or an entry without a `name:` line) —
 * format drift — so callers degrade loudly instead of misreporting the
 * installed state. `enabled` is false for a literal `disabled: true` or
 * `enabled: false` marker (standalone 2-space line, or inline on the `- id:` /
 * `name:` line). `!!js` expressions are not statically decidable and count as enabled. */
export function parseDshLoaderEntries(dump: string): DshLoaderEntry[] | null {
  const entries: DshLoaderEntry[] = [];
  let current: DshLoaderEntry | null = null;
  for (const line of dump.split("\n")) {
    if (/^- id: /.test(line)) {
      if (current) entries.push(current);
      current = { name: "", enabled: !DISABLED_MARKERS.test(line) };
    } else if (current) {
      const nameMatch = /^  name: (.+)$/.exec(line);
      if (nameMatch) {
        let name = nameMatch[1].trim();
        if (DISABLED_MARKERS.test(line)) {
          current.enabled = false;
          // Inline marker on the name line (drift shape): strip a trailing
          // `, disabled: true` / ` disabled: true` suffix before quote
          // removal so the row still matches its spec.
          name = name.replace(/\s*,?\s*(?:disabled: true|enabled: false)\s*$/, "");
        }
        current.name = name.replace(/^['"]|['"]$/g, "");
      } else if (/^  disabled: true$/.test(line) || /^  enabled: false$/.test(line)) {
        current.enabled = false;
      } else if (line.trim() !== "" && !line.startsWith("  ")) {
        // Top-level line outside the entry block: close the current entry.
        entries.push(current);
        current = null;
      }
    }
  }
  if (current) entries.push(current);
  if (dump.trim() !== "" && (entries.length === 0 || entries.some((entry) => !entry.name))) {
    return null;
  }
  return entries;
}

/** Assemble read-only dsh doctor findings from a command probe and a profile root.
 * `mounted` means a loader row is present and not disabled; this does not boot a fiber.
 * Issue states go to `errors`; every state also gets a worded `notes` line. An unusable
 * probe degrades into an explicit error instead of a silent pass. */
export function diagnoseDshHost(
  runDsh: DshCommandRunner,
  roots?: { dshHome?: string },
): DshDoctorResult {
  const errors: string[] = [];
  const notes: string[] = [];
  const profileDir = resolveDshProfileDir(roots?.dshHome);

  if (!isDshAvailable(() => runDsh(["--version"]))) {
    errors.push(`${DSH_BIN} CLI not found on PATH. ${DSH_INSTALL_HINT}`);
    return { location: profileDir, errors, notes };
  }

  let dump: string;
  try {
    dump = runDsh([DSH_PROFILE_FLAG, DSH_PROFILE, DSH_DUMP_FLAG]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`Warning: could not probe installed plugins (${message}); cannot verify install state.`);
    return { location: profileDir, errors, notes };
  }

  const entries = parseDshLoaderEntries(dump);
  if (entries === null) {
    errors.push("Warning: could not parse installed plugins from dump (unexpected format); cannot verify install state.");
    return { location: profileDir, errors, notes };
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  for (const spec of DSH_PLUGIN_SPECS) {
    const entry = byName.get(spec) ?? byName.get(dshLoaderName(spec));
    const state = !entry ? "uninstalled" : entry.enabled ? "mounted" : "disabled";
    if (spec === DSH_FALLBACKS_SPEC && state === "mounted" && fallbacksVersionDrifted(profileDir)) {
      const installedVersion = readInstalledFallbacksVersion(profileDir);
      const installedLabel = installedVersion ?? "unknown";
      notes.push(`${spec}: drifted (installed ${installedLabel}, pinned ${DSH_LLM_FALLBACKS_VERSION})`);
      errors.push(
        `${spec} is drifted (profile has ${installedLabel}, harness pins ${DSH_LLM_FALLBACKS_VERSION}). Run: mstar-harness init --target dsh`,
      );
      continue;
    }
    notes.push(`${spec}: ${state}`);
    if (state === "mounted") continue;
    const hint =
      state === "uninstalled"
        ? "Run: mstar-harness init --target dsh"
        : "Enable it (e.g. remove the disable entry from cordis.patch.yml) and re-run doctor.";
    errors.push(`${spec} is ${state}. ${hint}`);
  }
  return { location: profileDir, errors, notes };
}
