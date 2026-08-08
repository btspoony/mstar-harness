#!/usr/bin/env bun
/**
 * drift-lint.ts — roadmap §8.7 item 4 (guards risk R1): pointer callouts in
 * skills/ must reference real engine exports and real CLI subcommands, and
 * engine spec-citation comments must resolve to real skill files.
 *
 * Forward (skills → engine / CLI):
 *   - parse every `**Engine check (when available):**` callout in
 *     every markdown file under skills/ (blockquote runs)
 *   - every `import { X } from "@mstar-harness/engine"` name (in callouts or
 *     anywhere else in a skill file) must exist in
 *     packages/engine/src/index.ts exports (value and type exports)
 *   - every `mstar <verb>` / `mstar <verb> <sub>` command form in a callout
 *     must exist in the CLI command tree (packages/cli/src/index.ts
 *     `.command(...)` calls)
 * Reverse (engine → skills):
 *   - spec-citation comments in each packages/engine/src/<module>.ts header
 *     block (`mstar-*` SKILL.md / `references/<file>` citations) must resolve
 *     to an existing file under skills/
 *
 * Usage: bun run scripts/drift-lint.ts
 * Exit 0 = no drift; exit 1 = drift found (one line per violation).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const failures: string[] = [];
let calloutsChecked = 0;

function fail(message: string): void {
  failures.push(message);
}

/** Recursively collect files under `dir` matching `ext`. */
function collectFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(join(root, dir), { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(join(dir, entry.name), ext));
    } else if (entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

function exists(rel: string): boolean {
  try {
    return statSync(join(root, rel)).isFile();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Engine export inventory (packages/engine/src/index.ts)               */
/* ------------------------------------------------------------------ */

const engineIndex = readFileSync(join(root, "packages/engine/src/index.ts"), "utf8");
const engineExports = new Set<string>();
const exportRe = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
let m: RegExpExecArray | null;
while ((m = exportRe.exec(engineIndex))) {
  for (let name of m[1].split(",")) {
    name = name.trim().split(/\s+as\s+/)[0].trim();
    if (name) engineExports.add(name);
  }
}
if (engineExports.size === 0) {
  console.error("drift: could not parse any exports from packages/engine/src/index.ts");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* CLI command inventory (packages/cli/src/index.ts `.command(...)`)    */
/* ------------------------------------------------------------------ */

const cliSrc = readFileSync(join(root, "packages/cli/src/index.ts"), "utf8");
const cliCommands = new Set<string>();
const varPaths = new Map<string, string>();
const commandRe = /(?:const\s+(\w+)\s*=\s*program\s*|(\w+)\s*)\.command\(\s*"([a-z-]+)"\s*\)/g;
while ((m = commandRe.exec(cliSrc))) {
  const [, declared, receiver, name] = m;
  if (declared) {
    varPaths.set(declared, name);
    cliCommands.add(name);
  } else if (receiver === "program") {
    cliCommands.add(name);
  } else {
    const parent = varPaths.get(receiver);
    if (parent === undefined) {
      fail(`CLI parent of "${receiver}.command("${name}")" is not a known command var`);
      continue;
    }
    cliCommands.add(parent ? `${parent} ${name}` : name);
  }
}

/* ------------------------------------------------------------------ */
/* Forward: skill callouts → engine exports + CLI commands              */
/* ------------------------------------------------------------------ */

const skillFiles = collectFiles("skills", ".md");
for (const file of skillFiles) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const rel = relative(root, file);

  // Blockquote runs: consecutive lines starting with `>`.
  const runs: Array<{ start: number; end: number; text: string }> = [];
  let runStart = -1;
  for (let i = 0; i <= lines.length; i++) {
    const isQuote = i < lines.length && lines[i].trimStart().startsWith(">");
    if (isQuote && runStart === -1) runStart = i;
    if (!isQuote && runStart !== -1) {
      runs.push({ start: runStart, end: i - 1, text: lines.slice(runStart, i).join("\n") });
      runStart = -1;
    }
  }

  for (const run of runs) {
    if (!run.text.includes("**Engine check (when available):**")) continue;
    calloutsChecked++;

    for (const cm of run.text.matchAll(/mstar\s+([a-z-]+(?:\s+[a-z-]+)?)/g)) {
      const cmd = cm[1];
      if (!cliCommands.has(cmd)) {
        fail(`${rel}:${run.start + 1} callout references unknown CLI command "mstar ${cmd}" (known: ${[...cliCommands].sort().join(", ")})`);
      }
    }
    for (const im of run.text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@mstar-harness\/engine"/g)) {
      for (const raw of im[1].split(",")) {
        // Strip TS import modifiers so `import { type Foo }` / `import {
        // Foo as Bar }` resolve to the exported name `Foo`.
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (name && !engineExports.has(name)) {
          fail(`${rel}:${run.start + 1} callout imports unknown engine export "${name}"`);
        }
      }
    }
  }

  // Import statements anywhere in a skill file must reference real exports.
  for (const im of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@mstar-harness\/engine"/g)) {
    for (const raw of im[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name && !engineExports.has(name)) {
        fail(`${rel}: import of unknown engine export "${name}"`);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Reverse: engine module spec citations → skill files                  */
/* ------------------------------------------------------------------ */

/**
 * Non-skill spec sources the engine legitimately cites: generated artifact
 * types (`main.md`, `task-N-report.md`, …), root convention docs
 * (`STRATEGY.md`, `README.md`, …) and review-bundle files (`qcN.md`). These
 * are not skill files — existence is not expected under skills/.
 */
const ARTIFACT_SPEC_SOURCES = new Set([
  "main.md",
  "task-N-report.md",
  "STRATEGY.md",
  "delivery-compass.md",
  "README.md",
  "CONCEPTS.md",
  "DESIGN.md",
  "DESIGN.dark.md",
  "qc1.md",
  "qc2.md",
  "qc3.md",
  "qc-consolidated.md",
  "schema.yaml",
]);

/** True when the citation at `index` is prefixed by a `.harness/` path
 * (gitignored roadmap / ADR — not part of the skills tree). */
function citesHarnessPath(text: string, index: number): boolean {
  return text.slice(Math.max(0, index - 40), index).includes(".harness/");
}

const engineModules = collectFiles("packages/engine/src", ".ts").filter(
  (f) => !f.endsWith("/index.ts"),
);
const skillRefFiles = collectFiles("skills", ".md").map((f) => relative(root, f));
const yamlRefs = collectFiles("skills", ".yaml").map((f) => relative(root, f));
const allSkillFiles = new Set([...skillRefFiles, ...yamlRefs]);

for (const file of engineModules) {
  const rel = relative(root, file);
  const lines = readFileSync(file, "utf8").split(/\r?\n/);

  // Header block: contiguous comment lines at the top of the file.
  const header: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (header.length === 0 && (t === "" || t.startsWith("/*") || t.startsWith("//") || t.startsWith("*"))) {
      if (t !== "" || header.length > 0) header.push(line);
      if (t.startsWith("*/")) break;
    } else if (header.length > 0 && (t === "" || t.startsWith("*"))) {
      header.push(line);
      if (t.startsWith("*/")) break;
    } else if (header.length > 0) {
      break;
    } else {
      break;
    }
  }
  const headerText = header.join("\n");
  if (!/Spec|spec/.test(headerText)) continue;

  // Explicit skill paths: skills/<skill>/SKILL.md
  for (const sm of headerText.matchAll(/skills\/(mstar-[\w-]+)\/SKILL\.md/g)) {
    const p = `skills/${sm[1]}/SKILL.md`;
    if (!exists(p)) fail(`${rel}: spec citation "${p}" does not exist`);
  }
  // "<skill> SKILL.md" / "<skill> SKILL" token forms
  for (const sm of headerText.matchAll(/`?(mstar-[\w-]+)`?\s+SKILL(?:\.md)?/g)) {
    const p = `skills/${sm[1]}/SKILL.md`;
    if (!exists(p)) fail(`${rel}: spec citation "${p}" does not exist`);
  }
  // "<skill>/references/<file>" and "<skill> `references/<file>`" forms
  for (const sm of headerText.matchAll(/`?(mstar-[\w-]+)`?\s*(?:\/|\s+)`?references\/([\w.-]+)/g)) {
    const p = `skills/${sm[1]}/references/${sm[2]}`;
    if (!exists(p)) fail(`${rel}: spec citation "${p}" does not exist`);
  }
  // Bare "references/<file>" citations (no skill token): must exist under
  // some skill — unless they are `.harness/` roadmap citations.
  for (const rm of headerText.matchAll(/references\/([\w.-]+)/g)) {
    if (citesHarnessPath(headerText, rm.index)) continue;
    const candidates = [...allSkillFiles].filter((f) => f.endsWith(`/references/${rm[1]}`));
    if (candidates.length === 0) {
      fail(`${rel}: spec citation "references/${rm[1]}" does not exist under any skill`);
    }
  }
  // Bare "<file>.md"/"<file>.yaml" next to a spec marker ("spec:" / "§"):
  // must resolve under skills/, be a `.harness/` doc, or be a known
  // artifact-type spec source.
  for (const bm of headerText.matchAll(/(?<![-\w])([a-zA-Z0-9][\w-]*\.(?:md|yaml))/g)) {
    const name = bm[1];
    if (name === "SKILL.md") continue;
    const nearSpec = headerText.slice(Math.max(0, bm.index - 60), (bm.index ?? 0) + name.length + 60);
    if (!/spec|§/.test(nearSpec)) continue;
    if (citesHarnessPath(headerText, bm.index)) continue;
    if ([...allSkillFiles].some((f) => f.endsWith(`/${name}`))) continue;
    if (ARTIFACT_SPEC_SOURCES.has(name)) continue;
    fail(`${rel}: spec citation "${name}" does not exist under skills/ and is not a known artifact spec source`);
  }
}

/* ------------------------------------------------------------------ */

if (failures.length > 0) {
  console.error(`drift-lint: ${failures.length} violation(s) found\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`\nchecked ${calloutsChecked} Engine-check callouts against ${engineExports.size} engine exports and ${cliCommands.size} CLI commands`);
  process.exit(1);
}

console.log(
  `drift-lint: OK — ${calloutsChecked} Engine-check callouts reference real exports (${engineExports.size}) and CLI commands (${cliCommands.size}); engine spec citations resolve`,
);
