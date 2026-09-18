/**
 * Shared dashboard primitives (plan 20260918-dashboard D3; extended by D4).
 *
 * The read-envelope loader every view uses, the small presentational pieces the
 * views compose, and the authority/freshness vocabulary the projected
 * Workflows, Iterations and Roadmap views disclose. Nothing here reaches source
 * JSON, the filesystem or Markdown: every string is rendered as text by Preact,
 * and the API is the only data source (plan Global Constraints).
 */
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { html } from "htm/preact";
import type { CatalogIdentityDTO, CatalogLifecycle, DashboardBadge, ReadProjection, SourceDiagnostic } from "@mstar-harness/engine";

import { failureText } from "./format";

/**
 * The engine read envelope (state-projection contract §6) the views consume:
 * the view DTO, the revisions it was read at, and — for every view, projected
 * or not — the projection health block a projected view has to disclose.
 */
export type Envelope<T> = {
  data: T;
  storeRevision: number;
  catalogRevision: number;
  projection: ReadProjection;
};

export type LoadState<T> =
  | { status: "loading"; envelope: null; message: null }
  | { status: "ready"; envelope: Envelope<T>; message: null }
  | { status: "error"; envelope: null; message: string };

const LOADING = { status: "loading", envelope: null, message: null } as const;

/**
 * Longest a view waits for its own read before it says so. Loopback reads are
 * fast, so the deadline only fires for a wedged request — and with the server's
 * deliberate request serialization a single stuck read would otherwise leave
 * every view in "Loading…" with no error ever surfaced.
 */
export const ENVELOPE_DEADLINE_MS = 10_000;

const ENVELOPE_TIMEOUT_MESSAGE =
  `The dashboard did not answer within ${ENVELOPE_DEADLINE_MS / 1000} seconds. ` +
  "The local server may be stuck on an earlier read; reload to try again.";

/** The refusal a response body carries: `{error:{code,message}}` (plan D2). */
function failureOf(body: unknown, status: number): string {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof error?.code === "string" ? error.code : "internal-error";
  const message = typeof error?.message === "string" ? error.message : `The dashboard request failed with HTTP ${status}.`;
  return failureText(code, message);
}

/**
 * A read envelope carries `data` — which may be `null` for a detail whose row
 * cannot be read (no valid projection generation): the envelope's own
 * projection block is then the disclosure, and the view decides what that
 * means. Only a body with no envelope at all is a refusal.
 */
function isEnvelope(body: unknown): body is Envelope<unknown> {
  return typeof body === "object" && body !== null && Object.hasOwn(body, "data");
}

/**
 * Load one API path into envelope state. `null` holds the loading state without
 * a request, which is how the optional empty-store probe avoids a request it
 * does not need. A superseded, aborted or timed-out response never lands in
 * state.
 */
