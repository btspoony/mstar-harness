/**
 * kimi target adapter — minimal install-mode adapter (plan batch 2, T6).
 *
 * Kimi manages the Morning Star plugin through the TUI (`/plugins install`);
 * the kimi CLI has no plugin subcommand, so:
 *   - init is notes-only and harmless (zero mutations, TUI hint only);
 *   - doctor never requires the kimi binary and never errors on an absent
 *     install (the CLI ↔ plugin alignment note — including the not-installed
 *     TUI hint — is printed centrally by runDoctor in index.ts via
 *     `../src/plugin-version-alignment`, so the adapter adds no note).
 * Pure shape tests: no filesystem writes, no subprocesses.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, tmpdir } from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import { getAdapter } from "../src/adapters";
import { kimiAdapter } from "../src/adapters/kimi";
import { SUPPORTED_TARGETS } from "../src/types";

describe("kimi target registration", () => {
  test("kimi is a supported target and resolves to the install-mode adapter", () => {
    expect(SUPPORTED_TARGETS).toContain("kimi");
    const adapter = getAdapter("kimi");
    expect(adapter.target).toBe("kimi");
    expect(adapter.mode).toBe("install");
  });
});

describe("kimiAdapter", () => {
  test("doctor: no errors, no notes (alignment note is central), location = managed plugins root", () => {
    const result = kimiAdapter.runInstallDoctor!("project");
    expect(result.errors).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.location.endsWith(join("plugins", "managed"))).toBe(true);
  });

  test("init: present host (PATH stub) is notes-only and harmless — TUI install hint, zero mutations", async () => {
    // Hermetic presence stub: a fake `kimi` on PATH satisfies the D14 gate
    // without depending on the maintainer machine's real install.
    const stubDir = mkdtempSync(join(osTmpdir(), "kimi-stub-"));
    const stub = join(stubDir, "kimi");
    writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${previousPath ?? ""}`;
    try {
      for (const dryRun of [false, true]) {
        const result = await kimiAdapter.runInstallInit!("project", dryRun);
        expect(result!.location.endsWith(join("plugins", "managed"))).toBe(true);
        expect(result!.notes).toEqual(["Install via Kimi TUI: /plugins install"]);
      }
    } finally {
      process.env.PATH = previousPath;
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  test("init with a missing kimi CLI on a real install refuses naming the executable recovery; dry-run still previews", async () => {
    // The ambient CI PATH has no `kimi`; the D14 gate must refuse the real
    // install with the executable recovery (install guide + rerun command),
    // while `--dry-run` previews without probing (D15).
    const dry = await kimiAdapter.runInstallInit!("project", true);
    expect(dry!.location).toBeTruthy();

    let refused: Error | undefined;
    try {
      await kimiAdapter.runInstallInit!("project", false);
    } catch (error) {
      refused = error as Error;
    }
    expect(refused).toBeDefined();
    expect(refused!.message).toContain("kimi");
    expect(refused!.message).toContain("https://www.kimi.com/code/docs/kimi-code-cli/");
    expect(refused!.message).toContain("npx @mstar-harness/cli init --target kimi");
  });

  test("doctor does not require the kimi binary (no subprocess surface)", () => {
    // The adapter exposes no binary probe: doctor shape is static. Pin the
    // contract — the same call twice is identical (no hidden state).
    expect(kimiAdapter.runInstallDoctor!("global")).toEqual(kimiAdapter.runInstallDoctor!("global"));
  });
});
