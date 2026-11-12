/**
 * linear-write.ts — the write side of the Linear MCP provider (M1 one-way push).
 *
 * VERB: resolved from the host's own `tools/list` handshake over an injectable
 * candidate set, exactly as the listing side resolves its own. An absent
 * candidate refuses by name — never a silent skip of required behavior.
 *
 * EVIDENCE SPLIT, in full:
 * - REQUEST argument names are real: they come from the advertised `save_issue`
 *   input schema observed in the 2026-11-02 session (create needs `team` +
 *   `title`; `description`, `priority`, `state`, `labels`, `addLabels` and
 *   `removeLabels` all exist; `id` makes it an update).
 * - RESPONSE envelope is a DOCUMENTED FIXTURE, never live-observed: this module
 *   expects `{ issue: { identifier?, id?, updatedAt? } }` with at least one of
 *   `identifier`/`id`. Anything else — including an embedded `errors` array — is
 *   `ambiguous`: it cannot prove the mutation did not run, so it is never
 *   success and never an invented id.
 *
 * No credential crosses this module: the transport is injected and carries its
 * own auth headers.
 */
import { SyncError } from "../issue-sync.js";
import type { ProviderWrite, ProviderWritePayload, ProviderWriteReceipt } from "./provider.js";
import { isRecord, type LinearAdapterEntry, type LinearCallOutcome } from "./linear-adapter.js";
import { listingVerbIn, redactTransportMessage } from "./linear-probe.js";

/**
 * Candidate write verbs, in preference order. `save_issue` is the single save
 * verb whose advertised schema this session observed (create when `id` is
 * absent, update when present) — declared as a CANDIDATE, never as an
 * inventory: another host's handshake may name a different one.
 */
export const LINEAR_WRITE_VERBS: readonly string[] = ["save_issue"];

/** Candidate label-discovery verbs, same discipline. */
export const LINEAR_LABEL_VERBS: readonly string[] = ["list_issue_labels"];

/**
 * Candidate state-discovery verbs, same discipline. The observed envelope is a
 * bare array of `{ id, type, name }` — `list_issue_labels` answers with
 * `{ labels: [...] }` instead, so the two parsers are separate rather than one
 * guessing at both.
 */
export const LINEAR_STATE_VERBS: readonly string[] = ["list_issue_statuses"];

/** One discovery PAGE asks for this many labels. */
const LABEL_PAGE_LIMIT = 250;

/**
 * The most discovery pages one run reads. A workspace larger than this cannot
 * have its label set proven, so the run refuses by name instead of resolving
 * items against a set it knows is truncated — never by raising the page size.
 */
const DISCOVERY_PAGE_BOUND = 20;

/**
 * The same page ask for states. A team has a handful of workflow states, so
 * whatever the host's default page is, naming it removes the one way a state
 * could be dropped from the discovered set and falsely refuse an item.
 */
const STATE_PAGE_LIMIT = 250;

/** Host-owned capabilities injected at the MCP boundary (fixtures in tests). */
export type LinearWriteDeps = {
  findLinearEntry(): LinearAdapterEntry | null;
  call(entry: LinearAdapterEntry, request: { tool: string; arguments: Record<string, unknown> }): Promise<LinearCallOutcome>;
  /** Overrides the module candidate sets (tests, and a host that pins a verb). */
  writeVerbs?: readonly string[];
  labelVerbs?: readonly string[];
  stateVerbs?: readonly string[];
  /** The tools the host's `tools/list` returned, or `null` before a handshake. */
  listedVerbs(): readonly string[] | null;
  /**
   * The argument names the handshake advertised for one tool, or `null` when the
   * handshake carried no schema for it. Push never ASSUMES an argument: an update
   * that must remove a recorded label is refused when this cannot prove
   * `removeLabels` exists.
   */
  advertisedArguments(tool: string): readonly string[] | null;
  /** The bound team; a create cannot be issued without one. */
  scope?: { team?: string; project?: string };
};

