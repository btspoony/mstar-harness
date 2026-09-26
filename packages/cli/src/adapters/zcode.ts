import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter, Scope } from "../types";
import { ensureObject, readJson, writeJson, resolveProjectRoot, readHarnessVersion } from "../utils";
import { diagnoseZcodeHost } from "@mstar-harness/commands";
import {
  REPO_URL,
  PLUGIN_NAME,
  HARNESS_REPO_PATH,
  ensureLocalHarnessRepo,
  ensureGitCheckout,
  appendGitignore,
  appendHarnessProjectGitignore,
} from "./shared-install";

const MARKETPLACE_ID = "mstar-local";
const MARKETPLACE_NAME = "mstar-local";
const MARKETPLACE_DESCRIPTION = "Morning Star harness marketplace (GitHub source).";
const PLUGIN_DESCRIPTION =
  "Multi-agent code harness framework with unified skills for OpenCode, Cursor, Codex, Kimi Code, and ZCode.";
const PLUGIN_CATEGORY = "Productivity";
// Keep in sync with the repo-shipped marketplace manifests (`.claude-plugin/marketplace.json`,
// root `marketplace.json`) — ZCode replaces the bootstrap snapshot with the repo manifest on refresh.
const PLUGIN_DISPLAY_NAME = "Morning Star Harness";
const PLUGIN_ICON_URL = "https://raw.githubusercontent.com/btspoony/mstar-harness/main/assets/icon.png";
const GITHUB_REPO = "btspoony/mstar-harness";
const GITHUB_REF = "main";
const ZCODE_PLUGIN_CHECKOUT_PROJECT = ".zcode/plugin-checkout";
const ZCODE_PLUGINS_ROOT = path.join(os.homedir(), ".zcode", "cli", "plugins");
const KNOWN_MARKETPLACES_PATH = path.join(ZCODE_PLUGINS_ROOT, "known_marketplaces.json");
const MARKETPLACE_DIR = path.join(ZCODE_PLUGINS_ROOT, "marketplaces", MARKETPLACE_ID);

type GithubSource = { source: "github"; repo: string; ref?: string };

type MarketplacePluginEntry = {
  name: string;
  version: string;
  source: GithubSource;
  displayName: string;
  icon: string;
  description: string;
  category: string;
};

type KnownMarketplaceEntry = {
  id: string;
  source: GithubSource;
  name: string;
  description: string;
  addedAt: string;
  pluginCount: number;
  lastUpdated: string;
};

const GITHUB_SOURCE: GithubSource = { source: "github", repo: GITHUB_REPO, ref: GITHUB_REF };

function nowIso() {
  return new Date().toISOString();
}

/**
 * Bootstrap snapshot for ZCode's marketplace.json. The seeded `version` is
 * the CLI release version — the exact value `validateMarketplaceJson` (doctor)
 * compares against, so a current-CLI install always passes doctor even when
 * the shared `~/.mstar/harness` checkout is stale. ZCode's marketplace
 * refresh overwrites this seed with the repo-shipped manifest
 * (`.claude-plugin/marketplace.json`), which pins the release version too.
 * Exported for tests.
 */
export function marketplacePluginEntry(): MarketplacePluginEntry {
  return {
    name: PLUGIN_NAME,
    version: readHarnessVersion(),
    source: { ...GITHUB_SOURCE },
    displayName: PLUGIN_DISPLAY_NAME,
    icon: PLUGIN_ICON_URL,
    description: PLUGIN_DESCRIPTION,
    category: PLUGIN_CATEGORY,
  };
}

function knownMarketplaceEntry(existing?: Record<string, unknown>): KnownMarketplaceEntry {
  const previous = (existing && typeof existing.addedAt === "string" && existing.addedAt) || nowIso();
  return {
    id: MARKETPLACE_ID,
    source: { ...GITHUB_SOURCE },
    name: MARKETPLACE_NAME,
    description: MARKETPLACE_DESCRIPTION,
    addedAt: previous,
    pluginCount: 1,
    lastUpdated: nowIso(),
  };
}

