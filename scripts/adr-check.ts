/**
 * adr-check.ts — the repository's ADR gate: a thin adapter over the engine's
 * `lintAdrTree`, so the product command (`mstar lint <dir> --type adr`) and
 * this CI guard can never drift into two implementations.
 *
 * Contract: `mstar-doc-corpus/references/adr.md` (skill-relative; the text this
 * repository applies). This repository's instance of it — the tree and the
 * gate — is `docs/adr/README.md`. Scope: one walk of `docs/adr/`. This module
 * owns exactly two things the engine does not: where the tree sits in this
 * repository (`docs/adr`) and the `adr.*` failure-code prefix Guard 12 has
 * always printed.
 */
import { join } from "node:path";
import {
  ADR_BUCKETS as ENGINE_ADR_BUCKETS,
  ADR_CLASSES as ENGINE_ADR_CLASSES,
  lintAdrTree,
  type AdrBucket,
} from "../packages/engine/src/index.ts";

export const ADR_BUCKETS = ENGINE_ADR_BUCKETS;
export const ADR_CLASSES = ENGINE_ADR_CLASSES;

export type { AdrBucket };

export type AdrFailureCode =
  | "adr.bucket-unknown"
  | "adr.class-unknown"
  | "adr.status-mismatch"
  | "adr.archive-line-missing"
  | "adr.section-missing"
  | "adr.section-banned"
  | "adr.index-forbidden"
  | "adr.name-shape"
  | "adr.fence-unclosed";

export type AdrFailure = {
  /** Repo-relative path, e.g. `docs/adr/implemented/...`. */
  file: string;
  code: AdrFailureCode;
  message: string;
  recovery: string;
};

export type AdrCheckResult = { records: number; failures: AdrFailure[] };

/** This repository's ADR tree, relative to its root (`docs/adr/README.md`). */
const ADR_ROOT = "docs/adr";

export function checkAdrTree(repoRoot: string): AdrCheckResult {
  const tree = lintAdrTree(join(repoRoot, ADR_ROOT));
  return {
    records: tree.records,
    failures: tree.failures.map((failure) => ({
      file: `${ADR_ROOT}/${failure.file}`,
      // `lint.adr.<code>` (the engine's namespace) → `adr.<code>` (Guard 12's).
      code: failure.code.replace(/^lint\.adr\./, "adr.") as AdrFailureCode,
      message: `${ADR_ROOT}/${failure.message}`,
      recovery: failure.recovery,
    })),
  };
}

/** Guard 12 footer fragment: `Guard 12 ADR format N records, M failures`. */
export function summarizeAdrCheck(result: AdrCheckResult): string {
  return `Guard 12 ADR format ${result.records} records, ${result.failures.length} failures`;
}
