import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentAdapter } from "../types";
import { ensureObject, readJson, writeJson } from "../utils";

const MARKETPLACE_NAME = "personal";
const MARKETPLACE_DISPLAY_NAME = "Personal";
const MARKETPLACE_PATH = path.join(os.homedir(), ".agents", "plugins", "marketplace.json");
const PLUGIN_NAME = "morning-star-harness";
const PLUGIN_URL = "https://github.com/btspoony/mstar-harness.git";
const PLUGIN_REF = "main";
const PLUGIN_CATEGORY = "Productivity";

type MarketplaceEntry = {
  name: string;
  source: {
    source: "url";
    url: string;
    ref: string;
  };
  policy: {
    installation: "AVAILABLE";
    authentication: "ON_INSTALL";
  };
  category: string;
};

function mstarEntry(): MarketplaceEntry {
  return {
    name: PLUGIN_NAME,
    source: {
      source: "url",
      url: PLUGIN_URL,
      ref: PLUGIN_REF,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: PLUGIN_CATEGORY,
  };
}

function normalizeMarketplace(raw: Record<string, unknown>) {
  const next = ensureObject(raw);
  next.name = MARKETPLACE_NAME;
  const iface = ensureObject(next.interface);
  if (typeof iface.displayName !== "string" || !iface.displayName.trim()) {
    iface.displayName = MARKETPLACE_DISPLAY_NAME;
  }
  next.interface = iface;
  if (!Array.isArray(next.plugins)) {
    next.plugins = [];
  }
  return next;
}

function upsertEntry(raw: Record<string, unknown>) {
  const next = normalizeMarketplace(raw);
  const plugins = (next.plugins as unknown[]).filter((entry) => {
    return !(
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as { name?: unknown }).name === PLUGIN_NAME
    );
  });
  plugins.push(mstarEntry());
  next.plugins = plugins;
  return next;
}

function findEntry(raw: Record<string, unknown>) {
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

function validateEntryShape(entry: Record<string, unknown> | undefined) {
  const errors: string[] = [];
  if (!entry) {
    errors.push(`Missing ${PLUGIN_NAME} entry in ${MARKETPLACE_PATH}.`);
    return errors;
  }
  const source = ensureObject(entry.source);
  if (source.source !== "url") errors.push("Codex marketplace entry source.source must be `url`.");
  if (source.url !== PLUGIN_URL) errors.push(`Codex marketplace entry source.url must be ${PLUGIN_URL}.`);
  if (source.ref !== PLUGIN_REF) errors.push(`Codex marketplace entry source.ref must be ${PLUGIN_REF}.`);
  const policy = ensureObject(entry.policy);
  if (policy.installation !== "AVAILABLE") errors.push("Codex marketplace entry policy.installation must be AVAILABLE.");
  if (policy.authentication !== "ON_INSTALL") errors.push("Codex marketplace entry policy.authentication must be ON_INSTALL.");
  if (entry.category !== PLUGIN_CATEGORY) errors.push(`Codex marketplace entry category must be ${PLUGIN_CATEGORY}.`);
  return errors;
}

function runInit(dryRun: boolean) {
  const current = readJson(MARKETPLACE_PATH);
  const next = upsertEntry(current);
  const existingEntry = findEntry(current);
  if (!dryRun) writeJson(MARKETPLACE_PATH, next);
  return {
    location: MARKETPLACE_PATH,
    notes: [
      existingEntry ? `Updated ${PLUGIN_NAME} entry in personal Codex marketplace.` : `Added ${PLUGIN_NAME} entry to personal Codex marketplace.`,
      `Source URL: ${PLUGIN_URL}#${PLUGIN_REF}`,
      `Install after init: codex plugin add ${PLUGIN_NAME} --marketplace ${String(next.name)}`,
    ],
  };
}

function runDoctor() {
  const errors: string[] = [];
  if (!fs.existsSync(MARKETPLACE_PATH)) {
    return { location: MARKETPLACE_PATH, errors: [`Missing Codex personal marketplace: ${MARKETPLACE_PATH}`] };
  }
  const marketplace = readJson(MARKETPLACE_PATH);
  if (marketplace.name !== MARKETPLACE_NAME) {
    errors.push(`Codex personal marketplace name must be ${MARKETPLACE_NAME}.`);
  }
  errors.push(...validateEntryShape(findEntry(marketplace)));
  return { location: MARKETPLACE_PATH, errors };
}

export const codexAdapter: AgentAdapter = {
  target: "codex",
  mode: "install",
  runInstallInit: (_scope, dryRun) => runInit(dryRun),
  runInstallDoctor: () => runDoctor(),
};
