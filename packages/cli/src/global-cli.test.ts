/**
 * ensureGlobalCli — post-init helper that installs the matching-version
 * @mstar-harness/cli globally. Contract pinned here (SP1-AC1..AC5):
 * - --no-global-cli skips entirely (reason: "flag"), install never called,
 * - --dry-run prints the exact npm command and never spawns (reason: "dry-run"),
 * - a matching `mstar-harness --version` on PATH skips (reason: "already-matching"),
 * - otherwise install is called with the exact pinned spec
 *   `@mstar-harness/cli@<version>` — never latest, never a range,
 * - an install throw is converted to `action: "failed"`, never rethrown.
 * All runners are injected — no live npm registry calls.
 */
import { describe, expect, test } from "bun:test";
import { ensureGlobalCli } from "./global-cli";

const BASE = { version: "3.4.0", dryRun: false, noGlobalCli: false };

describe("ensureGlobalCli", () => {
  test("skips entirely when --no-global-cli is set (reason: flag)", () => {
    const install = () => {
      throw new Error("install must not be called");
    };
    const result = ensureGlobalCli({ ...BASE, noGlobalCli: true, install });
    expect(result).toEqual({ action: "skipped", reason: "flag" });
  });

  test("skips on dry-run (reason: dry-run) and prints the exact npm command", () => {
    const install = () => {
      throw new Error("install must not be called");
    };
    const lines: string[] = [];
    const result = ensureGlobalCli({
      ...BASE,
      dryRun: true,
      install,
      log: (line) => lines.push(line),
    });
    expect(result).toEqual({ action: "skipped", reason: "dry-run" });
    expect(lines.join("\n")).toContain("npm i -g @mstar-harness/cli@3.4.0");
  });

  test("skips when the PATH version already matches (reason: already-matching)", () => {
    const install = () => {
      throw new Error("install must not be called");
    };
    const result = ensureGlobalCli({ ...BASE, detectVersion: () => "3.4.0", install });
    expect(result).toEqual({ action: "skipped", reason: "already-matching" });
  });

  test("installs with the exact pinned spec when the PATH version differs", () => {
    const specs: string[] = [];
    const result = ensureGlobalCli({
      ...BASE,
      detectVersion: () => "3.3.0",
      install: (spec) => specs.push(spec),
    });
    expect(result).toEqual({ action: "installed", spec: "@mstar-harness/cli@3.4.0" });
    expect(specs).toEqual(["@mstar-harness/cli@3.4.0"]);
  });

  test("installs when the CLI is missing on PATH (detectVersion returns null)", () => {
    const specs: string[] = [];
    const result = ensureGlobalCli({
      ...BASE,
      detectVersion: () => null,
      install: (spec) => specs.push(spec),
    });
    expect(result).toEqual({ action: "installed", spec: "@mstar-harness/cli@3.4.0" });
    expect(specs).toEqual(["@mstar-harness/cli@3.4.0"]);
  });

  test("install throw becomes action: failed with the error message, never rethrown", () => {
    const result = ensureGlobalCli({
      ...BASE,
      detectVersion: () => null,
      install: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    expect(result).toEqual({
      action: "failed",
      spec: "@mstar-harness/cli@3.4.0",
      message: "EACCES: permission denied",
    });
  });
});
