import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateStatusWrite } from "../src/mstar.js";

const ENV_KEY = "MSTAR_HARNESS_DIR";
let previousEnv: string | undefined;
beforeEach(() => {
  previousEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});
afterEach(() => {
  if (previousEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = previousEnv;
});

function makeHarness(): { project: string; harness: string; statusPath: string; snapshotPath: string } {
  const project = mkdtempSync(join(tmpdir(), "mstar-opencode-active-only-"));
  execFileSync("git", ["init", "-q", project], { stdio: "ignore" });
  const harness = join(project, ".mstar");
  mkdirSync(join(harness, "workflows", "wf-1"), { recursive: true });
  mkdirSync(join(harness, "projects"), { recursive: true });
  const statusPath = join(harness, "status.json");
  const snapshotPath = join(harness, "workflows", "wf-1", "snapshot.json");
  writeFileSync(statusPath, JSON.stringify({ version: 2, updated_at: "2026-08-08", workflows: [] }));
  writeFileSync(snapshotPath, JSON.stringify({ schema_version: 1, id: "wf-1", type: "plan", status: "running", plans: [] }));
  return { project, harness, statusPath, snapshotPath };
}

describe("validateStatusWrite — ACTIVE-only authority", () => {
  test("a missing store is the pre-activation state: the document lint decides, no invented authority", async () => {
    const fixture = makeHarness();
    try {
      const result = await validateStatusWrite(fixture.statusPath, {
        doc: { version: 2, updated_at: "2026-08-08", workflows: [{ id: "wf-1", type: "invalid" }] },
      });
      // Plan S4: absence is not an authority verdict — the retired route is
      // only refused while the execution authority is ACTIVE. The invalid
      // document still fails, but through its own lint.
      expect(result?.ok).toBe(false);
      expect(result?.violations.map((violation) => violation.code)).toContain("status.workflow.invalid-type");
      expect(result?.violations.some((violation) => violation.code === "store.authority-unavailable")).toBe(false);
      expect(result?.hardBlocked).toBe(false);
    } finally {
      rmSync(fixture.project, { recursive: true, force: true });
    }
  });

  test("a missing store leaves the snapshot write to its document lint", async () => {
    const fixture = makeHarness();
    try {
      const result = await validateStatusWrite(fixture.snapshotPath, { doc: { type: "invalid" } });
      expect(result?.ok).toBe(false);
      expect(result?.violations.map((violation) => violation.code)).toContain("workflow.snapshot.invalid-type");
      expect(result?.violations.some((violation) => violation.code === "store.authority-unavailable")).toBe(false);
    } finally {
      rmSync(fixture.project, { recursive: true, force: true });
    }
  });

  test("ordinary workspace files are outside the coordination-write gate", async () => {
    const fixture = makeHarness();
    try {
      expect(await validateStatusWrite(join(fixture.project, "notes.json"), { doc: {} })).toBeNull();
    } finally {
      rmSync(fixture.project, { recursive: true, force: true });
    }
  });
});
