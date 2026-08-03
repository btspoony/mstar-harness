import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter, Scope } from "../types";
import { ensureObject, readJson, writeJson, resolveProjectRoot } from "../utils";
import {
  REPO_URL,
  PLUGIN_NAME,
  HARNESS_REPO_PATH,
  ensureLocalHarnessRepo,
  ensureGitCheckout,
  validateLocalHarnessRepo,
  validateGitCheckout,
  appendGitignore,
  appendHarnessProjectGitignore,
  missingHarnessProcessGitignoreEntries,
  homeRelativeSourcePath,
} from "./shared-install";

const MARKETPLACE_ID = "mstar-local";
const MARKETPLACE_NAME = "mstar-local";
const MARKETPLACE_DESCRIPTION = "Local Morning Star harness marketplace (directory source).";
const PLUGIN_DESCRIPTION =
  "Multi-agent code harness framework with unified skills for OpenCode, Cursor, Codex, Kimi Code, and ZCode.";
const PLUGIN_VERSION = "1.5.6";
const PLUGIN_CATEGORY = "Productivity";
const ZCODE_PLUGIN_MARKER = ".zcode-plugin/plugin.json";
const ZCODE_PLUGIN_CHECKOUT_PROJECT = ".zcode/plugin-checkout";
const ZCODE_AGENT_SMOKE_NAMES = ["fullstack-dev", "qc-specialist"];

const ZCODE_PLUGINS_ROOT = path.join(os.homedir(), ".zcode", "cli", "plugins");
const KNOWN_MARKETPLACES_PATH = path.join(ZCODE_PLUGINS_ROOT, "known_marketplaces.json");
const MARKETPLACE_DIR = path.join(ZCODE_PLUGINS_ROOT, "marketplaces", MARKETPLACE_ID);
const MARKETPLACE_JSON_PATH = path.join(MARKETPLACE_DIR, "marketplace.json");

type MarketplacePluginEntry = {
  name: string;
  source: { source: "directory"; path: string };
  description: string;
  version: string;
  category: string;
};

type KnownMarketplaceEntry = {
  id: string;
  source: { source: "directory"; path: string } | { source: "github"; repo: string };
  name: string;
  description: string;
  addedAt: string;
  pluginCount: number;
  lastUpdated: string;
};

function nowIso() {
  return new Date().toISOString();
}

/** Where the plugin source directory lives for a given scope. */
function pluginSourcePath(scope: Scope): string {
  if (scope === "global") return HARNESS_REPO_PATH;
  return path.join(resolveProjectRoot(), ZCODE_PLUGIN_CHECKOUT_PROJECT);
}

function marketplacePluginEntry(scope: Scope): MarketplacePluginEntry {
  const sourcePath =
    scope === "global" ? homeRelativeSourcePath(HARNESS_REPO_PATH) : `./${ZCODE_PLUGIN_CHECKOUT_PROJECT}`;
  return {
    name: PLUGIN_NAME,
    source: { source: "directory", path: sourcePath },
    description: PLUGIN_DESCRIPTION,
    version: PLUGIN_VERSION,
    category: PLUGIN_CATEGORY,
  };
}

function knownMarketplaceEntry(scope: Scope, existing?: Record<string, unknown>): KnownMarketplaceEntry {
  const source: KnownMarketplaceEntry["source"] =
    scope === "global"
      ? { source: "directory", path: homeRelativeSourcePath(HARNESS_REPO_PATH) }
      : { source: "github", repo: "btspoony/mstar-harness" };
  const previous = (existing && typeof existing.addedAt === "string" && existing.addedAt) || nowIso();
  return {
    id: MARKETPLACE_ID,
    source,
    name: MARKETPLACE_NAME,
    description: MARKETPLACE_DESCRIPTION,
    addedAt: previous,
    pluginCount: 1,
    lastUpdated: nowIso(),
  };
}

