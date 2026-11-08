#!/usr/bin/env bun
/**
 * standalone-smoke.ts — roadmap §8.7 item 2 (guards risk R2: standalone
 * rule). Simulates a checkout with @mstar-harness/engine and
 * @mstar-harness/cli uninstalled: this script imports nothing from those
 * packages (pure text scan, no bun install required) and verifies every
 * skill loads without depending on the runtime:
 *
 *   1. Every `skills/<name>/SKILL.md` parses a frontmatter `name:` (it loads
 *      as a skill). Expected set is DERIVED from readdir in both directions
 *      (S-d): every `mstar-*` dir + `pm` must load — an unlisted new
 *      mstar-* skill fails loudly instead of becoming "optional"; optional
 *      bundled skills (e.g. `grill-me`) are load-checked too but reported
 *      separately from the harness set.
 *   2. No skill markdown references `@mstar-harness/engine` or
 *      `@mstar-harness/cli` outside an advisory `**Engine check:**`
 *      blockquote. Fenced code blocks are allowed only when the block is
 *      labeled "Engine check" (advisory examples, e.g. mstar-artifacts
 *      references).
 *   3. Every `**Engine check:**` callout is a blockquote that carries the
 *      shared-contract pointer, and the contract it points at states the
 *      engine-absent fallback — so the callout never becomes the only place
 *      the standalone rule is written. A corpus with zero callouts fails:
 *      the marker or the scan broke, and a check that passes on zero hits is
 *      not a check.
 *
 * Usage: bun run scripts/standalone-smoke.ts
 * Exit 0 = standalone rule holds; exit 1 = violations found.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ENGINE_CHECK_CONTRACT_DOC,
  ENGINE_CHECK_MARKER,
  blockquoteRuns,
  checkCalloutPresence,
  checkContractDoc,
  scanCalloutContract,
} from "./skill-callout-contract.ts";

const root = process.cwd();
const failures: string[] = [];
const ENGINE_REF = /@mstar-harness\/(?:engine|cli)/;

/**
 * Harness skills that must load standalone BEYOND the `mstar-*` corpus.
 * The expected set itself is DERIVED from readdir (S-d): every
 * `skills/mstar-*` dir is by definition a harness skill that must load, so
 * adding a new mstar-* skill without a loadable SKILL.md fails loudly
 * instead of silently becoming "optional". `pm` is the only non-mstar-*
 * harness skill.
 */
const EXTRA_EXPECTED = ["pm"];

/** Fenced code block ranges: [[startLine, endLine], …] plus block text. */
type Fence = { start: number; end: number; text: string };

function collectMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const full = join(root, dir, entry.name);
    if (entry.isDirectory()) out.push(...collectMarkdown(join(dir, entry.name)));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function fencesOf(lines: string[]): Fence[] {
  const fences: Fence[] = [];
  let open = -1;
  const buf: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith("```")) {
      if (open === -1) {
        open = i;
        buf.length = 0;
      } else {
        buf.push(lines[i]);
        fences.push({ start: open, end: i, text: buf.join("\n") });
        open = -1;
      }
      continue;
    }
    if (open !== -1) buf.push(lines[i]);
  }
  if (open !== -1) fences.push({ start: open, end: lines.length - 1, text: buf.join("\n") });
  return fences;
}

function inFence(line: number, fences: Fence[]): Fence | undefined {
  return fences.find((f) => line >= f.start && line <= f.end);
}

