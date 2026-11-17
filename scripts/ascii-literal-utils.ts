/**
 * ASCII-literal tooling entry — the shared comment mask.
 *
 * The tokenizer lives in the engine (`packages/engine/src/comment-scan.ts`) so
 * the engine comment detectors and this tooling share ONE implementation and
 * one false-positive/false-negative profile. This module keeps the script-side
 * import path (`./ascii-literal-utils.ts`) that
 * `scripts/lint-ascii-literals.ts`, `scripts/escape-dist-literals.ts` and
 * `scripts/drift-lint.ts` use.
 */
export { commentMask } from "../packages/engine/src/comment-scan.ts";
