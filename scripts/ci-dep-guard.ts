#!/usr/bin/env bun
/**
 * ci-dep-guard.ts — roadmap §8.7 item 5 (qc2 F-004): the
 * `@mstar-harness/opencode` dep tree must never contain `commander` or
 * `inquirer` — including the scoped `@inquirer/*` family (`@inquirer/prompts`,
 * `@inquirer/core`, `@inquirer/type` — the roadmap names exactly
 * `commander` + `@inquirer/prompts` as the anti-pattern).
 *
 * Reads `npm ls --workspace @mstar-harness/opencode` output on stdin and
 * exits 1 when a forbidden package appears. The pattern is word-bounded and
 * tolerates the `@` scope prefix so:
 * - `└── @inquirer/prompts@8.4.2` MATCHES (scoped — the slice-3 guard missed
 *   these because the char before `inquirer` was `@`, never `^`/whitespace);
 * - `@commander-js/…`-style names do NOT false-positive (`@?` consumes the
 *   `@`, then `commander` must be followed by `@`/`/`/whitespace/EOL, and
 *   `-js` is none of those);
 * - `commanderjs` / `inquirer-core` style bare tokens do NOT false-positive.
 *
 * Single source of truth for the CI step: the workflow pipes the npm ls
 * output here (`bun run ci:dep-guard`), and `scripts/ci-dep-guard.test.ts`
 * guards the pattern semantics with positive + negative samples.
 */

const FORBIDDEN_DEP_RE = /(^|\s)@?(commander|inquirer)([@/\s]|$)/;

/** Lines of `npm ls` output that reference a forbidden package. */
export function findForbiddenDeps(tree: string): string[] {
  const matches: string[] = [];
  for (const line of tree.split(/\r?\n/)) {
    if (FORBIDDEN_DEP_RE.test(line)) matches.push(line.trim());
  }
  return matches;
}

async function readStdin(): Promise<string> {
  return new Promise<string>((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

/**
 * `--graph` mode: compute the RUNTIME dependency closure of
 * `@mstar-harness/opencode` directly from manifests + the installed tree
 * (node_modules), instead of `npm ls`. npm does not understand the
 * `workspace:*` protocol (declared for @mstar-harness/engine so bun always
 * resolves it locally), so npm ls is unusable for this gate. The walk:
 * - `workspace:*` specs resolve to the workspace member by scanning the
 *   package manifests under `packages/` (name fields);
 * - every other spec resolves to `node_modules/<name>` (hoisted root),
 *   recursing through `dependencies` only (runtime closure, devDeps excluded);
 * - forbidden-package semantics stay identical (FORBIDDEN_DEP_RE).
 */
async function graphClosure(entry = "packages/opencode/package.json"): Promise<string> {
  const { readdirSync } = await import("node:fs");
  const workspaceByName = new Map<string, string>();
  for (const dir of readdirSync("packages", { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const p = `packages/${dir.name}/package.json`;
    try {
      const manifest = JSON.parse((await Bun.file(p).text()) as string);
      if (typeof manifest.name === "string") workspaceByName.set(manifest.name, p);
    } catch {
      // not a package.json — skip
    }
  }
  const seen = new Set<string>();
  const names: string[] = [];
  const visit = async (manifestPath: string): Promise<void> => {
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as {
      name?: string;
      dependencies?: Record<string, string>;
    };
    if (manifest.name && seen.has(manifest.name)) return;
    if (manifest.name) seen.add(manifest.name);
    if (manifest.name) names.push(manifest.name);
    for (const [depName, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (spec === "workspace:*") {
        const member = workspaceByName.get(depName);
        if (!member) throw new Error(`workspace:* dep ${depName} not found in packages/*`);
        await visit(member);
        continue;
      }
      const installed = `node_modules/${depName}/package.json`;
      if (!(await Bun.file(installed).exists())) {
        throw new Error(`dep ${depName}@${spec} not installed (run bun install)`);
      }
      await visit(installed);
    }
  };
  await visit(entry);
  return names.map((n) => `├── ${n}`).join("\n");
}

async function main(): Promise<void> {
  const graphMode = process.argv.includes("--graph");
  const tree = graphMode ? await graphClosure() : await readStdin();
  const hits = findForbiddenDeps(tree);
  if (hits.length > 0) {
    console.error("@mstar-harness/opencode dep tree must not contain commander or inquirer (roadmap §8.7 item 5):");
    for (const hit of hits) console.error(`  ${hit}`);
    process.exit(1);
  }
  console.log("OK — opencode dep tree has no commander/inquirer");
}

if (import.meta.main) {
  await main();
}
