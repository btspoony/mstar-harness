/** Command-owned CLI subprocess coverage; fixture and assertion contracts are preserved. */
import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertKnowledgeCatalogCompleteness, initializeStore, registerCatalogEntity } from "@mstar-harness/engine";
import { runCli, withTempDir } from "./harness";
import { cliEnvelope, violationCodes } from "./support/cli-assertions";
import { KNOWLEDGE_GOOD } from "./support/cli-content-fixtures";

/**
 * One workspace whose configured knowledge root is COMPLETE (its only body has
 * a catalog row), so any later verdict is about the directory the caller named.
 * Returns the physical root: the engine realpaths its roots and macOS tmpdirs
 * are symlinked.
 */
async function completeKnowledgeRoot(dir: string): Promise<{ root: string; harness: string; configured: string }> {
  const root = realpathSync(dir);
  const harness = join(root, ".mstar");
  const configured = join(harness, "knowledge");
  mkdirSync(configured, { recursive: true });
  writeFileSync(join(configured, "registered.md"), KNOWLEDGE_GOOD);
  const context = { harnessDir: harness };
  (await initializeStore(context)).close();
  await registerCatalogEntity(context, {
    kind: "document", id: "doc-registered", title: "Registered doc", rootKind: "knowledge", relativePath: "registered.md", documentKind: "knowledge",
  }, { operationId: "fixture-catalog-complete", actor: "compound" });
  expect((await assertKnowledgeCatalogCompleteness(context)).ok).toBe(true);
  return { root, harness, configured };
}

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
      const harness = join(dir, ".mstar");
      mkdirSync(harness);
      const knowledgeDir = join(harness, "knowledge");
      mkdirSync(knowledgeDir);
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

  test("--knowledge-dir outside the configured root is refused even though the configured catalog is complete", async () => {
    await withTempDir("mstar-slice4-cli-", async (dir) => {
      const { root, harness, configured } = await completeKnowledgeRoot(dir);
      const alternate = join(root, "alternate-knowledge");
      mkdirSync(alternate, { recursive: true });
      const unregistered = join(alternate, "unregistered.md");
      writeFileSync(unregistered, KNOWLEDGE_GOOD);

      const result = runCli(["compound", "validate", unregistered, "--knowledge-dir", alternate], {
        cwd: root,
        env: { MSTAR_HARNESS_DIR: harness },
      });
      // Inverted assertion (PR #558 review must-fix 2): before the fix this case
      // was ok / exit 0 — the complete configured catalog vouched for a
      // directory the completeness query never discovered.
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("compound.catalog.knowledge-dir-mismatch");
      expect(cliEnvelope(result, "refused").message).toContain(configured);
    });
  });

  test("the configured knowledge root still passes, and an equal path spelled differently is not refused", async () => {
    await withTempDir("mstar-slice4-cli-", async (dir) => {
      const { root, harness, configured } = await completeKnowledgeRoot(dir);
      const category = join(configured, "engineering");
      mkdirSync(category);
      writeFileSync(join(category, "nested.md"), KNOWLEDGE_GOOD);
      await registerCatalogEntity({ harnessDir: harness }, {
        kind: "document", id: "doc-nested", title: "Nested doc", rootKind: "knowledge", relativePath: "engineering/nested.md", documentKind: "knowledge",
      }, { operationId: "fixture-catalog-nested", actor: "compound" });
      const link = join(root, "knowledge-link");
      symlinkSync(configured, link);

      for (const [doc, knowledgeDir] of [
        [join(configured, "registered.md"), configured],
        [join(configured, "registered.md"), `${harness}/./knowledge/`],
        // Both sides spelled through the symlink: the scope guard stays lexical.
        [join(link, "registered.md"), link],
        // A directory inside the configured root is proven by the same verdict.
        [join(category, "nested.md"), category],
      ] as const) {
        const result = runCli(["compound", "validate", doc, "--knowledge-dir", knowledgeDir], {
          cwd: root,
          env: { MSTAR_HARNESS_DIR: harness },
        });
        expect(result.exitCode).toBe(0);
        expect(cliEnvelope(result, "ok", "compound.validate.ok").data).toMatchObject({ ok: true, violations: [] });
      }
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