/** Normalize + upsert the mstar-local entry in known_marketplaces.json. */
function upsertKnownMarketplace(raw: Record<string, unknown>, scope: Scope) {
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
  marketplaces.push(knownMarketplaceEntry(scope, existing));
  next.marketplaces = marketplaces;
  return next;
}

function findKnownMarketplace(raw: Record<string, unknown>) {
  const marketplaces = Array.isArray(raw.marketplaces) ? raw.marketplaces : [];
  return marketplaces.find((entry) => {
    return (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as { id?: unknown }).id === MARKETPLACE_ID
    );
  }) as Record<string, unknown> | undefined;
}

function findMarketplacePlugin(raw: Record<string, unknown>) {
  const plugins = Array.isArray(raw.plugins) ? raw.plugins : [];
  return plugins.find((entry) => {
    return (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as { name?: unknown }).name === PLUGIN_NAME
    );
  }) as Record<string, unknown> | undefined;
}

function validateMarketplaceJson(scope: Scope) {
  const errors: string[] = [];
  if (!fs.existsSync(MARKETPLACE_JSON_PATH)) {
    errors.push(`Missing ZCode marketplace: ${MARKETPLACE_JSON_PATH}`);
    return errors;
  }
  const raw = readJson(MARKETPLACE_JSON_PATH);
  if (raw.name !== MARKETPLACE_NAME) {
    errors.push(`ZCode marketplace name must be ${MARKETPLACE_NAME} (in ${MARKETPLACE_JSON_PATH}).`);
  }
  const entry = findMarketplacePlugin(raw);
  if (!entry) {
    errors.push(`Missing ${PLUGIN_NAME} plugin entry in ${MARKETPLACE_JSON_PATH}.`);
    return errors;
  }
  const expected = marketplacePluginEntry(scope);
  const source = ensureObject(entry.source);
  if (source.source !== "directory") {
    errors.push("ZCode marketplace plugin source.source must be `directory`.");
  }
  if (source.path !== expected.source.path) {
    errors.push(`ZCode marketplace plugin source.path must be ${expected.source.path}.`);
  }
  if (entry.version !== PLUGIN_VERSION) {
    errors.push(`ZCode marketplace plugin version must be ${PLUGIN_VERSION}.`);
  }
  return errors;
}

function validateKnownMarketplaces(scope: Scope) {
  const errors: string[] = [];
  if (!fs.existsSync(KNOWN_MARKETPLACES_PATH)) {
    errors.push(`Missing ZCode known_marketplaces.json: ${KNOWN_MARKETPLACES_PATH}`);
    return errors;
  }
  const raw = readJson(KNOWN_MARKETPLACES_PATH);
  const entry = findKnownMarketplace(raw);
  if (!entry) {
    errors.push(`Missing ${MARKETPLACE_ID} entry in ${KNOWN_MARKETPLACES_PATH}.`);
    return errors;
  }
  const expected = knownMarketplaceEntry(scope, entry);
  if (entry.id !== MARKETPLACE_ID) errors.push(`known_marketplaces entry id must be ${MARKETPLACE_ID}.`);
  const source = ensureObject(entry.source);
  const expectedSource = expected.source as { source: string };
  if (source.source !== expectedSource.source) {
    errors.push(`known_marketplaces entry source.source must be ${expectedSource.source}.`);
  }
  return errors;
}

function validatePluginAgents(pluginRoot: string) {
  const errors: string[] = [];
  const agentsDir = path.join(pluginRoot, "agents");
  if (!fs.existsSync(agentsDir)) {
    errors.push(`Missing plugin agents directory: ${agentsDir}`);
    return errors;
  }
  for (const agentName of ZCODE_AGENT_SMOKE_NAMES) {
    const agentPath = path.join(agentsDir, `${agentName}.md`);
    if (!fs.existsSync(agentPath)) {
      errors.push(`Missing plugin agent file: ${agentPath}`);
    }
  }
  return errors;
}

