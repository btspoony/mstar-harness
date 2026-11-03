/**
 * issue-sync family — the supported sync entries (mirror-import plan Task 4,
 * one-way push plan Task 2):
 *
 *   mstar issue-sync import --project <project_id> [--max-pages <n>]
 *   mstar issue-sync push   --project <project_id> [--adopt <localId>=<ref>...]
 *                                                  [--force-create <localId>...]
 *
 * `import` refuses — before any write — when the binding cannot run, and
 * otherwise pages the bound Linear project into the local store through the
 * ledger and reports what it imported, updated, skipped or failed plus where it
 * stopped. A retryable ledger failure holds the cursor for the next run; an
 * adapter-unmappable item is reported as stranded and the scan continues.
 *
 * `push` is the only WRITE surface. It refuses the whole run before any write
 * when the stored credential's scope cannot create or update issues, discovers
 * the workspace's real label set, reconciles any ambiguous create by
 * correlation marker, and records only what a confirmed receipt (or an explicit
 * `--adopt`) proved. It never deletes, never creates a label, and never sends
 * the full-replace `labels` argument.
 *
 * Refusal vocabulary is the frozen contract's (sync-ledger-contract §4): the
 * retired names `linear.binding-not-ready` / `linear.project-unbound` are never
 * emitted. "Cannot run" is `linear.provider-disabled` with the probe state and
 * its cause in the message; "mirrors nothing" is the named absence
 * `linear.binding-absent`.
 */
import { refusalEnvelope } from "../envelope.js";
import { engineErrorFacts } from "./family-refusal.js";
import {
  adoptItem,
  createLinearProvider,
  DEFAULT_PROBE_DEADLINE_MS,
  IMPORT_DIRECTION,
  PUSH_DIRECTION,
  importPage,
  linearScopeCanWrite,
  openStore,
  pushItem,
  readCursor,
  readItem,
  readProjectBinding,
  readLinearCredential,
  reconcilePendingCreate,
  selectPushCandidates,
  commitLinearCredential,
  supersededBy,
  readRepoLinearBinding,
  resolveRepoRoot,
  resetCursor,
  resolveProcessHarnessDir,
  SyncError,
  writeCursor,
  type IssueProvider,
  type PushContext,
  type PushOutcome,
} from "@mstar-harness/engine";
import { z } from "zod";
import { commandEnvelopeSchema } from "../envelope.js";
import type { CommandDefinition, CommandEnvelope, CommandRequirement, InvocationContext } from "../types.js";

// Linear's hosted MCP endpoint. Kept beside the command because it is the one
// default the provider assembly needs; a deployment that self-hosts or proxies
// the endpoint overrides it where the assembly is constructed.
const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";

/**
 * The access token this machine stored through `mstar linear auth`, or null.
 *
 * A credential past its expiry is refreshed first: sending an expired token only
 * produces an access-denied that names nothing, while the refresh token beside it
 * was still usable. A credential that is merely due (inside the refresh window)
 * is returned as-is — it works until it expires.
 */
/**
 * A refusal that survives the trip to the envelope: a plain Error loses its code,
 * and the operator would be told `internal-error` for a condition with an exact
 * recovery.
 */
function refusalWith(code: string, message: string, recovery: string): Error {
  return Object.assign(new Error(message), { code, recovery });
}

export async function resolveStoredToken(invocation: InvocationContext): Promise<string | null> {
  const state = readLinearCredential();
  if (state.kind !== "present") return null;
  const { credential } = state;
  const expired = credential.expiresAt !== null && credential.expiresAt <= Date.now();
  if (!expired) return credential.accessToken;
  const refresh = invocation.effects.linearRefresh;
  const fallbackKey = process.env.LINEAR_API_KEY;
  if (refresh === undefined || credential.refreshToken === null || credential.clientId === null) {
    // An exported key is a documented fallback, not a dead branch: without this,
    // a headless machine holding both a stale credential and a working key would
    // refuse instead of importing.
    if (fallbackKey !== undefined && fallbackKey !== "") return null;
    throw refusalWith(
      "linear.reauth-required",
      "the stored Linear credential has expired and this host cannot refresh it",
      "Run `mstar linear auth` on the machine that holds the credential, or export LINEAR_API_KEY for a headless run.",
    );
  }
  const fresh = await refresh(LINEAR_MCP_URL, credential.clientId, credential.refreshToken);
  if (fresh === null) {
    throw refusalWith(
      "linear.reauth-required",
      "the refresh was declined",
      "Run `mstar linear auth` again; the stored refresh token is no longer accepted.",
    );
  }
  // The refresh waited on the network, so the file may have changed meanwhile.
  // The commit's lineage check makes that change win: a sign-out stays deleted,
  // and a grant `mstar linear auth` stored while this round trip was in flight
  // is not replaced by this older lineage's token (whose
  // `scope ?? credential.scope` fallback could also restore its narrower scope).
  // This run still uses the token it obtained.
  commitLinearCredential((current) => {
    if (supersededBy(current, credential)) return null;
    return {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken ?? credential.refreshToken,
      expiresAt: fresh.expiresAt,
      scope: fresh.scope ?? credential.scope,
      clientId: fresh.clientId ?? credential.clientId,
    };
  });
  return fresh.accessToken;
}

