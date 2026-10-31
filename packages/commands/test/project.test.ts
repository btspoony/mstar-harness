/**
 * project.test.ts — `mstar project bind` / `project show`
 * (binding-config plan Task 5): the correspondence verb, its named refusals
 * and its help text.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initializeStore, registerCatalogEntity } from "@mstar-harness/engine";
import { executeCommand, getCommandDefinitions } from "../src/index.js";
import type { CommandEffects, InvocationContext } from "../src/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LINEAR_BLOCK = "[linear]\nenabled=true\nmode=mirror\nworkspace=acme\nteam=eng\n";

/** A repo root with a `.mstarc` connection block and a registered project. */
async function repo(mstarc: string | null, projects: string[] = ["proj-a"]): Promise<InvocationContext> {
  const root = mkdtempSync(path.join(os.tmpdir(), "commands-project-"));
  roots.push(root);
  const harness = path.join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  await (await initializeStore({ harnessDir: harness })).close();
  for (const id of projects) {
    await registerCatalogEntity(
      { harnessDir: harness },
      { kind: "project", id, title: `Project ${id}`, rootKind: "projects", relativePath: `projects/${id}` },
      { operationId: `register-${id}`, actor: "test" },
    );
  }
  if (mstarc !== null) writeFileSync(path.join(root, ".mstarc"), mstarc);
  const effects: CommandEffects = {
    async readInput() { return ""; },
    async spawn() { throw new Error("not used"); },
    async startDashboard() { throw new Error("not used"); },
    async openBrowser() { throw new Error("not used"); },
  };
  return {
    cwd: root,
    controlRoot: harness,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects,
  };
}

