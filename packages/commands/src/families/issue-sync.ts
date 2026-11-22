/**
 * note: issue-sync family — the local half of the Linear mirror. Three verbs, no
 * Linear request anywhere in mstar:
 *
 *   mstar issue-sync pending --project <project_id> [--harness <root>]
 *   mstar issue-sync apply   --project <project_id> --results <file|-> [--adopt <localId>=<ref>...]
 *                                                   [--force-adopt <localId>...] [--release <localId>...] [--take-run]
 *   mstar issue-sync ingest  --project <project_id> --records <file|-> [--harness <root>]
 *
 * The agent holding the host's Linear tools performs every Linear call. mstar
 * hands it the payloads to write (`pending`), records what its tools reported
 * (`apply`), and associates a listing it fetched back with the local rows those
 * issues mirror (`ingest`). A run is one `pending`/`apply` pair over ONE run
 * lease per binding: `pending` claims it and leaves it held, `apply` continues
 * that run under its token, and either a completed `apply` or an explicit
 * `--take-run` ends it. The lease excludes a second RUNNING run, not a delivered
 * tool call: a call the predecessor already issued may still land, which is why
 * an unconfirmed create stays `pending` and the next `ingest`/`pending`
 * reconciles it by correlation marker instead of creating again.
 *
 * Refusal vocabulary: the `sync.*` ledger codes are unchanged (including
 * `sync.identity-conflict` for a recorded-identity conflict); the
 * `.mstarc`/`git` refusals are `linear.binding-absent`,
 * `linear.binding-invalid`, `linear.binding-incomplete`,
 * `linear.repo-unresolved`, `linear.author-unresolved`, plus the binding
 * state `linear.provider-disabled` and `linear.mode-refused`; and a refused
 * tool result is recorded as `linear.write-refused`. Every refusal names its
 * recovery; none tells the operator to hand-edit a credential file, because
 * no credential lives in mstar.
 */
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { refusalEnvelope } from "../envelope.js";
import { engineErrorFacts } from "./family-refusal.js";
import {
  acquireRun,
  adoptItem,
  assertReleaseTargets,
  externalIdOf,
  identityConflict,
  ingestRecords,
  isOlderInstant,
  openCollaborationStore,
  PUSH_DIRECTION,
  planPushItem,
  readItem,
  readRepoIdentity,
  readRepoLinearBinding,
  readRun,
  reconcileWith,
  recordResults,
  releaseRun,
  resolveProcessHarnessDir,
  resolveRepoRoot,
  selectPushCandidates,
  SyncError,
  type CollaborationAuthority,
  type IngestEntry,
  type IngestReport,
  type LinearBinding,
  type LinearFacetMapping,
  type PlanOutcome,
  type PushContext,
  type PushPlan,
  type StoreDb,
  type ProjectBinding,
  type PushResult,
  type RunLease,
  withSyncWrite,
} from "@mstar-harness/engine";
import { z } from "zod";
import { commandEnvelopeSchema } from "../envelope.js";
import type { CommandDefinition, CommandEnvelope, CommandRequirement, InvocationContext } from "../types.js";

/**
 * One schema PER VERB: the CLI syntax keys must equal the schema keys, so a
 * shared schema would force `ingest` to accept `--adopt` and vice versa.
 * why: one schema per verb keeps the CLI syntax and the admitted input from drifting apart.
 */
const pendingSchema = z.object({
  project: z.string().optional(),
  harness: z.string().optional(),
});
const applySchema = z.object({
  project: z.string().optional(),
  results: z.string().optional(),
  adopt: z.array(z.string()).optional(),
  forceAdopt: z.array(z.string()).optional(),
  release: z.array(z.string()).optional(),
  takeRun: z.boolean().optional(),
  run: z.string().optional(),
  harness: z.string().optional(),
});
const ingestSchema = z.object({
  project: z.string().optional(),
  records: z.string().optional(),
  harness: z.string().optional(),
});
const schemas = { pending: pendingSchema, apply: applySchema, ingest: ingestSchema } as const;
type Input = z.infer<typeof applySchema> & z.infer<typeof ingestSchema> & z.infer<typeof pendingSchema>;

const verbs = ["pending", "apply", "ingest"] as const;
type Verb = (typeof verbs)[number];

const flags: Record<keyof Input, string> = {
  project: "--project <id>",
  harness: "--harness <root>",
  results: "--results <file|->",
  records: "--records <file|->",
  adopt: "--adopt <localId>=<issueUrl|externalId>",
  forceAdopt: "--force-adopt <localId>",
  release: "--release <localId>",
  takeRun: "--take-run",
  run: "--run <runId>",
};

const options: Record<Verb, (keyof Input)[]> = {
  pending: ["project", "harness"],
  apply: ["project", "results", "adopt", "forceAdopt", "release", "takeRun", "run", "harness"],
  ingest: ["project", "records", "harness"],
};
const required: Record<Verb, (keyof Input)[]> = {
  pending: ["project"],
  apply: ["project", "results"],
  ingest: ["project", "records"],
};

/**
 * `--adopt` / `--force-adopt` / `--release` name one item each. Declared
 * variadic so an operator can pass several without the CLI refusing the
 * repetition.
 * why: these three are the only operator verbs, and each names a different ledger fact.
 */
const variadicOptions: Partial<Record<keyof Input, true>> = { adopt: true, forceAdopt: true, release: true };

class UsageError extends Error {}

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined || !value.trim()) throw new UsageError(flag + " is required");
  return value.trim();
}

function envelope(id: string, data: unknown): CommandEnvelope {
  return { version: 1, command: id, status: "ok", code: id + ".ok", exitCode: 0, data };
}

/**
 * note: a SyncError refusal survives as a refusal, never an internal error.
 * why: one code can cover conditions whose repairs differ, so the thrown error may
 * carry its own recovery line and `engineErrorFacts` preserves it into the envelope;
 * a caller that supplies none keeps the shared per-code text.
 */
function refused(code: string, message: string, recovery?: string): Error {
  const error = Object.assign(new Error("[" + code + "] " + message), { code });
  return recovery === undefined ? error : Object.assign(error, { recovery });
}

/**
 * Recovery text per refusal: every one names a documented entry to run, and
 * none of them tells the operator to hand-edit a credential file.
 * why: a refusal without its recovery line is a hard block, which the contract forbids.
 */
