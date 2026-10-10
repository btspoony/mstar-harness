import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectInstalledPackage } from "./opencode-v2-smoke.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function installedFixture(options: { id?: string; effect?: boolean; nestedReference?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "opencode-v2-smoke-fixture-"));
  roots.push(root);
  const assets = {
    "harness-agents/project-manager.md": "---\nname: project-manager\n---\n",
    "harness-commands/iteration-start.md": "---\nname: iteration-start\n---\n",
    "harness-skills/mstar-roles/SKILL.md": "---\nname: mstar-roles\n---\n",
  };
  if (options.nestedReference !== false) {
    Object.assign(assets, { "harness-skills/mstar-roles/references/project-manager.md": "nested reference\n" });
  }
  for (const [path, contents] of Object.entries(assets)) {
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "@mstar-harness/opencode-v2",
    version: "0.0.0-test",
    type: "module",
    main: "./dist/mstar.js",
    engines: { node: ">=24.18.0", bun: ">=1.4.0" },
  }));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/mstar.js"), `export default { id: ${JSON.stringify(options.id ?? "morning-star-harness")}, ${options.effect === false ? "" : "effect: () => {}"} };\n`);
  return root;
}

describe("OpenCode V2 installed package smoke", () => {
  test("imports the installed entry with Node and finds package-local assets and engines", async () => {
    const result = await inspectInstalledPackage(installedFixture());
    expect(result).toMatchObject({
      runtime: "node",
      id: "morning-star-harness",
      lifecycle: "effect",
      assets: {
        agent: true,
        command: true,
        skill: true,
        nestedReference: true,
      },
      engines: { node: ">=24.18.0", bun: ">=1.4.0" },
    });
    expect(result.nodeVersion).toMatch(/^v\d+\./);
  });

  test("rejects an installed entry with the wrong plugin identity", async () => {
    await expect(inspectInstalledPackage(installedFixture({ id: "wrong-plugin" }))).rejects.toThrow(/plugin id/);
  });

  test("rejects an installed entry without the Effect lifecycle", async () => {
    await expect(inspectInstalledPackage(installedFixture({ effect: false }))).rejects.toThrow(/Effect lifecycle/);
  });

  test("rejects a packed skill tree missing a nested reference", async () => {
    await expect(inspectInstalledPackage(installedFixture({ nestedReference: false }))).rejects.toThrow(/nested reference/);
  });
});
