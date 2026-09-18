/**
 * CLI `mstar catalog` -- subprocess tests against the built bundle (P2).
 *
 * Exercises the shipped entry point: the discovery proposal, the reviewed
 * import transport, its blocking rules, the export round trip through a second
 * clone, and the exit-code contract (0 success / 1 refusal / 2 usage). Does not
 * test field forwarding or source strings.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { initializeStore } from "@mstar-harness/engine";

const CLI_ROOT = resolve(import.meta.dir, "..");
const BUNDLE = join(CLI_ROOT, "dist/mstar-harness.js");
const NODE_BIN = process.env.NODE_BIN ?? "node";

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "MSTAR_HARNESS_DIR" || key === "MSTAR_CONTROL_ROOT" || key === "SDD_DIR") continue;
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Run the shipped bundle inside `cwd` (`bun` shebang launch, or explicit node). */
function runCli(args: string[], cwd: string, launcher: "bun" | "node" = "bun"): RunResult {
  const argv = launcher === "node" ? [NODE_BIN, BUNDLE, ...args] : [BUNDLE, ...args];
  const proc = spawnSync(argv[0]!, argv.slice(1), { cwd, env: cliEnv(), encoding: "utf8" });
  return { exitCode: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

function jsonOf(result: RunResult): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`expected JSON stdout, got ${JSON.stringify(result.stdout)} (stderr: ${result.stderr})`);
  }
}

function write(harness: string, relativePath: string, text: string): string {
  const absolute = join(harness, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text.endsWith("\n") ? text : `${text}\n`);
  return absolute;
}

/** A temp workspace: a real `.mstar` harness root plus an active store. */
async function harnessFixture(name: string): Promise<{ workspace: string; harness: string }> {
  const root = mkdtempSync(join(tmpdir(), `mstar-catalog-cli-${name}`));
  roots.push(root);
  const workspace = join(root, "ws");
  const harness = join(workspace, ".mstar");
  mkdirSync(harness, { recursive: true });
  const handle = await initializeStore({ harnessDir: workspace });
  handle.close();
  return { workspace, harness };
}

const ITERATIONS_README = [
  "# Iterations",
  "",
  "Human narrative about the iteration program stays here.",
  "",
  "| Iteration | Path | Description | Status |",
  "|-----------|------|-------------|--------|",
  "| `iter-alpha` | [`iter-alpha/`](iter-alpha/) | Alpha iteration package | `active` |",
].join("\n");

const KNOWLEDGE_BODY = ["---", "category: patterns", "---", "", "# Guard pattern notes", "", "Body text."].join("\n");

const PACKAGE_README = [
  "# iter-alpha",
  "",
  "Package narrative stays.",
  "",
  "## Documents",
  "",
  "| Document | Kind | Description | Status |",
  "|----------|------|-------------|--------|",
  "| [delivery-compass.md](delivery-compass.md) | compass | Delivery scope | active |",
  "| [guides/notes.md](guides/notes.md) | guide | Working notes | active |",
].join("\n");

async function populatedFixture(name: string): Promise<{ workspace: string; harness: string }> {
  const fixture = await harnessFixture(name);
  write(fixture.harness, "iterations/README.md", ITERATIONS_README);
  write(fixture.harness, "iterations/iter-alpha/README.md", PACKAGE_README);
  write(fixture.harness, "iterations/iter-alpha/delivery-compass.md", ["---", "iteration_id: iter-alpha", "---", "", "# iter-alpha Delivery Compass"].join("\n"));
  write(fixture.harness, "iterations/iter-alpha/guides/notes.md", "# Working notes");
  write(fixture.harness, "knowledge/patterns/guard.md", KNOWLEDGE_BODY);
  write(fixture.harness, "specs/notes/README.md", "# Ordinary README inside a walked root");
  write(fixture.harness, "specs/INSTALL.md", "# Install notes");
  return fixture;
}

beforeAll(() => {
  if (existsSync(BUNDLE)) chmodSync(BUNDLE, 0o755);
});