export type LinearWriteSide = {
  applyWrite(write: ProviderWrite): Promise<ProviderWriteReceipt>;
  /**
   * The label names this workspace/team really has. A mapped kind label missing
   * from this set refuses that ITEM (`linear.label-unresolved`); push never
   * creates a provider label.
   */
  discoverLabels(): Promise<ReadonlySet<string>>;
  /**
   * The workflow state names the bound team really has. A mapped disposition
   * state missing from this set refuses that ITEM (`linear.state-unresolved`)
   * before the call; push never creates or renames a state.
   */
  discoverStates(): Promise<ReadonlySet<string>>;
};

/** Create the write side of the Linear provider. */
export function createLinearWrite(deps: LinearWriteDeps): LinearWriteSide {
  const writeVerbs = deps.writeVerbs ?? LINEAR_WRITE_VERBS;
  const labelVerbs = deps.labelVerbs ?? LINEAR_LABEL_VERBS;
  const stateVerbs = deps.stateVerbs ?? LINEAR_STATE_VERBS;

  /** The entry the write needs, or a named refusal (nothing was sent). */
  function entryOrRefuse(): LinearAdapterEntry {
    const entry = deps.findLinearEntry();
    if (entry === null) {
      throw new SyncError("linear.host-unavailable", "no Linear MCP entry is configured for this host; nothing was written");
    }
    return entry;
  }

  return {
    async applyWrite(write: ProviderWrite): Promise<ProviderWriteReceipt> {
      const listed = deps.listedVerbs();
      const tool = listingVerbIn(listed ?? undefined, writeVerbs);
      if (tool === null) {
        if (listed === null) {
          return refused(
            "linear.host-unavailable",
            `this host has not completed the Linear handshake, so the write verb is unknown (candidates: ${writeVerbs.join(", ")})`,
          );
        }
        return refused("linear.host-unavailable", `the Linear handshake listed none of ${writeVerbs.join(", ")}, so no issue can be written`);
      }
      const entry = deps.findLinearEntry();
      if (entry === null) {
        return refused("linear.host-unavailable", "no Linear MCP entry is configured for this host; nothing was written");
      }
      let args: Record<string, unknown>;
      try {
        args = argumentsFor(write, tool, deps.advertisedArguments.bind(deps), deps.scope);
      } catch (error) {
        // A refusal the adapter raised BEFORE sending: provably not delivered.
        if (error instanceof SyncError) return refused(error.code, stripCode(error.message));
        throw error;
      }
      const outcome = await deps.call(entry, { tool, arguments: args });
      return classify(outcome);
    },

    async discoverLabels(): Promise<ReadonlySet<string>> {
      return discover(labelVerbs, "label", labelNames, labelNextCursor, { limit: LABEL_PAGE_LIMIT });
    },

    async discoverStates(): Promise<ReadonlySet<string>> {
      // The state envelope is a bare array: one page, no cursor to follow.
      return discover(stateVerbs, "state", stateNames, () => null, { limit: STATE_PAGE_LIMIT });
    },
  };

  /**
   * One discovery walk, shared by labels and states: same handshake rule, same
   * refusal vocabulary, so a host that cannot enumerate one of them says so the
   * same way. Only the verb candidates, the noun, the envelope parser and the
   * page-continuation reader differ.
   */
  async function discover(
    candidates: readonly string[],
    noun: "label" | "state",
    parse: (payload: unknown) => ReadonlySet<string> | null,
    nextCursor: (payload: unknown) => string | null,
    baseArguments: Record<string, unknown>,
  ): Promise<ReadonlySet<string>> {
    const listed = deps.listedVerbs();
    const tool = listingVerbIn(listed ?? undefined, candidates);
    if (tool === null) {
      throw new SyncError(
        "linear.host-unavailable",
        listed === null
          ? `this host has not completed the Linear handshake, so the ${noun} discovery verb is unknown (candidates: ${candidates.join(", ")})`
          : `the Linear handshake listed none of ${candidates.join(", ")}; the ${noun} set cannot be discovered, so no ${noun} can be resolved`,
      );
    }
    const entry = entryOrRefuse();
    const team = deps.scope?.team;
    const names = new Set<string>();
    let cursor: string | null = null;
    for (let page = 1; page <= DISCOVERY_PAGE_BOUND; page += 1) {
      const outcome = await deps.call(entry, {
        tool,
        arguments: {
          ...baseArguments,
          ...(team === undefined ? {} : { team }),
          ...(cursor === null ? {} : { cursor }),
        },
      });
      if (outcome.kind === "transport-error") {
        throw new SyncError(
          "linear.host-unavailable",
          `the ${noun} discovery call (${tool}) failed (${redactTransportMessage(outcome.message)}); nothing was written`,
        );
      }
      if (outcome.kind === "http-status") {
        throw new SyncError(
          "linear.host-unavailable",
          `the ${noun} discovery call (${tool}) answered HTTP ${outcome.status}; nothing was written`,
        );
      }
      const pageNames = parse(outcome.payload);
      if (pageNames === null) {
        throw new SyncError(
          "linear.host-unavailable",
          `the ${noun} discovery response from ${tool} did not match the documented envelope (${noun === "label" ? "{ labels: [{ name }], hasNextPage?, cursor? }" : "[{ name }]"}); nothing was written`,
        );
      }
      for (const name of pageNames) names.add(name);
      cursor = nextCursor(outcome.payload);
      if (cursor === null) return names;
    }
    // The page budget ran out with more pages advertised: the set this run
    // holds is provably truncated, so resolving against it would refuse an item
    // whose label may live on a page never read.
    throw new SyncError(
      noun === "label" ? "linear.label-unresolved" : "linear.state-unresolved",
      `the ${noun} discovery walk (${tool}) still had more pages after ${DISCOVERY_PAGE_BOUND} pages, so the ${noun} set is incomplete; nothing was written`,
    );
  }
}

