import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStoreCommandDefinitions } from "../src/index.js";
import { storeUpgradeFailure } from "../src/families/store.js";
import type { InvocationContext } from "../src/types.js";

import { SddScriptError } from "@mstar-harness/engine";
describe("store upgrade refusal diagnostics", () => {
  test("pending registration names the blocking operation and a supported recovery", () => {
    const result = storeUpgradeFailure("store.upgrade", {
      code: "execution.migration-conflict",
      message: "2 catalog operation(s) are still pending (op-safe-42).",
    });
    expect(result.code).toBe("store.upgrade-pending-registration");
    expect(result.message).toContain("Pending catalog registration op-safe-42");
    expect(result.message).toContain("catalog reconcile --operation-id <operation-id> --abort");
    expect(result.message).not.toContain("store.upgrade-blocked");
  });

  test.each([
    ["execution.migration-conflict", "execution source", "restore the reviewed source inputs"],
    ["execution.coverage-incomplete", "completeness evidence", "stop-session evidence"],
    ["execution.scope-mismatch", "control root", "Supply the correct control root"],
    ["execution.not-active", "execution schema", "Complete the store schema upgrade"],
    ["store.attestation-invalid", "activation attestation", "Correct the operator-supplied attestation"],
    ["store.activation-blocked", "consumer-readiness", "Reload or update"],
    ["store.migration-source-changed", "reviewed legacy source", "migration archive"],
    ["store.legacy-write-detected", "legacy consumer", "Stop or reload"],
    ["store.activation-stale", "recovery point", "fresh staged upgrade"],
    ["store.stale-epoch", "superseded store generation", "fresh activation attempt"],
    ["store.not-active", "not active", "Complete or resume"],
    ["store.busy", "Another store writer", "Wait for that writer"],
    ["store.corrupt", "unreadable or structurally invalid", "execution restore-preview --backup <backup-file>"],
    ["store.schema-drift", "schema history is inconsistent", "harness build that owns this store schema"],
    ["store.schema-unsupported", "does not support the store schema", "Upgrade the harness"],
    ["store.runtime-unsupported", "runtime lacks the SQLite support", "supported Bun or Node runtime"],
  ])("%s emits a cause-specific refusal and operator action", (code, cause, recovery) => {
    const result = storeUpgradeFailure("store.upgrade", { code, message: "sensitive detail must not leak" });
    expect(result.code).toBe(code);
    expect(result.message).toContain(cause);
    expect(result.message).toContain(recovery);
    expect(result.message).not.toContain("sensitive detail must not leak");
    expect(result.message).not.toContain("store.upgrade-blocked");
  });

  test.each([
    ["store.upgrade-staged-record-missing", "persisted staged migration record is missing or incomplete", "missing its complete saved record"],
    ["store.upgrade-staged-record-inconsistent", "persisted manifest or coverage identity is inconsistent", "saved staged migration identity does not verify"],
    ["store.upgrade-staged-inventory-mismatch", "retry inventory /somewhere does not match the staged manifest scope", "reviewed inventory"],
    ["store.upgrade-staged-manifest-missing", "staged execution authority without its matching recorded manifest", "no matching recorded migration manifest"],
    ["store.upgrade-state-changed", "store upgrade is blocked: changed precondition", "preconditions changed"],
    ["store.corrupt", "invalid JSON", "execution restore-preview --backup <backup-file>"],
  ])("%s maps a producer refusal to a cause-specific action", (code, producerMessage, cause) => {
    const failure = code === "store.corrupt" ? new SyntaxError(producerMessage) : new Error(producerMessage);
    const result = storeUpgradeFailure("store.upgrade", failure);
    expect(result.code).toBe(code);
    expect(result.message).toContain(cause);
    expect(result.message).not.toContain("store.upgrade-blocked");
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
      expect(blocked.message).toContain("store migrate --out <manifest-file>");
      expect(blocked.message).toContain("store migrate --apply --manifest <manifest-file>");
      expect(blocked.message).not.toContain("store.upgrade-blocked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