const IMPORT_OPERATION = ["--actor", "project-manager", "--operation-id", "imp-cli-1"];

describe("mstar catalog discover", () => {
  test("prints the proposal with its unknowns and writes a reviewable plan file", async () => {
    const { workspace, harness } = await populatedFixture("discover-");
    const planPath = join(workspace, "plan.json");

    const result = runCli(["catalog", "discover", "--json", "--out", planPath], workspace);
    expect(result.exitCode).toBe(0);
    const envelope = jsonOf(result);
    expect(envelope.ok).toBe(true);
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as {
      version: number;
      entities: { relativePath: string; idAssigned: boolean }[];
      unknowns: { code: string }[];
      retirementSections: { relativePath: string; startLine: number; endLine: number; preservedLines: number }[];
      conflicts: unknown[];
      links: unknown[];
    };
    expect(plan.version).toBe(1);
    expect(plan.conflicts).toEqual([]);
    expect(plan.entities.map((entity) => entity.relativePath)).toContain("patterns/guard.md");
    expect(plan.entities.some((entity) => entity.relativePath === "notes/README.md" || entity.relativePath === "INSTALL.md")).toBe(false);
    expect(plan.unknowns.map((unknown) => unknown.code)).toContain("identity");
    // Only the two recognized index tables are proposed for retirement; the
    // narrative above the iteration table stays outside the retired range.
    expect(plan.retirementSections.map((section) => `${section.rootKind}:${section.relativePath}`).sort()).toEqual([
      "iterations:README.md",
      "iterations:iter-alpha/README.md",
    ]);
    const iterationSection = plan.retirementSections.find((section) => section.relativePath === "README.md")!;
    expect(iterationSection.startLine).toBe(5);
    expect(iterationSection.endLine).toBe(7);
    expect(iterationSection.preservedLines).toBe(4);
    // `discover` is read-only: nothing was registered.
    const stored = jsonOf(runCli(["catalog", "list", "--json"], workspace));
    expect((stored.data as { total: number }).total).toBe(0);
  });

  test("help exits 0 and an unknown flag exits 2 with a usage payload", async () => {
    const { workspace } = await harnessFixture("usage-");
    const help = runCli(["catalog", "discover", "--help"], workspace);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--out");

    const usage = runCli(["catalog", "discover", "--nope", "--json"], workspace);
    expect(usage.exitCode).toBe(2);
    expect(jsonOf(usage)).toMatchObject({ ok: false, code: "usage", details: { operation: "discover" } });

    const nodeUsage = runCli(["catalog", "discover", "--nope"], workspace, "node");
    expect(nodeUsage.exitCode).toBe(2);
  });
});

