/**
 * The dsh workflow-script delivery surface, verified from its own sources —
 * no digest, version or file list is pinned here, because a legitimate
 * deliberate edit must not turn this red for having edited.
 *
 * - every script in `packages/dsh/workflows/` exists and parses as a body;
 * - `packages/dsh/package.json` ships that directory, so an installed host
 *   receives the files the skill tells it to read;
 * - the skill's per-script `meta` identity and its `**File**` anchors name
 *   exactly the files the directory holds, both sides read from source.
 *
 * The call contract passes a shipped body verbatim as the `workflow` tool's
 * `script` argument, so the shipped set is what the host actually executes:
 * that is a behaviour assertion over the delivery surface, not a pin on how
 * the source is written. The shipped set comes from `readdirSync`, so a
 * rename, an added script or an unshipped directory fails with no edit here.
 *
 * Run: `bun test scripts/dsh-workflow-files-contract.test.ts` (repo root).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const ROOT = join(import.meta.dir, "..");
const PACKAGE_DIR = join(ROOT, "packages", "dsh");
const WORKFLOW_DIR = join(PACKAGE_DIR, "workflows");
const CONTRACT = join(ROOT, "skills", "mstar-host", "references", "dsh-workflow-scripts.md");

const contract = readFileSync(CONTRACT, "utf8");
const shipped = readdirSync(WORKFLOW_DIR)
  .filter((name) => name.endsWith(".js"))
  .map((name) => name.slice(0, -".js".length))
  .sort();

describe("dsh workflow scripts are a shipped, self-consistent surface", () => {
  test("every shipped script exists and parses as a workflow body", () => {
    expect(shipped.length).toBeGreaterThan(0);
    for (const name of shipped) {
      // A body is a statement list ending in a top-level `return`, so it
      // compiles inside the async IIFE the workflow tool wraps it in — the
      // same syntax check `node --check` performs, without a second runtime.
      const source = readFileSync(join(WORKFLOW_DIR, `${name}.js`), "utf8");
      expect(() => new vm.Script(`(async () => {\n${source}\n})`)).not.toThrow();
    }
  });

  test("package.json ships the workflows directory", () => {
    const parsed: unknown = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"));
    const files = parsed !== null && typeof parsed === "object" && "files" in parsed ? parsed.files : undefined;
    expect(Array.isArray(files) ? files : []).toContain("workflows");
  });

  test("each script's meta identity is its own file stem", () => {
    const metaNames = [...contract.matchAll(/\*\*`meta`\*\*\n```json\n(.*?)\n```/g)]
      .map((match): unknown => JSON.parse(match[1]!))
      .map((meta) => (meta !== null && typeof meta === "object" && "name" in meta ? meta.name : undefined))
      .filter((name): name is string => typeof name === "string")
      .sort();
    expect(metaNames).toEqual([...shipped]);
    for (const name of shipped) {
      // The body's own argument guard names the workflow, so the meta/files
      // pairing is provable from both sides without a literal list here.
      expect(readFileSync(join(WORKFLOW_DIR, `${name}.js`), "utf8")).toContain(`${name} missing args:`);
    }
  });

  test("the contract's File anchors cover exactly the shipped files", () => {
    const anchored = [...contract.matchAll(/^\*\*File\*\* `@mstar-harness\/dsh\/workflows\/([^`]+)\.js`/gm)].map(
      (match) => match[1]!,
    );
    expect(anchored.length).toBeGreaterThan(0);
    expect([...anchored].sort()).toEqual([...shipped]);
  });
});
