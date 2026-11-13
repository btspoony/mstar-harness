/**
 * agent-shell-permission.test.ts — Guard: the three QC seat shells carry one
 * identical `permission` block, and `code-reviewer` (the read-only superset)
 * still carries every key path of that block with the same value. The shells
 * are hand-written, so an edit to one seat's allowlist now fails here instead
 * of silently leaving a peer seat with different authority.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseDocument } from "yaml";

const ROOT = join(import.meta.dir, "..");
const QC_SHELLS = ["agents/qc-specialist.md", "agents/qc-specialist-2.md", "agents/qc-specialist-3.md"] as const;
const SUPERSET_SHELL = "agents/code-reviewer.md";

/** Parsed YAML frontmatter of one agent shell; a shell without a closed block throws. */
function readAgentFrontmatter(root: string, file: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(root, file), "utf8"));
  if (match === null) throw new Error(`${file}: no closed YAML frontmatter block`);
  const parsed: unknown = parseDocument(match[1]!).toJS();
  if (parsed === null || typeof parsed !== "object") throw new Error(`${file}: frontmatter is not a mapping`);
  return parsed as Record<string, unknown>;
}

/** Flatten one permission tree to `dotted.key -> value` leaves for per-key-path comparison. */
function flattenPermission(value: unknown, prefix = ""): Map<string, unknown> {
  const leaves = new Map<string, unknown>();
  for (const [key, child] of Object.entries((value ?? {}) as Record<string, unknown>)) {
    const path = `${prefix}${key}`;
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      for (const [nested, leaf] of flattenPermission(child, `${path}.`)) leaves.set(nested, leaf);
    } else leaves.set(path, child);
  }
  return leaves;
}

function permissionOf(root: string, file: string): Record<string, unknown> {
  const permission = readAgentFrontmatter(root, file).permission;
  if (permission === null || typeof permission !== "object") throw new Error(`${file}: no permission block`);
  return permission as Record<string, unknown>;
}

describe("QC seat shell permission parity", () => {
  test("the three QC shells declare one identical permission block", () => {
    const [first, ...rest] = QC_SHELLS.map((file) => permissionOf(ROOT, file));
    for (const permission of rest) expect(permission).toEqual(first);
  });

  test("every QC permission key path is present in code-reviewer with the same value", () => {
    const qc = flattenPermission(permissionOf(ROOT, QC_SHELLS[0]));
    const superset = flattenPermission(permissionOf(ROOT, SUPERSET_SHELL));
    const missing = [...qc].filter(([path, value]) => !superset.has(path) || superset.get(path) !== value).map(([path]) => path);
    expect(missing).toEqual([]);
  });
});
