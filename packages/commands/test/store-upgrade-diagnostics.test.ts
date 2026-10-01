import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStoreCommandDefinitions } from "../src/index.js";
import { storeUpgradeFailure } from "../src/families/store.js";
import type { InvocationContext } from "../src/types.js";

import { SddScriptError } from "@mstar-harness/engine";
describe("store upgrade refusal diagnostics", () => {
  test("pending registration names the operation and phase-aware recovery", () => {
    const result = storeUpgradeFailure("store.upgrade", {
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
    ["execution.migration-conflict", "legacy source", "store upgrade --operator <name> --attestation <file>"],
    ["execution.coverage-incomplete", "complete migration evidence", "--inventory <inventory-file>"],
    ["execution.scope-mismatch", "does not match the migration scope", "--operator <name>"],
    ["store.attestation-invalid", "activation attestation", "store upgrade --operator <name> --attestation <file>"],
    ["store.activation-blocked", "consumer is not ready", "stop the active sessions"],
    ["store.migration-source-changed", "reviewed legacy source", "store upgrade --operator <name> --attestation <file>"],
    ["store.legacy-write-detected", "legacy consumer", "Stop or reload"],
    ["store.activation-stale", "recovery point", "store execution restore-preview --backup <backup-file> --out <preview-file>"],
    ["store.stale-epoch", "older store generation", "store upgrade --operator <name> --attestation <file>"],
    ["store.not-active", "not active", "store upgrade --operator <name> --attestation <file>"],
    ["store.busy", "Another store writer", "Wait for that writer"],
    ["store.corrupt", "unreadable or structurally invalid", "No online operator restore is available in this state"],
    ["store.schema-drift", "schema history is inconsistent", "store execution restore-preview --backup <backup-file> --out <preview-file>"],
    ["store.schema-unsupported", "does not support the store schema", "npm i -g @mstar-harness/cli@latest"],
    ["store.runtime-unsupported", "runtime lacks native SQLite support", "Bun >=1.4.0"],
  ])("%s emits a cause-specific refusal and operator action", (code, cause, recovery) => {
    const result = storeUpgradeFailure("store.upgrade", { code, message: "sensitive detail must not leak" });
    expect(result.code).toBe(code);
    expect(result.message).toContain(cause);
    expect(result.message).toContain(recovery);
    expect(result.message).not.toContain("sensitive detail must not leak");
    expect(result.message).not.toContain("store.upgrade-blocked");
  });

  test.each([
    ["store.upgrade-staged-record-missing", "persisted staged migration record is missing or incomplete", "missing saved record", "No operator-executable in-place recovery is available"],
    ["store.upgrade-staged-record-malformed", "malformed JSON in the persisted staged manifest or coverage record", "staged migration manifest or coverage JSON is malformed", "archive-first recovery path"],
    ["store.upgrade-staged-record-inconsistent", "persisted manifest or coverage identity is inconsistent", "identity does not verify", "cannot repair an inconsistent saved identity"],
    ["store.upgrade-staged-inventory-mismatch", "retry inventory /somewhere does not match the staged manifest scope", "reviewed inventory", "rerun `store upgrade`"],
    ["store.upgrade-staged-manifest-missing", "staged execution authority without its matching recorded manifest", "no matching recorded migration manifest", "cannot repair a missing manifest"],
    ["store.upgrade-state-changed", "store upgrade is blocked: changed precondition", "preconditions changed", "rerun `store upgrade`"],
    ["store.upgrade-state-changed", "unreachable store upgrade state", "preconditions changed", "rerun `store upgrade`"],
  ])("%s maps a producer refusal to a cause-specific action", (code, producerMessage, cause, recovery) => {
    const result = storeUpgradeFailure("store.upgrade", new Error(producerMessage));
    expect(result.code).toBe(code);
    expect(result.message).toContain(cause);
    expect(result.message).toContain(recovery);
    expect(result.message).not.toContain("store.upgrade-blocked");
  });

  test("unreadable corrupt store explicitly does not claim preview can recover it", () => {
    const result = storeUpgradeFailure("store.upgrade", new SyntaxError("invalid JSON"));
    expect(result.code).toBe("store.corrupt");
    expect(result.message).toContain("store execution restore-preview");
    expect(result.message).toContain("cannot recover an unreadable live store");
    expect(result.message).toContain("store init");
    expect(result.message).toContain("SQLite-only catalog/execution data");
  });

  test("unclassified payloads redact paths and internal identifiers", () => {
    const result = storeUpgradeFailure("store.upgrade", {
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
    const result = storeUpgradeFailure("store.upgrade", new Error("probe failed: underlying detail"));
    expect(result.code).toBe("store.upgrade.unexpected-failure");
    expect(result.message).toContain("probe failed: underlying detail");
    expect(result.message).toContain("Preserve the legacy sources and store bytes");
    expect(result.message).toContain("store upgrade");
  });

  test("SddScriptError remains a usage refusal with exit code 2", () => {
    const result = storeUpgradeFailure("store.upgrade", new SddScriptError("invalid request", 2));
    expect(result.status).toBe("usage");
    expect(result.code).toBe("usage");
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("store upgrade --help");
  });

  test("unclassified typed errors retain their stable code without leaking raw details", () => {
    const result = storeUpgradeFailure("store.upgrade", { code: "store.future-cause", message: "/private/path/session-uuid" });
    expect(result.code).toBe("store.future-cause");
    expect(result.message).toContain("store.future-cause");
    expect(result.message).not.toContain("/private/path");
    expect(result.message).not.toContain("session-uuid");
    expect(result.message).not.toContain("store.upgrade-blocked");
  });

  test("missing store distinguishes empty workspaces from legacy sources with runnable recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "mstar-store-upgrade-missing-"));
    try {
      const definition = getStoreCommandDefinitions().find((command) => command.id === "store.upgrade");
      if (definition === undefined) throw new Error("store.upgrade definition is missing");
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
      expect(blocked.message).toContain("store upgrade --operator <name> --attestation <file>");
      expect(blocked.message).toContain("activate, and retire those execution files");
      expect(blocked.message).not.toContain("store migrate --out");
      expect(blocked.message).not.toContain("store.upgrade-blocked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
