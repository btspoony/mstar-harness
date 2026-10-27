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

/**
 * Read every page of a list view.
 *
 * The dashboard caps one page at 200 rows, while the list screens filter, search and
 * count in the browser — reading one page would present that page as the list and hide
 * every match past it. Pages are merged into the first envelope, so the projection and
 * the store's `total` stay those of the same read.
 */
export async function readAllListPages<T extends ListPayload>(
  fetchImpl: typeof fetch,
  path: (offset: number) => string,
  signal?: AbortSignal,
): Promise<{ status: "ready"; envelope: ReadEnvelope<T> } | { status: "error"; message: string }> {
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
