import fs from "node:fs";
import path from "node:path";

export const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";

/** Historical git-based plugin entries for this harness repository. */
export function isLegacyMorningStarGitPlugin(plugin: string): boolean {
  const raw = plugin.trim();
  const match = /^morning-star@git\+(.+)$/i.exec(raw);
  if (!match) return false;
  const spec = match[1].split("#")[0].trim().toLowerCase();
  return (
    /^https?:\/\/github\.com\/btspoony\/mstar-harness(\.git)?(\/.*)?$/.test(spec) ||
    /^ssh:\/\/git@github\.com\/btspoony\/mstar-harness(\.git)?(\/.*)?$/.test(spec) ||
    /^git@github\.com:btspoony\/mstar-harness(\.git)?$/.test(spec)
  );
}

export function isMstarHarnessOpencodePlugin(plugin: string): boolean {
  const value = plugin.trim();
  return value === "@mstar-harness/opencode" || value.startsWith("@mstar-harness/opencode@");
}

export function isAnyMstarHarnessOpencodeSlot(plugin: string): boolean {
  return isLegacyMorningStarGitPlugin(plugin) || isMstarHarnessOpencodePlugin(plugin);
}

export function validateOpencodeConfig(config: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (config.$schema !== OPENCODE_CONFIG_SCHEMA) {
    errors.push(`Missing or invalid $schema (expected: ${OPENCODE_CONFIG_SCHEMA}).`);
  }
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  const hasMstarOpencode = plugins.some(
    (item) => typeof item === "string" && isAnyMstarHarnessOpencodeSlot(item.trim()),
  );
  if (!hasMstarOpencode) {
    errors.push("Missing @mstar-harness/opencode plugin entry in `plugin` (or legacy morning-star git plugin).");
  }
  return errors;
}

export function getOpencodeDoctorWarnings(
  config: Record<string, unknown>,
  allRoles: readonly string[],
): string[] {
  const warnings: string[] = [];
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  const strings = plugins
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  const hasNpm = strings.some(isMstarHarnessOpencodePlugin);
  const hasLegacy = strings.some(isLegacyMorningStarGitPlugin);
  if (hasLegacy && !hasNpm) {
    warnings.push(
      "Plugin list uses legacy `morning-star@git+…` for this harness; run `mstar-harness init --target opencode` to rewrite to `@mstar-harness/opencode@latest`.",
    );
  }
  if (hasLegacy && hasNpm) {
    warnings.push(
      "Both legacy `morning-star@git+…` and `@mstar-harness/opencode` appear in `plugin`; run `init` again to dedupe and keep a single npm plugin line.",
    );
  }

  const agent = config.agent && typeof config.agent === "object" && !Array.isArray(config.agent)
    ? config.agent as Record<string, unknown>
    : {};
  const missingModels = allRoles.filter((roleId) => {
    const role = agent[roleId] && typeof agent[roleId] === "object" && !Array.isArray(agent[roleId])
      ? agent[roleId] as Record<string, unknown>
      : {};
    return typeof role.model !== "string" || !role.model.trim();
  });
  if (missingModels.length) {
    warnings.push(
      `${missingModels.length} role(s) have no explicit agent.<role>.model — OpenCode default model will be used (recommended for fastest setup).`,
    );
  }
  return warnings;
}

export type OpencodeDoctorResult = { location: string; errors: string[]; warnings: string[] };

/** Discover and validate opencode.json beneath a supplied synthetic or real host root. */
export function diagnoseOpencodeHost(root: string, allRoles: readonly string[]): OpencodeDoctorResult {
  const location = path.join(root, "opencode.json");
  let config: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(location, "utf8"));
    config = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { location, errors: [`Missing config file: ${location}`], warnings: [] };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { location, errors: [`Could not read config file ${location}: ${message}`], warnings: [] };
  }
  const errors = validateOpencodeConfig(config);
  return {
    location,
    errors,
    warnings: errors.length ? [] : getOpencodeDoctorWarnings(config, allRoles),
  };
}
