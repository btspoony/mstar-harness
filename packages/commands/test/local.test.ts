import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareSemver,
  detectCursorPluginVersionForScope,
  detectZcodePluginVersion,
  formatPluginVersionDoctorNote,
  joinWithinRoot,
  resolveCliPath,
  validateAgentPlugin,
} from "../src/index.js";

const previousProjectRoot = process.env.MSTAR_CLI_PROJECT_ROOT;
const fixtures: string[] = [];

afterEach(() => {
  if (previousProjectRoot === undefined) delete process.env.MSTAR_CLI_PROJECT_ROOT;
  else process.env.MSTAR_CLI_PROJECT_ROOT = previousProjectRoot;
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "commands-host-health-"));
  fixtures.push(root);
  return root;
}

function writeJson(root: string, relative: string, value: unknown): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

describe("shared host-health helpers", () => {
  test("shared path helpers resolve relative paths and reject lexical root escapes", () => {
    const root = fixture();
    process.env.MSTAR_CLI_PROJECT_ROOT = root;
    expect(resolveCliPath("docs/spec.md")).toBe(path.join(root, "docs/spec.md"));
    expect(joinWithinRoot(root, "child", "file.json")).toBe(path.join(root, "child", "file.json"));
    expect(() => joinWithinRoot(root, "..", "outside")).toThrow(`path escapes ${root}`);
  });

  test("shared semver comparison applies prerelease precedence", () => {
    expect(compareSemver("2.0.0-rc.2", "2.0.0-rc.10")).toBeLessThan(0);
    expect(compareSemver("2.0.0", "2.0.0-rc.10")).toBeGreaterThan(0);
  });

  test("shared manifest discovery selects the highest installed version and preserves note wording", () => {
    const project = fixture();
    const global = fixture();
    writeJson(project, ".cursor-plugin/plugin.json", { version: "1.2.0" });
    writeJson(global, "package.json", { version: "1.3.0" });
    expect(detectCursorPluginVersionForScope("project", { project, global })).toBe("1.2.0");
    expect(detectCursorPluginVersionForScope("global", { project, global })).toBe("1.3.0");
    expect(formatPluginVersionDoctorNote("cursor", "1.3.0", "1.3.0")).toBe("Plugin/CLI versions aligned (1.3.0).");
    expect(formatPluginVersionDoctorNote("cursor", "1.3.0", null)).toContain("No installed Morning Star plugin found");
  });

  test("shared ZCode discovery tolerates missing manifests and orders cache versions", () => {
    const root = fixture();
    writeJson(root, "marketplace/morning-star-harness/1.0.0/.zcode-plugin/plugin.json", { version: "1.0.0" });
    mkdirSync(path.join(root, "marketplace", "morning-star-harness", "2.1.0"), { recursive: true });
    expect(detectZcodePluginVersion(root)).toBe("2.1.0");
    expect(detectZcodePluginVersion(path.join(root, "missing"))).toBeNull();
  });

  test("shared agent-plugin validation reads fixtures and reports schema violations", () => {
    const root = fixture();
    writeJson(root, "plugin.json", {
      "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "fixture-plugin",
    });
    expect(validateAgentPlugin(root)).toMatchObject({ ok: true, errors: [], warnings: [] });
    writeJson(root, "plugin.json", { name: "Invalid--Name" });
    const invalid = validateAgentPlugin(root);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors).toContain('plugin.json: "$schema" is required and must be the string https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
    expect(invalid.errors.some((error) => error.includes("violates Agent Plugins name rules"))).toBe(true);
  });
});
