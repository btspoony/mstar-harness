/**
 * dsh Linear listing adapter (mirror-import plan Task 2): the read-only
 * `listIssues(cursor)` half of the engine's `IssueProvider`. One MCP `tools/call`
 * per page against the configured Linear entry; never a write call, never a
 * per-issue poll, never a credential in output.
 *
 * The tool name, argument schema and payload shape were recorded from the live
 * service with an authenticated `tools/list` + `tools/call` (serverInfo
 * `linear` 1.0.2, 38 tools) — the tool-surface note kept with the iteration
 * artifacts records the method and what a re-run should reproduce. The listing
 * verb is `list_issues`; its envelope is:
 *
 *   { issues: LinearItem[], hasNextPage?: boolean, cursor?: string | null, errors?: [{ message }] }
 *
 * and treats anything else as a page FAILURE rather than an empty page — an
 * unmappable payload must never look like "this project has no issues".
 * An embedded `errors` array is likewise a page failure (contract §5).
 */
import { SyncError } from "../issue-sync.js";
import type { ProviderItem, ProviderItemFailure, ProviderPage } from "./provider.js";
import { listingVerbIn, redactTransportMessage } from "./linear-probe.js";

/** A configured Linear MCP entry, as the host configuration names it. */
export type LinearAdapterEntry = { url: string };

/** The outcome of one injected `tools/call`. */
export type LinearCallOutcome =
  | { kind: "ok"; payload: unknown }
  | { kind: "transport-error"; message: string }
  | { kind: "http-status"; status: number };

/** Host-owned capabilities injected at the MCP boundary (fixtures in tests). */
export type LinearListDeps = {
  /** Find the configured Linear MCP entry, or `null` when none exists. */
  findLinearEntry(): LinearAdapterEntry | null;
  /** Perform one read-only `tools/call` against the entry. */
  call(entry: LinearAdapterEntry, request: { tool: string; arguments: Record<string, unknown> }): Promise<LinearCallOutcome>;
  /**
   * Candidate listing verbs, in preference order. Still the P2 probe's candidate
   * set: the authenticated inventory has not been recorded yet.
   */
  listingVerbs: readonly string[];
  /**
   * The binding the page is requested FOR. Without it the request asks the
   * service for "everything this credential can see", so a credential that
   * reaches several projects would file another project's issues under the one
   * local project.
   *
   * Both argument names are recorded from the service's own schema (`team`:
   * "Team name or ID"; `project`: "Project name, ID, identifier, or slug") —
   * see the tool-surface note kept with the iteration artifacts for the method
   * and what was captured. The schema proves the names; it does NOT prove the
   * server honours them for every credential, which is why the page is still
   * checked per item below: a filter that silently stops applying looks exactly
   * like a filter with nothing to exclude.
   */
  scope?: { team?: string; project?: string };
  /**
   * The tools the host's own `tools/list` returned (the handshake the probe
   * already ran), or `null` when no handshake has happened. The adapter resolves
   * its verb through the SAME `listingVerbIn` rule the probe uses (QC F9), so
   * readiness and use can never disagree on which verb is called.
   */
  listedVerbs(): readonly string[] | null;
};

/** Contract §5: 50 per page, so a run is a predictable number of requests. */
export const LINEAR_PAGE_SIZE = 50;

/**
 * Fields the mapper reads, requested explicitly. `team`/`teamId` and
 * `project`/`projectId` are in the list because the scope guard compares them;
 * requesting a subset would leave the guard unable to prove anything.
 */
export const LINEAR_ITEM_FIELDS: readonly string[] = [
  "id",
  "title",
  "description",
  "priority",
  "url",
  "createdAt",
  "updatedAt",
  "status",
  "statusType",
  "labels",
  "team",
  "teamId",
  "project",
  "projectId",
];

export type LinearListSide = {
  listIssues(cursor: string | null): Promise<ProviderPage>;
};

