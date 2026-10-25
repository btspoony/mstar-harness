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
