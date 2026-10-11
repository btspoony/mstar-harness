import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeMarketplaceFiles } from "./adapters/zcode";

describe("installer write safety", () => {
  test("re-clones an incomplete shared harness checkout once and preserves it for diagnosis", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mstar-clone-repair-"));
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    mkdirSync(bin);
    const log = path.join(root, "git.log");
    writeFileSync(path.join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nif [ "$1" = "-C" ]; then exit 0; fi\nif [ "$1" = "clone" ]; then mkdir -p "$3/.git" "$3/.codex-plugin"; touch "$3/.codex-plugin/plugin.json"; exit 0; fi\nexit 1\n`, { mode: 0o755 });
    mkdirSync(path.join(home, ".mstar", "harness"), { recursive: true });
    writeFileSync(path.join(home, ".mstar", "harness", "partial"), "failed clone");
    // Import after patching homedir: shared-install captures the home path at module load.
    const script = `import os from "node:os"; os.homedir = () => ${JSON.stringify(home)}; const { ensureLocalHarnessRepo } = await import(${JSON.stringify(new URL("./adapters/shared-install.ts", import.meta.url).pathname)}); console.log(ensureLocalHarnessRepo(false).join("\\n"));`;
    try {
      const result = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout)).toContain("Moved invalid checkout");
      const checkout = path.join(home, ".mstar", "harness");
      expect(readFileSync(path.join(checkout, ".codex-plugin", "plugin.json"), "utf8")).toBe("");
      const retained = path.join(home, ".mstar", "harness.broken-");
      expect(readdirSync(path.dirname(checkout)).some((name) => name.startsWith(path.basename(retained)))).toBe(true);
      expect(readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("clone "))).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restores the first ZCode file when writing the second file fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mstar-zcode-rollback-"));
    const first = path.join(root, "marketplace.json");
    const second = path.join(root, "known.json");
    const firstBefore = '{"previous":"marketplace"}';
    const secondBefore = '{"previous":"known"}';
    writeFileSync(first, firstBefore);
    writeFileSync(second, secondBefore);
    let writes = 0;
    const write = (filePath: string, value: Record<string, unknown>) => {
      writes += 1;
      if (writes === 2) throw new Error("second write denied");
      writeFileSync(filePath, JSON.stringify(value));
    };
    try {
      expect(() => writeMarketplaceFiles(first, second, { next: true }, { next: true }, write as never))
        .toThrow(/second write denied.*Previously existing file contents were restored/);
      expect(readFileSync(first, "utf8")).toBe(firstBefore);
      expect(readFileSync(second, "utf8")).toBe(secondBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