describe("mstar catalog import", () => {
  test("applies a reviewed plan, and its export round-trips into a second clone without an execution session", async () => {
    const { workspace } = await populatedFixture("import-");
    const planPath = join(workspace, "plan.json");
    expect(runCli(["catalog", "discover", "--out", planPath], workspace).exitCode).toBe(0);

    const imported = runCli(["catalog", "import", "--plan", planPath, ...IMPORT_OPERATION, "--json"], workspace);
    expect(imported.exitCode).toBe(0);
    const receipt = jsonOf(imported).data as { operationId: string; entities: { id: string }[]; links: { relation: string }[] };
    expect(receipt.operationId).toBe("imp-cli-1");
    expect(receipt.entities.length).toBeGreaterThan(0);

    const listed = jsonOf(runCli(["catalog", "list", "--json"], workspace)).data as { total: number; items: { id: string }[] };
    expect(listed.total).toBe(receipt.entities.length);
    const shown = jsonOf(runCli(["catalog", "show", "document", listed.items.find((item) => item.id.startsWith("doc-"))!.id, "--json"], workspace)).data as {
      entity: { present: boolean; documentKind: string };
    };
    expect(shown.entity.present).toBe(true);
    expect(shown.entity.documentKind).toBe("knowledge");

    // Export is versioned transport carrying ids, relations and revisions.
    const exportPath = join(workspace, "catalog-export.json");
    const exported = runCli(["catalog", "export", "--out", exportPath, "--json"], workspace);
    expect(exported.exitCode).toBe(0);
    const payload = JSON.parse(readFileSync(exportPath, "utf8")) as {
      version: number;
      entities: { id: string; revision: number; rootKind: string; relativePath: string; kind: string; documentKind: string | null; title: string; description: string | null; lifecycle: string; registeredAt: string; updatedAt: string; sourceHash: string | null }[];
      links: { fromId: string; relation: string; toId: string }[];
    };
    expect(payload.version).toBe(1);
    expect(payload.entities.length).toBe(receipt.entities.length);
    // Relations bump the revision of their source row: export carries real
    // provenance, and the clone's import does not copy it as local state.
    expect(Math.max(...payload.entities.map((entity) => entity.revision))).toBeGreaterThan(1);

    // A second clone holding the same tracked bodies re-imports the payload by
    // its ids and relations.
    const clone = await populatedFixture("import-clone-");
    const clonePlan = join(clone.workspace, "plan.json");
    expect(runCli(["catalog", "discover", "--out", clonePlan], clone.workspace).exitCode).toBe(0);
    const dryRun = runCli(["catalog", "import", "--inputs", exportPath, ...IMPORT_OPERATION, "--dry-run", "--json"], clone.workspace);
    expect(dryRun.exitCode).toBe(0);
    expect((jsonOf(dryRun).data as { importable: boolean }).importable).toBe(true);

    const cloneImport = runCli(["catalog", "import", "--inputs", exportPath, ...IMPORT_OPERATION, "--json"], clone.workspace);
    expect(cloneImport.exitCode).toBe(0);
    const cloneReceipt = jsonOf(cloneImport).data as { entities: { id: string; revision: number }[]; links: { fromId: string; relation: string; toId: string }[] };
    expect(cloneReceipt.entities.map((entity) => entity.id).sort()).toEqual(payload.entities.map((entity) => entity.id).sort());
    expect(cloneReceipt.entities.every((entity) => entity.revision === 1)).toBe(true);
    expect(cloneReceipt.links).toEqual(payload.links);
    expect(cloneReceipt.links.length).toBeGreaterThan(0);

    // No workflow session, no root registration: import is catalog-only.
    expect(readdirSync(clone.harness)).not.toContain("workflows");
    expect(readdirSync(clone.harness)).not.toContain("status.json");
  });

  test("a conflicting plan is refused and writes nothing", async () => {
    const { workspace, harness } = await populatedFixture("conflict-");
    write(
      harness,
      "iterations/README.md",
      ITERATIONS_README.replace("[`iter-alpha/`](iter-alpha/)", "[`iter-alpha-old/`](iter-alpha-old/)"),
    );
    const planPath = join(workspace, "plan.json");
    expect(runCli(["catalog", "discover", "--out", planPath], workspace).exitCode).toBe(0);
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as { conflicts: { field: string }[] };
    expect(plan.conflicts.map((conflict) => conflict.field)).toContain("path");

    const refused = runCli(["catalog", "import", "--plan", planPath, ...IMPORT_OPERATION, "--json"], workspace);
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused)).toMatchObject({ ok: false, code: "catalog.import-conflict" });
    expect((jsonOf(runCli(["catalog", "list", "--json"], workspace)).data as { total: number }).total).toBe(0);
  });

  test("source drift since review is refused and writes nothing", async () => {
    const { workspace, harness } = await populatedFixture("drift-");
    const planPath = join(workspace, "plan.json");
    expect(runCli(["catalog", "discover", "--out", planPath], workspace).exitCode).toBe(0);

    write(harness, "knowledge/patterns/guard.md", ["# Guard pattern notes", "", "Edited after the review."].join("\n"));

    const dryRun = runCli(["catalog", "import", "--plan", planPath, ...IMPORT_OPERATION, "--dry-run", "--json"], workspace);
    expect(dryRun.exitCode).toBe(1);
    const verification = jsonOf(dryRun).data as { importable: boolean; drift: { sourceKey: string; state: string }[] };
    expect(verification.importable).toBe(false);
    expect(verification.drift).toEqual([
      expect.objectContaining({ sourceKey: "knowledge:patterns/guard.md", state: "changed" }),
    ]);

    const refused = runCli(["catalog", "import", "--plan", planPath, ...IMPORT_OPERATION, "--json"], workspace);
    expect(refused.exitCode).toBe(1);
    expect(jsonOf(refused)).toMatchObject({ ok: false, code: "catalog.import-source-drift" });
    expect((jsonOf(runCli(["catalog", "list", "--json"], workspace)).data as { total: number }).total).toBe(0);
  });
});

