/** Command-owned CLI subprocess coverage; fixture and assertion contracts are preserved. */
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLI_ROOT, runCli, withTempDir } from "./harness";
import { cliEnvelope } from "./support/cli-assertions";

// ---------------------------------------------------------------------------
// mstar roles validate — mapping / load-order checks (audit-003)
// ---------------------------------------------------------------------------

describe("mstar roles validate — mapping / load-order checks (audit-003)", () => {
  /** Real mstar-roles skill dir of this checkout — a passing fixture by
   * definition of the drift-lint guard (Task 2 enforces the same corpus). */
  const REPO_ROLES_DIR = join(resolve(CLI_ROOT, "..", ".."), "skills", "mstar-roles");

  /** mstar-* sibling with no Load Order section (violates
   * roles.loadorder.section.missing). */
  const SIBLING_NO_LOAD_ORDER = `# mstar-foo

A topic skill body without a Load Order heading.
`;

  test("default flags validate the shipped corpus (exit 0, OK + counts)", () => {
    // cwd = packages/cli: resolveCliProjectRoot walks up to the monorepo root,
    // so --roles-dir defaults to <root>/skills/mstar-roles and --skills-dir to
    // <root>/skills — the real corpus must pass (same guarantee Task 2 guards).
    const result = runCli(["roles", "validate"], { cwd: resolve(CLI_ROOT, "..", "..") });
    expect(result.exitCode).toBe(0);
    const envelope = cliEnvelope(result, "ok", "roles.validate.ok");
    expect(envelope.data).toMatchObject({ ok: true, violations: [], siblingCount: expect.any(Number), loadOrderChecked: expect.any(Number) });
  });

  test("--roles-dir / --skills-dir overrides; load-order violation exits 1 with one row each", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const skillsRoot = join(dir, "skills");
      mkdirSync(join(skillsRoot, "mstar-foo"), { recursive: true });
      writeFileSync(join(skillsRoot, "mstar-foo", "SKILL.md"), SIBLING_NO_LOAD_ORDER);
      const result = runCli(["roles", "validate", "--roles-dir", REPO_ROLES_DIR, "--skills-dir", skillsRoot]);
      expect(result.exitCode).toBe(1);
      // Mapping still passes on the real roles dir — the failure is isolated to
      // the load-order lint so the row contract is asserted exactly.
      const envelope = cliEnvelope(result, "refused", "roles.loadorder.section.missing");
      expect(envelope.message).toContain('skill "mstar-foo"');
    });
  });

  test("empty roles dir — mapping violations, one row each (exit 1)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["roles", "validate", "--roles-dir", dir, "--skills-dir", dir]);
      expect(result.exitCode).toBe(1);
      const violations = cliEnvelope(result, "refused").details?.violations ?? [];
      const missingReferences = violations.filter(({ code }) => code === "roles.mapping.reference.missing");
      expect(missingReferences.length).toBeGreaterThan(0);
    });
  });

  test("unreadable sibling SKILL.md is skipped best-effort (exit 0)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const skillsRoot = join(dir, "skills");
      // A directory named SKILL.md makes readFileSync throw (EISDIR)
      // deterministically — exercises the best-effort skip without
      // root-dependent chmod semantics.
      mkdirSync(join(skillsRoot, "mstar-foo", "SKILL.md"), { recursive: true });
      const result = runCli(["roles", "validate", "--roles-dir", REPO_ROLES_DIR, "--skills-dir", skillsRoot]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "roles.validate.ok").data).toMatchObject({ siblingCount: 0, loadOrderChecked: 0 });
    });
  });

  test("relative --roles-dir resolves against MSTAR_CLI_PROJECT_ROOT", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      // Copy the real roles dir into the fixture project root so the mapping
      // passes; the sibling scan then covers the copied mstar-roles SKILL.md.
      cpSync(REPO_ROLES_DIR, join(dir, "skills", "mstar-roles"), { recursive: true });
      const nested = join(dir, "nested", "deep");
      mkdirSync(nested, { recursive: true });
      const result = runCli(["roles", "validate", "--roles-dir", "skills/mstar-roles", "--skills-dir", join(dir, "skills")], {
        cwd: nested,
        env: { MSTAR_CLI_PROJECT_ROOT: dir },
      });
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "roles.validate.ok").data).toMatchObject({ siblingCount: 1, loadOrderChecked: 1 });
    });
  });
});
