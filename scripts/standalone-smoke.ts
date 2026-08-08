#!/usr/bin/env bun
/**
 * standalone-smoke.ts — roadmap §8.7 item 2 (guards risk R2: standalone
 * rule). Simulates a checkout with @mstar-harness/engine and
 * @mstar-harness/cli uninstalled: this script imports nothing from those
 * packages (pure text scan, no bun install required) and verifies every
 * skill loads without depending on the runtime:
 *
 *   1. Every `skills/<name>/SKILL.md` parses a frontmatter `name:` (it loads
 *      as a skill). Expected: the 19 harness skills (18 `mstar-*` + `pm`).
 *   2. No skill markdown references `@mstar-harness/engine` or
 *      `@mstar-harness/cli` outside an advisory `**Engine check (when
 *      available):**` blockquote. Fenced code blocks are allowed only when
 *      the block is labeled "Engine check" (advisory examples, e.g.
 *      mstar-plan-artifacts references).
 *   3. Every `**Engine check (when available):**` callout is a blockquote
 *      and carries the standalone guarantee ("Skill text below remains
 *      authoritative when the runtime is absent"), so the skill body still
 *      states its rule in prose.
 *
 * Usage: bun run scripts/standalone-smoke.ts
 * Exit 0 = standalone rule holds; exit 1 = violations found.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const failures: string[] = [];
const ENGINE_REF = /@mstar-harness\/(?:engine|cli)/;
const CALLOUT_MARKER = "**Engine check (when available):**";
const STANDALONE_GUARANTEE = "Skill text below remains authoritative when the runtime is absent";

/** The 19 harness skills that must load standalone (18 mstar-* + pm). */
const EXPECTED_SKILLS = [
  "mstar-audit",
  "mstar-branch-worktree",
  "mstar-coding-behavior",
  "mstar-compound",
  "mstar-compound-refresh",
  "mstar-design-md",
  "mstar-dispatch-gates",
  "mstar-harness-core",
  "mstar-host",
  "mstar-iteration",
  "mstar-phase-gates",
  "mstar-plan-artifacts",
  "mstar-plan-conventions",
  "mstar-review-qc",
  "mstar-roles",
  "mstar-sdd",
  "mstar-skill-authoring",
  "mstar-strategy",
  "pm",
];

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

/* 1. Every SKILL.md must load (frontmatter `name:`), expected set present. */
let loaded = 0;
const loadedNames: string[] = [];
for (const dir of skillDirs) {
  const skillFile = join(root, "skills", dir, "SKILL.md");
  let text: string;
  try {
    text = readFileSync(skillFile, "utf8");
  } catch {
    if (EXPECTED_SKILLS.includes(dir)) {
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
  loadedNames.push(name);
}
for (const expected of EXPECTED_SKILLS) {
  if (!loadedNames.includes(expected)) {
    failures.push(`expected harness skill "${expected}" did not load`);
  }
}

/* 2 + 3. Engine references must be advisory-only; callouts blockquoted. */
let callouts = 0;
let guaranteeMissing = 0;
for (const file of collectMarkdown("skills")) {
  const rel = relative(root, file);
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const fences = fencesOf(lines);

  // Blockquote runs: consecutive lines starting with `>`.
  const runs: Array<{ start: number; end: number; text: string; isCallout: boolean }> = [];
  let runStart = -1;
  for (let i = 0; i <= lines.length; i++) {
    const isQuote = i < lines.length && lines[i].trimStart().startsWith(">");
    if (isQuote && runStart === -1) runStart = i;
    if (!isQuote && runStart !== -1) {
      const runText = lines.slice(runStart, i).join("\n");
      runs.push({ start: runStart, end: i - 1, text: runText, isCallout: runText.includes(CALLOUT_MARKER) });
      runStart = -1;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hasRef = ENGINE_REF.test(line);
    const hasMarker = line.includes(CALLOUT_MARKER);

    if (hasMarker && !line.trimStart().startsWith(">")) {
      failures.push(`${rel}:${i + 1} callout marker must be a blockquote (advisory callouts only)`);
    }
    if (hasMarker) {
      const run = runs.find((r) => i >= r.start && i <= r.end);
      if (run) {
        callouts++;
        if (!run.text.includes(STANDALONE_GUARANTEE)) {
          guaranteeMissing++;
          failures.push(`${rel}:${i + 1} callout lacks the standalone guarantee ("${STANDALONE_GUARANTEE}")`);
        }
      }
    }

    if (!hasRef) continue;
    const fence = inFence(i, fences);
    if (fence) {
      if (!fence.text.includes("Engine")) {
        failures.push(`${rel}:${i + 1} engine reference inside a code block not labeled "Engine" (advisory examples only)`);
      }
      continue;
    }
    if (line.trimStart().startsWith(">")) {
      const run = runs.find((r) => i >= r.start && i <= r.end);
      if (run && run.isCallout) continue;
      failures.push(`${rel}:${i + 1} engine reference in a blockquote that is not an "Engine check" callout`);
      continue;
    }
    // The only allowed prose mention of the CLI package is its documented
    // install command (`npx @mstar-harness/cli init ...`) — an opt-in install
    // path, not a skill load-order dependency.
    if (line.includes("@mstar-harness/cli") && line.includes("npx @mstar-harness/cli")) continue;
    failures.push(`${rel}:${i + 1} engine reference in prose/load order — engine must be absent from skill load instructions`);
  }
}

if (failures.length > 0) {
  console.error(`standalone-smoke: ${failures.length} violation(s) found\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`\nloaded ${loaded} skill(s); ${callouts} Engine-check callouts (${guaranteeMissing} missing the standalone guarantee)`);
  process.exit(1);
}

console.log(`standalone-smoke: OK — ${loaded} skills load standalone (${EXPECTED_SKILLS.length} expected: ${loadedNames.join(", ")})`);
console.log(`standalone-smoke: OK — ${callouts} Engine-check callouts are advisory blockquotes with the standalone guarantee`);
console.log(`standalone-smoke: OK — no @mstar-harness/engine or @mstar-harness/cli reference in any skill load order (engine + cli uninstalled simulation)`);
