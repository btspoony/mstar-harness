/**
 * skill-callout-contract.ts — the literal shape of an engine-check callout,
 * plus the blockquote splitter every callout scan runs, shared by the guards
 * that police it: `drift-lint.ts` (Guard 1 forward citations, Guard 6 dedup)
 * and `standalone-smoke.ts` (contract-pointer survival). One literal and one
 * splitter, so a form change cannot leave a guard scanning for a marker no
 * file carries.
 *
 * Dependency-free on purpose: the standalone smoke job runs with no
 * `node_modules` (engine + CLI uninstalled), so it must not import
 * `drift-lint.ts` — that module loads the engine source and its spec
 * scripts, none of which resolve in that job.
 */

/** The one literal that makes a blockquote an engine-check callout. A form
 * change moves here once instead of leaving a renamed marker silently
 * unscanned (`0 callouts` still exits 0). */
export const ENGINE_CHECK_MARKER = "**Engine check:**";

/** The document section that owns availability, fallback and pointer form. */
export const ENGINE_CHECK_CONTRACT_DOC = "skills/mstar-use-cli/references/checks-and-lints.md";
export const ENGINE_CHECK_CONTRACT_HEADING = "## Engine check callouts";

/** The pointer every callout closes with. The callout carries no second copy
 * of the contract, so this sentence is the only wording that repeats. */
export const ENGINE_CHECK_CONTRACT_POINTER =
  "Contract → **`mstar-use-cli`** `references/checks-and-lints.md` § Engine check callouts.";

/** The clause that makes the contract's engine-absent fallback checkable. */
export const ENGINE_CHECK_FALLBACK_NEEDLE = "the owning skill's text stays authoritative";

/** One run of consecutive blockquote lines (`>` at the start of the trimmed
 * line). `end` is the last line index of the run, `text` those lines joined. */
export type BlockquoteRun = { start: number; end: number; text: string };

/**
 * Split lines into blockquote runs — the one splitter every callout scan
 * uses. A run closes at the first non-quote line; the loop runs one past the
 * last line so a run that ends at EOF is still emitted.
 */
export function blockquoteRuns(lines: string[]): BlockquoteRun[] {
  const runs: BlockquoteRun[] = [];
  let runStart = -1;
  for (let i = 0; i <= lines.length; i++) {
    const isQuote = i < lines.length && lines[i].trimStart().startsWith(">");
    if (isQuote && runStart === -1) runStart = i;
    if (!isQuote && runStart !== -1) {
      runs.push({ start: runStart, end: i - 1, text: lines.slice(runStart, i).join("\n") });
      runStart = -1;
    }
  }
  return runs;
}

export type CalloutContractScan = { callouts: number; failures: string[] };

/**
 * Callout checks over one skill file's text: the marker is a blockquote
 * (advisory callouts only) and every callout carries the shared-contract
 * pointer. Failure rows are `rel:line message`. A callout still states its
 * own command, engine export and fail sentence — this module checks the one
 * part that must not drift, not the site's semantics.
 */
export function scanCalloutContract(rel: string, text: string): CalloutContractScan {
  const lines = text.split(/\r?\n/);
  const failures: string[] = [];
  const runs = blockquoteRuns(lines);

  // A marker outside a run would make the callout a load-order instruction.
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(ENGINE_CHECK_MARKER)) continue;
    const inRun = runs.some((run) => i >= run.start && i <= run.end);
    if (!inRun) {
      failures.push(`${rel}:${i + 1} callout marker must be a blockquote (advisory callouts only)`);
    }
  }

  // One callout per run that carries the marker; the offset keeps the failure
  // on the marker's own line when a callout wraps.
  let callouts = 0;
  for (const run of runs) {
    const markerOffset = run.text.split("\n").findIndex((line) => line.includes(ENGINE_CHECK_MARKER));
    if (markerOffset === -1) continue;
    callouts++;
    if (!run.text.includes(ENGINE_CHECK_CONTRACT_POINTER)) {
      failures.push(
        `${rel}:${run.start + markerOffset + 1} callout lacks the shared-contract pointer ("${ENGINE_CHECK_CONTRACT_POINTER}")`,
      );
    }
  }

  return { callouts, failures };
}

/**
 * A corpus with no callouts means the marker or the scan broke, never that
 * the corpus is clean: a check that passes on zero hits is not a check.
 */
export function checkCalloutPresence(callouts: number): string[] {
  return callouts > 0
    ? []
    : [`found 0 Engine-check callouts — the marker or the scan is broken, not the corpus`];
}

/** The contract doc must own the section and state the engine-absent fallback. */
export function checkContractDoc(rel: string, text: string): string[] {
  const failures: string[] = [];
  if (!text.includes(ENGINE_CHECK_CONTRACT_HEADING)) {
    failures.push(`${rel} is missing the "${ENGINE_CHECK_CONTRACT_HEADING}" section`);
  }
  if (!text.includes(ENGINE_CHECK_FALLBACK_NEEDLE)) {
    failures.push(`${rel} does not state the engine-absent fallback ("${ENGINE_CHECK_FALLBACK_NEEDLE}")`);
  }
  return failures;
}
