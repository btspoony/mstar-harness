/** why: The unreadable-store boundary, proved as behaviour in ONE isolated fixture.
 *
 * A physically unreadable `store.db` is not restorable online (`store execution
 * restore-preview`/`restore` both need a successful inventory of the live
 * store), so an operator continues in a fresh clone and preserves the original
 * bytes as evidence. This case proves the facts the refusal text promises,
 * against a temp tree that never touches a real store:
 *
 * - the original refusal keeps its code and names the supported bootstrap verbs;
 * - the documented public sequence (scaffold in a fresh clone → `store init` →
 *   `catalog discover`) yields a usable harness at the fixed root;
 * - the corrupt bytes are byte-identical afterwards.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

describe("unreadable store — refusal boundary and the documented fresh-clone bootstrap", () => {
  test("a corrupt store refuses online recovery, the public bootstrap builds a usable fresh harness, and the evidence bytes survive", () => {
    withTempDir("mstar-unreadable-store-", (root) => {
      execFileSync("git", ["init", "-q"], { cwd: root });
      const corruptHarness = join(root, ".mstar");
      const storePath = join(corruptHarness, "store.db");
      mkdirSync(corruptHarness, { recursive: true });
      writeFileSync(storePath, CORRUPT_BYTES);
      const bytesBefore = readFileSync(storePath);
      const mstarc = join(root, ".mstarc");
      // invariant: The declared layout carries the repository's collaboration identity
      // too: `store init` pairs the lane and refuses without it. The repo_id
      // derives from the unique temp path so reruns never meet a lane a
      // previous run published and left ACTIVE.
      const declared = `[config]\nspecs_dir=custom/specs\n[collaboration]\nmode=local\nrepo_id=fixture-unreadable-recovery-${root.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(-110)}\n`;
      writeFileSync(mstarc, declared);

      // (a) The unreadable store keeps its typed refusal and names supported routes.
      const refused = runCli(["status", "validate"], { cwd: root });
      const refusal = envelopeOf(refused);
      expect(refused.exitCode).toBe(1);
      expect(refusal.status).toBe("refused");
      expect(refusal.code).toBe("store.corrupt");
      expect(refusal.data).toBeUndefined();
      const recovery = String(refusal.details?.selfCheck?.recovery ?? "");
      expect(recovery).toContain("mstar harness scaffold");
      expect(recovery).toContain("mstar store init");
      expect(recovery).toContain("mstar catalog discover");
      // why: It never advertises an online restore of a store no reader can inventory,
      // and it never points at the retired root selector.
      expect(recovery).not.toContain("mstar store restore");
      expect(recovery).not.toContain("MSTAR_HARNESS_DIR");

      // why: (b) A fresh clone has no `.mstar`; the fixed root bootstraps there.
      const fresh = join(root, "fresh-clone");
      mkdirSync(fresh, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: fresh });
      writeFileSync(join(fresh, ".mstarc"), declared);

      const scaffold = envelopeOf(runCli(["harness", "scaffold", fresh], { cwd: fresh }));
      expect(scaffold.status).toBe("ok");
      expect(scaffold.data?.harnessDir).toBe(join(realpathSync(fresh), ".mstar"));
      // why: The repository's declared layout is never edited, and the scaffold does
      // not write the retired `harness_dir` key.
      expect(readFileSync(join(fresh, ".mstarc"), "utf8")).toBe(declared);
      expect(readFileSync(join(fresh, ".mstarc"), "utf8")).not.toContain("harness_dir");

      const initialized = envelopeOf(runCli(["store", "init"], { cwd: fresh }));
      expect(initialized.status).toBe("ok");
      expect(initialized.data?.authorityState).toBe("active");

      const discovered = envelopeOf(runCli(["catalog", "discover"], { cwd: fresh }));
      expect(discovered.status).toBe("ok");

      // The fresh root still resolves the repository's declared corpus layout.
      const resolved = envelopeOf(runCli(["path", "resolve"], { cwd: fresh }));
      expect(resolved.status).toBe("ok");
      expect(resolved.data?.specsDir).toBe(join(realpathSync(fresh), "custom", "specs"));

      // Usable: the fresh root answers a store read on its own authority.
      const listed = envelopeOf(runCli(["catalog", "list"], { cwd: fresh }));
      expect(listed.status).toBe("ok");
      expect(listed.data?.total).toBe(0);

      // (c) The preserved evidence is untouched, byte for byte.
      expect(existsSync(storePath)).toBe(true);
      expect(readFileSync(storePath).equals(bytesBefore)).toBe(true);
    });
  }, 120000);
});
