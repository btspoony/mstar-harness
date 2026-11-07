/**
 * The four dsh read-only fan-out scripts are shipped as real files under
 * `packages/dsh/workflows/`. Each body was captured byte-for-byte from the
 * fenced block of `skills/mstar-host/references/dsh-workflow-scripts.md`
 * before the files were created; these are those bodies' SHA-256 digests.
 *
 * Those bytes are the deliverable, not implementation detail: the host passes
 * the shipped body verbatim as the `workflow` tool's `script` argument, so this
 * pins what a caller actually executes — a BEHAVIOUR assertion, not a
 * source-shape one. A deliberate script edit records its new digest here in the
 * same change; that is the design intent, not a maintenance burden.
 *
 * Run: `bun test scripts/dsh-workflow-files-hash.test.ts` (repo root).
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW_DIR = join(import.meta.dir, "..", "packages", "dsh", "workflows");

/** Recorded SHA-256 of each shipped script body, keyed by file stem. */
const RECORDED: Record<string, string> = {
  "mstar-qc-tri": "49aae2d007406378ec941c8e0a122fed203f5b1e350ee33ae9ec539ff1275781",
  "mstar-audit-fanout": "87cd92b59b6de5e36a5b61893334763edd4f0bc6457aaf0f000c0dd9aa1469fc",
  "mstar-pr-seats": "3a77b308e6ad3303ef62c754b20a7ee496e9d7040c7aa3a0526d80680cee8e05",
  "mstar-review-single": "6050aeccd06b192ef186308aa92c5d7ad34f357ef3df8d2accb1faadb7647ff4",
};

describe("shipped dsh workflow scripts are byte-identical to their recorded bodies", () => {
  for (const [stem, digest] of Object.entries(RECORDED)) {
    test(`${stem}.js matches its recorded SHA-256`, () => {
      const body = readFileSync(join(WORKFLOW_DIR, `${stem}.js`));
      expect(createHash("sha256").update(body).digest("hex")).toBe(digest);
    });
  }

  test("the shipped set is exactly the recorded scripts", () => {
    const shipped = readdirSync(WORKFLOW_DIR)
      .filter((name) => name.endsWith(".js"))
      .map((name) => name.slice(0, -3))
      .sort();
    expect(shipped).toEqual(Object.keys(RECORDED).sort());
  });
});
