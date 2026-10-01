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

  test("--knowledge-dir without README index → compound.index.retired, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const doc = join(dir, "doc.md");
      writeFileSync(doc, KNOWLEDGE_GOOD);
      const knowledgeDir = join(dir, "knowledge");
      mkdirSync(knowledgeDir);
      const result = runCli(["compound", "validate", doc, "--knowledge-dir", knowledgeDir]);
      expect(result.exitCode).toBe(1);
      // The README index is retired in authority (state-projection contract
      // §4, P4 adjudication): compound.index.missing-readme is superseded by
      // the actionable retired-reader refusal.
      expect(cliEnvelope(result, "refused", "compound.index.retired").message).toContain("no longer a register");
    });
  });

  test("doc outside --knowledge-dir → compound.scope.outside, exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const doc = join(dir, "doc.md");
      writeFileSync(doc, KNOWLEDGE_GOOD);
      const knowledgeDir = join(dir, "knowledge");
      mkdirSync(knowledgeDir);
      writeFileSync(join(knowledgeDir, "README.md"), "# Knowledge\n\n| Document | Source Plan | Description | Status |\n|---|---|---|---|\n");
      const result = runCli(["compound", "validate", doc, "--knowledge-dir", knowledgeDir]);
      expect(result.exitCode).toBe(1);
      expect(violationCodes(result)).toContain("compound.scope.outside");
    });
  });

  test("doc inside --knowledge-dir with index row → README register retired (exit 1, scope still guarded)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const knowledgeDir = join(dir, "knowledge");
      mkdirSync(knowledgeDir);
      const doc = join(knowledgeDir, "doc.md");
      writeFileSync(doc, KNOWLEDGE_GOOD);
      writeFileSync(join(knowledgeDir, "README.md"), "# Knowledge\n\n| Document | Source Plan | Description | Status |\n|---|---|---|---|\n| [doc](doc.md) | 20260808-x | x | done |\n");
      const result = runCli(["compound", "validate", doc, "--knowledge-dir", knowledgeDir]);
      // The retired README reader refuses even when the row exists. The
      // separate outside-scope case above keeps the scope guard covered.
      expect(result.exitCode).toBe(1);
      const envelope = cliEnvelope(result, "refused", "compound.index.retired");
      expect(envelope.details?.violations?.map(({ code }) => code) ?? [envelope.code]).toEqual(["compound.index.retired"]);
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
