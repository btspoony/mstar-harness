import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

const artifact = join(import.meta.dir, "session-context.mjs");

describe("bundled session-context standalone", () => {
  test("runs from a bare copy without node_modules and emits context plus degraded diagnostic", () => {
    const bare = mkdtempSync(join(tmpdir(), "mstar-session-context-"));
    try {
      const hooksDir = join(bare, "hooks");
      const workspace = join(bare, "workspace");
      mkdirSync(hooksDir);
      mkdirSync(join(workspace, ".mstar"), { recursive: true });
      writeFileSync(join(hooksDir, "session-context.mjs"), readFileSync(artifact));
      const result = spawnSync("node", [join(hooksDir, "session-context.mjs")], {
        cwd: bare,
        input: JSON.stringify({ cwd: workspace }),
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(output.hookSpecificOutput.additionalContext).toContain("Harness workspace detected");
      expect(output.hookSpecificOutput.additionalContext).toContain("ACTIVE execution authority unavailable");
      expect(result.stderr).toContain("Morning Star session context: ACTIVE execution authority unavailable");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