function definition(id: string) {
  const found = getCommandDefinitions().find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing command definition: ${id}`);
  return found;
}

const bind = (input: Record<string, unknown>, context: InvocationContext) => definition("project.bind").execute(input, context);

/** The refusal's recovery text lives on the envelope details. */
function recoveryOf(envelope: { details?: Record<string, unknown> }): string {
  const recovery = envelope.details?.recovery;
  return typeof recovery === "string" ? recovery : "";
}

describe("mstar project bind", () => {
  test("binds and reads back the correspondence; workspace/team come from .mstarc", async () => {
    const context = await repo(LINEAR_BLOCK);
    const bound = await bind({ project: "proj-a", provider: "linear", remoteProject: "Team Roadmap", operation: "op-1" }, context);
    expect(bound.status).toBe("ok");
    expect(bound.data).toMatchObject({ projectId: "proj-a", provider: "linear", remoteProject: "Team Roadmap", changed: true });

    const shown = await definition("project.show").execute({ project: "proj-a" }, context);
    expect(shown.status).toBe("ok");
    expect(shown.data).toMatchObject({
      kind: "bound",
      binding: { projectId: "proj-a", provider: "linear", workspace: "acme", team: "eng", remoteProject: "Team Roadmap" },
    });
  });

  test("an unbound project answers the named absence", async () => {
    const context = await repo(LINEAR_BLOCK);
    const shown = await definition("project.show").execute({ project: "proj-a" }, context);
    expect(shown.data).toMatchObject({ kind: "absent", code: "linear.binding-absent" });
  });

  test("the identical pair is a no-op success, not a refusal", async () => {
    const context = await repo(LINEAR_BLOCK);
    await bind({ project: "proj-a", provider: "linear", remoteProject: "Team Roadmap", operation: "op-1" }, context);
    const again = await bind({ project: "proj-a", provider: "linear", remoteProject: "Team Roadmap", operation: "op-2" }, context);
    expect(again.status).toBe("ok");
    expect(again.data).toMatchObject({ changed: false });
  });

  test("linear.provider-disabled — the provider is not enabled in .mstarc", async () => {
    for (const mstarc of [null, "[linear]\nenabled=false\nmode=mirror\nworkspace=acme\nteam=eng\n"]) {
      const context = await repo(mstarc);
      const refused = await bind({ project: "proj-a", provider: "linear", remoteProject: "Team Roadmap", operation: "op-1" }, context);
      expect(refused.status).toBe("refused");
      expect(refused.code).toBe("linear.provider-disabled");
      expect(recoveryOf(refused)).toContain("enabled=true");
    }
  });

  test("linear.provider-disabled — a provider other than linear is not supported", async () => {
    const context = await repo(LINEAR_BLOCK);
    const refused = await bind({ project: "proj-a", provider: "jira", remoteProject: "X", operation: "op-1" }, context);
    expect(refused.code).toBe("linear.provider-disabled");
    expect(refused.message).toContain('"jira"');
  });

  test("linear.project-unregistered — the project has no catalog row", async () => {
    const context = await repo(LINEAR_BLOCK, []);
    const refused = await bind({ project: "ghost", provider: "linear", remoteProject: "Team Roadmap", operation: "op-1" }, context);
    expect(refused.status).toBe("refused");
    expect(refused.code).toBe("linear.project-unregistered");
    expect(recoveryOf(refused)).toContain("catalog register");
  });

  test("linear.rebind-refused — the project already mirrors a different remote project", async () => {
    const context = await repo(LINEAR_BLOCK);
    await bind({ project: "proj-a", provider: "linear", remoteProject: "Team Roadmap", operation: "op-1" }, context);
    const refused = await bind({ project: "proj-a", provider: "linear", remoteProject: "Other Roadmap", operation: "op-2" }, context);
    expect(refused.status).toBe("refused");
    expect(refused.code).toBe("linear.rebind-refused");
    expect(recoveryOf(refused)).toContain("project show");
  });

  test("an invalid .mstarc [linear] block refuses with its own name and a recovery", async () => {
    const context = await repo("[linear]\nenabled=true\nmode=yaml\nworkspace=acme\nteam=eng\n");
    const refused = await bind({ project: "proj-a", provider: "linear", remoteProject: "Team Roadmap", operation: "op-1" }, context);
    expect(refused.code).toBe("linear.mode-refused");
    expect(recoveryOf(refused)).toContain("mode=mirror");
  });

  test("usage: every required flag is named, and workspace/team are never flags", async () => {
    const options = definition("project.bind").cli?.options ?? [];
    const flags = options.map((option) => option.flags);
    expect(flags).toContain("--project <id>");
    expect(flags).toContain("--provider <name>");
    expect(flags).toContain("--remote-project <name-or-id>");
    expect(flags).toContain("--operation <id>");
    expect(flags.some((flag) => /workspace|team/i.test(flag))).toBe(false);

    const context = await repo(LINEAR_BLOCK);
    const missing = await bind({ project: "proj-a", provider: "linear", operation: "op-1" }, context);
    expect(missing.status).toBe("usage");
    expect(missing.code).toBe("usage");
    expect(missing.message).toContain("--remote-project");
    expect(recoveryOf(missing)).toContain("mstar project bind");
  });

  test("the verb writes only the binding row and never touches issue rows", async () => {
    const context = await repo(LINEAR_BLOCK);
    const { openStore } = await import("@mstar-harness/engine");
    const before = await issueCounts(context.controlRoot);
    await bind({ project: "proj-a", provider: "linear", remoteProject: "Team Roadmap", operation: "op-1" }, context);
    expect(await issueCounts(context.controlRoot)).toEqual(before);
    const handle = await openStore({ harnessDir: context.controlRoot }, "read");
    try {
      expect((handle.db.prepare("select count(*) as n from project_bindings").get() as { n: number }).n).toBe(1);
    } finally {
      handle.close();
    }
  });
});

async function issueCounts(harnessDir: string): Promise<Record<string, number>> {
  const { openStore } = await import("@mstar-harness/engine");
  const handle = await openStore({ harnessDir }, "read");
  try {
    const out: Record<string, number> = {};
    for (const table of ["issues", "issue_transitions", "issue_occurrences", "issue_sync_state", "sync_cursor"]) {
      const exists = handle.db.prepare("select name from sqlite_master where type='table' and name=?").get(table);
      if (exists === undefined) continue;
      out[table] = (handle.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
    }
    return out;
  } finally {
    handle.close();
  }
}

describe("QC fix wave", () => {
  test("F4: a parent directory's .mstarc is never inherited — the repo's own config is the authority", async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "commands-project-parent-"));
    roots.push(parent);
    // The PARENT carries a complete connection block this repo does not have.
    writeFileSync(path.join(parent, ".mstarc"), "[linear]\nenabled=true\nmode=mirror\nworkspace=other-repo\nteam=other-team\n");
    const root = path.join(parent, "repo");
    mkdirSync(root, { recursive: true });
    const harness = path.join(root, ".mstar");
    mkdirSync(harness, { recursive: true });
    await (await initializeStore({ harnessDir: harness })).close();
    await registerCatalogEntity(
      { harnessDir: harness },
      { kind: "project", id: "proj-a", title: "Project A", rootKind: "projects", relativePath: "projects/proj-a" },
      { operationId: "register-proj-a", actor: "test" },
    );
    const context: InvocationContext = {
      cwd: root,
      controlRoot: harness,
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
      signal: new AbortController().signal,
      effects: {
        async readInput() { return ""; },
        async spawn() { throw new Error("not used"); },
        async startDashboard() { throw new Error("not used"); },
        async openBrowser() { throw new Error("not used"); },
      },
    };
    const refused = await bind({ project: "proj-a", provider: "linear", remoteProject: "Team Roadmap", operation: "op-1" }, context);
    expect(refused.status).toBe("refused");
    expect(refused.code).toBe("linear.provider-disabled");
    expect(refused.message).toContain("no .mstarc at the repo root");
    expect(refused.message).toContain("never inherited");
    expect(refused.message).not.toContain("other-repo");
  });

  test("F8: common boolean spellings are accepted; an unreadable value is refused by name", async () => {
    for (const spelling of ["TRUE", "1", "yes", "On"]) {
      const context = await repo(`[linear]\nenabled=${spelling}\nmode=mirror\nworkspace=acme\nteam=eng\n`);
      const bound = await bind({ project: "proj-a", provider: "linear", remoteProject: "Team Roadmap", operation: `op-${spelling}` }, context);
      expect([spelling, bound.status]).toEqual([spelling, "ok"]);
    }
    for (const spelling of ["false", "0", "no", "off"]) {
      const context = await repo(`[linear]\nenabled=${spelling}\nmode=mirror\nworkspace=acme\nteam=eng\n`);
      const refused = await bind({ project: "proj-a", provider: "linear", remoteProject: "Team Roadmap", operation: `op-${spelling}` }, context);
      expect([spelling, refused.code]).toEqual([spelling, "linear.provider-disabled"]);
    }
    const context = await repo("[linear]\nenabled=maybe\nmode=mirror\nworkspace=acme\nteam=eng\n");
    const refused = await bind({ project: "proj-a", provider: "linear", remoteProject: "Team Roadmap", operation: "op-x" }, context);
    expect(refused.code).toBe("linear.binding-invalid");
    expect(refused.message).toContain('enabled="maybe"');
    expect(recoveryOf(refused)).toContain("true/1/yes/on");
  });

  test("F5: an unreadable store keeps its own code and never answers with 'retry'", async () => {
    const context = await repo(LINEAR_BLOCK);
    // A store whose schema this build cannot read.
    const { openStore } = await import("@mstar-harness/engine");
    const handle = await openStore({ harnessDir: context.controlRoot }, "write");
    try {
      // A migration row this build has never heard of → schema-unsupported.
      handle.db.prepare("insert into schema_version(version, name, checksum, applied_at) values (999, 'future', 'x', 'now')").run();
    } finally {
      handle.close();
    }
    const refused = await bind({ project: "proj-a", provider: "linear", remoteProject: "Team Roadmap", operation: "op-1" }, context);
    expect(refused.status).toBe("refused");
    expect(String(refused.code).startsWith("store.")).toBe(true);
    const recovery = recoveryOf(refused);
    expect(recovery.toLowerCase()).not.toContain("retry project.bind");
    expect(recovery).toMatch(/upgrade|release|schema/i);
  });
});

describe("project family definitions", () => {
  test("both verbs are registered with effects and descriptions", () => {
    const ids = getCommandDefinitions().map((item) => item.id).filter((id) => id.startsWith("project."));
    expect(ids.sort()).toEqual(["project.bind", "project.show"]);
    expect(definition("project.bind").effects).toEqual(["write"]);
    expect(definition("project.show").effects).toEqual(["read"]);
    expect(definition("project.bind").description).toContain("mirrors");
    expect(definition("project.bind").cli?.path).toEqual(["project", "bind"]);
    expect(definition("project.show").cli?.path).toEqual(["project", "show"]);
  });
});
