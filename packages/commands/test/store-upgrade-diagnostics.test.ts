import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStoreCommandDefinitions } from "../src/index.js";
import { storeUpgradeFailure } from "../src/families/store.js";
import type { InvocationContext } from "../src/types.js";

import { SddScriptError } from "@mstar-harness/engine";
describe("store safe-upgrade refusal diagnostics", () => {
  test("pending registration names the operation and phase-aware recovery", () => {
    const result = storeUpgradeFailure("store.safe-upgrade", {
      code: "execution.migration-conflict",
      message: "2 catalog operation(s) are still pending (op-safe-42).",
    });
    expect(result.code).toBe("store.upgrade-pending-registration");
    expect(result.message).toContain("Pending catalog registration op-safe-42");
    expect(result.message).toContain("catalog reconcile --operation-id <operation-id>");
    expect(result.message).toContain("For phase `prepared` with no workflow snapshot or root registration, rerun with `--abort`");
    expect(result.message).toContain("if a snapshot or root registration exists, abort is refused");
    expect(result.message).not.toContain("store.upgrade-blocked");
  });

  test.each([
    ["execution.migration-conflict", "legacy source", "store safe-upgrade --operator <name> --attestation <file>"],
    ["execution.coverage-incomplete", "complete migration evidence", "--inventory <inventory-file>"],
    ["execution.scope-mismatch", "does not match the migration scope", "--operator <name>"],
    ["store.attestation-invalid", "activation attestation", "store safe-upgrade --operator <name> --attestation <file>"],
    ["store.activation-blocked", "consumer is not ready", "stop the active sessions"],
    ["store.migration-source-changed", "reviewed legacy source", "store safe-upgrade --operator <name> --attestation <file>"],
    ["store.legacy-write-detected", "legacy consumer", "Stop or reload"],
    ["store.activation-stale", "recovery point", "store execution restore-preview --backup <backup-file> --out <preview-file>"],
    ["store.stale-epoch", "older store generation", "store safe-upgrade --operator <name> --attestation <file>"],
    ["store.not-active", "not active", "store safe-upgrade --operator <name> --attestation <file>"],
    ["store.busy", "Another store writer", "Wait for that writer"],
    ["store.corrupt", "unreadable or structurally invalid", "No online operator restore is available in this state"],
    ["store.schema-drift", "schema history is inconsistent", "store execution restore-preview --backup <backup-file> --out <preview-file>"],
    ["store.schema-unsupported", "does not support the store schema", "npm i -g @mstar-harness/cli@latest"],
    ["store.runtime-unsupported", "runtime lacks native SQLite support", "Bun >=1.4.0"],
  ])("%s emits a cause-specific refusal and operator action", (code, cause, recovery) => {
    const result = storeUpgradeFailure("store.safe-upgrade", { code, message: "sensitive detail must not leak" });
    expect(result.code).toBe(code);
    expect(result.message).toContain(cause);
    expect(result.message).toContain(recovery);
    expect(result.message).not.toContain("sensitive detail must not leak");
    expect(result.message).not.toContain("store.upgrade-blocked");
  });

  test.each([
    ["store.upgrade-staged-record-missing", "persisted staged migration record is missing or incomplete", "missing its complete saved record", "mstar store backup --out <backup-file>"],
    ["store.upgrade-staged-record-malformed", "malformed JSON in the persisted staged manifest or coverage record", "staged migration manifest or coverage JSON is malformed", "Preserve the entire store"],
    ["store.upgrade-staged-record-inconsistent", "persisted manifest or coverage identity is inconsistent", "identity does not verify", "mstar store backup --out <backup-file>"],
    ["store.upgrade-staged-inventory-mismatch", "retry inventory /somewhere does not match the staged manifest scope", "reviewed inventory", "rerun `store safe-upgrade`"],
    ["store.upgrade-staged-manifest-missing", "staged execution authority without its matching recorded manifest", "no matching recorded migration manifest", "mstar store backup --out <backup-file>"],
    ["store.upgrade-state-changed", "store safe-upgrade is blocked: changed precondition", "changed store readiness preconditions", "mstar store safe-upgrade"],
  ])("%s maps a producer refusal to a cause-specific action", (code, producerMessage, cause, recovery) => {
    const result = storeUpgradeFailure("store.safe-upgrade", Object.assign(new Error(producerMessage), { code }));
    expect(result.code).toBe(code);
    expect(result.message).toContain(cause);
    expect(result.message).toContain(recovery);
    expect(result.message).not.toContain("store.upgrade-blocked");
  });

  test("staged JSON parse failure stays distinct from database corruption", () => {
    const staged = storeUpgradeFailure("store.safe-upgrade", Object.assign(
      new Error("store safe-upgrade found malformed JSON in the persisted staged manifest or coverage record"),
      { code: "store.upgrade-staged-record-malformed" },
    ));
    const corrupt = storeUpgradeFailure("store.safe-upgrade", { code: "store.corrupt", message: "database cannot be read" });
    expect(staged.code).toBe("store.upgrade-staged-record-malformed");
    expect(staged.message).toContain("staged migration manifest or coverage JSON is malformed");
    expect(staged.message).toContain("mstar store backup --out <backup-file>");
    expect(corrupt.code).toBe("store.corrupt");
    expect(corrupt.message).toContain("unreadable or structurally invalid");
    expect(corrupt.message).toContain("store init");
  });

  test("unclassified payloads redact paths and internal identifiers", () => {
    const result = storeUpgradeFailure("store.safe-upgrade", {
      code: "store.future-cause",
      message: "failed at /Users/alice/private/store.db with workflowId operationId lossDigest",
    });
    expect(result.message).not.toContain("/Users/alice");
    expect(result.message).not.toContain("workflowId");
    expect(result.message).not.toContain("operationId");
    expect(result.message).not.toContain("lossDigest");
    expect(result.message).toContain("[path omitted]");
    expect(result.message).toContain("[internal field omitted]");
  });
  test("genuinely unclassified errors include their diagnostic and an actionable next step", () => {
    const result = storeUpgradeFailure("store.safe-upgrade", new Error("probe failed: underlying detail"));
    expect(result.code).toBe("store.safe-upgrade.unexpected-failure");
    expect(result.message).toContain("probe failed: underlying detail");
    expect(result.message).toContain("Preserve the legacy sources and store bytes");
    expect(result.message).toContain("store safe-upgrade");
  });

  test("SddScriptError remains a usage refusal with exit code 2", () => {
    const result = storeUpgradeFailure("store.safe-upgrade", new SddScriptError("invalid request", 2));
    expect(result.status).toBe("usage");
    expect(result.code).toBe("usage");
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("store safe-upgrade --help");
  });

  test("unclassified typed errors retain their stable code without leaking raw details", () => {
    const result = storeUpgradeFailure("store.safe-upgrade", { code: "store.future-cause", message: "/private/path/session-uuid" });
    expect(result.code).toBe("store.future-cause");
    expect(result.message).toContain("store.future-cause");
    expect(result.message).not.toContain("/private/path");
    expect(result.message).not.toContain("session-uuid");
    expect(result.message).not.toContain("store.upgrade-blocked");
  });

  test("missing store distinguishes empty workspaces from legacy sources with runnable recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-missing-"));
    try {
      const definition = getStoreCommandDefinitions().find((command) => command.id === "store.safe-upgrade");
      if (definition === undefined) throw new Error("store.safe-upgrade definition is missing");
      const invocation: InvocationContext = {
        cwd: root,
        controlRoot: null,
        versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
        signal: new AbortController().signal,
        effects: {
          async readInput() { return ""; },
          async spawn() { return { exitCode: 1, signal: null, stdout: "", stderr: "" }; },
          async startDashboard() { throw new Error("not available"); },
          async openBrowser() { throw new Error("not available"); },
        },
      };
      const empty = await definition.execute(definition.input.parse({ harness: join(root, "empty") }), invocation);
      expect(empty.code).toBe("store.upgrade-empty-store");
      expect(empty.message).toContain("store init");
      expect(empty.message).not.toContain("store.upgrade-blocked");

      const legacy = join(root, "legacy");
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, "status.json"), JSON.stringify({ version: 2, workflows: [] }));
      const blocked = await definition.execute(definition.input.parse({ harness: legacy }), invocation);
      expect(blocked.code).toBe("store.upgrade-legacy-source-only");
      expect(blocked.message).toContain("store init");
      expect(blocked.message).toContain("status.json");
      expect(blocked.message).toContain("store safe-upgrade --operator <name> --attestation <file>");
      expect(blocked.message).toContain("activate, and retire those execution files");
      expect(blocked.message).not.toContain("store migrate --out");
      expect(blocked.message).not.toContain("store.upgrade-blocked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