const RECOVERY: Record<string, string> = {
  "linear.provider-disabled":
    "The Linear mirror is not enabled for this repository. Set enabled=true in the .mstarc [linear] block (with workspace and team), then re-run `mstar issue-sync pending --project <project-id>`.",
  "linear.binding-absent":
    "This store project mirrors no Linear project yet. Bind one first: `mstar project bind --project <project-id> --provider linear --remote-project <name-or-id> --operation <id>`, or declare the [linear] block in the repository's .mstarc, then re-run.",
  "linear.binding-invalid":
    "A [linear] value in .mstarc cannot be read. Read the cause, fix that key in .mstarc, and re-run. Nothing was written.",
  "linear.binding-incomplete":
    "The [linear] block is missing a required value. Set workspace and team (and enabled=true), then re-run. Nothing was written.",
  "linear.mode-refused":
    "The only supported [linear] mode is mirror. Set mode=mirror in .mstarc, then re-run. Nothing was written.",
  "linear.repo-unresolved":
    "The correlation marker needs a repository identity. Add one with `git remote add origin <url>`, or declare `[linear] repo=<owner/name>` in .mstarc, then re-run. Nothing was written.",
  "linear.author-unresolved":
    "The correlation marker needs this checkout's git author. Set it with `git config user.name \"Your Name\"` and `git config user.email \"you@example.com\"`, then re-run. Nothing was written.",
  "sync.run-held":
    "Another issue-sync run holds this binding; its start time, pid and host are in the message. Wait for that agent to run `mstar issue-sync apply --project <project-id> --results <file|->`, which ends the run. If you confirmed that holder is dead, take the run over with `mstar issue-sync apply --project <project-id> --results <file|-> --take-run` (send `[]` when you have no results to record).",
  "sync.run-taken":
    "This run was taken over while it was working, so it wrote nothing further and stopped. Its earlier writes stand, and a create it had already sent may still land: re-run `mstar issue-sync ingest --project <project-id> --records <file|->` with a listing that shows the current remote issues, so an unconfirmed create is associated by its marker before anything creates again.",
  "sync.identity-conflict":
    "This item already points at a remote issue and `--adopt` named a different one. Replacing an established identity is not an ordinary edit: re-run with `--force-adopt <localId>` beside that `--adopt <localId>=<issueUrl>` entry only if the new reference is the right one. Nothing was written.",
  "sync.operator-conflict":
    "The run's own flags contradict each other: one local item cannot be adopted and released in the same run, `--adopt` names one identity per local id, and a `--force-adopt` id must also appear in `--adopt`. Re-run with one verb per item. Nothing was written.",
  "sync.illegal-transition":
    "Read the cause, which names the row it refused. `--release` clears only a pending create with no remote id: when the ledger already records a remote issue for that item (an `ingest` associated it), its recovery is `--adopt <localId>=<issueUrl|externalId>` or a normal `pending`/`apply` update. Nothing was written.",
  "sync.not-found":
    "This local id has no push ledger row, so this run never planned it. Run `mstar issue-sync pending --project <project-id>` first and apply the results that run produced.",
  "sync.local-issue-missing":
    "This local id is not an issue in this store. Capture it first, then re-run `mstar issue-sync pending --project <project-id>`.",
  "linear.write-refused":
    "The remote refused this item; the cause is the tool's own words. Nothing was recorded as applied, so the item stays retryable: address the cause in Linear (a missing label, state or permission) and re-run `mstar issue-sync pending --project <project-id>`.",
  "collaboration.mode-unavailable":
    "This verb delivers to Linear, and the repository holds local authority only. Set mode=mirror in the repository's .mstarc [collaboration] block, initialize/activate that collaboration store through the reviewed cutover, then re-run. Nothing was written.",
  "collaboration.stale-binding":
    "The project binding or the repository's .mstarc changed after this command read it, or the run it names was opened under a different binding. Nothing was written. Re-run the same issue-sync verb: `pending` opens a run under the binding in force. A run a rebind superseded is retired with `mstar issue-sync apply --project <project-id> --results <file|-> --take-run` and an empty result list.",
  "store.not-active":
    "Activate the store first: `mstar store upgrade --operator <name>`, then re-run.",
  "store.not-initialized":
    "Create the store first: `mstar harness scaffold` then `mstar store init`; retrying cannot create it.",
  usage: "Run `mstar issue-sync <verb> --help` for the accepted flags and payload shapes.",
};

function refusalFor(id: string, code: string, message: string, details?: Record<string, unknown>): CommandEnvelope<never> {
  return refusalEnvelope({
    command: id,
    status: "refused",
    code,
    exitCode: 1,
    message: "[" + code + "] " + message,
    details: { operation: id, ...details },
    // why: A literal, not a composed verb: the help-reachability prover must be able to read
    // the command this refusal advertises (the per-code map above stays unprovable 
    // behind its element access, which is the refusal-quality exemption, not this one).
    recovery: RECOVERY[code] ?? "Read the cause, resolve it, then re-run the same issue-sync verb: `mstar issue-sync pending --project <project-id>` plans the work, `apply` records results, and `ingest` associates a listing.",
  });
}

function failure(id: string, error: unknown): CommandEnvelope<never> {
  if (error instanceof UsageError) {
    return refusalEnvelope({
      command: id,
      status: "usage",
      code: "usage",
      exitCode: 2,
      message: error.message,
      details: { operation: id },
      recovery: RECOVERY.usage,
    });
  }
  const facts = engineErrorFacts(error);
  const code = facts.code ?? id + ".internal-error";
  // shortcut: the recovery below is chosen at runtime (the engine's own text, then
  // this family's per-code RECOVERY map); the refusal prover evaluates only literal,
  // conditional, `??`/`||` over provable arms, const bindings and declared helpers, so
  // the exemption is refreshed under I-000872. upgrade: when the prover can read element
  // and property access, drop the exemption.
  return refusalEnvelope({
    command: id,
    status: "refused",
    code,
    exitCode: 1,
    message: error instanceof Error ? error.message : String(error),
    details: { operation: id, ...facts.details },
    recovery: facts.recovery ?? RECOVERY[code] ?? "Read the cause, resolve it, then re-run the same issue-sync verb: `mstar issue-sync pending --project <project-id>` plans the work, `apply` records results, and `ingest` associates a listing.",
  });
}


/** note: Everything a verb needs from the declarations, resolved once, before any write. */
type Target = {
  projectId: string;
  bindingId: string;
  harnessDir: string;
  /** note: The `.mstarc` connection facts this command resolved. */
  linear: LinearBinding;
  /** note: The binding row the collaboration lane holds, revision included. */
  project: ProjectBinding;
  /** note: Where the `.mstarc` was read: the under-lock comparison re-reads it here. */
  repoRoot: string;
  remoteProject: string;
  identity: { repo: string; author: string };
};