function refused(code: string, cause: string): ProviderWriteReceipt {
  return { kind: "refused", code, cause };
}

function stripCode(message: string): string {
  return message.replace(/^\[[^\]]+\]\s*/, "");
}

/**
 * Build the request body. Every refusal here happens BEFORE the call, so it is
 * provably a non-delivery.
 */
function argumentsFor(
  write: ProviderWrite,
  tool: string,
  advertised: (tool: string) => readonly string[] | null,
  scope: { team?: string; project?: string } | undefined,
): Record<string, unknown> {
  const payload: ProviderWritePayload = write.payload;
  const args: Record<string, unknown> = {
    title: payload.title,
    description: payload.description,
    priority: payload.priority,
    state: payload.state,
  };
  // `addLabels`, never `labels`: the full-replace argument removes labels a
  // human added, which push must never do.
  if (payload.labels !== undefined && payload.labels.length > 0) args.addLabels = [...payload.labels];
  if (write.kind === "update") {
    args.id = write.externalId;
    if (payload.removeLabels !== undefined && payload.removeLabels.length > 0) {
      const names = advertised(tool);
      if (names === null || !names.includes("removeLabels")) {
        throw new SyncError(
          "linear.write-refused",
          `this host's ${tool} schema does not advertise "removeLabels", so the recorded kind label ${JSON.stringify(payload.removeLabels.join(", "))} cannot be replaced; the update was not sent (it would strand the old label). Re-authorize against a host whose Linear MCP advertises removeLabels, or change the kind back.`,
        );
      }
      args.removeLabels = [...payload.removeLabels];
    }
    // `team` is deliberately absent on update: the save schema forbids combining
    // `addLabels` with a team change.
    return args;
  }
  if (scope?.team === undefined || scope.team.trim() === "") {
    throw new SyncError(
      "linear.write-refused",
      `a create needs the bound team, and this binding names none; nothing was written (set [linear] team=<key> in .mstarc)`,
    );
  }
  args.team = scope.team;
  // The bound PROJECT, so the create lands where the binding says. Push recovery
  // reads are filtered by this project, so an issue created outside it could
  // never be found again. Updates never carry it: the save schema treats
  // `project` as a move, and a confirmed identity already lives where it belongs.
  if (scope.project !== undefined && scope.project.trim() !== "") args.project = scope.project;
  return args;
}

/**
 * The two 4xx answers that do NOT prove the mutation did not run. `408 Request
 * Timeout` and `425 Too Early` are request-level rejections raised around a
 * body the server may already have accepted — a deadline or an early-data
 * refusal can arrive after the write executed — so they belong with the
 * unconfirmed outcomes: calling them `refused` would make the next run create
 * the exact duplicate the contract forbids.
 */
const LATE_4XX: Record<number, string> = {
  408: "the request timed out, which can happen after the server already ran the mutation",
  425: "the server deferred the request as too early, which can happen after the server already ran the mutation",
};