/** Create the listing side of the dsh Linear provider. */
export function createLinearAdapter(deps: LinearListDeps): LinearListSide {
  return {
    async listIssues(cursor: string | null): Promise<ProviderPage> {
      const listed = deps.listedVerbs();
      const tool = listingVerbIn(listed ?? undefined, deps.listingVerbs);
      if (tool === null) {
        throw new SyncError(
          "linear.list-unimplemented",
          listed === null
            ? `this host has not completed the Linear handshake, so the listing verb is unknown (candidates: ${deps.listingVerbs.join(", ")})`
            : `the Linear handshake listed none of ${deps.listingVerbs.join(", ")}, so no page can be requested`,
        );
      }
      const entry = deps.findLinearEntry();
      if (entry === null) {
        throw new SyncError("linear.query-failed", "no Linear MCP entry is configured for this host; nothing was listed");
      }
      const scope = deps.scope ?? {};
      const outcome = await deps.call(entry, {
        tool,
        arguments: {
          limit: LINEAR_PAGE_SIZE,
          // Ownership fields are requested EXPLICITLY: the per-item guard below
          // can only check what the page actually carries, and the default
          // projection is free to drop them.
          fields: [...LINEAR_ITEM_FIELDS],
          ...(scope.team === undefined ? {} : { team: scope.team }),
          ...(scope.project === undefined ? {} : { project: scope.project }),
          ...(cursor === null ? {} : { cursor }),
        },
      });
      if (outcome.kind === "transport-error") {
        throw new SyncError(
          "linear.query-failed",
          `the Linear MCP call failed (${redactTransportMessage(outcome.message)}); the page was not ingested and the cursor did not advance`,
        );
      }
      if (outcome.kind === "http-status") {
        throw new SyncError(
          "linear.query-failed",
          `the Linear MCP call answered HTTP ${outcome.status}; the page was not ingested and the cursor did not advance`,
        );
      }
      return mapPage(outcome.payload, deps.scope);
    },
  };
}

type Payload = Record<string, unknown>;

function isRecord(value: unknown): value is Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An embedded GraphQL/proxy `errors` array is a failure, even next to partial
 * `data`: a half page that looks full would silently skip issues (contract §5).
 */
function assertNoEmbeddedErrors(payload: Payload): void {
  const errors = payload.errors;
  if (errors === undefined || errors === null) return;
  if (!Array.isArray(errors)) {
    throw new SyncError("linear.query-failed", "the Linear MCP page carried a non-array `errors` field; nothing was ingested");
  }
  if (errors.length === 0) return;
  const first = errors[0];
  const message = isRecord(first) && typeof first.message === "string" ? first.message : String(first);
  throw new SyncError(
    "linear.query-failed",
    `the Linear MCP page reported errors (${redactTransportMessage(message)}); nothing from that page was ingested`,
  );
}

/**
 * Map the documented fixture envelope. A page whose ENVELOPE is unusable (not an
 * object, no `issues` array, embedded `errors`) is still a page failure: nothing
 * on it can be trusted. A single ITEM that cannot be mapped fails that item by
 * identity and lets the rest of the page proceed (contract §2), so one poison
 * item cannot block every later page forever.
 */
export function mapPage(payload: unknown, scope?: { team?: string; project?: string }): ProviderPage {
  if (!isRecord(payload)) {
    throw new SyncError("linear.query-failed", "the Linear MCP page was not an object; nothing was ingested");
  }
  assertNoEmbeddedErrors(payload);
  const items = payload.issues;
  if (!Array.isArray(items)) {
    throw new SyncError(
      "linear.query-failed",
      "the Linear MCP page carries no `issues` array; an unmappable page is a failure, never an empty project",
    );
  }
  // Cross-scope guard. The listing filters server-side, but a filter that did
  // not take effect looks exactly like a filter that had nothing to exclude —
  // and the page itself carries each item's own team, so the claim is checkable.
  // A mismatched item is refused as a PAGE failure rather than dropped: silently
  // skipping it would import a partial mirror that looks complete.
  const ownership = (entry: unknown, key: "team" | "project"): string | null => {
    if (!isRecord(entry)) return null;
    const raw = entry[key];
    if (typeof raw === "string") return raw;
    // Either dimension may arrive as `{ name }`; an unreadable value is null so
    // the caller can tell "absent" from "different".
    if (isRecord(raw) && typeof raw.name === "string") return raw.name;
    const id = entry[`${key}Id`];
    return typeof id === "string" ? id : null;
  };
  for (const key of ["team", "project"] as const) {
    const expected = scope?.[key];
    if (expected === undefined) continue;
    const foreign = items.find((entry) => {
      const seen = ownership(entry, key);
      if (seen === null) return false; // absent is not "different"
      if (seen === expected) return false;
      // A binding may scope by ID while the item names the entity: the pair
      // (name, id) identifies one thing, so either side matching is a match.
      const id = isRecord(entry) ? entry[`${key}Id`] : undefined;
      return typeof id === "string" ? id !== expected : true;
    });
    if (foreign !== undefined) {
      throw new SyncError(
        "linear.query-failed",
        `the page carries an issue whose ${key} is ${JSON.stringify(ownership(foreign, key))} although the binding scopes it to ` +
          `${JSON.stringify(expected)}; the server-side filter did not take effect, so nothing was ingested`,
      );
    }
  }

  const mapped: ProviderItem[] = [];
  const failures: ProviderItemFailure[] = [];
  items.forEach((entry, index) => {
    try {
      mapped.push(mapItem(entry, index));
    } catch (error) {
      if (!(error instanceof SyncError)) throw error;
      failures.push({ index, externalId: externalIdOf(entry), cause: stripCodeLabel(error.message) });
    }
  });
  return { items: mapped, nextCursor: nextCursorOf(payload), failures };
}

