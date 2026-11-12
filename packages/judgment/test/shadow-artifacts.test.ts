import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

  // A directory named like the artifact resolves but cannot be read. This discriminates the
  // read-side translation from the resolution-only one without any permission setup, so it
  // holds for a privileged account too.
  test("names an artifact the read itself cannot open, relative to the run root", async () => {
    const root = runRoot();
    try {
      mkdirSync(join(root, "baseline.json"));
      const { code, stderr } = await capture(["assess", "--root", root]);
      expect(code).toBe(2);
      expect(stderr).toContain("jev.artifact-missing: baseline.json");
      expect(stderr).not.toContain(root);
      expect(stderr).not.toContain("EISDIR");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