/**
 * Read the two declarations this family runs on, in order, before any store or
 * ledger write: the repository's `.mstarc` `[linear]` block (is the mirror on,
 * and for which team) and the store's project binding (which remote project).
 * The git identity comes last, because it is the fact the marker is stamped
 * with and its refusal names the config command that supplies it.
 * why: the order matters - the cheaper refusal answers first, before any store write.
 */
async function resolveTarget(invocation: InvocationContext, input: Input): Promise<Target> {
  const projectId = requireValue(input.project, "--project");
  const harnessDir =
    resolveProcessHarnessDir(invocation.cwd, input.harness) ?? input.harness ?? invocation.controlRoot ?? invocation.cwd;
  // why: The root is resolved ONCE and passed in: the harness's own checkout wins,
  // and a harness that lives outside any checkout falls back to the invocation's.
  const repoRoot = resolveRepoRoot(harnessDir) ?? resolveRepoRoot(invocation.cwd) ?? invocation.cwd;
  const repo = readRepoLinearBinding(repoRoot);
  if (repo.kind === "absent") throw refused(repo.code, stripCode(repo.message));
  if (repo.kind === "invalid") throw refused(repo.code, stripCode(repo.message));
  if (!repo.binding.enabled) {
    throw refused(
      "linear.provider-disabled",
      "a [linear] block exists in " + repo.file + " but enabled is not true, so this repository mirrors nothing",
    );
  }
  const binding = await collaborationBinding(harnessDir, projectId);
  if (binding === null) {
    throw refused(
      "linear.binding-absent",
      "project " + projectId + " mirrors no external project in its collaboration store yet. Bind one with " +
        "`mstar project bind --project " + projectId + " --provider linear --remote-project <name-or-id> --operation <id>`",
    );
  }
  if (binding.provider !== "linear") {
    throw refused(
      "linear.provider-disabled",
      "project " + projectId + " mirrors provider " + JSON.stringify(binding.provider) + "; this command drives a linear binding only",
    );
  }
  const identity = readRepoIdentity(repoRoot, repo.binding.repo);
  if (!identity.ok) throw refused(identity.code, stripCode(identity.message));
  return {
    projectId,
    bindingId: "linear:" + projectId,
    harnessDir,
    linear: repo.binding,
    project: binding,
    repoRoot,
    remoteProject: binding.remoteProject,
    identity: { repo: identity.repo, author: identity.author },
  };
}

/** note: A refusal message without its leading `[code]` - the envelope re-adds it. */
function stripCode(message: string): string {
  return message.replace(/^\[[^\]]+\]\s*/, "");
}

/** note: The push context one ledger write carries: identity, mapping and the run token. */
function pushContextFor(target: Target, runId: string | undefined): PushContext {
  return {
    bindingId: target.bindingId,
    identity: target.identity,
    mapping: target.linear.mapping,
    ...(runId === undefined ? {} : { runId }),
  };
}

/** note: The binding row as the collaboration lane holds it; the mirror's only binding source. */
const BINDING_SQL =
  "select project_id, provider, workspace, team, remote_project, revision, updated_at from project_bindings where project_id = ?";

function bindingOf(row: Record<string, unknown>): ProjectBinding {
  return {
    projectId: row.project_id as string,
    provider: row.provider as string,
    workspace: row.workspace as string,
    team: row.team as string,
    remoteProject: row.remote_project as string,
    revision: row.revision as number,
    updatedAt: row.updated_at as string,
  };
}

/**
 * note: The project binding, read through the collaboration boundary: after the
 * cutover the binding lives in the repository's collaboration store, so no
 * execution table is consulted and a clone with no execution store can still
 * plan and record. `db` may be a read handle or the transaction's own connection.
 */
function bindingOn(db: StoreDb, projectId: string): ProjectBinding | null {
  const row = db.prepare(BINDING_SQL).get(projectId) as Record<string, unknown> | undefined;
  return row === undefined ? null : bindingOf(row);
}

/** note: The resolved binding, read through the collaboration read handle. */
async function collaborationBinding(harnessDir: string, projectId: string): Promise<ProjectBinding | null> {
  const handle = await openCollaborationStore({ harnessDir }, "read");
  try {
    return bindingOn(handle.db, projectId);
  } finally {
    handle.close();
  }
}

/** note: The binding row's facts, as one comparable line. */
function projectStampOf(binding: ProjectBinding): string {
  return JSON.stringify([binding.provider, binding.workspace, binding.team, binding.remoteProject, binding.revision]);
}

/** note: The `.mstarc` connection facts, including the facet mapping they resolve to. */
function linearStampOf(linear: LinearBinding): string {
  return JSON.stringify([linear.enabled, linear.mode, linear.workspace, linear.team, linear.repo, linear.mapping]);
}

/**
 * invariant: The complete destination one run is opened under: the collaboration generation
 * it belongs to, the marker identity its payloads carry, the repository's effective
 * `[linear]` connection, and the project binding row. A run's proof is this whole
 * line, so a changed workspace, a different mapping, a changed git author or
 * repository, a rebind, or a restored image (new epoch) all refuse continuation
 * instead of recording a cached result under a new destination.
 */
function runStampOf(target: Target, authority: CollaborationAuthority): string {
  return (
    "binding=" +
    JSON.stringify({
      storeId: authority.storeId,
      epoch: authority.epoch,
      // why: the marker's repo and author are stamped into every payload, so a new
      // author or repository would confirm a write the planned marker never named.
      marker: { repo: target.identity.repo, author: target.identity.author },
      linear: linearStampOf(target.linear),
      project: projectStampOf(target.project),
    })
  );
}

/**
 * note: One sync effect on the collaboration authority. `withSyncWrite` takes
 * `BEGIN IMMEDIATE`, re-verifies the repository binding and active state under
 * the lock, commits, and owns the single collaboration revision advance of that
 * commit; the ledger and ingest verbs below never open a transaction of their own.
 *
 * The project binding is re-read from the COLLABORATION store inside that
 * transaction — the lane that owns it after the cutover — and re-proved against
 * the facts this command resolved, so a rebind or a `.mstarc` edit between
 * resolution and the write refuses instead of retargeting the ledger at another
 * remote destination. No execution table is consulted on this path.
 */
