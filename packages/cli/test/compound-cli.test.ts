/** Command-owned CLI subprocess coverage; fixture and assertion contracts are preserved. */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, withTempDir } from "./harness";
import { cliEnvelope, violationCodes } from "./support/cli-assertions";
import { KNOWLEDGE_GOOD } from "./support/cli-content-fixtures";

// ---------------------------------------------------------------------------
// mstar compound validate
// ---------------------------------------------------------------------------

describe("mstar compound validate — knowledge-doc schema / index / scope", () => {
  test("valid knowledge doc → schema OK, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const doc = join(dir, "doc.md");
      writeFileSync(doc, KNOWLEDGE_GOOD);
      const result = runCli(["compound", "validate", doc]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "compound.validate.ok").data?.ok).toBe(true);
    });
  });

  test("doc missing required field → compound.schema.missing-field, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const doc = join(dir, "doc.md");
      writeFileSync(doc, "---\ndate: 2026-08-08\n---\n");
      const result = runCli(["compound", "validate", doc]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("compound.schema.missing-field");
    });
  });

  test("--knowledge-dir with no resolvable harness → compound.catalog.unresolved-harness, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const doc = join(dir, "doc.md");
      writeFileSync(doc, KNOWLEDGE_GOOD);
      const knowledgeDir = join(dir, "knowledge");
      mkdirSync(knowledgeDir);
      // A tree with no harness root: catalog completeness is a store.db query,
      // so the check refuses instead of passing (the retired README reader is
      // no longer the answer, and a silently skipped check is not either).
      const result = runCli(["compound", "validate", doc, "--knowledge-dir", knowledgeDir], { cwd: dir });
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused", "compound.catalog.unresolved-harness").message).toContain("cannot be asserted");
    });
  });

  test("--knowledge-dir with a harness whose store is missing → store.not-initialized, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const doc = join(dir, "doc.md");
      writeFileSync(doc, KNOWLEDGE_GOOD);
      const knowledgeDir = join(dir, "knowledge");
      mkdirSync(knowledgeDir);
      const harness = join(dir, ".mstar");
      mkdirSync(harness);
      const result = runCli(["compound", "validate", doc, "--knowledge-dir", knowledgeDir], {
        cwd: dir,
        env: { MSTAR_HARNESS_DIR: harness },
      });
      // Unavailable catalog data is never read as a complete catalog.
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("store.not-initialized");
      expect(violationCodes(result)).not.toContain("compound.index.retired");
    });
  });

  test("doc outside --knowledge-dir → compound.scope.outside, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const doc = join(dir, "doc.md");
      writeFileSync(doc, KNOWLEDGE_GOOD);
      const knowledgeDir = join(dir, "knowledge");
      mkdirSync(knowledgeDir);
      const result = runCli(["compound", "validate", doc, "--knowledge-dir", knowledgeDir], { cwd: dir });
      expect(result.exitCode).toBe(1);
      // The scope guard still runs independently of the catalog query.
      expect(violationCodes(result)).toContain("compound.scope.outside");
    });
  });

  test("missing <doc-path> arg → usage, exit 2", () => {
    const result = runCli(["compound", "validate"]);
    expect(result.exitCode).toBe(2);
    expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain("docPath");
  });

  test("nonexistent doc → exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["compound", "validate", join(dir, "nope.md")]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused").message).toContain("not found");
    });
  });
});
