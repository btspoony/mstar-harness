import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  extractFrontmatterAndBody,
  loadAgentsFromDir,
  loadCommandsFromDir,
  loadSkillsFromDir,
  packageRoot,
  parseSimpleFrontmatter,
  projectAgentDefinition,
} from "../src/assets";
import type { CommandDefinition, PermissionRule, ProjectedAgent } from "../src/assets";

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "opencode-v2-assets-"));

const writeFileUnder = (dir: string, rel: string, content: string) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
};

/** Materialize a seat markdown into a temp `harness-agents` dir; returns the dir. */
function agentsDirWith(content: string): string {
  const dir = path.join(tmpRoot(), "harness-agents");
  writeFileUnder(dir, "project-manager.md", content);
  return dir;
}

const PM_PRIMARY_SEAT = `---
name: project-manager
description: "Project Manager - coordinate the team."
mode: primary
tools:
  write: true
  edit: true
  bash: true
permission:
  task:
    "*": allow
---

## Morning Star Role Binding

You are \`project-manager\`.
`;

const READ_ONLY_SEAT = `---
name: writing-specialist
description: "Writing Specialist."
mode: subagent
tools:
  write: true
permission:
  task:
    "*": deny
    explore: allow
---

Read-only body.
`;

describe("frontmatter parsing", () => {
  test("extracts frontmatter and body", () => {
    const { frontmatter, body } = extractFrontmatterAndBody(PM_PRIMARY_SEAT);
    expect(frontmatter).toContain("name: project-manager");
    expect(body.startsWith("\n## Morning Star Role Binding")).toBe(true);
  });

  test("nested permission maps parse into objects with effect scalars", () => {
    const parsed = parseSimpleFrontmatter(extractFrontmatterAndBody(READ_ONLY_SEAT).frontmatter);
    // runtime-validated boundary: parsed frontmatter is file input, narrowed
    // explicitly rather than cast blind
    const asRecord = (value: unknown): Record<string, unknown> => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("expected a nested frontmatter map, got a non-object");
      }
      // runtime check above has already excluded non-records; TS cannot see it
      return value as Record<string, unknown>;
    };
    const task = asRecord(asRecord(parsed.permission).task);
    expect(task["*"]).toBe("deny");
    expect(task.explore).toBe("allow");
  });
});