/** Classify one transport outcome. Only a strict envelope parse is `confirmed`. */
function classify(outcome: LinearCallOutcome): ProviderWriteReceipt {
  if (outcome.kind === "transport-error") {
    // Sent but unconfirmed: the failure may have landed after the mutation ran,
    // so this is `ambiguous` — the safe class, because it forbids a retried
    // create. A pre-send failure is indistinguishable from here and lands in the
    // same class on purpose.
    return { kind: "ambiguous", cause: `the write call failed in transport (${redactTransportMessage(outcome.message)}); delivery is unconfirmed` };
  }
  if (outcome.kind === "http-status") {
    if (outcome.status >= 400 && outcome.status < 500) {
      const late = LATE_4XX[outcome.status];
      if (late !== undefined) {
        return { kind: "ambiguous", cause: `the write answered HTTP ${outcome.status}: ${late}; delivery is unconfirmed` };
      }
      // Every other request-level rejection happened before the mutation ran.
      return refused("linear.write-refused", `the provider rejected the write with HTTP ${outcome.status}; nothing was written`);
    }
    return { kind: "ambiguous", cause: `the write answered HTTP ${outcome.status}; delivery is unconfirmed` };
  }
  const parsed = parseIssue(outcome.payload);
  if (parsed === null) {
    return {
      kind: "ambiguous",
      cause: "the write response did not match the documented envelope ({ issue: { identifier | id, updatedAt? } }) or carried an embedded errors array; delivery is unconfirmed",
    };
  }
  return { kind: "confirmed", externalId: parsed.externalId, updatedAt: parsed.updatedAt };
}

/** Strict parse of the documented fixture envelope; `null` means unparseable. */
function parseIssue(payload: unknown): { externalId: string; updatedAt: string | null } | null {
  if (!isRecord(payload)) return null;
  const errors = payload.errors;
  if (Array.isArray(errors) && errors.length > 0) return null;
  const issue = payload.issue;
  if (!isRecord(issue)) return null;
  // Linear lists the human key as `identifier` and the API id as `id`; the
  // identifier is what the ledger keys on, so it wins when both are present.
  const identifier = nonBlank(issue.identifier) ?? nonBlank(issue.id);
  if (identifier === null) return null;
  return { externalId: identifier, updatedAt: nonBlank(issue.updatedAt) };
}

function nonBlank(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Label names from the documented discovery envelope. A group cannot be applied
 * to an issue, so group rows are ignored rather than resolved.
 */
function labelNames(payload: unknown): ReadonlySet<string> | null {
  if (!isRecord(payload)) return null;
  const rows = payload.labels;
  if (!Array.isArray(rows)) return null;
  const names = new Set<string>();
  for (const row of rows) {
    if (typeof row === "string") {
      if (row.trim() !== "") names.add(row.trim());
      continue;
    }
    if (!isRecord(row)) return null;
    const name = nonBlank(row.name);
    if (name === null) return null;
    if (row.isGroup === true) continue;
    names.add(name);
  }
  return names;
}

/**
 * The next page of the label envelope. `list_issue_labels` advertises a
 * `cursor` request argument and continues while `hasNextPage` is true, so the
 * page is followed only on that pair — an empty cursor with `hasNextPage: true`
 * ends the walk rather than re-reading page one, and a page that omits both
 * ends it too. Same rule as the listing side, which already reads this pair.
 */
function labelNextCursor(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload.hasNextPage !== true) return null;
  return nonBlank(payload.cursor);
}

/**
 * State names from the observed discovery envelope: a bare array of
 * `{ id, type, name }`. Deliberately not folded into `labelNames`: the wire
 * shapes differ (the label call answers `{ labels: [...] }`), and one parser
 * accepting both would turn an envelope change into a silent empty set — which
 * would then refuse every item as `linear.state-unresolved`.
 */
function stateNames(payload: unknown): ReadonlySet<string> | null {
  if (!Array.isArray(payload)) return null;
  const names = new Set<string>();
  for (const row of payload) {
    if (typeof row === "string") {
      if (row.trim() !== "") names.add(row.trim());
      continue;
    }
    if (!isRecord(row)) return null;
    const name = nonBlank(row.name);
    if (name === null) return null;
    names.add(name);
  }
  return names;
}
