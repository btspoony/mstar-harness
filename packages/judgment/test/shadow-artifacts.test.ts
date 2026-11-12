import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShadowCommand } from "../scripts/shadow.js";

async function capture(args: string[]): Promise<{ code: number; stderr: string }> {
  const output: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { output.push(chunk.toString()); return true; }) as typeof process.stderr.write;
  try {
    return { code: await runShadowCommand(args), stderr: output.join("") };
  } finally {
    process.stderr.write = originalWrite;
  }
}

function runRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "jev-artifact-")));
}

describe("shadow artifact refusals", () => {
  test("names the missing run-root artifact and keeps the fail-closed exit code", async () => {
    const root = runRoot();
    try {
      const { code, stderr } = await capture(["assess", "--root", root]);
      expect(code).toBe(2);
      expect(stderr).toContain("jev.artifact-missing: baseline.json");
      expect(stderr).not.toContain(root);
      expect(stderr).not.toContain("ENOENT");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("does not report an unparsable artifact as missing", async () => {
    const root = runRoot();
    try {
      writeFileSync(join(root, "baseline.json"), "{");
      const { code, stderr } = await capture(["assess", "--root", root]);
      expect(code).toBe(2);
      expect(stderr).not.toContain("jev.artifact-missing");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
