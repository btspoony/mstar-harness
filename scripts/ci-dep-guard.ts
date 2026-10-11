#!/usr/bin/env bun
/**
 * `@mstar-harness/opencode` and `@mstar-harness/opencode-v2` dep trees must
 * never contain `commander` or `inquirer` — including the scoped `@inquirer/*`
 * family (`@inquirer/prompts`, `@inquirer/core`, `@inquirer/type` — the roadmap
 * names exactly `commander` + `@inquirer/prompts` as the anti-pattern).
 * Reads either package's `npm ls --workspace <name> --omit=dev` output on
 * stdin and exits 1 when a forbidden package appears. `--omit=dev` prunes
 * the engine devDependency edge (`workspace:*` — npm ls cannot validate
 * workspace: edges against a bun-installed tree), leaving the runtime dep
 * tree the guard covers. The pattern is word-bounded and
 * tolerates the `@` scope prefix so:
 * - `└── @inquirer/prompts@8.4.2` MATCHES (scoped — the slice-3 guard missed
 *   these because the char before `inquirer` was `@`, never `^`/whitespace);
 * - `@commander-js/…`-style names do NOT false-positive (`@?` consumes the
 *   `@`, then `commander` must be followed by `@`/`/`/whitespace/EOL, and
 *   `-js` is none of those);
 * - `commanderjs` / `inquirer-core` style bare tokens do NOT false-positive.
 *
 * Single source of truth for the CI step: the workflow pipes npm ls output
 * here (`bun run ci:dep-guard -- <package-name>`), and the test file
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

function readStdin(): Promise<string> {
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

async function main(): Promise<void> {
  const packageName = process.argv[2] ?? "@mstar-harness/opencode";
  const hits = findForbiddenDeps(await readStdin());
  if (hits.length > 0) {
    console.error(`${packageName} dep tree must not contain commander or inquirer:`);
    for (const hit of hits) console.error(`  ${hit}`);
    process.exit(1);
  }
  console.log(`OK — ${packageName} dep tree has no commander/inquirer`);
}

if (import.meta.main) {
  await main();
}