async function syncWrite<T>(
  target: Target,
  apply: (db: StoreDb, authority: CollaborationAuthority) => T,
): Promise<T> {
  return withSyncWrite({ harnessDir: target.harnessDir }, (db, authority) => {
    requireBindingUnderLock(db, target);
    return apply(db, authority);
  });
}

/** invariant: Refuse when the binding this command resolved is no longer the binding in force. */
function requireBindingUnderLock(db: StoreDb, target: Target): void {
  const current = bindingOn(db, target.projectId);
  if (current === null) {
    throw refused(
      "linear.binding-absent",
      "project " + target.projectId + " mirrors no external project in its collaboration store, so this ledger write has no " +
        "destination. Bind one with `mstar project bind --project " + target.projectId + " --provider linear --remote-project <name-or-id> --operation <id>`",
    );
  }
  // why: the `.mstarc` connection is the other half of the destination, and it is a
  // file: re-reading it here catches an edit no transaction can lock.
  const repo = readRepoLinearBinding(target.repoRoot);
  const linear = repo.kind === "bound" ? linearStampOf(repo.binding) : null;
  if (projectStampOf(current) !== projectStampOf(target.project) || linear !== linearStampOf(target.linear)) {
    throw refused(
      "collaboration.stale-binding",
      "project " + target.projectId + "'s binding changed after this command read it, so this ledger write would target a " +
        "different remote destination",
    );
  }
}

/**
 * note: A run belongs to the exact destination and authority generation it was
 * opened under, and says so in its own record (`sync_runs.reason`): the
 * collaboration store id and epoch, the effective `[linear]` connection, and the
 * project binding row. Continuation therefore refuses a rebind, a changed
 * workspace or mapping, and a restored image whose new epoch retired the run.
 */
function requireRunBinding(run: RunLease, target: Target, authority: CollaborationAuthority): void {
  const stamp = runStampOf(target, authority);
  if (!run.reason.endsWith(stamp)) {
    throw refused(
      "collaboration.stale-binding",
      "run " + run.runId + " was opened under a different destination or collaboration generation than the one in force for " +
        "project " + target.projectId + ", so its results cannot be recorded here. Retire that run with `mstar issue-sync apply " +
        "--project " + target.projectId + " --results <file|-> --take-run` and an empty result list, then run `mstar issue-sync " +
        "pending --project " + target.projectId + "` to open a run under the current one",
    );
  }
}

/**
 * note: Only a `mirror` repository delivers to Linear. `local` holds the same
 * authority over the same rows and never pushes or ingests remote data, and a
 * `remote` repository's collaboration authority is the provider itself: this
 * mirror lane must never become its delivery route.
 */
function requireMirror(authority: CollaborationAuthority): void {
  if (authority.mode !== "mirror") {
    throw refused(
      "collaboration.mode-unavailable",
      "this repository's collaboration mode is " + JSON.stringify(authority.mode) + ", and issue-sync is the one-way mirror " +
        "delivery lane only: it never pushes to or ingests from Linear for local or remote authority",
    );
  }
}

/**
 * Read a JSON argument: a file path, or `-` for stdin. An unreadable path or a
 * body that is not JSON is a USAGE refusal naming the flag - the caller
 * mistyped it, and no store work has happened yet.
 * why: `-` for stdin keeps payloads out of process argument lists and shell history.
 */
