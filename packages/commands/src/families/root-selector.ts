import { resolveProcessHarnessDir } from "@mstar-harness/engine";
import type { InvocationContext } from "../types.js";

/**
 * why: A per-call root follows the same seam as the MCP selector — a blank value
 * is absent (the connection/invocation root applies) and a relative value is
 * resolved against the invocation cwd, never handed to `createFsStore` raw
 * (where `""` becomes `process.cwd()` and `.mstar` stays cwd-relative).
 */
export function callHarness(harness: string | undefined, context: InvocationContext): string | null {
  const value = harness?.trim();
  if (value === undefined || value === "") return context.controlRoot;
  return resolveProcessHarnessDir(context.cwd, value);
}