/**
 * One schema PER VERB: the CLI syntax keys must equal the schema keys, so a
 * shared schema would force `import` to accept `--adopt` and vice versa.
 */
const importSchema = z.object({
  project: z.string().optional(),
  maxPages: z.number().int().positive().optional(),
  harness: z.string().optional(),
});
const pushSchema = z.object({
  project: z.string().optional(),
  adopt: z.array(z.string()).optional(),
  forceCreate: z.array(z.string()).optional(),
  harness: z.string().optional(),
});
const schemas = { import: importSchema, push: pushSchema } as const;
type Input = z.infer<typeof importSchema> & z.infer<typeof pushSchema>;

const verbs = ["import", "push"] as const;
type Verb = (typeof verbs)[number];

/** Bound one run at 20 pages × 50 items, so a first run cannot run unbounded. */
const DEFAULT_MAX_PAGES = 20;

/** A `ready` probe is exactly `initialize` + `tools/list` (provider contract §5). */
const HANDSHAKE_REQUESTS = 2;

/**
 * Probe state → refusal code (contract §4). `linear.provider-disabled` keeps its
 * configuration-only meaning, so it is NOT the answer for a reachable-but-hosted
 * provider.
 */
const PROBE_REFUSAL = {
  "service-absent": "linear.host-unavailable",
  unreachable: "linear.host-unavailable",
  "access-denied": "linear.access-denied",
} as const;

const flags: Record<keyof Input, string> = {
  project: "--project <id>",
  maxPages: "--max-pages <n>",
  harness: "--harness <root>",
  adopt: "--adopt <localId>=<issueUrl|externalId>",
  forceCreate: "--force-create <localId>",
};

const options: Record<Verb, (keyof Input)[]> = {
  import: ["project", "maxPages", "harness"],
  push: ["project", "adopt", "forceCreate", "harness"],
};
const required: Record<Verb, (keyof Input)[]> = { import: ["project"], push: ["project"] };

/**
 * `--adopt` / `--force-create` name one item each. Declared variadic so an
 * operator can pass several (`--adopt A=LIN-1 --adopt B=LIN-2` or one
 * `--adopt A=LIN-1 --adopt` list) without the CLI refusing the repetition.
 */
const variadicOptions: Partial<Record<keyof Input, true>> = { adopt: true, forceCreate: true };

class UsageError extends Error {}

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined || !value.trim()) throw new UsageError(`${flag} is required`);
  return value.trim();
}

function envelope(id: string, data: unknown): CommandEnvelope {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}

