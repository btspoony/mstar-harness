/**
 * V2 generation contract in `@mstar-harness/commands` host-health (plan task 3):
 *   - `OPENCODE_V2_CONFIG_SCHEMA` pins the preserve-don't-invent `$schema`
 *     fallback (opencode tag v2.0.26 `packages/schema/src/config.ts` declares
 *     `$schema` optional with no published id);
 *   - `isMstarHarnessOpencodeV2Slot` matches string AND `{package}` object
 *     forms of the owned V2 plugin slot;
 *   - `detectOpencodeGeneration` is the config-marker consistency guard
 *     (demoted from default selection by D12): plural `plugins` key / V2 slot
 *     → v2 markers, singular `plugin` with an owned V1 slot → v1 markers,
 *     dual-host configs are ambiguous for the guard and validated twice by
 *     the doctor instead;
 *   - `validateOpencodeConfigV2` checks the plural-key contract (never a
 *     `$schema` requirement) and accepts object-form slots;
 *   - `getOpencodeDoctorWarningsV2` mirrors the V1 model-coverage warning on
 *     the plural `agents` key;
 *   - `diagnoseOpencodeV2Host` validates the matched generation(s) with
 *     per-generation prefixes, validates BOTH generations on a dual-host
 *     config, scopes to one generation under explicit selection, and reports
 *     the generation source (probe vs explicit flag vs both-keys).
 * All fixtures live in temp dirs — no real host binary is involved.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  detectOpencodeGeneration,
  diagnoseOpencodeV2Host,
  getOpencodeDoctorWarningsV2,
  hasOpencodeV1Markers,
  hasOpencodeV2Markers,
  isMstarHarnessOpencodeV2Slot,
  OPENCODE_V2_CONFIG_SCHEMA,
  parseOpencodeVersionOutput,
  validateOpencodeConfigV2,
} from "../src/host-health/opencode-v2.js";
import { diagnoseMcpTarget, type McpRuntime } from "../src/host-health/mcp.js";
import { getLocalCommandDefinitions } from "../src/index.js";

const MCP_RUNTIME: McpRuntime = { kind: "node", version: "24.18.0" };

function writeMcpConfig(root: string, config: unknown): void {
  const configDir = join(root, ".config", "opencode");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify(config));
}

const ALL_ROLES = ["project-manager", "fullstack-dev"] as const;

const V2_CONFIG = {
  plugins: ["other-plugin", { package: "@some/pkg", options: { enabled: true } }, "@mstar-harness/opencode-v2@latest"],
  agents: { "project-manager": { model: "model-a" }, "fullstack-dev": { model: "model-b" } },
  mcp: { servers: { "morning-star": { type: "local", command: ["npx", "@mstar-harness/cli", "mcp"] } } },
};

const V1_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  plugin: ["@mstar-harness/opencode@latest"],
};

const DUAL_CONFIG = {
  plugin: ["@mstar-harness/opencode@latest"],
  plugins: ["@mstar-harness/opencode-v2@latest"],
};

function tempRoot(config: Record<string, unknown> | null): string {
  const root = mkdtempSync(join(tmpdir(), "opencode-v2-health-"));
  if (config !== null) writeFileSync(join(root, "opencode.json"), JSON.stringify(config, null, 2));
  return root;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("V2 $schema pin decision", () => {
  test("opencode v2.0.26 publishes no V2 $schema id — the constant records the preserve-don't-invent fallback", () => {
    // The writer must never invent a $schema value and the validator must not
    // require one; this pin is the contracted fallback (spec Q3 $schema rule).
    expect(OPENCODE_V2_CONFIG_SCHEMA).toBeNull();
  });

  test("the V2 validator checks the plural-key contract without requiring $schema", () => {
    expect(validateOpencodeConfigV2({ plugins: ["@mstar-harness/opencode-v2@latest"] })).toEqual([]);
  });
});

describe("isMstarHarnessOpencodeV2Slot", () => {
  test("matches string forms of the owned V2 slot at any version", () => {
    expect(isMstarHarnessOpencodeV2Slot("@mstar-harness/opencode-v2")).toBe(true);
    expect(isMstarHarnessOpencodeV2Slot("@mstar-harness/opencode-v2@latest")).toBe(true);
    expect(isMstarHarnessOpencodeV2Slot("@mstar-harness/opencode-v2@1.2.3")).toBe(true);
    expect(isMstarHarnessOpencodeV2Slot(" @mstar-harness/opencode-v2@latest ")).toBe(true);
  });

  test("matches the {package} object form and rejects everything else", () => {
    expect(isMstarHarnessOpencodeV2Slot({ package: "@mstar-harness/opencode-v2@latest", options: {} })).toBe(true);
    expect(isMstarHarnessOpencodeV2Slot({ package: "@mstar-harness/opencode-v2" })).toBe(true);
    expect(isMstarHarnessOpencodeV2Slot({ package: "@some/pkg" })).toBe(false);
    expect(isMstarHarnessOpencodeV2Slot({ options: {} })).toBe(false);
    expect(isMstarHarnessOpencodeV2Slot("@mstar-harness/opencode@latest")).toBe(false);
    expect(isMstarHarnessOpencodeV2Slot("unrelated")).toBe(false);
    expect(isMstarHarnessOpencodeV2Slot(42)).toBe(false);
    expect(isMstarHarnessOpencodeV2Slot(null)).toBe(false);
  });
});

describe("detectOpencodeGeneration consistency guard", () => {
  test("plural `plugins` key / V2 slot markers resolve v2", () => {
    expect(hasOpencodeV2Markers(V2_CONFIG)).toBe(true);
    expect(detectOpencodeGeneration(V2_CONFIG)).toBe("v2");
    // The plural key itself is a v2 marker even when it holds only unrelated entries.
    expect(detectOpencodeGeneration({ plugins: ["unrelated"] })).toBe("v2");
  });

  test("singular `plugin` with an owned V1 slot resolves v1", () => {
    expect(hasOpencodeV1Markers(V1_CONFIG)).toBe(true);
    expect(detectOpencodeGeneration(V1_CONFIG)).toBe("v1");
    // The singular key alone is not a marker without an owned slot.
    expect(detectOpencodeGeneration({ plugin: ["unrelated"] })).toBeNull();
  });

  test("dual-host configs are ambiguous for the guard (the doctor validates both instead)", () => {
    expect(detectOpencodeGeneration(DUAL_CONFIG)).toBeNull();
  });

  test("no markers resolves null", () => {
    expect(detectOpencodeGeneration({})).toBeNull();
  });
});

describe("validateOpencodeConfigV2", () => {
  test("accepts a config holding the owned V2 slot in string or object form", () => {
    expect(validateOpencodeConfigV2(V2_CONFIG)).toEqual([]);
    expect(validateOpencodeConfigV2({ plugins: [{ package: "@mstar-harness/opencode-v2", options: { a: 1 } }] })).toEqual([]);
  });

  test("refuses a missing `plugins` key and a plugins list without an owned slot", () => {
    expect(validateOpencodeConfigV2({})).toEqual([
      "Missing @mstar-harness/opencode-v2 plugin entry in `plugins` (string or {package} form).",
    ]);
    expect(validateOpencodeConfigV2({ plugins: ["unrelated", { package: "@some/pkg" }] })).toEqual([
      "Missing @mstar-harness/opencode-v2 plugin entry in `plugins` (string or {package} form).",
    ]);
  });

  test("never requires a $schema value", () => {
    const errors = validateOpencodeConfigV2({ plugins: ["@mstar-harness/opencode-v2@latest"], $schema: "https://example.invalid/kept.json" });
    expect(errors).toEqual([]);
  });
});

describe("getOpencodeDoctorWarningsV2", () => {
  test("warns on the plural `agents` key when roles lack model assignments", () => {
    const warnings = getOpencodeDoctorWarningsV2({ plugins: ["@mstar-harness/opencode-v2@latest"] }, ALL_ROLES);
    expect(warnings).toEqual([
      "2 role(s) have no explicit agents.<role>.model — OpenCode default model will be used (recommended for fastest setup).",
    ]);
  });

  test("stays silent when every role carries a model", () => {
    const warnings = getOpencodeDoctorWarningsV2(V2_CONFIG, ALL_ROLES);
    expect(warnings).toEqual([]);
  });
});

describe("diagnoseOpencodeV2Host", () => {
  test("explicit v1 selection validates only the V1 generation and names the source", () => {
    const root = tempRoot(V1_CONFIG);
    const result = diagnoseOpencodeV2Host(root, ALL_ROLES, { resolved: "v1", explicitSelection: true });
    expect(result.generations).toEqual(["v1"]);
    expect(result.errors).toEqual([]);
    expect(result.generationSource).toBe("explicit --opencode-generation flag");
  });

  test("explicit v2 selection scopes the doctor to one generation on a dual-host config", () => {
    const root = tempRoot(DUAL_CONFIG);
    const result = diagnoseOpencodeV2Host(root, ALL_ROLES, { resolved: "v2", explicitSelection: true });
    expect(result.generations).toEqual(["v2"]);
    // The V1 half of the dual config is out of scope under explicit selection.
    expect(result.errors).toEqual([]);
  });

  test("probed resolution on a dual-host config validates both generations with per-generation prefixes", () => {
    const root = tempRoot({ plugin: ["unrelated"], plugins: ["unrelated"] });
    const result = diagnoseOpencodeV2Host(root, ALL_ROLES, { resolved: "v2" });
    expect(result.generations).toEqual(["v1", "v2"]);
    expect(result.generationSource).toBe("both generation keys present");
    expect(result.errors.some((error) => error.startsWith("[v1] "))).toBe(true);
    expect(result.errors.some((error) => error.startsWith("[v2] "))).toBe(true);
  });

  test("probed resolution validates the matched generation and warns on marker disagreement", () => {
    const root = tempRoot(V1_CONFIG);
    const result = diagnoseOpencodeV2Host(root, ALL_ROLES, { resolved: "v2" });
    expect(result.generations).toEqual(["v2"]);
    expect(result.generationSource).toBe("opencode --version probe");
    expect(result.errors.some((error) => error.startsWith("[v2] Missing @mstar-harness/opencode-v2"))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("consistency guard"))).toBe(true);
  });

  test("a missing config file reports the read error once", () => {
    const root = tempRoot(null);
    const result = diagnoseOpencodeV2Host(root, ALL_ROLES, { resolved: "v2", explicitSelection: true });
    expect(result.errors).toEqual([`Missing config file: ${join(root, "opencode.json")}`]);
    expect(result.generations).toEqual([]);
  });
});

describe("parseOpencodeVersionOutput", () => {
  test("maps the observed `opencode vMAJOR.MINOR.PATCH` form (major >= 2 → v2, 1.x → v1)", () => {
    expect(parseOpencodeVersionOutput("opencode v2.0.24\n")).toBe("v2");
    expect(parseOpencodeVersionOutput("opencode v1.9.9")).toBe("v1");
  });

  test("never guesses on unmapped or unparseable output", () => {
    expect(parseOpencodeVersionOutput("opencode v0.1.0")).toBeNull();
    expect(parseOpencodeVersionOutput("garbage")).toBeNull();
    expect(parseOpencodeVersionOutput("")).toBeNull();
  });
});
describe("OpenCode MCP doctor health", () => {
  test("healthy nested V2 and flat V1 configurations are aligned", () => {
    const v2Root = mkdtempSync(join(tmpdir(), "opencode-v2-mcp-"));
    roots.push(v2Root);
    writeMcpConfig(v2Root, {
      mcp: {
        servers: {
          "morning-star": { type: "local", command: ["npx", "@mstar-harness/cli", "mcp"] },
        },
      },
    });
    const v2Health = diagnoseMcpTarget("opencode", v2Root, MCP_RUNTIME);
    expect(v2Health.status).toBe("aligned");
    expect(v2Health.errors).toEqual([]);

    const v1Root = mkdtempSync(join(tmpdir(), "opencode-v1-mcp-"));
    roots.push(v1Root);
    writeMcpConfig(v1Root, {
      mcp: {
        "morning-star": { type: "local", command: ["npx", "@mstar-harness/cli", "mcp"] },
      },
    });
    const v1Health = diagnoseMcpTarget("opencode", v1Root, MCP_RUNTIME);
    expect(v1Health.status).toBe("aligned");
    expect(v1Health.errors).toEqual([]);
  });

  test("broken entries in either config shape are mismatches", () => {
    for (const mcp of [
      { servers: { "morning-star": { type: "local", command: ["node", "wrong"] } } },
      { "morning-star": { type: "local", command: ["node", "wrong"] } },
    ]) {
      const root = mkdtempSync(join(tmpdir(), "opencode-broken-mcp-"));
      roots.push(root);
      writeMcpConfig(root, { mcp });
      expect(diagnoseMcpTarget("opencode", root, MCP_RUNTIME).status).toBe("mismatch");
    }
  });
  test("flat V1 server named `servers` stays flat, while malformed nested V2 remains a mismatch", () => {
    const flatRoot = mkdtempSync(join(tmpdir(), "opencode-v1-servers-name-"));
    roots.push(flatRoot);
    writeMcpConfig(flatRoot, {
      mcp: {
        servers: { type: "local", command: ["npx", "@mstar-harness/cli", "mcp"] },
      },
    });
    expect(diagnoseMcpTarget("opencode", flatRoot, MCP_RUNTIME).status).toBe("aligned");

    const malformedRoot = mkdtempSync(join(tmpdir(), "opencode-v2-malformed-servers-"));
    roots.push(malformedRoot);
    writeMcpConfig(malformedRoot, { mcp: { servers: null } });
    expect(diagnoseMcpTarget("opencode", malformedRoot, MCP_RUNTIME).status).toBe("mismatch");
  });
  test("healthy V2 MCP config keeps the doctor envelope on its exit-0 path", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "opencode-v2-doctor-project-"));
    const homeRoot = mkdtempSync(join(tmpdir(), "opencode-v2-doctor-home-"));
    roots.push(projectRoot, homeRoot);
    writeFileSync(join(projectRoot, "opencode.json"), JSON.stringify(V2_CONFIG));
    writeMcpConfig(homeRoot, V2_CONFIG);

    const previousProjectRoot = process.env.MSTAR_CLI_PROJECT_ROOT;
    process.env.MSTAR_CLI_PROJECT_ROOT = projectRoot;
    const home = spyOn(os, "homedir").mockReturnValue(homeRoot);
    try {
      const doctor = getLocalCommandDefinitions().find(({ id }) => id === "doctor");
      expect(doctor).toBeDefined();
      if (!doctor) return;
      const result = await doctor.execute(
        { target: "opencode", scope: "project", generation: "v2" },
        { versions: { cli: "test" }, effects: {} },
      );
      expect(result).toMatchObject({ status: "ok" });
      expect(result.data.mcpHealth.status).toBe("aligned");
    } finally {
      home.mockRestore();
      if (previousProjectRoot === undefined) delete process.env.MSTAR_CLI_PROJECT_ROOT;
      else process.env.MSTAR_CLI_PROJECT_ROOT = previousProjectRoot;
    }
  });
  test("timed-out doctor version probe refuses even when stdout contains a valid version", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "opencode-timeout-project-"));
    const homeRoot = mkdtempSync(join(tmpdir(), "opencode-timeout-home-"));
    const binRoot = mkdtempSync(join(tmpdir(), "opencode-timeout-bin-"));
    roots.push(projectRoot, homeRoot, binRoot);
    writeFileSync(join(projectRoot, "opencode.json"), JSON.stringify(V2_CONFIG));
    writeMcpConfig(homeRoot, V2_CONFIG);
    const fakeOpencode = join(binRoot, "opencode");
    writeFileSync(fakeOpencode, "#!/bin/sh\nprintf 'opencode v2.0.24\\n'\nsleep 30\n");
    chmodSync(fakeOpencode, 0o755);

    const previousProjectRoot = process.env.MSTAR_CLI_PROJECT_ROOT;
    const previousPath = process.env.PATH;
    process.env.MSTAR_CLI_PROJECT_ROOT = projectRoot;
    process.env.PATH = `${binRoot}${path.delimiter}${previousPath ?? ""}`;
    const home = spyOn(os, "homedir").mockReturnValue(homeRoot);
    try {
      const doctor = getLocalCommandDefinitions().find(({ id }) => id === "doctor");
      expect(doctor).toBeDefined();
      if (!doctor) return;
      const result = await doctor.execute(
        { target: "opencode", scope: "project" },
        { versions: { cli: "test" }, effects: {} },
      );
      expect(result.status).toBe("refused");
      expect(result.details.errors.join(" ")).toContain("--opencode-generation <v1|v2>");
      expect(result.details.errors.join(" ").toLowerCase()).toContain("timeout");
    } finally {
      home.mockRestore();
      if (previousProjectRoot === undefined) delete process.env.MSTAR_CLI_PROJECT_ROOT;
      else process.env.MSTAR_CLI_PROJECT_ROOT = previousProjectRoot;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }, 10_000);
});
