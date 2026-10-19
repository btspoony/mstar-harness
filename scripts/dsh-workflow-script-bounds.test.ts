/**
 * I-000735's assertion clause — the dsh workflow-script pool bound is pinned
 * by a host-core-count-independent check. The `mstar-audit-fanout` script in
 * `dsh-workflow-scripts.md` (§ mstar-audit-fanout) chunks its child seats so
 * in-flight children stay within the host subagent pool's `maxActiveSubagents`
 * cap (default 8, hard reject) — a bound independent of the `workflow` tool's
 * own core-derived concurrency (`min(16, cores - 2)`). Without this check the
 * `CHUNK` constant could silently regress to a core-derived value and exceed
 * the pool on hosts with more than 10 logical CPUs.
 *
 * Run: `bun test scripts/dsh-workflow-script-bounds.test.ts` (repo root).
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOC = join(import.meta.dir, "..", "skills", "mstar-host", "references", "dsh-workflow-scripts.md");

/** The ```js fenced blocks of the document, in document order. */
function jsBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```js\n([\s\S]*?)```/g)].map((match) => match[1]!);
}

const script = jsBlocks(readFileSync(DOC, "utf8")).find((block) => block.includes("CHUNK"));

describe("dsh-workflow-scripts chunk bound (host-core-count-independent)", () => {
  it("the fan-out script declares CHUNK = Math.min(8, categories.length)", () => {
    expect(script, "the §2 script block declaring CHUNK must exist in dsh-workflow-scripts.md").toBeDefined();
    // The pinned bound, exactly: the pool cap constant (8), never a
    // core-derived expression.
    expect(script).toMatch(/const CHUNK = Math\.min\(8, categories\.length\)/);
    expect(script).not.toMatch(/CHUNK\s*=[^;\n]*cores/);
  });

  it("the chunking actually slices the seats by CHUNK", () => {
    // A declared constant the loop no longer uses would be the same silent
    // regression: every batch is built from CHUNK-sized slices.
    expect(script).toMatch(/Math\.ceil\(categories\.length \/ CHUNK\)/);
    expect(script).toMatch(/categories\.slice\(index \* CHUNK/);
  });
});