/** Recovery text per refusal: every one names a documented entry to run. */
const RECOVERY: Record<string, string> = {
  "linear.provider-disabled":
    "The binding is not enabled for this repo. Fix the .mstarc `[linear]` block (`enabled=true`, `mode=mirror`, `workspace=<slug>`, `team=<key>`), then re-run `mstar issue-sync import --project <project-id>`.",
  "linear.host-unavailable":
    "The provider is configured, but this host cannot reach its Linear MCP service right now. Add or repair the Linear MCP entry in the host's MCP configuration (the cause names what failed), then re-run the import. Nothing was written and the cursor did not advance.",
  "linear.access-denied":
    "This host reached the Linear MCP service and the credential was rejected or expired. Re-authorize the host's Linear connection (sign in / refresh the API key in the host, not in `.mstarc`), then re-run the import. Nothing was written and the cursor did not advance.",
  "linear.binding-absent":
    "This store project mirrors no Linear project yet. Bind one first: `mstar project bind --project <project-id> --provider linear --remote-project <name-or-id> --operation <id>`, then re-run the import.",
  "linear.query-failed":
    "A page failed and nothing from it was ingested; the cursor did not advance. Re-run `mstar issue-sync import --project <project-id>` to resume from the recorded cursor once the provider answers again.",
  "linear.list-unimplemented":
    "This host exposes no Linear listing adapter, so no page can be requested. Run the import from a host that ships the adapter (dsh this iteration), or install a release whose plugin provides it.",
  "linear.identity-collision":
    "A local issue already holds the identity a Linear item would map to. Rename the local capture's sourceIdentity, then re-run the import; the two are never merged.",
  "store.not-active":
    'Activate the store first: `mstar store upgrade --operator <name>`, then re-run the import.',
  "store.not-initialized":
    'Create and activate the store: `mstar harness scaffold` then `mstar store init`; retrying cannot create it.',
  "linear.scope-insufficient":
    "The stored Linear credential cannot create or update issues. Reauthorize explicitly: open the dsh plugin Settings and press Authorize on the linear-mcp row, or run `mstar linear auth login` — both request read + issues:create and present the provider's consent screen. A refresh never widens an existing read-only grant.",
  "linear.write-refused":
    "The provider refused this write, so nothing was written and the item is failed for a safe retry. Read the cause: a request-level rejection (HTTP 4xx) and a schema missing `removeLabels` are both refused this way. Re-run `mstar issue-sync push --project <project-id>` after addressing it.",
  "linear.write-ambiguous":
    "The write was sent but not confirmed, so delivery is unknown and the item stays pending with no external id. The next run reconciles it by correlation marker; use `--adopt <localId>=<issueUrl>` if you can see the remote issue yourself, or `--force-create <localId>` when you are sure it does not exist.",
  "linear.label-unresolved":
    "The mapped kind label does not exist in this Linear workspace and push never creates labels. Create that label in Linear's UI, or redirect it in `.mstarc` with `[linear.mapping] kind.<kind>=<label>`; other items still push.",
  "linear.state-unresolved":
    "The mapped workflow state does not exist in this Linear team and push never creates or renames states. Rename it in Linear's workflow settings, or redirect it in `.mstarc` with `[linear.mapping] disposition.<state>=<name>`; other items still push.",
};

function refusalFor(id: string, code: string, message: string, details?: Record<string, unknown>): CommandEnvelope<never> {
  return refusalEnvelope({
    command: id,
    status: "refused",
    code,
    exitCode: 1,
    message: `[${code}] ${message}`,
    details: { operation: id, ...details },
    recovery: RECOVERY[code] ?? "Run `mstar issue-sync import --help` for the supported flags and check the named condition.",
  });
}

function failure(id: string, error: unknown): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UsageError) {
    return refusalEnvelope({
      command: id,
      status: "usage",
      code: "usage",
      exitCode: 2,
      message,
      details: { operation: id },
      recovery:
        "Check the project binding with `mstar project show`, then pass --project naming a store project whose Linear project is already bound.",
    });
  }
  const facts = engineErrorFacts(error);
  const code = facts.code ?? `${id}.internal-error`;
  return refusalEnvelope({
    command: id,
    status: "refused",
    code,
    exitCode: 1,
    message,
    details: { operation: id, ...facts.details },
    recovery:
      facts.recovery ??
      RECOVERY[code] ??
      `Run \`mstar issue-sync import --help\` and check the named condition; retry only after addressing it.`,
  });
}

/** One item the run could not process, reported by identity and page index. */
type StrandedItem = {
  page: number;
  /** Zero-based item index inside the page, or null for a whole-page failure. */
  index: number | null;
  externalId: string | null;
  cause: string;
};

type ImportReport = {
  projectId: string;
  bindingId: string;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  pages: number;
  /**
   * Every provider request this run made: the contract-defined handshake
   * (`initialize` + `tools/list` = 2) plus one `tools/call` per page. This is
   * the rate-limit budget, evidenced rather than assumed.
   */
  requests: number;
  /** The cursor a later run resumes from (unchanged when nothing advanced). */
  cursor: string | null;
  /** Items left unprocessed, by identity and page index. */
  stranded: StrandedItem[];
  /**
   * Why the run stopped: the page bound, a retryable ledger failure holding the
   * cursor, or the last page. Adapter-level failures alone do not stop a run —
   * they are reported in `stranded` and the cursor advances (I-000948).
   */
  stopped: "complete" | "max-pages" | "stranded";
};

