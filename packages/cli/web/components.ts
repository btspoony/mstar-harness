/**
 * Shared dashboard primitives (plan 20260918-dashboard D3).
 *
 * The read-envelope loader every view uses, plus the small presentational
 * pieces the Issues views compose. Nothing here reaches source JSON, the
 * filesystem or Markdown: every string is rendered as text by Preact, and the
 * API is the only data source (plan Global Constraints).
 */
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { html } from "htm/preact";

import { failureText } from "./format";

/** The engine read envelope (state-projection contract §6) the views consume. */
export type Envelope<T> = { data: T; storeRevision: number; catalogRevision: number };

export type LoadState<T> =
  | { status: "loading"; envelope: null; message: null }
  | { status: "ready"; envelope: Envelope<T>; message: null }
  | { status: "error"; envelope: null; message: string };

const LOADING = { status: "loading", envelope: null, message: null } as const;

/** The refusal a response body carries: `{error:{code,message}}` (plan D2). */
function failureOf(body: unknown, status: number): string {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof error?.code === "string" ? error.code : "internal-error";
  const message = typeof error?.message === "string" ? error.message : `The dashboard request failed with HTTP ${status}.`;
  return failureText(code, message);
}

/**
 * Load one API path into envelope state. `null` holds the loading state without
 * a request, which is how the optional empty-store probe avoids a request it
 * does not need. A superseded or aborted response never lands in state.
 */
export function useEnvelope<T>(path: string | null): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>(LOADING);
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    let current = true;
    setState(LOADING);
    void (async () => {
      try {
        const response = await fetch(path, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const body: unknown = await response.json().catch(() => null);
        if (!current) return;
        const envelope = (body as { data?: unknown } | null)?.data;
        setState(
          response.ok && envelope !== undefined && envelope !== null
            ? { status: "ready", envelope: body as Envelope<T>, message: null }
            : { status: "error", envelope: null, message: failureOf(body, response.status) },
        );
      } catch {
        if (!current) return;
        setState({
          status: "error",
          envelope: null,
          message: "The dashboard could not reach its local server. Check that the dashboard is running, then reload.",
        });
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, [path]);
  return state;
}

/** One label/value pair of a `<dl>` (identity facts, history facts). */
export function Field(props: { label: string; children: ComponentChildren }) {
  return html`<div class="fact">
    <dt class="fact-label">${props.label}</dt>
    <dd class="fact-value">${props.children}</dd>
  </div>`;
}

/** One detail section: heading-20 plus its content, flat (no nested cards). */
export function DetailSection(props: { title: string; children: ComponentChildren }) {
  return html`<section class="detail-section">
    <h2 class="heading-20">${props.title}</h2>
    ${props.children}
  </section>`;
}

/** A vocabulary value with a tone; the text is always the stored label. */
export function Badge(props: { tone: string; children: ComponentChildren }) {
  return html`<span class="badge" data-tone=${props.tone}>${props.children}</span>`;
}

/** A state block: error red, warning amber (DESIGN.md "Empty, stale and error states"). */
export function Notice(props: { tone: "error" | "warning"; children: ComponentChildren }) {
  return html`<div class="notice" data-tone=${props.tone}>${props.children}</div>`;
}

export function EmptyState(props: { children: ComponentChildren }) {
  return html`<div class="empty-state">${props.children}</div>`;
}

/**
 * The one polite live region per view: loaded results and source errors are
 * announced without moving focus (DESIGN.md "Controls, focus and accessibility").
 */
export function LiveRegion(props: { message: string }) {
  return html`<p class="visually-hidden" role="status" aria-live="polite">${props.message}</p>`;
}
