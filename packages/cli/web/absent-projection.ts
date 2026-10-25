/**
 * The projection a record read carries when the record is not there at all.
 *
 * A `404` answers no envelope, but the shared screens' `read` props need one. The
 * screens' resolver reads the payload first — `null` is the `absent` arm — and only
 * consults the projection to distinguish `unavailable`, so this value only has to
 * be a *published* generation (not `null`, which would mean "the projection could
 * not be read"). It is not a claim about freshness: "this record does not exist"
 * is not a statement about the store.
 *
 * One constant, shared by every detail pair, so a second shape cannot appear and
 * disagree about what a missing record means.
 */
import type { ReadProjection } from "@mstar-harness/engine";
export const ABSENT_PROJECTION = {
  generation: 1,
  freshness: "current" as const,
  builtAt: null,
  checkedAt: "",
  diagnostics: [] as ReadProjection["diagnostics"],
} satisfies ReadProjection;