function runInit(scope: Scope, dryRun: boolean) {
  const notes = ensureLocalHarnessRepo(dryRun);
  const projectRoot = resolveProjectRoot();

  if (scope === "project") {
    const checkoutPath = path.join(projectRoot, ZCODE_PLUGIN_CHECKOUT_PROJECT);
    notes.push(...ensureGitCheckout(REPO_URL, checkoutPath, dryRun));
    notes.push(...appendGitignore(projectRoot, [ZCODE_PLUGIN_CHECKOUT_PROJECT], dryRun));
    notes.push(...appendHarnessProjectGitignore(projectRoot, dryRun));
    notes.push(
      `Materialized ZCode plugin checkout at ${ZCODE_PLUGIN_CHECKOUT_PROJECT} (directory source requires a real directory).`,
    );
  }

  // Write the marketplace.json (single mstar plugin entry).
  const marketplaceJson = buildMarketplaceJsonForScope(scope);
  if (!dryRun) {
    if (!fs.existsSync(MARKETPLACE_DIR)) fs.mkdirSync(MARKETPLACE_DIR, { recursive: true });
    writeJson(MARKETPLACE_JSON_PATH, marketplaceJson);
  }
  notes.push(`Wrote ZCode marketplace: ${MARKETPLACE_JSON_PATH}`);

  // Upsert the mstar-local entry in known_marketplaces.json.
  const knownRaw = readJson(KNOWN_MARKETPLACES_PATH);
  const knownNext = upsertKnownMarketplace(knownRaw, scope);
  if (!dryRun) writeJson(KNOWN_MARKETPLACES_PATH, knownNext);
  notes.push(`Registered ${MARKETPLACE_ID} marketplace in ${KNOWN_MARKETPLACES_PATH}`);

  notes.push(
    `Then in ZCode: Settings → Plugin Management → Discover → install ${PLUGIN_NAME} from the ${MARKETPLACE_ID} marketplace.`,
  );
  notes.push(
    `Fallback (if directory source is rejected): add \`github:btspoony/mstar-harness\` as a marketplace instead.`,
  );

  return {
    location: KNOWN_MARKETPLACES_PATH,
    notes,
  };
}

function buildMarketplaceJsonForScope(scope: Scope): Record<string, unknown> {
  return {
    name: MARKETPLACE_NAME,
    description: MARKETPLACE_DESCRIPTION,
    plugins: [marketplacePluginEntry(scope)],
  };
}

function runDoctor(scope: Scope) {
  const errors: string[] = [];
  errors.push(...validateLocalHarnessRepo());

  if (scope === "project") {
    const projectRoot = resolveProjectRoot();
    const checkoutPath = path.join(projectRoot, ZCODE_PLUGIN_CHECKOUT_PROJECT);
    errors.push(...validateGitCheckout(checkoutPath, ZCODE_PLUGIN_MARKER));
    const gitignorePath = path.join(projectRoot, ".gitignore");
    const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
    if (!gitignore.split(/\r?\n/).includes(ZCODE_PLUGIN_CHECKOUT_PROJECT)) {
      errors.push(`Missing .gitignore entry: ${ZCODE_PLUGIN_CHECKOUT_PROJECT}`);
    }
    for (const entry of missingHarnessProcessGitignoreEntries(gitignore)) {
      errors.push(`Missing .gitignore entry: ${entry}`);
    }
    errors.push(...validatePluginAgents(checkoutPath));
  } else {
    errors.push(...validatePluginAgents(HARNESS_REPO_PATH));
  }

  errors.push(...validateKnownMarketplaces(scope));
  errors.push(...validateMarketplaceJson(scope));

  return { location: KNOWN_MARKETPLACES_PATH, errors };
}

export const zcodeAdapter: AgentAdapter = {
  target: "zcode",
  mode: "install",
  runInstallInit: (scope, dryRun) => runInit(scope, dryRun),
  runInstallDoctor: (scope) => runDoctor(scope),
};