describe("agent projection (frontmatter -> V2 agent info)", () => {
  test("PM primary seat: prompt becomes system, legacy keys dropped, permissions projected", () => {
    const agents = loadAgentsFromDir(agentsDirWith(PM_PRIMARY_SEAT));
    const projected = projectAgentDefinition(agents["project-manager"]);

    expect(projected.mode).toBe("primary");
    expect(projected.system).toContain("You are `project-manager`.");
    expect(projected).not.toHaveProperty("prompt");
    expect(projected).not.toHaveProperty("tools");
    expect(projected).not.toHaveProperty("permission");

    // legacy `tools` map first, then permission rules — ordered, last-match-wins
    expect(projected.permissions).toEqual([
      { action: "write", resource: "*", effect: "allow" },
      { action: "edit", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "allow" },
    ]);
  });

  test("read-only seat: subagent mode and ordered deny/allow rules", () => {
    const agents = loadAgentsFromDir(agentsDirWith(READ_ONLY_SEAT));
    const projected = projectAgentDefinition(agents["writing-specialist"]);

    expect(projected.mode).toBe("subagent");
    expect(projected.permissions).toEqual([
      { action: "write", resource: "*", effect: "allow" },
      { action: "subagent", resource: "*", effect: "deny" },
      { action: "subagent", resource: "explore", effect: "allow" },
    ]);
  });

  test("translates legacy bash and task actions for V2 permissions", () => {
    const projected = projectAgentDefinition({
      name: "project-manager",
      tools: { task: true },
      permission: { bash: { "*": "deny" } },
    });

    expect(projected.permissions).toEqual([
      { action: "subagent", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
    ]);
  });

  test("description and other non-legacy keys are preserved", () => {
    const agents = loadAgentsFromDir(agentsDirWith(PM_PRIMARY_SEAT));
    const projected = projectAgentDefinition(agents["project-manager"]);
    expect(projected.description).toBe("Project Manager - coordinate the team.");
    expect(projected.name).toBe("project-manager");
  });

  test("mode outside the V2 enum is dropped, known modes pass through", () => {
    const agents = loadAgentsFromDir(agentsDirWith(PM_PRIMARY_SEAT));
    const base = agents["project-manager"];
    expect(projectAgentDefinition({ ...base, mode: "all" }).mode).toBe("all");
    expect(projectAgentDefinition({ ...base, mode: "primary" }).mode).toBe("primary");
    expect(projectAgentDefinition({ ...base, mode: "bogus" }).mode).toBeUndefined();
  });

  test("invalid permission effect fails closed with the offending field named", () => {
    const agents = loadAgentsFromDir(agentsDirWith(PM_PRIMARY_SEAT));
    const base = agents["project-manager"];
    expect(() =>
      projectAgentDefinition({
        ...base,
        permission: { task: { "*": "sometimes" } },
      }),
    ).toThrow(/task/);
  });
});

describe("bundled loaders resolve from the packed layout", () => {
  /** Packed-layout fixture: `harness-*` dirs sit next to `dist/`, exactly like
   * the published package layout — loaders must resolve from that shape, never
   * from `process.cwd()`. */
  function packedLayout(): string {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    return root;
  }

  test("agents/commands/skills load from the fixture package root, not cwd", () => {
    const root = packedLayout();
    writeFileUnder(root, "harness-agents/project-manager.md", PM_PRIMARY_SEAT);
    writeFileUnder(
      root,
      "harness-commands/iteration-drive.md",
      "---\nname: iteration-drive\ndescription: Drive\n---\nBody",
    );
    writeFileUnder(root, "harness-skills/mstar-sdd/SKILL.md", "---\nname: mstar-sdd\n---\nSkill body");

    const agents = loadAgentsFromDir(path.join(root, "harness-agents"));
    expect(Object.keys(agents)).toEqual(["project-manager"]);
    expect(agents["project-manager"].mode).toBe("primary");

    const commands = loadCommandsFromDir(path.join(root, "harness-commands"));
    expect(Object.keys(commands)).toEqual(["iteration-drive"]);
    const drive: CommandDefinition = commands["iteration-drive"];
    expect(drive.template).toBe("Body");
    expect(drive.description).toBe("Drive");

    const skills = loadSkillsFromDir(path.join(root, "harness-skills"));
    expect(skills).toEqual([
      { name: "mstar-sdd", location: path.join(root, "harness-skills", "mstar-sdd", "SKILL.md") },
    ]);

    // resolution is anchored to the given package-shaped root — cwd independence
    expect(process.cwd()).not.toBe(root);
    const location: string = skills[0].location;
    expect(path.isAbsolute(location)).toBe(true);
  });

  test("real package layout resolves: src/assets sits under the package root", () => {
    // packageRoot must be the package directory (src/..), matching the packed
    // layout where dist/ sits next to harness-* dirs.
    expect(path.basename(packageRoot)).toBe("opencode-v2");
    expect(fs.existsSync(path.join(packageRoot, "package.json"))).toBe(true);
  });

  test("missing directory is explicit: loaders return empty, not an error", () => {
    const root = packedLayout();
    expect(loadAgentsFromDir(path.join(root, "harness-agents"))).toEqual({});
    expect(loadCommandsFromDir(path.join(root, "harness-commands"))).toEqual({});
    expect(loadSkillsFromDir(path.join(root, "harness-skills"))).toEqual([]);
  });

  test("unreadable agent entry fails with the path named", () => {
    const root = packedLayout();
    const agentsDir = path.join(root, "harness-agents");
    // a directory named like an agent file — readdir lists it, readFileSync fails
    fs.mkdirSync(path.join(agentsDir, "broken.md"), { recursive: true });
    let message = "";
    try {
      loadAgentsFromDir(agentsDir);
    } catch (error) {
      message = String((error as NodeJS.ErrnoException).message);
    }
    expect(message).toContain("broken.md");
  });
});