async function readJsonArgument(invocation: InvocationContext, value: string | undefined, flag: string): Promise<unknown> {
  const source = requireValue(value, flag);
  let raw: string;
  if (source === "-") {
    raw = await invocation.effects.readInput();
  } else {
    try {
      raw = readFileSync(source, "utf8");
    } catch (error) {
      throw new UsageError(flag + " " + source + " cannot be read: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  if (raw.trim() === "") {
    throw new UsageError(flag + " received no content; pass a JSON array (use [] for an empty one)");
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new UsageError(flag + " is not valid JSON: " + (error instanceof Error ? error.message : String(error)));
  }
}

/** note: `pending`'s item: the plan a caller's tools write, in the frozen envelope shape. */
type PendingReport = {
  binding: { provider: "linear"; workspace: string; team: string; remoteProject: string };
  identity: { repo: string; author: string };
  runId: string;
  items: PushPlan[];
  skipped: Array<{ localId: string; reason: string }>;
  unresolved: Array<{ localId: string; cause: string }>;
};

/**
 * note: Plan every pushable item and hand the caller the payloads. No Linear call is
 * made here, and the run lease stays HELD: the caller's tools run between this
 * verb and `apply`, which ends the run.
 */
async function runPending(id: string, input: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
  const target = await resolveTarget(invocation, input);
  return syncWrite(target, (db, authority) => {
    requireMirror(authority);
    // why: One run per binding, claimed before any candidate work. `pending` does not
    // release it: the lease covers the caller's tool calls as much as this
    // process, and `apply` is what ends the run. The run records the binding
    // generation it was opened under, which every continuation re-proves.
    const run = acquireRun(db, {
      bindingId: target.bindingId,
      direction: PUSH_DIRECTION,
      holderPid: process.pid,
      holderHost: hostname(),
      reason: "issue-sync pending " + runStampOf(target, authority),
    });
    const push = pushContextFor(target, run.runId);
    const report: PendingReport = {
      binding: {
        provider: "linear",
        workspace: target.linear.workspace,
        team: target.linear.team,
        remoteProject: target.remoteProject,
      },
      identity: target.identity,
      runId: run.runId,
      items: [],
      skipped: [],
      unresolved: [],
    };
    for (const candidate of selectPushCandidates(db, target.bindingId)) {
      const outcome: PlanOutcome = planPushItem(db, push, candidate);
      if (outcome.outcome === "planned") report.items.push(outcome.plan);
      else if (outcome.outcome === "skipped") report.skipped.push({ localId: outcome.localId, reason: outcome.reason });
      else report.unresolved.push({ localId: outcome.localId, cause: outcome.cause });
    }
    return envelope(id, report);
  });
}

/**
 * One entry of the `apply` report. `outcome` echoes the CALLER'S word
 * (confirmed/refused/ambiguous) exactly as it handed it in; the ledger state
 * each word produced appears only in `counts` (applied/unconfirmed/refused), so
 * the two vocabularies never mix inside one field.
 * why: the caller's word and the ledger state are different vocabularies and must not mix.
 */
type ApplyItem = { localId: string; outcome: "confirmed" | "refused" | "ambiguous"; externalId: string | null; cause?: string };
type ApplyReport = {
  projectId: string;
  bindingId: string;
  runId: string;
  adopted: Array<{ localId: string; externalId: string | null }>;
  released: string[];
  /** note: whether this call ended the run it used, or left a borrowed lease to its holder. */
  lease: "released" | "left-to-the-holder";
  items: ApplyItem[];
  counts: { applied: number; unconfirmed: number; refused: number };
};

/**
 * Parse `--adopt <localId>=<issueUrl|externalId>`. The FIRST `=` splits, so an
 * identifier containing one survives; a value with no `=` is a usage error
 * rather than a silently ignored flag.
 * why: an unparseable pair must be refused loudly, never silently dropped or half-read.
 */
function adoptPairs(values: readonly string[] | undefined): Array<{ localId: string; reference: string }> {
  return (values ?? []).map((value) => {
    const split = value.indexOf("=");
    if (split <= 0 || split === value.length - 1) {
      throw new UsageError("--adopt expects <localId>=<issueUrl|externalId>; received " + JSON.stringify(value));
    }
    return { localId: value.slice(0, split).trim(), reference: value.slice(split + 1).trim() };
  });
}

/**
 * note: Operator verbs are validated against each other before the first write, so a
 * self-contradicting request cannot land half-applied behind a later refusal.
 */
function assertOperatorVerbsAgree(
  adoptions: ReadonlyArray<{ localId: string; reference: string }>,
  released: ReadonlySet<string>,
  forcedAdopt: ReadonlySet<string>,
): void {
  const adopted = new Map<string, string>();
  for (const { localId, reference } of adoptions) {
    const first = adopted.get(localId);
    if (first !== undefined) {
      throw new SyncError(
        "sync.operator-conflict",
        "--adopt names " + localId + " twice (" + first + ", " + reference + "), but one local item has one remote identity; " +
          "keep the pair that is the right issue and re-run; nothing was written",
      );
    }
    adopted.set(localId, reference);
  }
  for (const localId of adopted.keys()) {
    if (released.has(localId)) {
      throw new SyncError(
        "sync.operator-conflict",
        "--adopt and --release both name " + localId + "; adopting records a remote identity for the item, releasing " +
          "clears a pending create that has none, so they cannot describe one item in one run. Keep the verb that " +
          "matches what you saw and re-run; nothing was written",
      );
    }
  }
  for (const localId of forcedAdopt) {
    if (!adopted.has(localId)) {
      throw new SyncError(
        "sync.operator-conflict",
        "--force-adopt names " + localId + ", but --adopt does not; the flag only relaxes the identity replacement for " +
          "one --adopt entry. Add --adopt " + localId + "=<issueUrl|externalId> with the reference that is really right, " +
          "or drop --force-adopt, and re-run; nothing was written",
      );
    }
  }
}

/**
 * Validate the caller's results. A well-formed entry becomes a ledger write; an
 * ill-formed one does NOT abort the run - the frozen contract says a missing
 * field is that entry's refusal in the report.
 * why: per-item validation keeps one malformed entry from failing the whole run.
 * why: per-entry refusals keep the caller's word so the report reads like the input.
 */
/** note: A per-item validation refusal keeps the caller's word and carries the cause. */
function refusedItem(localId: string, cause: string): ApplyItem {
  return { localId, outcome: "refused", externalId: null, cause };
}

function parseResults(raw: unknown): { results: PushResult[]; refused: ApplyItem[] } {
  if (!Array.isArray(raw)) {
    throw new UsageError("--results must be a JSON array of {localId, outcome, externalId?, remoteUpdatedAt?, cause?} entries");
  }
  const results: PushResult[] = [];
  const refused: ApplyItem[] = [];
  raw.forEach((entry, index) => {
    const name = "(entry " + index + ")";
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      refused.push(refusedItem(name, "not a JSON object"));
      return;
    }
    const record = entry as Record<string, unknown>;
    const localId = typeof record.localId === "string" ? record.localId.trim() : "";
    if (localId === "") {
      refused.push(refusedItem(name, "no localId"));
      return;
    }
    const outcome = record.outcome;
    if (outcome !== "confirmed" && outcome !== "refused" && outcome !== "ambiguous") {
      refused.push(refusedItem(localId, 'outcome must be "confirmed", "refused" or "ambiguous"'));
      return;
    }
    const externalId =
      typeof record.externalId === "string" && record.externalId.trim() !== "" ? record.externalId.trim() : null;
    if (outcome === "confirmed" && externalId === null) {
      refused.push(refusedItem(localId, "a confirmed result must name the remote issue in externalId"));
      return;
    }
    results.push({
      localId,
      outcome,
      ...(externalId === null ? {} : { externalId }),
      ...(typeof record.url === "string" ? { url: record.url } : {}),
      ...(typeof record.remoteUpdatedAt === "string" ? { remoteUpdatedAt: record.remoteUpdatedAt } : {}),
      ...(typeof record.cause === "string" ? { cause: record.cause } : {}),
    });
  });
  return { results, refused };
}

/**
 * note: the identity a caller-supplied result names, through the same normalizer `--adopt`
 * uses, so `LIN-9` and the issue URL that resolves to it compare equal.
 * why: a value the normalizer rejects cannot match any adoption, and the recorder reports it
 * per item, so the preflight stays out of that decision.
 */
function normalizedOrNull(externalId: string): string | null {
  try {
    return externalIdOf(externalId);
  } catch {
    return null;
  }
}

/**
 * Refuse an apply whose results were planned BEFORE the run it would continue.
 *
 * A continuation borrows the held run's token, so an old retry must not continue a
 * run that a later `pending` opened: it would write under that holder's token. The
 * evidence is the claim timestamp of every create cycle in the results — a cycle
 * claimed before the held run started cannot have been planned by it.
 *
 * why: an explicit `--adopt` in this same invocation is not that stale retry: it
 * validates and records the identity before the results are read, so a stale
 * result it covers is admitted, and the return value says so - that batch runs
 * under a lease it did NOT acquire, so its caller must leave the lease alone. A
 * stale result no adoption covers, or a confirmed one naming an identity the
 * adoption does not record, is still refused: nothing makes that write sane.
 *
 * shortcut: the check needs a create cycle to compare, so an empty `--results`
 * (or one naming only updates) has no evidence and continues the held run; and a
 * `--take-run` replacement keeps the original start by design, so a retry racing
 * a takeover is not detectable this way. upgrade: add an explicit run token to
 * `apply` when either bound starts to matter.
 */
function assertApplyOwnsHeldRun(
  db: StoreDb,
  target: Target,
  held: RunLease | null,
  takeRun: boolean,
  results: readonly PushResult[],
  adoptedIdentities: ReadonlyMap<string, string>,
): void {
  if (takeRun || held === null) return;
  const unadopted = results.find((result) => {
    const row = readItem(db, { bindingId: target.bindingId, direction: PUSH_DIRECTION, localId: result.localId });
    const stale =
      row !== null && row.itemState === "pending" && row.externalId === null && isOlderInstant(row.updatedAt, held.startedAt);
    if (!stale) return false;
    // why: an explicit `--adopt` in the SAME invocation establishes the identity
    // before the results are recorded, so the documented recovery composition is
    // not a stale apply: the adoption, not the older run, carries the identity.
    const adopted = adoptedIdentities.get(result.localId);
    if (adopted === undefined) return true;
    // why: both sides go through the same normalizer, so a `--adopt` that names a
    // Linear URL covers the result that names the identifier it resolves to.
    const named = result.externalId === null || result.externalId === undefined ? null : normalizedOrNull(result.externalId);
    // why: a confirmed result must name the identity the adoption records; a
    // different one is the identity conflict the recorder refuses per item, and
    // the batch cannot be made sane by proceeding.
    if (result.outcome === "confirmed" && named !== adopted) return true;
    return false;
  });
  if (unadopted !== undefined) {
    // why: the recovery is NOT the run-held one - `--take-run` would bypass this very
    // guard, while the stale result is repaired by naming the identity it is about.
    throw refused(
      "sync.run-held",
      "these results belong to an earlier run: " + JSON.stringify(unadopted.localId) + " was claimed before the run now holding " +
        target.bindingId + " started (" + held.startedAt + "), so this apply cannot continue it and the lease is untouched. Name the " +
        "remote identity the result is about with `mstar issue-sync apply --project <project-id> --adopt <localId>=<issueUrl|externalId>`, " +
        "or associate it by its marker with `mstar issue-sync ingest --project <project-id> --records <file|->`, then re-run this apply",
      "Record the identity this result is about, then re-run the apply. " +
        "`mstar issue-sync apply --project <project-id> --results <file|-> --adopt <localId>=<issueUrl|externalId>` names it in the same " +
        "invocation, and `mstar issue-sync ingest --project <project-id> --records <file|->` associates the issue by its marker first. " +
        "`--take-run` is not the repair here: it would bypass the ownership check that refused this batch",
    );
  }
}

/**
 * Record the caller's results, then END the run.
 *
 * The run is CONTINUED (same token), not re-acquired: `pending` claimed it and
 * left it held for exactly these tool calls. `--take-run` replaces a holder the
 * operator confirmed dead; with no run row at all - the normal case when
 * `pending` ran in a session that already released - this acquires a fresh one
 * so every write still carries a token.
 * why: apply both continues the held run and ends it, so the lease survives exactly
 * these writes - unless the batch was admitted only through adoption coverage: then
 * it borrowed a lease it never acquired, leaves it to its holder, and says so in
 * the report.
 */
async function runApply(id: string, input: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
  const adoptions = adoptPairs(input.adopt);
  const forcedAdopt = new Set((input.forceAdopt ?? []).map((value) => value.trim()).filter((value) => value !== ""));
  const released = new Set((input.release ?? []).map((value) => value.trim()).filter((value) => value !== ""));
  const takeRun = input.takeRun === true;
  assertOperatorVerbsAgree(adoptions, released, forcedAdopt);
  const namedRun = typeof input.run === "string" ? input.run.trim() : undefined;
  if (namedRun !== undefined && takeRun) {
    throw new UsageError(
      "--run names the run these results continue; --take-run replaces the holder instead. Pass one of them",
    );
  }

  const target = await resolveTarget(invocation, input);
  const parsed = parseResults(await readJsonArgument(invocation, input.results, "--results"));
  const recordsResults = parsed.results.length > 0;
  // why: Raw results are only meaningful as the answer to a plan this repository
  // recorded. A batch that names no run cannot be attributed to one, and a
  // takeover never records results — it exists to release a dead holder.
  if (recordsResults && takeRun) {
    throw refused(
      "sync.run-held",
      "a takeover records no results: it only replaces a holder you confirmed dead. Take the run over with an empty " +
        "result list (\`--results -\` carrying \`[]\`), then record these results under the run id the takeover returns",
    );
  }
  // why: an ordinary cycle that planned nothing (empty project, every item skipped or
  // unresolved) is completed by naming its own run with an empty list; that is a
  // completion, not a borrow. Anything unnamed must name what it records instead.
  if (!recordsResults && adoptions.length === 0 && released.size === 0 && !takeRun && namedRun === undefined) {
    throw new UsageError(
      "--results carries no entries and no operator verb was given, so there is nothing to record. Pass the results your " +
        "Linear tools returned, `--adopt <localId>=<issueUrl|externalId>` / `--release <localId>`, or `--run <runId>` with " +
        "an empty list to complete the run `pending` returned when it planned no work",
    );
  }
  if (recordsResults && namedRun === undefined) {
    throw refused(
      "sync.run-held",
      "these results are unattributed: pass \`--run <runId>\` with the id the \`pending\` report returned for them. A result " +
        "from an earlier attempt is not attributable to any run — reconcile it with \`mstar issue-sync ingest --project " +
        target.projectId + " --records <file|->\`, or name the remote issue it is about with \`--adopt <localId>=<issueUrl|externalId>\`",
    );
  }
  return syncWrite(target, (db, authority) => {
    requireMirror(authority);
    // why: the ownership preflight below must see the identities this invocation
    // already validates, so every operator verb is checked before it, not after.
    const adoptedIdentities = new Map<string, string>();
    for (const { localId, reference } of adoptions) {
      const externalId = externalIdOf(reference);
      const existing = readItem(db, { bindingId: target.bindingId, direction: PUSH_DIRECTION, localId });
      const conflict = identityConflict(existing, localId, externalId);
      if (conflict !== null && !forcedAdopt.has(localId)) throw conflict;
      adoptedIdentities.set(localId, externalId);
    }
    assertReleaseTargets(db, target.bindingId, released);

    const held = readRun(db, { bindingId: target.bindingId, direction: PUSH_DIRECTION });
    // why: a stale create cycle this run did not open may only be recorded through the
    // adoption that names its identity; the preflight refuses the rest before a write.
    if (recordsResults) {
      assertApplyOwnsHeldRun(db, target, held, takeRun, parsed.results, adoptedIdentities);
    }
    // why: raw results continue the run the caller NAMED and nothing else — not the
    // currently held token, not a fresh one. An operator-only batch (adopt/release)
    // is an explicitly confirmed action, so it may borrow the held lease or open one
    // so every ledger write still carries a token.
    let active: RunLease;
    if (namedRun !== undefined) {
      if (held === null) {
        throw refused(
          "sync.run-held",
          "no run holds " + target.bindingId + " now, so --run " + JSON.stringify(namedRun) +
            " continues nothing. Run `mstar issue-sync pending --project " + target.projectId + "` and pass the runId it returns",
        );
      }
      if (held.runId !== namedRun) {
        throw refused(
          "sync.run-held",
          "--run " + JSON.stringify(namedRun) + " does not name the run holding " + target.bindingId + " now (" +
            JSON.stringify(held.runId) + ", started " + held.startedAt + "). These results belong to another run: apply the " +
            "runId the current `pending` returned, or end that run with `--take-run` and an empty result list once you " +
            "confirmed its holder is dead, then re-plan",
        );
      }
      requireRunBinding(held, target, authority);
      active = held;
    } else if (takeRun) {
      if (held === null) {
        throw refused(
          "sync.run-held",
          "no run holds " + target.bindingId + ", so there is nothing to take over. Run `mstar issue-sync pending --project " +
            target.projectId + "` to open one",
        );
      }
      // why: a takeover clears a dead holder without recording anything, and it
      // restamps the run under the binding in force, which is how a superseded run
      // is retired after a rebind.
      active = acquireRun(db, {
        bindingId: target.bindingId,
        direction: PUSH_DIRECTION,
        holderPid: process.pid,
        holderHost: hostname(),
        reason: "operator took the run over with --take-run " + runStampOf(target, authority),
        takeRun: true,
      });
    } else if (held === null) {
      active = acquireRun(db, {
        bindingId: target.bindingId,
        direction: PUSH_DIRECTION,
        holderPid: process.pid,
        holderHost: hostname(),
        reason: "issue-sync apply " + runStampOf(target, authority),
      });
    } else {
      requireRunBinding(held, target, authority);
      active = held;
    }
    // why: only a run this invocation acquired (a fresh one, a takeover, or the exact
    // run it named) may be ended here. An operator-only batch that found a run held by
    // someone else borrowed that lease and must leave it intact: its holder may still
    // be inside a provider call, and its own exact-token results must remain valid.
    const ownsRun = namedRun !== undefined || takeRun || held === null;
    const push = pushContextFor(target, active.runId);
    const report: ApplyReport = {
      projectId: target.projectId,
      bindingId: target.bindingId,
      runId: active.runId,
      adopted: [],
      released: [],
      // why: an operator who adopted a residue needs to know the newer holder still
      // owns the direction, or the next `pending` refusal looks unexplained.
      lease: ownsRun ? "released" : "left-to-the-holder",
      items: [...parsed.refused],
      counts: { applied: 0, unconfirmed: 0, refused: parsed.refused.length },
    };

    // why: Operator-confirmed adoptions are ordinary ledger verbs: the row takes the
    // identity and forgets the previous one's proof, so the next `pending`
    // converges this item's content onto the adopted issue instead of reporting
    // it unchanged.
    for (const { localId, reference } of adoptions) {
      const adopted = adoptItem(db, target.bindingId, localId, reference, {
        force: forcedAdopt.has(localId),
        runId: active.runId,
      });
      report.adopted.push({ localId, externalId: adopted.externalId });
    }

    // why: A release clears a pending create with no remote id after the operator
    // confirmed no issue carries its marker (`ingest` is how that is checked: an
    // associated issue records an external id, which makes this flag refuse).
    if (released.size > 0) {
      reconcileWith(db, push, [], { release: released });
      report.released = [...released];
    }

    for (const outcome of recordResults(db, push, parsed.results)) {
      report.items.push({
        localId: outcome.localId,
        // why: The CALLER'S word, echoed: `confirmed` stays `confirmed` whether the
        // ledger landed `applied` or refused the entry as unclaimed; the ledger
        // state it produced shows only in `counts`.
        outcome: outcome.outcome === "applied" ? "confirmed" : outcome.outcome === "unconfirmed" ? "ambiguous" : "refused",
        externalId: outcome.externalId,
        ...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
      });
      if (outcome.outcome === "applied") report.counts.applied += 1;
      else if (outcome.outcome === "unconfirmed") report.counts.unconfirmed += 1;
      else report.counts.refused += 1;
    }
    // invariant: The run ends in the commit that recorded its results, and only when this
    // invocation owns it (exact named run, takeover, or a run it acquired): a lease
    // merely borrowed by an operator-only batch belongs to its holder. A batch that
    // refuses before this point rolls back whole, so the run a `pending` opened stays
    // held and the same results can be re-sent under its id.
    if (ownsRun) {
      releaseRun(db, { bindingId: target.bindingId, direction: PUSH_DIRECTION, runId: active.runId });
    }
    return envelope(id, report);
  });
}
/**
 * Validate a listing the caller fetched. Unlike `--results`, an ill-formed
 * listing is the caller's own defect and nothing has been written yet, so it is
 * a usage refusal naming the entry - the association rule never sees a
 * half-built record.
 * why: a malformed listing is the caller's defect and must be refused before any ledger write.
 */
function parseRecords(raw: unknown): Array<{
  externalId: string;
  url: string;
  title: string;
  description: string;
  state: string;
  priority: string | null;
  labels: string[];
  updatedAt: string;
}> {
  if (!Array.isArray(raw)) {
    throw new UsageError(
      "--records must be a JSON array of {externalId, title, description, state, priority, labels, updatedAt} entries",
    );
  }
  return raw.map((entry, index) => {
    const name = "--records[" + index + "]";
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new UsageError(name + " is not a JSON object");
    }
    const record = entry as Record<string, unknown>;
    const externalId = typeof record.externalId === "string" ? record.externalId.trim() : "";
    if (externalId === "") throw new UsageError(name + " has no externalId");
    const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt.trim() : "";
    if (updatedAt === "" || Number.isNaN(Date.parse(updatedAt))) {
      throw new UsageError(name + " needs an ISO-8601 updatedAt; the ledger records it as the remote revision");
    }
    // why: title and state are not defaulted: a malformed record would become a fake
    // drift report against real ledger facts, so it is refused per item instead.
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (title === "") throw new UsageError(name + " has no title; mstar never guesses remote content");
    const state = typeof record.state === "string" ? record.state.trim() : "";
    if (state === "") throw new UsageError(name + " has no state; the drift check compares it with the pushed payload");
    const text = (value: unknown): string => (typeof value === "string" ? value : "");
    const labels = Array.isArray(record.labels)
      ? record.labels.filter((label): label is string => typeof label === "string")
      : [];
    return {
      externalId,
      url: text(record.url),
      title,
      description: text(record.description),
      state,
      priority: typeof record.priority === "string" ? record.priority : null,
      labels,
      updatedAt,
    };
  });
}

