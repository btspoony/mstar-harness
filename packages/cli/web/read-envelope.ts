/**
 * Reading the dashboard's JSON envelope.
 *
 * Every destination's read meets the same two questions — "is this body an
 * envelope?" and "what did the refusal say?" — and four copies of the answers had
 * accumulated, one per ported pair. One implementation, so a stricter check lands
 * in one place instead of five.
 */
import type { CollaborationScope, ReadEnvelope } from "@mstar-harness/engine";

/**
 * The envelope a JSON body is, or `null` when it is not one. The source
 * observations are normalized at this boundary: an absent `collaboration` /
 * `execution` member means "not disclosed", which is `null`, and a projection
 * without the `observed` flag was read (the pre-split transport always read it).
 */
export function asEnvelope<T>(body: unknown): ReadEnvelope<T> | null {
  if (body === null || typeof body !== "object") return null;
  const candidate = body as Partial<ReadEnvelope<T>> & { data?: unknown; projection?: unknown };
  if (candidate.data === undefined || candidate.projection === undefined) return null;
  const projection = candidate.projection as { generation?: unknown; freshness?: unknown; observed?: unknown };
  if (typeof projection.generation !== "number" && projection.generation !== null) return null;
  if (typeof projection.freshness !== "string") return null;
  const envelope = body as ReadEnvelope<T>;
  return {
    ...envelope,
    projection: { ...envelope.projection, observed: typeof projection.observed === "boolean" ? projection.observed : true },
    collaboration: candidate.collaboration ?? null,
    execution: candidate.execution ?? null,
  };
}

/** A refusal's message, or the generic one when the body carries none. */
export function refusalMessage(body: unknown, status: number): string {
  if (body !== null && typeof body === "object") {
    const error = (body as { error?: { message?: unknown } }).error;
    if (error !== undefined && typeof error.message === "string" && error.message !== "") return error.message;
  }
  return `The dashboard read was refused (HTTP ${status}).`;
}

/** The message for a read that never reached the server. */
export const UNREACHABLE =
  "The dashboard could not reach its local server. Check that the dashboard is running, then reload.";

/**
 * The named gap of an EXPLICITLY incomplete collaboration observation, or `null`
 * when the observation is complete or the envelope discloses none (a legacy
 * transport). `null` is "not disclosed", never "healthy".
 */
export function collaborationGap(
  envelope: ReadEnvelope<unknown>,
): { completeness: "partial" | "unavailable"; code: string } | null {
  const collaboration: ReadEnvelope<unknown>["collaboration"] | undefined = envelope.collaboration;
  if (collaboration === null || collaboration === undefined || collaboration.completeness === "complete") return null;
  return { completeness: collaboration.completeness, code: collaboration.code };
}

/**
 * A read whose rows require collaboration must fail closed on an explicit gap:
 * the transport established a complete observation or these rows are not
 * authoritative, so they are never presented as a successful list.
 */
export function requiredCollaborationRefusal(envelope: ReadEnvelope<unknown>): string | null {
  const gap = collaborationGap(envelope);
  return gap === null
    ? null
    : `The collaboration authority answered ${gap.completeness} (${gap.code}), so this read is not authoritative. Reload to read it again.`;
}

/** A list view's payload: rows in a page window, plus the store's unpaged count. */
type ListPayload = { items: unknown[]; total: number };

/** One settled list read, or `mixed`: the store moved while its pages were read. */
type ListRead<T> =
  | { status: "ready"; envelope: ReadEnvelope<T> }
  | { status: "error"; message: string }
  | { status: "mixed" };

/**
 * Read every page of a list view.
 *
 * The dashboard caps one page at 200 rows, while the list screens filter, search and
 * count in the browser — reading one page would present that page as the list and hide
 * every match past it. Pages are merged into the first envelope, so the projection and
 * the store's `total` stay those of the same read.
 *
 * Offsets only mean something inside one store state: a registration or capture between
 * two pages shifts every later window, so the concatenation would silently drop and
 * repeat rows while still claiming the first page's counts. A page from another
 * revision restarts the read once; a store that moved twice is refused rather than
 * presented as one list.
 */
export async function readAllListPages<T extends ListPayload>(
  fetchImpl: typeof fetch,
  path: (offset: number) => string,
  signal?: AbortSignal,
): Promise<{ status: "ready"; envelope: ReadEnvelope<T> } | { status: "error"; message: string }> {
  const first = await readAllListPagesOnce<T>(fetchImpl, path, signal);
  if (first.status !== "mixed") return first;
  const second = await readAllListPagesOnce<T>(fetchImpl, path, signal);
  if (second.status !== "mixed") return second;
  return {
    status: "error",
    message: "The store changed while its list was being read, so the pages are not one snapshot. Reload to read the list again.",
  };
}

/**
 * The engine's paged collaboration key ends with `:<limit>:<offset>` (contract
 * §Read/Completeness: the snapshot scope names the page). The LOGICAL scope is
 * that key without its page bounds — the filter set two pages of one list
 * share. A key that does not carry the page we asked for is left untouched.
 */