async function runImport(id: string, input: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
  const projectId = requireValue(input.project, "--project");
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;
  const harnessDir =
    resolveProcessHarnessDir(invocation.cwd, input.harness) ?? input.harness ?? invocation.controlRoot ?? invocation.cwd;
  const context = { harnessDir };

  // The two declarations are read FIRST: the provider needs the endpoint they
  // supply, and every refusal must happen before a store write or a listing call.
  // The root is resolved HERE, once, and passed in. The harness's own checkout
  // wins; a harness that lives outside any checkout (harness_dir pointing at
  // shared state) has no repository to read, so the invocation's checkout is the
  // only thing that can name one.
  const repoRoot = resolveRepoRoot(harnessDir) ?? resolveRepoRoot(invocation.cwd) ?? invocation.cwd;
  const repo = readRepoLinearBinding(repoRoot);
  if (repo.kind !== "bound" || !repo.binding.enabled) {
    const why =
      repo.kind === "absent"
        ? repo.message.replace(/^\[?linear\.[a-z-]+\]?:?\s*/, "")
        : repo.kind === "invalid"
          ? repo.message
          : `a [linear] block exists in ${repo.file} but enabled is not true`;
    throw Object.assign(new Error(`[linear.provider-disabled] ${why}`), { code: "linear.provider-disabled" });
  }
  const binding = await readProjectBinding(context, projectId);
  if (binding.kind === "absent") {
    throw Object.assign(new Error(binding.message), { code: "linear.binding-absent" });
  }
  if (binding.binding.provider !== "linear") {
    throw Object.assign(
      new Error(`[linear.provider-disabled] project ${projectId} mirrors provider "${binding.binding.provider}"; this iteration imports linear only`),
      { code: "linear.provider-disabled" },
    );
  }

  // Built here rather than taken from the host. `issueProvider` stays as an
  // override for tests and for a host that mounts its own MCP client, but the
  // command no longer REQUIRES one: an unwired host used to turn every real run
  // into `linear.list-unimplemented`, which is not a refusal an operator could
  // recover from.
  const provider: IssueProvider =
    invocation.effects.issueProvider?.(projectId) ??
    createLinearProvider({
      url: LINEAR_MCP_URL,
      // Precedence is explicit: the stored credential this machine authorized
      // wins, and an exported key is the fallback for a headless deployment.
      token: (await resolveStoredToken(invocation)) ?? process.env.LINEAR_API_KEY,
      deadlineMs: DEFAULT_PROBE_DEADLINE_MS,
      // The listing is scoped to the binding: a credential that reaches several
      // teams or projects must never import another one's issues here.
      scope: { team: repo.binding.team ?? undefined, project: binding.binding.remoteProject },
    });

  // Each non-ready probe state keeps its OWN cause and recovery (contract §4):
  // a host that cannot reach its service and a host whose credential was
  // rejected need different operator actions, and neither is a configuration
  // fault of `.mstarc`.
  const probe = await provider.probe();
  if (probe.state !== "ready") {
    const code = PROBE_REFUSAL[probe.state];
    throw Object.assign(
      new Error(`[${code}] the binding cannot run: probe state "${probe.state}" — ${probe.cause}`),
      { code },
    );
  }

  const bindingId = `linear:${projectId}`;
  // Cursor writes are per SCAN, not per value: a fixed id made a second scan
  // that reached the same cursor find the first scan's receipt and skip the
  // write, so it reported progress the store never recorded.
  const scanId = new Date().toISOString();
  const cursorOperation = (suffix: string): string => `linear-import:${bindingId}:cursor:${scanId}:${suffix}`;

  const report: ImportReport = {
    projectId,
    bindingId,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    pages: 0,
    // The probe already spent the two handshake calls; a `ready` state is
    // exactly `initialize` + `tools/list` per the provider contract.
    requests: HANDSHAKE_REQUESTS,
    cursor: null,
    stranded: [],
    stopped: "complete",
  };
  const handle = await openStore(context, "write");
  try {
    const db = handle.db;
    let cursor = readCursor(db, { bindingId, direction: IMPORT_DIRECTION });
    report.cursor = cursor;
    while (report.pages < maxPages) {
      // A throwing page call leaves the cursor where it was: nothing from that
      // page was ingested, so the next run re-reads it.
      const page = await provider.listIssues(cursor);
      report.requests++;
      report.pages++;
      // The repo's own [linear.mapping] correspondence, applied at capture time.
      // Accepting an override and then ignoring it made the setting a lie.
      const counts = importPage(db, bindingId, page.items, repo.binding.mapping);
      report.imported += counts.imported;
      report.updated += counts.updated;
      report.skipped += counts.skipped;
      report.failed += counts.failed;
      // Contract §2 "Cursor advance and the overlap window", split by whether a
      // retry could ever help (I-000948):
      // - an ADAPTER-level failure (a title-less item, a non-object) can never
      //   change by re-reading the same page, so it is reported as stranded and
      //   the cursor advances — one poison item must not cap every later page.
      // - a LEDGER-level failure (identity collision, store refusal) is
      //   retryable, so the next run re-reads this page (the overlap window) and
      //   the `failed → pending` retry can actually run.
      for (const failure of page.failures ?? []) {
        report.stranded.push({
          page: report.pages,
          index: failure.index,
          externalId: failure.externalId,
          cause: failure.cause,
        });
      }
      if (counts.failed > 0) {
        report.stranded.push({
          page: report.pages,
          index: null,
          externalId: null,
          cause: `${counts.failed} item(s) on this page are failed; the ledger holds the cause and the next run retries them`,
        });
        report.stopped = "stranded";
        break;
      }
      if (page.nextCursor === null) {
        report.stopped = "complete";
        // A COMPLETED scan rewinds the page pointer: leaving it on the last page
        // makes every earlier page unreachable, so an issue edited there is
        // never read again. A scan that stops for any other reason keeps its
        // pointer — rewinding a stopped run would re-request the same page from
        // the top forever and drop the position that made progress possible.
        resetCursor(db, {
          bindingId,
          direction: IMPORT_DIRECTION,
          operationId: cursorOperation("complete"),
        });
        report.cursor = null;
        break;
      }
      writeCursor(db, {
        bindingId,
        direction: IMPORT_DIRECTION,
        cursor: page.nextCursor,
        operationId: cursorOperation(page.nextCursor),
      });
      cursor = page.nextCursor;
      report.cursor = cursor;
      report.stopped = "max-pages";
    }
    return envelope(id, report);
  } finally {
    handle.close();
  }
}