/** note: `ingest`'s envelope: the five association buckets, counted and listed. */
type IngestEnvelope = IngestReport & {
  projectId: string;
  bindingId: string;
  identity: { repo: string; author: string };
  counts: { associated: number; drift: number; foreign: number; orphan: number; unmanaged: number };
};

/**
 * note: Associate a listing with the local rows it mirrors. mstar makes no Linear call
 * and writes no local issue: the ledger's association is the whole effect.
 */
async function runIngest(id: string, input: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
  const target = await resolveTarget(invocation, input);
  const records = parseRecords(await readJsonArgument(invocation, input.records, "--records"));
  return syncWrite(target, (db, authority) => {
    requireMirror(authority);
    // why: An association recorded under a run opened for another binding would
    // attribute these remote issues to a destination this command no longer mirrors.
    const held = readRun(db, { bindingId: target.bindingId, direction: PUSH_DIRECTION });
    if (held !== null) requireRunBinding(held, target, authority);
    const report = ingestRecords(
      db,
      { bindingId: target.bindingId, identity: target.identity, mapping: target.linear.mapping },
      records,
    );
    const data: IngestEnvelope = {
      projectId: target.projectId,
      bindingId: target.bindingId,
      identity: target.identity,
      ...report,
      counts: {
        associated: report.associated.length,
        drift: report.drift.length,
        foreign: report.foreign.length,
        orphan: report.orphan.length,
        unmanaged: report.unmanaged.length,
      },
    };
    return envelope(id, data);
  });
}

