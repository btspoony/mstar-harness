import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter, Scope } from "../types";
import { ensureObject, readJson, writeJson, resolveProjectRoot, readHarnessVersion } from "../utils";
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
} from "./shared-install";

const MARKETPLACE_ID = "mstar-local";
const MARKETPLACE_NAME = "mstar-local";
const MARKETPLACE_DESCRIPTION = "Morning Star harness marketplace (GitHub source).";
const PLUGIN_DESCRIPTION =
  "Multi-agent code harness framework with unified skills for OpenCode, Cursor, Codex, Kimi Code, and ZCode.";
const PLUGIN_CATEGORY = "Productivity";
const GITHUB_REPO = "btspoony/mstar-harness";
const GITHUB_REF = "main";
const ZCODE_PLUGIN_MARKER = ".zcode-plugin/plugin.json";
const ZCODE_PLUGIN_CHECKOUT_PROJECT = ".zcode/plugin-checkout";
const ZCODE_AGENT_SMOKE_NAMES = ["fullstack-dev", "qc-specialist"];

const ZCODE_PLUGINS_ROOT = path.join(os.homedir(), ".zcode", "cli", "plugins");
const KNOWN_MARKETPLACES_PATH = path.join(ZCODE_PLUGINS_ROOT, "known_marketplaces.json");
const MARKETPLACE_DIR = path.join(ZCODE_PLUGINS_ROOT, "marketplaces", MARKETPLACE_ID);
const MARKETPLACE_JSON_PATH = path.join(MARKETPLACE_DIR, "marketplace.json");

type GithubSource = { source: "github"; repo: string; ref?: string };

type MarketplacePluginEntry = {
  name: string;
  source: GithubSource;
  description: string;
  version: string;
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

function marketplacePluginEntry(): MarketplacePluginEntry {
  return {
    name: PLUGIN_NAME,
    source: { ...GITHUB_SOURCE },
    description: PLUGIN_DESCRIPTION,
    version: readHarnessVersion(),
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

function validateMarketplaceJson() {
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
  const expected = marketplacePluginEntry();
  const source = ensureObject(entry.source);
  if (source.source !== "github") {
    errors.push("ZCode marketplace plugin source.source must be `github`.");
  }
  if (source.repo !== expected.source.repo) {
    errors.push(`ZCode marketplace plugin source.repo must be ${expected.source.repo}.`);
  }
  const expectedVersion = readHarnessVersion();
  if (entry.version !== expectedVersion) {
    errors.push(`ZCode marketplace plugin version must be ${expectedVersion}.`);
  }
  return errors;
}

function validateKnownMarketplaces() {
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
  if (entry.id !== MARKETPLACE_ID) errors.push(`known_marketplaces entry id must be ${MARKETPLACE_ID}.`);
  const source = ensureObject(entry.source);
  if (source.source !== "github") {
    errors.push(`known_marketplaces entry source.source must be github.`);
  }
  if (source.repo !== GITHUB_REPO) {
    errors.push(`known_marketplaces entry source.repo must be ${GITHUB_REPO}.`);
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
    `Then in ZCode: Settings → Plugin Management → Discover → install ${PLUGIN_NAME} from the ${MARKETPLACE_ID} marketplace.`,
  );

  return {
    location: KNOWN_MARKETPLACES_PATH,
    notes,
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

  errors.push(...validateKnownMarketplaces());
  errors.push(...validateMarketplaceJson());

  return { location: KNOWN_MARKETPLACES_PATH, errors };
}

export const zcodeAdapter: AgentAdapter = {
  target: "zcode",
  mode: "install",
  runInstallInit: (scope, dryRun) => runInit(scope, dryRun),
  runInstallDoctor: (scope) => runDoctor(scope),
};
