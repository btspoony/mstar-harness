import fs from "node:fs";

const PLUGIN_NAME = "morning-star-harness";
export const CODEX_MARKETPLACE_NAME = "mstar-repo";
const MARKETPLACE_GIT_SOURCE = "btspoony/mstar-harness";
const CODEX_PLUGIN_ID = `${PLUGIN_NAME}@${CODEX_MARKETPLACE_NAME}`;

export type CodexCommandRunner = (args: string[]) => string;

/** Parse `codex plugin marketplace list --json` into configured marketplace names. */
export function parseCodexMarketplaceNames(dump: string): string[] {
  const parsed = JSON.parse(dump) as { marketplaces?: unknown };
  const list = Array.isArray(parsed.marketplaces) ? parsed.marketplaces : [];
  return list
    .map((entry) => (entry && typeof entry === "object" && "name" in entry && typeof entry.name === "string" ? entry.name : ""))
    .filter((name) => name !== "");
}

/** Parse `codex plugin list --json` into full installed entries. */
export function parseCodexInstalledEntries(dump: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(dump) as { installed?: unknown };
  const list = Array.isArray(parsed.installed) ? parsed.installed : [];
  return list.filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
}

/** Extract installed plugin IDs from a codex plugin-list response. */
export function parseCodexInstalledPluginIds(dump: string): string[] {
  return parseCodexInstalledEntries(dump)
    .map((entry) => (typeof entry.pluginId === "string" ? entry.pluginId : ""))
    .filter((pluginId) => pluginId !== "");
}

/** Probe whether Codex is executable; diagnostic failures are reported as unavailable. */
export function isCodexAvailable(probe: () => unknown): boolean {
  try {
    probe();
    return true;
  } catch {
    return false;
  }
}

/** Discover the installed Morning Star plugin version; command and parse failures report null. */
export function detectCodexPluginVersion(runCodex: CodexCommandRunner): string | null {
  let entries: Array<Record<string, unknown>>;
  try {
    entries = parseCodexInstalledEntries(runCodex(["plugin", "list", "--json"]));
  } catch {
    return null;
  }
  const entry = entries.find((candidate) => candidate.pluginId === CODEX_PLUGIN_ID);
  const version = typeof entry?.version === "string" ? entry.version : "";
  return version === "" ? null : version;
}

/** Format a migration note for a legacy personal marketplace dump, if present. */
export function legacyCodexMarketplaceNote(raw: string, legacyPath: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { plugins?: unknown };
    const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
    const hasMstar = plugins.some(
      (entry) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry) && "name" in entry && entry.name === PLUGIN_NAME,
    );
    if (hasMstar) {
      return `Legacy personal marketplace entry found at ${legacyPath} — the ${PLUGIN_NAME} plugin now installs from the repo marketplace (${MARKETPLACE_GIT_SOURCE}). Remove the entry, then install: codex plugin add ${CODEX_PLUGIN_ID}`;
    }
  } catch {
    // Unparseable user config: leave it alone.
  }
  return null;
}

const CODEX_BIN = "codex";
const CODEX_INSTALL_HINT =
  "Install the Codex CLI (https://github.com/openai/codex), e.g. `npm install -g @openai/codex`, then re-run init.";

export type CodexDoctorResult = { location: string; errors: string[]; notes: string[] };

/** Assemble read-only Codex doctor findings from the CLI probe and optional legacy artifact. */
export function diagnoseCodexHost(
  runCodex: CodexCommandRunner,
  legacyMarketplacePath: string,
): CodexDoctorResult {
  const errors: string[] = [];
  const notes: string[] = [];
  let legacyRaw: string;
  try {
    legacyRaw = fs.readFileSync(legacyMarketplacePath, "utf8");
  } catch {
    legacyRaw = "";
  }
  const legacyNote = legacyCodexMarketplaceNote(legacyRaw, legacyMarketplacePath);
  if (legacyNote) notes.push(legacyNote);

  if (!isCodexAvailable(() => runCodex(["--version"]))) {
    errors.push(`${CODEX_BIN} CLI not found on PATH. ${CODEX_INSTALL_HINT}`);
    return { location: `${CODEX_BIN} marketplaces (config.toml)`, errors, notes };
  }

  try {
    const marketplaces = parseCodexMarketplaceNames(runCodex(["plugin", "marketplace", "list", "--json"]));
    if (!marketplaces.includes(CODEX_MARKETPLACE_NAME)) {
      errors.push(
        `Marketplace ${CODEX_MARKETPLACE_NAME} not configured (run init, or: ${CODEX_BIN} plugin marketplace add ${MARKETPLACE_GIT_SOURCE} --ref main).`,
      );
    }
    const installed = parseCodexInstalledPluginIds(runCodex(["plugin", "list", "--json"]));
    if (marketplaces.includes(CODEX_MARKETPLACE_NAME) && !installed.includes(CODEX_PLUGIN_ID)) {
      notes.push(`Plugin not installed yet: ${CODEX_BIN} plugin add ${CODEX_PLUGIN_ID}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`Could not query ${CODEX_BIN} plugin marketplace list: ${message}`);
  }
  return { location: `${CODEX_BIN} marketplaces (config.toml)`, errors, notes };
}