/** What one push run did, item by item plus the reconcile outcome. */
type PushReport = {
  projectId: string;
  bindingId: string;
  created: number;
  updated: number;
  skipped: number;
  /** Sent but unconfirmed; the next run reconciles by marker. */
  unresolved: number;
  failed: number;
  /** Rows this run adopted by marker equality after an interrupted create. */
  reconciled: Array<{ localId: string; externalId: string }>;
  /** One row per item that did not converge, with the credential-free cause. */
  items: Array<{ localId: string; outcome: string; externalId: string | null; cause?: string }>;
  /** The workspace label set this run resolved kind labels against. */
  labels: string[];
  /** The team's workflow state names this run resolved dispositions against. */
  states: string[];
};

/**
 * Parse `--adopt <localId>=<issueUrl|externalId>`. The FIRST `=` splits, so an
 * identifier containing one survives; a value with no `=` is a usage error
 * rather than a silently ignored flag.
 */
function adoptPairs(values: readonly string[] | undefined): Array<{ localId: string; reference: string }> {
  return (values ?? []).map((value) => {
    const split = value.indexOf("=");
    if (split <= 0 || split === value.length - 1) {
      throw new UsageError(`--adopt expects <localId>=<issueUrl|externalId>; received ${JSON.stringify(value)}`);
    }
    return { localId: value.slice(0, split).trim(), reference: value.slice(split + 1).trim() };
  });
}