/** Normalize + upsert the mstar-local entry in known_marketplaces.json. */
function upsertKnownMarketplace(raw: Record<string, unknown>) {
  const next = ensureObject(raw);
  if (typeof next.version !== "number") next.version = 1;
  if (!Array.isArray(next.marketplaces)) next.marketplaces = [];
  const existing = (next.marketplaces as unknown[]).find((entry) => {
    return (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as { id?: unknown }).id === MARKETPLACE_ID
    );
  }) as Record<string, unknown> | undefined;
  const marketplaces = (next.marketplaces as unknown[]).filter((entry) => {
    return !(
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as { id?: unknown }).id === MARKETPLACE_ID
    );
  });
  marketplaces.push(knownMarketplaceEntry(existing));
  next.marketplaces = marketplaces;
  return next;
}


function buildMarketplaceJson(): Record<string, unknown> {
  return {
    name: MARKETPLACE_NAME,
    description: MARKETPLACE_DESCRIPTION,
    plugins: [marketplacePluginEntry()],
  };
}

function runInit(scope: Scope, dryRun: boolean) {
  const notes = ensureLocalHarnessRepo(dryRun);
  const projectRoot = resolveProjectRoot();

  if (scope === "project") {
    // Project scope keeps a local real checkout for doctor/agent-file smoke checks.
    // The registered marketplace still points at the github repo (durable across machines).
    const checkoutPath = path.join(projectRoot, ZCODE_PLUGIN_CHECKOUT_PROJECT);
    notes.push(...ensureGitCheckout(REPO_URL, checkoutPath, dryRun));
    notes.push(...appendGitignore(projectRoot, [ZCODE_PLUGIN_CHECKOUT_PROJECT], dryRun));
    notes.push(...appendHarnessProjectGitignore(projectRoot, dryRun));
    notes.push(
      `Materialized local ZCode plugin checkout at ${ZCODE_PLUGIN_CHECKOUT_PROJECT} for smoke checks (the registered marketplace still points at the github repo).`,
    );
  }

  // Write the marketplace.json (single mstar plugin entry, github source).
  if (!dryRun) {
    if (!fs.existsSync(MARKETPLACE_DIR)) fs.mkdirSync(MARKETPLACE_DIR, { recursive: true });
    writeJson(MARKETPLACE_JSON_PATH, buildMarketplaceJson());
  }
  notes.push(`Wrote ZCode marketplace: ${MARKETPLACE_JSON_PATH}`);

  // Upsert the mstar-local entry in known_marketplaces.json.
  const knownRaw = readJson(KNOWN_MARKETPLACES_PATH);
  const knownNext = upsertKnownMarketplace(knownRaw);
  if (!dryRun) writeJson(KNOWN_MARKETPLACES_PATH, knownNext);
  notes.push(`Registered ${MARKETPLACE_ID} marketplace in ${KNOWN_MARKETPLACES_PATH}`);

  notes.push(
    `Then in ZCode: Settings \u2192 Plugin Management \u2192 Discover \u2192 install ${PLUGIN_NAME} from the ${MARKETPLACE_ID} marketplace.`,
  );

  return {
    location: KNOWN_MARKETPLACES_PATH,
    notes,
  };
}

function runDoctor(scope: Scope) {
  return diagnoseZcodeHost(scope, {
    pluginsRoot: ZCODE_PLUGINS_ROOT,
    projectRoot: resolveProjectRoot(),
    harnessRepoPath: HARNESS_REPO_PATH,
  });
}

export const zcodeAdapter: AgentAdapter = {
  target: "zcode",
  mode: "install",
  runInstallInit: (scope, dryRun) => runInit(scope, dryRun),
  runInstallDoctor: (scope) => runDoctor(scope),
};