const skillDirs = readdirSync(join(root, "skills"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

/* 1. Every SKILL.md must load (frontmatter `name:`). The expected set is
 * derived from readdir in BOTH directions: every mstar-* dir (plus `pm`)
 * must load — a new mstar-* skill that is not loadable fails instead of
 * being silently classified optional; and every expected entry must have
 * actually loaded. */
let loaded = 0;
const harnessNames: string[] = [];
const optionalNames: string[] = [];
const expectedDirs = skillDirs.filter((dir) => dir.startsWith("mstar-") || EXTRA_EXPECTED.includes(dir));
for (const extra of EXTRA_EXPECTED) {
  if (!skillDirs.includes(extra)) {
    failures.push(`expected harness skill dir "${extra}" does not exist`);
  }
}
for (const dir of skillDirs) {
  const skillFile = join(root, "skills", dir, "SKILL.md");
  let text: string;
  try {
    text = readFileSync(skillFile, "utf8");
  } catch {
    if (expectedDirs.includes(dir)) {
      failures.push(`skills/${dir}/SKILL.md missing — expected harness skill does not load`);
    }
    continue;
  }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const name = fm?.[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  if (!name) {
    failures.push(`skills/${dir}/SKILL.md has no frontmatter "name:" — cannot load as a skill`);
    continue;
  }
  loaded++;
  if (expectedDirs.includes(dir)) harnessNames.push(name);
  else optionalNames.push(name);
}
for (const expected of expectedDirs) {
  if (!harnessNames.includes(expected)) {
    failures.push(`expected harness skill "${expected}" did not load`);
  }
}
const mstarSkillCount = expectedDirs.filter((dir) => dir.startsWith("mstar-")).length;


/* 2 + 3. Engine references must be advisory-only; callouts blockquoted and
 * carrying the shared-contract pointer. */
let callouts = 0;
for (const file of collectMarkdown("skills")) {
  const rel = relative(root, file);
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const fences = fencesOf(lines);

  const scan = scanCalloutContract(rel, text);
  callouts += scan.callouts;
  failures.push(...scan.failures);

  // Blockquote runs: consecutive lines starting with `>`.
  const runs = blockquoteRuns(lines);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!ENGINE_REF.test(line)) continue;
    const fence = inFence(i, fences);
    if (fence) {
      if (!fence.text.includes("Engine")) {
        failures.push(`${rel}:${i + 1} engine reference inside a code block not labeled "Engine" (advisory examples only)`);
      }
      continue;
    }
    if (line.trimStart().startsWith(">")) {
      const run = runs.find((r) => i >= r.start && i <= r.end);
      if (run && run.text.includes(ENGINE_CHECK_MARKER)) continue;
      failures.push(`${rel}:${i + 1} engine reference in a blockquote that is not an "Engine check" callout`);
      continue;
    }
    // The only allowed prose mentions of the CLI package are its documented
    // user-action commands — install (`npx @mstar-harness/cli init ...`) and
    // global update (`npm i -g @mstar-harness/cli@...`) — each an opt-in
    // user-action path, not a skill load-order dependency.
    if (
      line.includes("@mstar-harness/cli") &&
      (line.includes("npx @mstar-harness/cli") || line.includes("npm i -g @mstar-harness/cli"))
    )
      continue;
    failures.push(`${rel}:${i + 1} engine reference in prose/load order — engine must be absent from skill load instructions`);
  }
}

failures.push(...checkCalloutPresence(callouts));
try {
  failures.push(...checkContractDoc(ENGINE_CHECK_CONTRACT_DOC, readFileSync(join(root, ENGINE_CHECK_CONTRACT_DOC), "utf8")));
} catch (error) {
  failures.push(`${ENGINE_CHECK_CONTRACT_DOC} is unreadable (${(error as Error).message})`);
}

if (failures.length > 0) {
  console.error(`standalone-smoke: ${failures.length} violation(s) found\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`\nloaded ${loaded} skill(s); ${callouts} Engine-check callouts scanned`);
  process.exit(1);
}

console.log(
  `standalone-smoke: OK — ${harnessNames.length} harness skills load standalone (${mstarSkillCount} mstar-* + pm — ${harnessNames.join(", ")})` +
    (optionalNames.length > 0
      ? `; ${optionalNames.length} optional bundled skill${optionalNames.length === 1 ? "" : "s"} (${optionalNames.join(", ")})`
      : ""),
);
console.log(`standalone-smoke: OK — ${callouts} Engine-check callouts are advisory blockquotes that carry the shared-contract pointer`);
console.log(`standalone-smoke: OK — no @mstar-harness/engine or @mstar-harness/cli reference in any skill load order (engine + cli uninstalled simulation)`);
