/**
 * Reading the dashboard's JSON envelope.
 *
 * Every destination's read meets the same two questions — "is this body an
 * envelope?" and "what did the refusal say?" — and four copies of the answers had
 * accumulated, one per ported pair. One implementation, so a stricter check lands
 * in one place instead of five.
 */
import type { ReadEnvelope } from "@mstar-harness/engine";

/** The envelope a JSON body is, or `null` when it is not one. */
export function asEnvelope<T>(body: unknown): ReadEnvelope<T> | null {
  if (body === null || typeof body !== "object") return null;
  const candidate = body as { data?: unknown; projection?: unknown };
  if (candidate.data === undefined || candidate.projection === undefined) return null;
  const projection = candidate.projection as { generation?: unknown; freshness?: unknown };
  if (typeof projection.generation !== "number" && projection.generation !== null) return null;
  if (typeof projection.freshness !== "string") return null;
  return body as ReadEnvelope<T>;
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

/** The version members that make two pages the same store state. */
function sameStoreState(a: ReadEnvelope<unknown>, b: ReadEnvelope<unknown>): boolean {
  return (
    a.storeRevision === b.storeRevision &&
    a.catalogRevision === b.catalogRevision &&
    a.projection.generation === b.projection.generation
  );
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
      if (first === null) first = envelope;
      else if (!sameStoreState(first, envelope)) return { status: "mixed" };
      rows.push(...page.items);
      total = page.total;
      // A short (or empty) page is the end even when `total` disagrees; a page's offset
      // advances by what the server actually returned.
      if (page.items.length === 0 || rows.length >= total) break;
      offset += page.items.length;
    }
    if (first === null) return { status: "error", message: UNREACHABLE };
    return { status: "ready", envelope: { ...first, data: { ...first.data, items: rows } as T } };
  } catch {
    return { status: "error", message: UNREACHABLE };
  }
}
