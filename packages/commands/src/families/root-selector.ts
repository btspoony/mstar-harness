import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { readMainWorktree, resolveProcessHarnessDir } from "@mstar-harness/engine";
import type { InvocationContext } from "../types.js";

/** why: A per-call root follows the MCP selector contract: a blank value is
 * absent (the invocation root applies), a relative value resolves against the
 * invocation cwd, and a value inside a linked checkout is refused — accepting
 * it would write process state the fixed-root resolver never reads. A non-Git
 * launch keeps the documented explicit-root behavior.
 */
export function callHarness(harness: string | undefined, context: InvocationContext): string | null {
  const value = harness?.trim();
  if (value === undefined || value === "") return context.controlRoot;
  const candidate = resolveProcessHarnessDir(context.cwd, value);
  if (candidate === null) return context.controlRoot;
  let parentReal: string;
  try {
    parentReal = realpathSync(dirname(candidate));
  } catch {
    return candidate;
  }
  const main = readMainWorktree(dirname(candidate));
  if (main !== null && main.root !== parentReal) {
    throw new Error(`harness.root-not-main: ${candidate} is not the Git main worktree's .mstar; run \`mstar path resolve\` and pass its controlHarnessDir.`);
  }
  return candidate;
}
