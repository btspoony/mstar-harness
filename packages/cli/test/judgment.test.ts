import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { judgmentExitCode } from "../src/commands/judgment";

const roots: string[] = [];
const REPO = resolve(import.meta.dir, "../../..");
const CLI_ENTRY = join(REPO, "packages/cli/src/index.ts");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "judgment-cli-"));
  roots.push(root);
  return root;
}

function run(args: string[], cwd: string) {
  const env = { ...process.env };
  delete env.MSTAR_HARNESS_DIR;
  delete env.MSTAR_CONTROL_ROOT;
  delete env.JEV_REQUESTS_DIR;
  delete env.JEV_STATUS_PATH;
  return spawnSync("bun", ["run", CLI_ENTRY, "judgment", "review-advice", ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

describe("mstar judgment review-advice", () => {
  test("non-judgment CLI version behavior remains intact", () => {
    const result = spawnSync("bun", ["run", CLI_ENTRY, "--version"], { cwd: REPO, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("3.11.2");
  });
  test("off is inert with nonexistent inputs and leaves no mailbox", () => {
    const cwd = workspace();
    const result = run(["--file", "missing-pack.json", "--pilot", "missing-pilot.json"], cwd);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: "mstar.judgment-cli/v1",
      status: "disabled",
      advice: null,
    });
    expect(existsSync(join(cwd, ".jev-mailbox"))).toBe(false);
  });

  test("review-advice help remains a successful help request rather than a usage failure", () => {
    const result = run(["--help"], workspace());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).not.toContain('"schema":"mstar.judgment-cli/v1"');
  });

  test("unknown options return one structured usage result and exit 2", () => {
    const result = run(["--file", "pack.json", "--pilot", "pilot.json", "--unknown"], workspace());
    expect(result.status).toBe(2);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: "mstar.judgment-cli/v1",
      status: "invalid",
      code: "jev.usage",
    });
  });

  test("file and stdin are mutually exclusive with the same usage envelope", () => {
    const result = run(["--file", "pack.json", "--stdin", "--pilot", "pilot.json"], workspace());
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: "mstar.judgment-cli/v1",
      status: "invalid",
      code: "jev.usage",
    });
  });

  test("runtime outcomes and actual signal statuses map to the CLI contract", () => {
    const result = { schema: "mstar.judgment-cli/v1", contractRevision: "phase3a-native-20260924", status: "recorded", advice: null } as const;
    expect(judgmentExitCode(result)).toBe(0);
    expect(judgmentExitCode({ ...result, status: "unavailable" })).toBe(1);
    expect(judgmentExitCode({ ...result, status: "cancelled" })).toBe(130);
    expect(judgmentExitCode(result, "SIGINT")).toBe(130);
    expect(judgmentExitCode(result, "SIGTERM")).toBe(143);
  });
});
