/** Command-owned CLI subprocess coverage; fixture and assertion contracts are preserved. */
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, withTempDir } from "./harness";
import { cliEnvelope, violationCodes } from "./support/cli-assertions";
import { DESIGN_LEVEL1 } from "./support/cli-content-fixtures";

// ---------------------------------------------------------------------------
// mstar design-md validate
// ---------------------------------------------------------------------------

describe("mstar design-md validate — tokens / parity / completeness", () => {
  test("valid Level 1 DESIGN.md → tokens OK, completeness MVP, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "DESIGN.md"), DESIGN_LEVEL1);
      const result = runCli(["design-md", "validate", dir]);
      expect(result.exitCode).toBe(0);
      const envelope = cliEnvelope(result, "ok", "design-md.validate.ok");
      expect(envelope.data?.ok).toBe(true);
      expect(envelope.data?.completeness).toMatchObject({ level: "MVP" });
    });
  });

  test("invalid token value → design-md.tokens.color-format, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "DESIGN.md"), DESIGN_LEVEL1.replace('"#ffffff"', '"not-a-color"'));
      const result = runCli(["design-md", "validate", dir]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("design-md.tokens.color-format");
    });
  });

  test("light/dark key mismatch → design-md.parity.missing-dark, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "DESIGN.md"), DESIGN_LEVEL1);
      // Dark theme missing gray-900 (and background-100 value differs).
      writeFileSync(
        join(dir, "DESIGN.dark.md"),
        DESIGN_LEVEL1.replace('gray-1000: "#171717"', 'gray-1000: "#000000"').replace('  gray-900: "#666666"\n', ""),
      );
      const result = runCli(["design-md", "validate", dir]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("design-md.parity.missing-dark");
    });
  });

  test("no DESIGN.md in dir → exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["design-md", "validate", dir]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused").message).toContain("design file not found");
    });
  });

  test("missing <dir> arg → usage, exit 2", () => {
    const result = runCli(["design-md", "validate"]);
    expect(result.exitCode).toBe(2);
    expect(String(cliEnvelope(result, "usage").message)).toContain("missing required argument 'dir'");
  });
});
