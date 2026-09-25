import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeStore, readRoadmapAuthority, registerCatalogEntity, type StoreContext } from "@mstar-harness/engine";

const CLI_ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(CLI_ROOT, "dist/mstar-harness.js");
const ROOT = mkdtempSync(join(tmpdir(), "mstar-roadmap-cli-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

type Result = { status: number | null; stdout: string; stderr: string };
type CliEnvelope = { ok: boolean; code?: string; data?: unknown };

function run(args: string[], cwd: string): Result {
  const env = { ...process.env };
  delete env.MSTAR_HARNESS_DIR;
  delete env.MSTAR_CONTROL_ROOT;
  const result = spawnSync(BUNDLE, args, { cwd, env, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a JSON object");
  return value as Record<string, unknown>;
}

function envelope(result: Result): CliEnvelope {
  const value = object(JSON.parse(result.stdout));
  if (typeof value.ok !== "boolean") throw new Error("expected a CLI envelope with boolean ok");
  return {
    ok: value.ok,
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(Object.hasOwn(value, "data") ? { data: value.data } : {}),
  };
}

function data(result: Result): Record<string, unknown> {
  return object(envelope(result).data);
}

async function fixture(name: string): Promise<{ dir: string; context: StoreContext }> {
  const dir = mkdtempSync(join(ROOT, name));
  mkdirSync(join(dir, ".mstar"), { recursive: true });
  const context = { harnessDir: join(dir, ".mstar") };
  const store = await initializeStore(context);
  store.close();
  await registerCatalogEntity(context, {
    kind: "project", id: "proj-roadmap", title: "Roadmap proof", rootKind: "projects", relativePath: "proj-roadmap",
  }, { operationId: `register-${name}`, actor: "roadmap-test" });
  return { dir, context };
}

const MARKDOWN = `---\nproject_id: proj-roadmap\ntitle: Proof roadmap\nstatus: active\ncreated_at: 2026-09-25\nmilestones:\n  - M1\n---\n\n## Direction\n\nKeep the full source document.\n\n## Explanation\n\nVisible prose not represented by summary fields.\n\n- [ ] parent\n  - [x] nested goal\n`;

describe("roadmap CLI", () => {
  test("preview is read-only; reviewed apply, show and both exports round-trip content", async () => {
    const { dir, context } = await fixture("roundtrip-");
    const source = join(dir, "roadmap.md");
    const reviewFile = join(dir, "review.json");
    writeFileSync(source, MARKDOWN);
    const revisionBefore = await readRoadmapAuthority(context, "proj-roadmap");

    const help = run(["roadmap", "--help"], dir);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("show");
    expect(help.stdout).toContain("import");
    expect(help.stdout).toContain("replace");
    expect(help.stdout).toContain("export");

    const preview = run(["roadmap", "import", "--project", "proj-roadmap", "--file", source, "--json"], dir);
    expect(preview.status).toBe(0);
    const reviewed = data(preview);
    expect(reviewed.expectedRoadmapRevision).toBe("absent");
    expect(await readRoadmapAuthority(context, "proj-roadmap")).toEqual(revisionBefore);
    writeFileSync(reviewFile, `${JSON.stringify(reviewed)}\n`);

    const applied = run(["roadmap", "import", "--review", reviewFile, "--apply", "--operation", "import-proof", "--json"], dir);
    expect(applied.status).toBe(0);
    const receipt = data(applied);
    const shown = data(run(["roadmap", "show", "--project", "proj-roadmap", "--json"], dir));
    const shownRoadmap = object(shown.roadmap);
    expect(shownRoadmap.contentMarkdown).toBe(MARKDOWN);
    expect(shownRoadmap.revision).toBe(receipt.revision);

    const markdown = run(["roadmap", "export", "--project", "proj-roadmap", "--format", "markdown"], dir);
    expect(markdown.stdout).toBe(MARKDOWN);
    const transport = data(run(["roadmap", "export", "--project", "proj-roadmap", "--format", "json", "--json"], dir));
    expect(transport).toEqual({
      version: 1,
      projectId: "proj-roadmap",
      revision: receipt.revision,
      contentHash: receipt.contentHash,
      contentMarkdown: MARKDOWN,
    });
  });

  test("replacement uses observed revisions and rejects stale revisions and drifted reviewed sources", async () => {
    const { dir } = await fixture("cas-");
    const source = join(dir, "roadmap.md");
    const reviewFile = join(dir, "review.json");
    writeFileSync(source, MARKDOWN);
    const review = run(["roadmap", "import", "--project", "proj-roadmap", "--file", source, "--json"], dir);
    writeFileSync(reviewFile, `${JSON.stringify(data(review))}\n`);
    writeFileSync(source, `${MARKDOWN}\nchanged after review\n`);
    const drift = run(["roadmap", "import", "--review", reviewFile, "--apply", "--operation", "drift", "--json"], dir);
    expect(drift.status).toBe(1);
    expect(envelope(drift).code).toBe("roadmap.source-drift");

    writeFileSync(source, MARKDOWN);
    const created = run([
      "roadmap", "replace", "--project", "proj-roadmap", "--file", source,
      "--expect-project", "1", "--expect-roadmap", "absent", "--operation", "create", "--json",
    ], dir);
    expect(created.status).toBe(0);
    const stale = run([
      "roadmap", "replace", "--project", "proj-roadmap", "--file", source,
      "--expect-project", "1", "--expect-roadmap", "absent", "--operation", "stale", "--json",
    ], dir);
    expect(stale.status).toBe(1);
    expect(envelope(stale).code).toBe("roadmap.revision-conflict");
  });

  test("known project absence and store refusal are distinct", async () => {
    const { dir } = await fixture("absent-");
    const absent = run(["roadmap", "show", "--project", "proj-roadmap", "--json"], dir);
    expect(absent.status).toBe(0);
    expect(data(absent).roadmap).toBeNull();
    const missingRoot = join(ROOT, "missing-store");
    mkdirSync(missingRoot, { recursive: true });
    const refused = run(["roadmap", "show", "--project", "proj-roadmap", "--harness", join(missingRoot, ".mstar"), "--json"], dir);
    expect(refused.status).toBe(1);
    expect(envelope(refused).ok).toBe(false);
  });
});
