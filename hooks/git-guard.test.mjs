import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

const hook = join(import.meta.dir, "git-guard.mjs");

function runGuard(command) {
  const cwd = mkdtempSync(join(tmpdir(), "mstar-git-guard-"));
  try {
    const init = spawnSync("git", ["init", "-b", "main"], { cwd, encoding: "utf8" });
    expect(init.status).toBe(0);
    const result = spawnSync(process.execPath, [hook], {
      cwd,
      input: JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } }),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    return result.stdout ? JSON.parse(result.stdout) : {};
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("git-guard bare force push", () => {
  test.each(["git push --force origin main", "git push -f origin main", "git push origin +main:main"])(
    "denies %s",
    (command) => expect(runGuard(command).hookSpecificOutput?.permissionDecision).toBe("deny"),
  );

  test.each([
    "git push origin main",
    "git push --force-with-lease origin main",
    "git push -o +audit origin main",
    "git push +backup main",
    "git push --repo=origin main",
  ])("allows %s", (command) => expect(runGuard(command)).toEqual({}));

  test.each([
    "git push --repo=origin +main:main",
    "git push --recurse-submodules=check origin +main:main",
    "git push --unknown-flag origin main",
    "git push origin +main",
  ])("denies %s", (command) =>
    expect(runGuard(command).hookSpecificOutput?.permissionDecision).toBe("deny"));
});