async function runPush(id: string, input: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
  const projectId = requireValue(input.project, "--project");
  const adoptions = adoptPairs(input.adopt);
  const forced = new Set((input.forceCreate ?? []).map((value) => value.trim()).filter((value) => value !== ""));
  const harnessDir =
    resolveProcessHarnessDir(invocation.cwd, input.harness) ?? input.harness ?? invocation.controlRoot ?? invocation.cwd;
  const context = { harnessDir };

  // 1. SCOPE PREFLIGHT, before anything is resolved or written. A credential
  //    that cannot create/update issues refuses the whole run here: no probe, no
  //    listing, no ledger write. An absent credential is not this preflight's
  //    call — a host may hold the transport, and the probe reports the truth.
  const stored = readLinearCredential();
  if (stored.kind === "present" && !linearScopeCanWrite(stored.credential.scope)) {
    throw Object.assign(
      new Error(
        `[linear.scope-insufficient] the stored Linear credential's scope is ${JSON.stringify(stored.credential.scope ?? "absent")}, which cannot create or update issues; nothing was written`,
      ),
      { code: "linear.scope-insufficient" },
    );
  }

  // 2. The binding declarations, read before any store or provider work.
  const repoRoot = resolveRepoRoot(harnessDir) ?? resolveRepoRoot(invocation.cwd) ?? invocation.cwd;
  const repo = readRepoLinearBinding(repoRoot);
  if (repo.kind !== "bound" || !repo.binding.enabled) {
    const why =
      repo.kind === "absent"
        ? repo.message.replace(/^\[?linear\.[a-z-]+\]?:?\s*/, "")
        : repo.kind === "invalid"
          ? repo.message
          : `a [linear] block exists in ${repo.file} but enabled is not true`;
    throw Object.assign(new Error(`[linear.provider-disabled] ${why}`), { code: "linear.provider-disabled" });
  }
  const binding = await readProjectBinding(context, projectId);
  if (binding.kind === "absent") {
    throw Object.assign(new Error(binding.message), { code: "linear.binding-absent" });
  }
  if (binding.binding.provider !== "linear") {
    throw Object.assign(
      new Error(`[linear.provider-disabled] project ${projectId} mirrors provider "${binding.binding.provider}"; this iteration pushes to linear only`),
      { code: "linear.provider-disabled" },
    );
  }

  type WriteProvider = IssueProvider & {
    discoverLabels?: () => Promise<ReadonlySet<string>>;
    discoverStates?: () => Promise<ReadonlySet<string>>;
  };
  const provider: WriteProvider =
    invocation.effects.issueProvider?.(projectId) ??
    createLinearProvider({
      url: LINEAR_MCP_URL,
      token: (await resolveStoredToken(invocation)) ?? process.env.LINEAR_API_KEY,
      deadlineMs: DEFAULT_PROBE_DEADLINE_MS,
      scope: { team: repo.binding.team ?? undefined, project: binding.binding.remoteProject },
    });
  const discoverLabels = provider.discoverLabels?.bind(provider);
  if (discoverLabels === undefined) {
    throw Object.assign(
      new Error(
        "[linear.host-unavailable] this host's provider cannot discover the workspace label set (list_issue_labels), so no kind label could be resolved; nothing was written",
      ),
      { code: "linear.host-unavailable" },
    );
  }
  const discoverStates = provider.discoverStates?.bind(provider);
  if (discoverStates === undefined) {
    throw Object.assign(
      new Error(
        "[linear.host-unavailable] this host's provider cannot discover the team's workflow states (list_issue_statuses), so no disposition could be resolved; nothing was written",
      ),
      { code: "linear.host-unavailable" },
    );
  }

  const probe = await provider.probe();
  if (probe.state !== "ready") {
    const code = PROBE_REFUSAL[probe.state];
    throw Object.assign(new Error(`[${code}] the binding cannot run: probe state "${probe.state}" — ${probe.cause}`), { code });
  }

  // 3. Discovery of BOTH mapped vocabularies: a run-level guard, still before
  //    any write. Only names the workspace really has are ever sent, and push
  //    never creates a label or a state.
  const labels = await discoverLabels();
  const states = await discoverStates();

  const bindingId = `linear:${projectId}`;
  const handle = await openStore(context, "write");
  try {
    const db = handle.db;
    const storeRow = db.prepare("select store_id from store_meta where id = 1").get() as { store_id: string } | undefined;
    if (storeRow === undefined) {
      throw Object.assign(new Error("[store.not-initialized] store_meta is missing, so the pushing store has no identity"), {
        code: "store.not-initialized",
      });
    }
    const pushContext: PushContext = {
      bindingId,
      binding: { workspace: repo.binding.workspace ?? "", team: repo.binding.team ?? binding.binding.team ?? "" },
      storeId: storeRow.store_id,
      mapping: repo.binding.mapping,
      labels,
      states,
    };
    const report: PushReport = {
      projectId,
      bindingId,
      created: 0,
      updated: 0,
      skipped: 0,
      unresolved: 0,
      failed: 0,
      reconciled: [],
      items: [],
      labels: [...labels].sort(),
      states: [...states].sort(),
    };

    // 4. Operator-confirmed adoptions. These are ordinary ledger verbs: the row
    //    takes the identity, and its content converges on the next changed push.
    for (const { localId, reference } of adoptions) {
      const adopted = adoptItem(db, bindingId, localId, reference);
      report.items.push({ localId, outcome: "adopted", externalId: adopted.externalId });
    }

    // 5. Reconcile ambiguous creates by marker. Zero residue ⇒ zero listing calls.
    //    An adopted row continues on the ordinary update path below, which is
    //    what converges its content; an unresolved one is counted once here and
    //    `pushItem` reports it as `unresolved` without writing anything.
    const reconciled = await reconcilePendingCreate(db, provider, pushContext);
    report.reconciled = reconciled.adopted;
    for (const adopted of reconciled.adopted) {
      report.items.push({ localId: adopted.localId, outcome: "reconciled", externalId: adopted.externalId });
    }

    // 6. One write per candidate, classified by its receipt.
    for (const candidate of selectPushCandidates(db, bindingId)) {
      const outcome: PushOutcome = await pushItem(
        db,
        provider,
        forced.has(candidate.localId) ? { ...pushContext, forceCreate: true } : pushContext,
        candidate,
      );
      report[outcome.outcome]++;
      report.items.push({
        localId: outcome.localId,
        outcome: outcome.outcome,
        externalId: outcome.externalId,
        ...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
      });
    }
    return envelope(id, report);
  } finally {
    handle.close();
  }
}

