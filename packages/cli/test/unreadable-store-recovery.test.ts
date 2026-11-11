/**
 * The unreadable-store boundary, proved as behaviour in ONE isolated fixture.
 *
 * A physically unreadable `store.db` is not restorable online (`store execution
 * restore-preview`/`restore` both need a successful inventory of the live
 * store), so an operator continues on a fresh control root and preserves the
 * original bytes as evidence. This case proves the three facts the refusal text
 * promises, against a temp tree that never touches a real store:
 *
 * - the original refusal keeps its code and names the supported bootstrap verbs;
 * - the documented public sequence (scaffold with `MSTAR_HARNESS_DIR` + the
 *   repository root → `store init --harness` → `catalog discover --harness`)
 *   yields a usable harness;
 * - the corrupt bytes are byte-identical afterwards.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, withTempDir, type RunResult } from "./harness";

const CORRUPT_BYTES = "this is not a SQLite database\n";

interface Envelope {
  status: string;
  code: string;
  message?: string;
  data?: Record<string, unknown>;
  details?: { recovery?: unknown; selfCheck?: { recovery?: unknown } };
}

function envelopeOf(result: RunResult): Envelope {
  return JSON.parse(result.stdout) as Envelope;
}

describe("unreadable store — refusal boundary and the documented fresh-root bootstrap", () => {
  test("a corrupt store refuses online recovery, the public bootstrap builds a usable harness, and the evidence bytes survive", () => {
    withTempDir("mstar-unreadable-store-", (root) => {
      execFileSync("git", ["init", "-q"], { cwd: root });
      const corruptHarness = join(root, ".mstar");
      const storePath = join(corruptHarness, "store.db");
      mkdirSync(corruptHarness, { recursive: true });
      writeFileSync(storePath, CORRUPT_BYTES);
      const bytesBefore = readFileSync(storePath);
      const freshHarness = join(corruptHarness, "recovered-control");

      // (a) The unreadable store keeps its typed refusal and names supported routes.
      const refused = runCli(["status", "validate"], { cwd: root, env: { MSTAR_HARNESS_DIR: corruptHarness } });
      const refusal = envelopeOf(refused);
      expect(refused.exitCode).toBe(1);
      expect(refusal.status).toBe("refused");
      expect(refusal.code).toBe("store.corrupt");
      expect(refusal.data).toBeUndefined();
      const recovery = String(refusal.details?.selfCheck?.recovery ?? "");
      expect(recovery).toContain("mstar store init --harness");
      expect(recovery).toContain("mstar catalog discover --harness");
      // It never advertises an online restore of a store no reader can inventory.
      expect(recovery).not.toContain("mstar store restore");

      // (b) The documented public sequence bootstraps a usable fresh harness.
      const scaffold = envelopeOf(runCli(["harness", "scaffold", root], { cwd: root, env: { MSTAR_HARNESS_DIR: freshHarness } }));
      expect(scaffold.status).toBe("ok");
      expect(scaffold.data?.harnessDir).toBe(freshHarness);

      const initialized = envelopeOf(runCli(["store", "init", "--harness", freshHarness], { cwd: root }));
      expect(initialized.status).toBe("ok");
      expect(initialized.data?.authorityState).toBe("active");

      const discovered = envelopeOf(runCli(["catalog", "discover", "--harness", freshHarness], { cwd: root }));
      expect(discovered.status).toBe("ok");

      // Usable: the fresh root answers a store read on its own authority.
      const listed = envelopeOf(runCli(["catalog", "list", "--harness", freshHarness], { cwd: root }));
      expect(listed.status).toBe("ok");
      expect(listed.data?.total).toBe(0);

      // (c) The preserved evidence is untouched, byte for byte.
      expect(existsSync(storePath)).toBe(true);
      expect(readFileSync(storePath).equals(bytesBefore)).toBe(true);
    });
  }, 120000);
});