describe("mstar catalog domain verbs", () => {
  test("register, link, show and update follow the catalog contract", async () => {
    const { workspace, harness } = await harnessFixture("verbs-");
    write(harness, "specs/contract.md", "# Contract");

    const registered = runCli(
      [
        "catalog",
        "register",
        "--kind", "document",
        "--id", "doc-contract",
        "--title", "Contract",
        "--root-kind", "specs",
        "--path", "contract.md",
        "--document-kind", "spec",
        "--actor", "project-manager",
        "--operation-id", "reg-1",
        "--json",
      ],
      workspace,
    );
    expect(registered.exitCode).toBe(0);
    expect(jsonOf(registered).data).toEqual({ kind: "document", id: "doc-contract", revision: 1, storeRevision: 1 });

    const project = runCli(
      [
        "catalog",
        "register",
        "--kind", "project",
        "--id", "proj-a",
        "--title", "Project Alpha",
        "--root-kind", "projects",
        "--path", "proj-a",
        "--actor", "project-manager",
        "--operation-id", "reg-2",
        "--json",
      ],
      workspace,
    );
    expect(project.exitCode).toBe(0);

    const linked = runCli(
      [
        "catalog",
        "link",
        "--from-kind", "document",
        "--from-id", "doc-contract",
        "--relation", "belongs-to",
        "--to-kind", "project",
        "--to-id", "proj-a",
        "--actor", "project-manager",
        "--operation-id", "lnk-1",
        "--json",
      ],
      workspace,
    );
    expect(linked.exitCode).toBe(0);

    const shown = jsonOf(runCli(["catalog", "show", "document", "doc-contract", "--json"], workspace)).data as {
      entity: { revision: number; lifecycle: string; title: string };
      links: { relation: string; toId: string }[];
    };
    expect(shown.entity).toMatchObject({ revision: 2, lifecycle: "active", title: "Contract" });
    expect(shown.links).toEqual([{ fromKind: "document", fromId: "doc-contract", relation: "belongs-to", toKind: "project", toId: "proj-a", ordinal: null }]);

    // A stale revision is a domain refusal, not a usage error.
    const stale = runCli(
      [
        "catalog",
        "update",
        "document",
        "doc-contract",
        "--expect", "1",
        "--title", "Renamed",
        "--actor", "project-manager",
        "--operation-id", "upd-1",
        "--json",
      ],
      workspace,
    );
    expect(stale.exitCode).toBe(1);
    expect(jsonOf(stale)).toMatchObject({ ok: false, code: "catalog.revision-conflict" });

    const renamed = runCli(
      [
        "catalog",
        "update",
        "document",
        "doc-contract",
        "--expect", "2",
        "--title", "Renamed",
        "--actor", "project-manager",
        "--operation-id", "upd-2",
        "--json",
      ],
      workspace,
    );
    expect(renamed.exitCode).toBe(0);
    expect((jsonOf(renamed).data as { revision: number }).revision).toBe(3);

    const filtered = jsonOf(runCli(["catalog", "list", "--kind", "project", "--json"], workspace)).data as { total: number; items: { id: string }[] };
    expect(filtered.total).toBe(1);
    expect(filtered.items[0]!.id).toBe("proj-a");

    const missing = runCli(["catalog", "show", "plan", "no-such-plan", "--json"], workspace);
    expect(missing.exitCode).toBe(1);
    expect(jsonOf(missing)).toMatchObject({ ok: false, code: "catalog.not-found" });
  });
});