export function getIssueSyncCommandDefinitions(): readonly CommandDefinition[] {
  const descriptions: Record<Verb, string> = {
    import:
      "Import the bound Linear project's issues into this store, read-only toward Linear; a second run with unchanged remote state imports nothing. --max-pages bounds one run (default 20 pages of 50) and the reported cursor resumes it. An issue Linear returns without a usable title/identifier is reported as stranded and the scan continues; repair it in Linear's UI and the next full scan picks it up.",
    push:
      "Push this project's local issues to the bound Linear team: create when no remote identity is known, update when a confirmed one exists, skip when the payload is unchanged. An unconfirmed create stays pending and the next run reconciles it by correlation marker — never by title/description. --adopt <localId>=<issueUrl|externalId> records an identity you confirmed yourself; --force-create <localId> says the remote issue does not exist. Requires a credential granted read + issues:create.",
  };
  return verbs.map((verb) => {
    const id = `issue-sync.${verb}`;
    const opts = options[verb];
    const requirements: CommandRequirement[] = (["cli", "mcp"] as const).flatMap((route): CommandRequirement[] => [
      ...required[verb].map((name) => ({ name, ownership: "caller" as const, route, required: true })),
      ...(verb === "import"
        ? [{
            name: "maxPages",
            ownership: "caller" as const,
            route,
            required: false,
            constraint: `optional: bounds one run at <n> pages of 50 items (default ${DEFAULT_MAX_PAGES}); a re-run resumes from the reported cursor`,
          }]
        : [
            {
              name: "adopt",
              ownership: "caller" as const,
              route,
              required: false,
              constraint: "optional, repeatable: <localId>=<issueUrl|externalId> for a remote issue you confirmed belongs to that local issue",
            },
            {
              name: "forceCreate",
              ownership: "caller" as const,
              route,
              required: false,
              constraint: "optional, repeatable: <localId> whose remote absence you confirmed; bypasses the reconcile guard for that item only",
            },
          ]),
    ]);
    return {
      id,
      cli: {
        path: ["issue-sync", verb],
        aliases: [],
        arguments: [],
        options: opts.map((key) => ({
          key,
          flags: flags[key],
          required: required[verb].includes(key),
          ...(key === "maxPages" ? { defaultValue: DEFAULT_MAX_PAGES } : {}),
          ...(variadicOptions[key] === true ? { variadic: true } : {}),
        })),
      },
      input: schemas[verb],
      output: commandEnvelopeSchema,
      effects: ["write"] as const,
      description: descriptions[verb],
      rootInputs: ["harness"],
      requirements,
      async execute(value: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
        try {
          return verb === "push" ? await runPush(id, value, invocation) : await runImport(id, value, invocation);
        } catch (error) {
          if (error instanceof SyncError) return refusalFor(id, error.code, error.message.replace(/^\[[^\]]+\]\s*/, ""));
          return failure(id, error);
        }
      },
    } satisfies CommandDefinition;
  });
}