export function useEnvelope<T>(path: string | null): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>(LOADING);
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    let current = true;
    setState(LOADING);
    const deadline = setTimeout(() => {
      if (!current) return;
      current = false;
      controller.abort();
      setState({ status: "error", envelope: null, message: ENVELOPE_TIMEOUT_MESSAGE });
    }, ENVELOPE_DEADLINE_MS);
    void (async () => {
      try {
        const response = await fetch(path, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const body: unknown = await response.json().catch(() => null);
        if (!current) return;
        clearTimeout(deadline);
        setState(
          response.ok && isEnvelope(body)
            ? { status: "ready", envelope: body as Envelope<T>, message: null }
            : { status: "error", envelope: null, message: failureOf(body, response.status) },
        );
      } catch {
        if (!current) return;
        clearTimeout(deadline);
        setState({
          status: "error",
          envelope: null,
          message: "The dashboard could not reach its local server. Check that the dashboard is running, then reload.",
        });
      }
    })();
    return () => {
      current = false;
      clearTimeout(deadline);
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

// ---------------------------------------------------------------------------
// Projection freshness (state-projection contract §6, DESIGN.md states)
// ---------------------------------------------------------------------------

/**
 * True while the envelope carries no valid projection generation. That state is
 * never "no work": the refresh publishes `generation` and `freshness` together,
 * so this is the envelope's own `unavailable` disclosure, and it is what keeps
 * an unread source from rendering as an empty list (plan D4 STOP rule).
 */
export function projectionUnavailable(projection: ReadProjection): boolean {
  return projection.generation === null;
}

/**
 * What a projected view discloses about its own freshness: the named sources
 * and their reasons, the last successful build and the last check. `null` while
 * the published generation is current — then nothing is withheld.
 */
export type Disclosure = {
  freshness: "stale" | "unavailable";
  diagnostics: readonly SourceDiagnostic[];
  builtAt: string | null;
  checkedAt: string;
};

export function projectionDisclosure(projection: ReadProjection): Disclosure | null {
  if (projection.freshness === "current") return null;
  return {
    freshness: projection.freshness,
    diagnostics: projection.diagnostics,
    builtAt: projection.builtAt,
    checkedAt: projection.checkedAt,
  };
}

/**
 * The disclosure's own copy (DESIGN.md "Stale projection"): what the reader is
 * looking at, one named source + reason per recorded diagnostic, the last
 * successful build time and the check time. A state with no recorded diagnostic
 * says so instead of naming a source it does not have.
 */
export function disclosureLines(disclosure: Disclosure): string[] {
  const lines = [
    disclosure.freshness === "stale"
      ? "Execution data is stale: the last successful projection is retained and shown."
      : "Execution data is unavailable: no valid projection has been published yet.",
  ];
  if (disclosure.diagnostics.length === 0) {
    lines.push("No source diagnostic was recorded for this state.");
  } else {
    for (const diagnostic of disclosure.diagnostics) {
      lines.push(`Source ${diagnostic.sourceKey}: ${diagnostic.reason} — ${diagnostic.message}`);
    }
  }
  lines.push(
    disclosure.builtAt === null ? "Last successful build: none recorded." : `Last successful build: ${disclosure.builtAt}.`,
  );
  lines.push(disclosure.checkedAt === "" ? "Last checked: unknown." : `Last checked: ${disclosure.checkedAt}.`);
  return lines;
}

/** Amber for a retained stale generation, red for no generation at all. */
export function ProjectionNotice(props: { disclosure: Disclosure }) {
  const disclosure = props.disclosure;
  return html`<${Notice} tone=${disclosure.freshness === "stale" ? "warning" : "error"}>
    ${disclosureLines(disclosure).map(
      (line, index) => html`<p class="notice-line" key=${index}>${line}</p>`,
    )}
  </${Notice}>`;
}

// ---------------------------------------------------------------------------
// Authority vocabulary (state-projection contract §1/§6)
// ---------------------------------------------------------------------------

/**
 * The read boundary's explicit join disclosure: a missing catalog row, a
 * missing or conflicting prepared pin, or absent execution data is named here,
 * never silently resolved into a value the store did not give.
 */
const BADGE_LABELS: Record<DashboardBadge, string> = {
  "catalog-missing": "No catalog row",
  "catalog-pin-missing": "Prepared pin missing",
  "catalog-pin-conflict": "Prepared pin differs from the catalog revision",
  "execution-unavailable": "No execution data",
};

/** The disclosure vocabulary of one badge list, in the order the read boundary set it. */
export function dataBadgeText(badges: readonly DashboardBadge[]): string[] {
  return badges.map((badge) => BADGE_LABELS[badge]);
}

export function DataBadges(props: { badges: readonly DashboardBadge[] }) {
  if (props.badges.length === 0) return null;
  return html`<p class="badges">
    ${dataBadgeText(props.badges).map((label, index) => html`<${Badge} key=${index} tone="warning">${label}</${Badge}>`)}
  </p>`;
}

/** Archived/superseded stay visibly terminal; only `active` reads as current. */
export function catalogLifecycleTone(lifecycle: CatalogLifecycle): "neutral" | "terminal" {
  return lifecycle === "active" ? "neutral" : "terminal";
}

/**
 * One catalog row's authoritative identity: title, description, location and
 * catalog lifecycle. Nothing projected is rendered here — the execution
 * projection never supplies these fields (contract §1).
 */
export function CatalogFacts(props: { catalog: CatalogIdentityDTO }) {
  const catalog = props.catalog;
  return html`<dl class="facts">
    <${Field} label="Catalog title">${catalog.title}</${Field}>
    ${catalog.description === null
      ? null
      : html`<${Field} label="Catalog description"><span class="prose">${catalog.description}</span></${Field}>`}
    <${Field} label="Catalog location"
      ><span class="mono">${`${catalog.rootKind}:${catalog.relativePath}`}</span></${Field}
    >
    <${Field} label="Catalog lifecycle"
      ><${Badge} tone=${catalogLifecycleTone(catalog.lifecycle)}>${catalog.lifecycle}</${Badge}></${Field}
    >
    <${Field} label="Catalog revision"><span class="mono">${String(catalog.revision)}</span></${Field}>
    <${Field} label="Catalog updated"><span class="mono">${catalog.updatedAt}</span></${Field}>
  </dl>`;
}

/**
 * One prepared catalog pin (contract §1): the frozen catalog revision an
 * execution row was prepared from. `catalogRevision` is `null` when the catalog
 * row itself is missing, in which case no comparison is claimed.
 */
export type PinState =
  | { kind: "missing" }
  | { kind: "pinned"; revision: number }
  | { kind: "conflict"; pin: number; current: number };

export function pinState(pinRevision: number | null, catalogRevision: number | null): PinState {
  if (pinRevision === null) return { kind: "missing" };
  if (catalogRevision !== null && catalogRevision !== pinRevision) {
    return { kind: "conflict", pin: pinRevision, current: catalogRevision };
  }
  return { kind: "pinned", revision: pinRevision };
}

/** A missing pin is named as missing, never filled in from the catalog's current revision. */
export function pinText(state: PinState): string {
  switch (state.kind) {
    case "missing":
      return "Prepared pin missing: this execution row records no catalog revision, so no prepared input is confirmed.";
    case "conflict":
      return `Prepared pin conflict: prepared at catalog revision ${state.pin}, the catalog row is now revision ${state.current}.`;
    case "pinned":
      return `Prepared pin: this execution row was prepared at catalog revision ${state.revision}.`;
  }
}

/** An absent projected value is named, never shown as an empty cell or a zero. */
export function textOrAbsent(value: string | null): string {
  return value === null || value.trim() === "" ? "Not recorded" : value;
}

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

/** Fixed dashboard page size: the read boundary's own list default (contract §6). */
export const DASHBOARD_PAGE_SIZE = 50;

/** Previous/next over one page of a list, with the shown range named. */
export function Pager(props: { offset: number; count: number; total: number; onChange: (offset: number) => void }) {
  return html`<div class="pager">
    <button
      type="button"
      class="button-secondary"
      disabled=${props.offset === 0}
      onClick=${() => props.onChange(Math.max(0, props.offset - DASHBOARD_PAGE_SIZE))}
    >
      Previous
    </button>
    <p class="pager-summary">
      Showing ${props.count === 0 ? 0 : props.offset + 1}–${props.offset + props.count} of ${props.total}
    </p>
    <button
      type="button"
      class="button-secondary"
      disabled=${props.offset + props.count >= props.total}
      onClick=${() => props.onChange(props.offset + DASHBOARD_PAGE_SIZE)}
    >
      Next
    </button>
  </div>`;
}