function logicalScope(scope: CollaborationScope, offset: number): CollaborationScope {
  const bounds = /:(\d+):(\d+)$/.exec(scope.key);
  if (bounds === null) return scope;
  const limit = Number(bounds[1]);
  const pageOffset = Number(bounds[2]);
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(pageOffset) || pageOffset !== offset) return scope;
  return { kind: scope.kind, key: scope.key.slice(0, bounds.index) };
}

/**
 * Every source fact that must agree for two pages to be one list: the
 * collaboration observation (authority identity/epoch, completeness, LOGICAL
 * scope, revision, catalog revision and gap code) and the execution observation
 * (identity/epoch/revision), beside the projection generation and its health.
 * Numeric counters alone cannot tell a restored or replaced authority apart, and
 * page bounds are deliberately excluded: they differ by construction across a
 * list's pages.
 */
function sourceStamp(envelope: ReadEnvelope<unknown>, offset: number): string {
  const { collaboration, execution, projection, storeRevision, catalogRevision } = envelope;
  return JSON.stringify({
    // The top-level counters stay part of the comparison: they are the
    // collaboration revisions the transport states, and a server that predates
    // the source observations still moves them.
    storeRevision,
    catalogRevision,
    collaboration:
      collaboration === null
        ? null
        : collaboration.completeness === "unavailable"
          ? { completeness: collaboration.completeness, scope: logicalScope(collaboration.scope, offset), code: collaboration.code }
          : {
              completeness: collaboration.completeness,
              scope: logicalScope(collaboration.scope, offset),
              authority: collaboration.authority,
              revision: collaboration.revision,
              catalogRevision: collaboration.catalogRevision,
              code: collaboration.completeness === "partial" ? collaboration.code : null,
            },
    execution:
      execution === null
        ? null
        : execution.asOf === null
          ? { asOf: null, code: execution.code }
          : { storeId: execution.storeId, epoch: execution.epoch, revision: execution.revision },
    // Health is part of the disclosure, not decoration: a page read while the
    // projection was still current must not be joined with one read after it
    // went stale, or the assembled list would state the first page's freshness.
    projection: { observed: projection.observed, generation: projection.generation, freshness: projection.freshness },
  });
}

/** The version members that make two pages the same source observations. */
function sameStoreState(a: ReadEnvelope<unknown>, b: ReadEnvelope<unknown>, aOffset: number, bOffset: number): boolean {
  return sourceStamp(a, aOffset) === sourceStamp(b, bOffset);
}

/**
 * The assembled list's own collaboration scope: the pages share one source
 * snapshot, but their row set is no longer any single page's filter set, so the
 * scope says so instead of claiming the first page's bounds.
 */
function assembledEnvelope<T extends ListPayload>(pages: ReadEnvelope<ListPayload>, rows: unknown[]): ReadEnvelope<T> {
  const collaboration = pages.collaboration;
  return {
    ...pages,
    data: { ...pages.data, items: rows } as T,
    collaboration:
      collaboration === null
        ? null
        : { ...collaboration, scope: { kind: collaboration.scope.kind, key: `assembled:${collaboration.scope.key}` } },
  };
}

/** A page read against a partial snapshot cannot be assembled as one list. */
function partialRefusal(envelope: ReadEnvelope<unknown>): string | null {
  const collaboration = envelope.collaboration;
  return collaboration !== null && collaboration.completeness === "partial"
    ? `A page of this list was read against a partial collaboration snapshot (${collaboration.code}). ` +
      "The list is not one authoritative snapshot; reload to read it again."
    : null;
}

/** One pass over the pages; `mixed` means the caller should start again. */
async function readAllListPagesOnce<T extends ListPayload>(
  fetchImpl: typeof fetch,
  path: (offset: number) => string,
  signal?: AbortSignal,
): Promise<ListRead<T>> {
  try {
    const rows: unknown[] = [];
    let first: ReadEnvelope<ListPayload> | null = null;
    let firstOffset = 0;
    let total = 0;
    for (let offset = 0; ; ) {
      const response = await fetchImpl(path(offset), {
        headers: { accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) return { status: "error", message: refusalMessage(body, response.status) };
      const envelope = asEnvelope<ListPayload>(body);
      if (envelope === null) {
        return { status: "error", message: "The list answered with something that is not a read envelope." };
      }
      const page = envelope.data;
      if (page === null || !Array.isArray(page.items)) {
        return { status: "error", message: "The list answered without its rows." };
      }
      const partial = partialRefusal(envelope);
      if (partial !== null) return { status: "error", message: partial };
      if (first === null) {
        first = envelope;
        firstOffset = offset;
      } else if (!sameStoreState(first, envelope, firstOffset, offset)) return { status: "mixed" };
      rows.push(...page.items);
      total = page.total;
      // A short (or empty) page is the end even when `total` disagrees; a page's offset
      // advances by what the server actually returned.
      if (page.items.length === 0 || rows.length >= total) break;
      offset += page.items.length;
    }
    if (first === null) return { status: "error", message: UNREACHABLE };
    return { status: "ready", envelope: assembledEnvelope<T>(first, rows) };
  } catch {
    return { status: "error", message: UNREACHABLE };
  }
}
