/**
 * Agent-plugin validation — skills containment (validateAgentPlugin).
 *
 * A skill's SKILL.md may itself be a symlink whose target escapes the plugin
 * root even when the skill directory resolves inside it; the validator must
 * resolve the final file and enforce the same containment before parsing it.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateAgentPlugin } from "@mstar-harness/commands";

const SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

const VALID_SKILL_MD = `---
name: demo
description: demo skill
---

body
`;

function makePluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mstar-agent-plugins-"));
  writeFileSync(
    join(root, "plugin.json"),
    JSON.stringify({ $schema: SCHEMA, name: "demo-plugin" }),
  );
  mkdirSync(join(root, "skills", "demo"), { recursive: true });
  writeFileSync(join(root, "skills", "demo", "SKILL.md"), VALID_SKILL_MD);
  return root;
}

describe("validateAgentPlugin skills containment", () => {
  test("plain skill inside the root validates without warnings", () => {
    const root = makePluginRoot();
    try {
      const result = validateAgentPlugin(root);
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("SKILL.md symlink escaping the plugin root is skipped with a warning", () => {
    const root = makePluginRoot();
    const outside = mkdtempSync(join(tmpdir(), "mstar-outside-"));
    try {
      const outsideFile = join(outside, "external.md");
      writeFileSync(outsideFile, VALID_SKILL_MD);
      const skillMd = join(root, "skills", "demo", "SKILL.md");
      rmSync(skillMd);
      symlinkSync(outsideFile, skillMd);

      const result = validateAgentPlugin(root);
      expect(result.ok).toBe(true); // warning, not an error
      expect(
        result.warnings.some(
          (w) => w.includes("demo/SKILL.md resolves outside the plugin root"),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("SKILL.md symlink staying inside the plugin root still validates", () => {
    const root = makePluginRoot();
    try {
      const shared = join(root, "shared-skill.md");
      writeFileSync(shared, VALID_SKILL_MD);
      const skillMd = join(root, "skills", "demo", "SKILL.md");
      rmSync(skillMd);
      symlinkSync(shared, skillMd);

      const result = validateAgentPlugin(root);
      expect(result.ok).toBe(true);
      expect(result.warnings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