export function getIssueSyncCommandDefinitions(): readonly CommandDefinition[] {
  const descriptions: Record<Verb, string> = {
    pending:
      "Plan this project's local issues for the host's Linear tools. NOTHING IS SENT: mstar makes no Linear call, holds no Linear credential and opens no socket. Run this first, then write each item with your own Linear MCP tools (discover their names at runtime) and finish with `issue-sync apply`. Each item carries localId, operation (create when the ledger holds no remote identity yet, update when it does), externalId, the payload to write, and the marker that must stay the LAST line of the description verbatim - it is how a later listing is associated with this local issue. `requestHash` is the skip key: an item whose ledger hash equals it is under `skipped` because the remote already says this, so it costs no tool call; `unresolved` names an unconfirmed earlier create that reconciliation must associate before anything creates again.",
    apply:
      "Record what your Linear tools reported for the items `issue-sync pending` planned, one entry per item: {localId, outcome, externalId?, remoteUpdatedAt?, cause?}. outcome `confirmed` proves delivery and names the remote issue (externalId) plus its revision when the tool returns one; `refused` means provably NOT delivered (a validation or permission error), so the item stays retryable; `ambiguous` means sent but unconfirmed - a create keeps its pending residue and the next ingest associates it by marker, never by guessing a second create. An unknown localId, an entry this run never planned, or a missing field is that entry's refusal in the report, not a failed run. The report echoes your word: `items[].outcome` is the `confirmed`/`refused`/`ambiguous` you sent, while `counts` groups the LEDGER states each produced (`applied`/`unconfirmed`/`refused`) - the two vocabularies are never mixed in one field. `--results` takes a file path or `-` for stdin, and [] records nothing. --adopt <localId>=<issueUrl|externalId> records an identity you confirmed yourself, BEFORE your results are recorded - so for an item named in both, the adopt wins and the entry's `confirmed` must repeat the adopted id or it is refused as a conflict; --force-adopt allows replacing one the row already records; --release <localId> clears a pending create with no remote id after ingest showed no issue carrying its marker (an associated issue records an id, which makes the flag refuse). ONE run per binding, continued from pending and ended here; --take-run replaces a holder you confirmed dead.",
    ingest:
      "Associate a listing your Linear tools returned with the local issues those remote issues mirror. --records takes a file path or - for stdin: [{externalId, url, title, description, state, priority, labels, updatedAt}]. The key is the marker in the description - repo=<owner/name>, local=<issue-id>, author=<Name <email>> - and repo must be this repository, local must exist here, and author must be this checkout's git author. Five buckets, one entry each (localId, externalId, url, and a cause when it is not a clean association): associated (recorded in the ledger, converged), drift (needs your judgement, nothing rewritten: the remote content no longer matches what mstar last confirmed, two remote issues claim one local issue, or the ledger row cannot take the association because a released create left it failed - the cause names the recovery), foreign (another operator's clone of this repository pushed it), orphan (the local issue is gone), unmanaged (no marker, a marker of the retired format, or another repository's - never adopted by title). No local issue is created, updated or closed.",
  };
  return verbs.map((verb) => {
    const id = "issue-sync." + verb;
    const requirements: CommandRequirement[] = (["cli", "mcp"] as const).flatMap((route): CommandRequirement[] =>
      options[verb].map((key) => ({
        name: key,
        ownership: "caller" as const,
        route,
        required: required[verb].includes(key),
        ...(variadicOptions[key] === true ? { constraint: "optional, repeatable: one local item per value" } : {}),
      })),
    );
    return {
      id,
      cli: {
        path: ["issue-sync", verb],
        aliases: [],
        arguments: [],
        options: options[verb].map((key) => ({
          key,
          flags: flags[key],
          required: required[verb].includes(key),
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
          if (verb === "pending") return await runPending(id, value, invocation);
          if (verb === "apply") return await runApply(id, value, invocation);
          return await runIngest(id, value, invocation);
        } catch (error) {
          // shortcut: the wrapper picks the recovery from its per-code RECOVERY map, so a
          // wrapper call site has no provable recovery argument; exemption under I-000872.
          // upgrade: when the prover resolves a wrapper's own map lookup, drop the exemption.
          if (error instanceof SyncError) return refusalFor(id, error.code, stripCode(error.message));
          return failure(id, error);
        }
      },
    } satisfies CommandDefinition;
  });
}