/** The item's identity when the payload names one, for the failure report. */
function externalIdOf(entry: unknown): string | null {
  if (!isRecord(entry)) return null;
  for (const key of ["identifier", "id"]) {
    const value = entry[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

function stripCodeLabel(message: string): string {
  return message.replace(/^\[[^\]]+\]\s*/, "");
}

/**
 * The REAL envelope (verified against the service): `{ issues, hasNextPage,
 * cursor }`. A page continues only when `hasNextPage` is true AND a non-blank
 * cursor came with it — an empty cursor with `hasNextPage: true` is a broken
 * page, not an invitation to loop on page one.
 */
function nextCursorOf(payload: Payload): string | null {
  const more = payload.hasNextPage;
  if (more !== true) {
    if (payload.cursor !== undefined && payload.cursor !== null && typeof payload.cursor !== "string") {
      throw new SyncError("linear.query-failed", "the Linear MCP page carried a non-string `cursor`; nothing was ingested");
    }
    return null;
  }
  const cursor = payload.cursor;
  if (typeof cursor !== "string" || cursor.trim() === "") {
    throw new SyncError(
      "linear.query-failed",
      "the Linear MCP page said hasNextPage but carried no usable `cursor`; the run stopped rather than re-reading page one",
    );
  }
  return cursor;
}

/** A missing required field is a page failure: no field is invented. */
function required(item: Payload, field: string, index: number): string {
  const value = item[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new SyncError(
      "linear.query-failed",
      `issue at page index ${index} has no usable "${field}"; the page was refused rather than ingested with a guessed value`,
    );
  }
  return value;
}

/**
 * `priority` is nullable (Linear allows an unset priority; the local severity
 * enum does not) — the mapper keeps the label when the payload carries one and
 * falls back to the numeric priority, nothing else.
 */
function priorityOf(item: Payload): string | null {
  const label = item.priorityLabel;
  if (typeof label === "string" && label.trim() !== "") return label.trim();
  const value = item.priority;
  // Verified shape: `{ value: 0, name: "No priority" }`. The NAME is the
  // readable label and the number is the ordering key; whichever arrives, the
  // mapper keeps a string and invents nothing.
  if (isRecord(value)) {
    if (typeof value.name === "string" && value.name.trim() !== "") return value.name.trim();
    if (typeof value.value === "number") return String(value.value);
    if (typeof value.value === "string" && value.value.trim() !== "") return value.value.trim();
    return null;
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return null;
}

function labelsOf(item: Payload): string[] {
  const labels = item.labels;
  if (labels === undefined || labels === null) return [];
  if (!Array.isArray(labels)) {
    throw new SyncError("linear.query-failed", "an issue carried a non-array `labels` field; the page was refused");
  }
  return labels.map((label) => {
    if (typeof label === "string") return label;
    if (isRecord(label) && typeof label.name === "string") return label.name;
    throw new SyncError("linear.query-failed", "an issue carried an unusable label entry; the page was refused");
  });
}

function stateOf(item: Payload): string {
  const state = item.state;
  if (isRecord(state) && typeof state.name === "string") return state.name;
  if (typeof state === "string") return state;
  // Linear's MCP listing may name this `status`; both spellings are read, and an
  // absent state is an empty string rather than an invented one.
  const status = item.status;
  if (isRecord(status) && typeof status.name === "string") return status.name;
  if (typeof status === "string") return status;
  return "";
}

function mapItem(entry: unknown, index: number): ProviderItem {
  if (!isRecord(entry)) {
    throw new SyncError("linear.query-failed", `issue at page index ${index} is not an object; the page was refused`);
  }
  // Linear lists the human key as `identifier` and the API id as `id`; the
  // identifier is stable across runs and is what the ledger keys on.
  const identifier =
    typeof entry.identifier === "string" && entry.identifier.trim() !== "" ? entry.identifier : required(entry, "id", index);
  return {
    externalId: identifier,
    title: required(entry, "title", index),
    description: typeof entry.description === "string" ? entry.description : "",
    state: stateOf(entry),
    priority: priorityOf(entry),
    labels: labelsOf(entry),
    updatedAt: required(entry, "updatedAt", index),
    url: required(entry, "url", index),
  };
}
