/**
 * issue-sync family — the local half of the Linear mirror. Three verbs, no
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
  openStore,
  PUSH_DIRECTION,
  planPushItem,
  readItem,
  readProjectBinding,
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
  type IngestEntry,
  type IngestReport,
  type LinearBinding,
  type LinearFacetMapping,
  type PlanOutcome,
  type PushContext,
  type PushPlan,
  type PushResult,
  type RunLease,
} from "@mstar-harness/engine";
import { z } from "zod";
import { commandEnvelopeSchema } from "../envelope.js";
import type { CommandDefinition, CommandEnvelope, CommandRequirement, InvocationContext } from "../types.js";

/**
 * One schema PER VERB: the CLI syntax keys must equal the schema keys, so a
 * shared schema would force `ingest` to accept `--adopt` and vice versa.
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
};

const options: Record<Verb, (keyof Input)[]> = {
  pending: ["project", "harness"],
  apply: ["project", "results", "adopt", "forceAdopt", "release", "takeRun", "harness"],
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

/** A refusal that survives the trip to the envelope, with its frozen code. */
function refused(code: string, message: string): Error {
  return Object.assign(new Error("[" + code + "] " + message), { code });
}

/**
 * Recovery text per refusal: every one names a documented entry to run, and
 * none of them tells the operator to hand-edit a credential file.
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
    recovery: RECOVERY[code] ?? "Read the cause, resolve it, and re-run `mstar issue-sync " + verbOf(id) + " --help`.",
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
  // the exemption is refreshed under I-000872. Upgrade when it can read element access.
  return refusalEnvelope({
    command: id,
    status: "refused",
    code,
    exitCode: 1,
    message: error instanceof Error ? error.message : String(error),
    details: { operation: id, ...facts.details },
    recovery: facts.recovery ?? RECOVERY[code] ?? "Read the cause, resolve it, and re-run `mstar issue-sync " + verbOf(id) + " --help`.",
  });
}

function verbOf(id: string): string {
  const dot = id.indexOf(".");
  return dot === -1 ? id : id.slice(dot + 1);
}

/** Everything a verb needs from the declarations, resolved once, before any write. */
type Target = {
  projectId: string;
  bindingId: string;
  harnessDir: string;
  binding: LinearBinding;
  remoteProject: string;
  identity: { repo: string; author: string };
};

/**
 * Read the two declarations this family runs on, in order, before any store or
 * ledger write: the repository's `.mstarc` `[linear]` block (is the mirror on,
 * and for which team) and the store's project binding (which remote project).
 * The git identity comes last, because it is the fact the marker is stamped
 * with and its refusal names the config command that supplies it.
 */
async function resolveTarget(invocation: InvocationContext, input: Input): Promise<Target> {
  const projectId = requireValue(input.project, "--project");
  const harnessDir =
    resolveProcessHarnessDir(invocation.cwd, input.harness) ?? input.harness ?? invocation.controlRoot ?? invocation.cwd;
  // The root is resolved ONCE and passed in: the harness's own checkout wins,
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
  const binding = await readProjectBinding({ harnessDir }, projectId);
  if (binding.kind === "absent") throw refused(binding.code, stripCode(binding.message));
  if (binding.binding.provider !== "linear") {
    throw refused(
      "linear.provider-disabled",
      "project " + projectId + " mirrors provider " + JSON.stringify(binding.binding.provider) + "; this command drives a linear binding only",
    );
  }
  const identity = readRepoIdentity(repoRoot, repo.binding.repo);
  if (!identity.ok) throw refused(identity.code, stripCode(identity.message));
  return {
    projectId,
    bindingId: "linear:" + projectId,
    harnessDir,
    binding: repo.binding,
    remoteProject: binding.binding.remoteProject,
    identity: { repo: identity.repo, author: identity.author },
  };
}

/** A refusal message without its leading `[code]` - the envelope re-adds it. */
function stripCode(message: string): string {
  return message.replace(/^\[[^\]]+\]\s*/, "");
}

/** The push context one ledger write carries: identity, mapping and the run token. */
function pushContextFor(target: Target, runId: string | undefined): PushContext {
  return {
    bindingId: target.bindingId,
    identity: target.identity,
    mapping: target.binding.mapping,
    ...(runId === undefined ? {} : { runId }),
  };
}

/**
 * Read a JSON argument: a file path, or `-` for stdin. An unreadable path or a
 * body that is not JSON is a USAGE refusal naming the flag - the caller
 * mistyped it, and no store work has happened yet.
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

/** `pending`'s item: the plan a caller's tools write, in the frozen envelope shape. */
type PendingReport = {
  binding: { provider: "linear"; workspace: string; team: string; remoteProject: string };
  identity: { repo: string; author: string };
  runId: string;
  items: PushPlan[];
  skipped: Array<{ localId: string; reason: string }>;
  unresolved: Array<{ localId: string; cause: string }>;
};

/**
 * Plan every pushable item and hand the caller the payloads. No Linear call is
 * made here, and the run lease stays HELD: the caller's tools run between this
 * verb and `apply`, which ends the run.
 */
async function runPending(id: string, input: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
  const target = await resolveTarget(invocation, input);
  const handle = await openStore({ harnessDir: target.harnessDir }, "write");
  try {
    const db = handle.db;
    // One run per binding, claimed before any candidate work. `pending` does not
    // release it: the lease covers the caller's tool calls as much as this
    // process, and `apply` is what ends the run.
    const run = acquireRun(db, {
      bindingId: target.bindingId,
      direction: PUSH_DIRECTION,
      holderPid: process.pid,
      holderHost: hostname(),
      reason: "issue-sync pending",
    });
    const push = pushContextFor(target, run.runId);
    const report: PendingReport = {
      binding: {
        provider: "linear",
        workspace: target.binding.workspace,
        team: target.binding.team,
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
  } finally {
    handle.close();
  }
}

/**
 * One entry of the `apply` report. `outcome` echoes the CALLER'S word
 * (confirmed/refused/ambiguous) exactly as it handed it in; the ledger state
 * each word produced appears only in `counts` (applied/unconfirmed/refused), so
 * the two vocabularies never mix inside one field.
 */
type ApplyItem = { localId: string; outcome: "confirmed" | "refused" | "ambiguous"; externalId: string | null; cause?: string };
type ApplyReport = {
  projectId: string;
  bindingId: string;
  runId: string;
  adopted: Array<{ localId: string; externalId: string | null }>;
  released: string[];
  items: ApplyItem[];
  counts: { applied: number; unconfirmed: number; refused: number };
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
      throw new UsageError("--adopt expects <localId>=<issueUrl|externalId>; received " + JSON.stringify(value));
    }
    return { localId: value.slice(0, split).trim(), reference: value.slice(split + 1).trim() };
  });
}

/**
 * Operator verbs are validated against each other before the first write, so a
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
 */
/** A per-item validation refusal keeps the caller's word and carries the cause. */
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
 * Record the caller's results, then END the run.
 *
 * The run is CONTINUED (same token), not re-acquired: `pending` claimed it and
 * left it held for exactly these tool calls. `--take-run` replaces a holder the
 * operator confirmed dead; with no run row at all - the normal case when
 * `pending` ran in a session that already released - this acquires a fresh one
 * so every write still carries a token.
 */
async function runApply(id: string, input: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
  const adoptions = adoptPairs(input.adopt);
  const forcedAdopt = new Set((input.forceAdopt ?? []).map((value) => value.trim()).filter((value) => value !== ""));
  const released = new Set((input.release ?? []).map((value) => value.trim()).filter((value) => value !== ""));
  const takeRun = input.takeRun === true;
  assertOperatorVerbsAgree(adoptions, released, forcedAdopt);

  const target = await resolveTarget(invocation, input);
  const parsed = parseResults(await readJsonArgument(invocation, input.results, "--results"));
  const handle = await openStore({ harnessDir: target.harnessDir }, "write");
  let run: RunLease | null = null;
  try {
    const db = handle.db;
    const held = readRun(db, { bindingId: target.bindingId, direction: PUSH_DIRECTION });
    run =
      takeRun || held === null
        ? acquireRun(db, {
            bindingId: target.bindingId,
            direction: PUSH_DIRECTION,
            holderPid: process.pid,
            holderHost: hostname(),
            reason: takeRun ? "operator took the run over with --take-run" : "issue-sync apply",
            takeRun,
          })
        : held;
    const push = pushContextFor(target, run.runId);
    const report: ApplyReport = {
      projectId: target.projectId,
      bindingId: target.bindingId,
      runId: run.runId,
      adopted: [],
      released: [],
      items: [...parsed.refused],
      counts: { applied: 0, unconfirmed: 0, refused: parsed.refused.length },
    };

    // EVERY operator verb is validated against the ledger BEFORE the first write:
    // a bad `--release` discovered after an `--adopt` had landed would leave the
    // run half-applied behind a usage refusal.
    for (const { localId, reference } of adoptions) {
      const externalId = externalIdOf(reference);
      const existing = readItem(db, { bindingId: target.bindingId, direction: PUSH_DIRECTION, localId });
      const conflict = identityConflict(existing, localId, externalId);
      if (conflict !== null && !forcedAdopt.has(localId)) throw conflict;
    }
    assertReleaseTargets(db, target.bindingId, released);

    // Operator-confirmed adoptions are ordinary ledger verbs: the row takes the
    // identity and forgets the previous one's proof, so the next `pending`
    // converges this item's content onto the adopted issue instead of reporting
    // it unchanged.
    for (const { localId, reference } of adoptions) {
      const adopted = adoptItem(db, target.bindingId, localId, reference, {
        force: forcedAdopt.has(localId),
        runId: run.runId,
      });
      report.adopted.push({ localId, externalId: adopted.externalId });
    }

    // A release clears a pending create with no remote id after the operator
    // confirmed no issue carries its marker (`ingest` is how that is checked: an
    // associated issue records an external id, which makes this flag refuse).
    if (released.size > 0) {
      reconcileWith(db, push, [], { release: released });
      report.released = [...released];
    }

    for (const outcome of recordResults(db, push, parsed.results)) {
      report.items.push({
        localId: outcome.localId,
        // The CALLER'S word, echoed: `confirmed` stays `confirmed` whether the
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
    return envelope(id, report);
  } finally {
    // The run ends on EVERY exit, and only when this run still holds it: a run a
    // takeover replaced names a token the successor does not carry, so its own
    // `finally` deletes nothing.
    if (run !== null) {
      try {
        releaseRun(handle.db, { bindingId: target.bindingId, direction: PUSH_DIRECTION, runId: run.runId });
      } catch {
        // A release that cannot land must not mask the outcome that produced it.
      }
    }
    handle.close();
  }
}

/**
 * Validate a listing the caller fetched. Unlike `--results`, an ill-formed
 * listing is the caller's own defect and nothing has been written yet, so it is
 * a usage refusal naming the entry - the association rule never sees a
 * half-built record.
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
    // title and state are not defaulted: a malformed record would become a fake
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

/** `ingest`'s envelope: the five association buckets, counted and listed. */
type IngestEnvelope = IngestReport & {
  projectId: string;
  bindingId: string;
  identity: { repo: string; author: string };
  counts: { associated: number; drift: number; foreign: number; orphan: number; unmanaged: number };
};

/**
 * Associate a listing with the local rows it mirrors. mstar makes no Linear call
 * and writes no local issue: the ledger's association is the whole effect.
 */
async function runIngest(id: string, input: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
  const target = await resolveTarget(invocation, input);
  const records = parseRecords(await readJsonArgument(invocation, input.records, "--records"));
  const handle = await openStore({ harnessDir: target.harnessDir }, "write");
  try {
    const report = ingestRecords(
      handle.db,
      { bindingId: target.bindingId, identity: target.identity, mapping: target.binding.mapping },
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
  } finally {
    handle.close();
  }
}

export function getIssueSyncCommandDefinitions(): readonly CommandDefinition[] {
  const descriptions: Record<Verb, string> = {
    pending:
      "Plan this project's local issues for the host's Linear tools. NOTHING IS SENT: mstar makes no Linear call, holds no Linear credential and opens no socket. Run this first, then write each item with your own Linear MCP tools (discover their names at runtime) and finish with `issue-sync apply`. Each item carries localId, operation (create when the ledger holds no remote identity yet, update when it does), externalId, the payload to write, and the marker that must stay the LAST line of the description verbatim - it is how a later listing is associated with this local issue. `requestHash` is the skip key: an item whose ledger hash equals it is under `skipped` because the remote already says this, so it costs no tool call; `unresolved` names an unconfirmed earlier create that reconciliation must associate before anything creates again.",
    apply:
      "Record what your Linear tools reported for the items `issue-sync pending` planned, one entry per item: {localId, outcome, externalId?, remoteUpdatedAt?, cause?}. outcome `confirmed` proves delivery and names the remote issue (externalId) plus its revision when the tool returns one; `refused` means provably NOT delivered (a validation or permission error), so the item stays retryable; `ambiguous` means sent but unconfirmed - a create keeps its pending residue and the next ingest associates it by marker, never by guessing a second create. An unknown localId, an entry this run never planned, or a missing field is that entry's refusal in the report, not a failed run. The report echoes your word: `items[].outcome` is the `confirmed`/`refused`/`ambiguous` you sent, while `counts` groups the LEDGER states each produced (`applied`/`unconfirmed`/`refused`) - the two vocabularies are never mixed in one field. `--results` takes a file path or `-` for stdin, and [] records nothing. --adopt <localId>=<issueUrl|externalId> records an identity you confirmed yourself, BEFORE your results are recorded - so for an item named in both, the adopt wins and the entry's `confirmed` must repeat the adopted id or it is refused as a conflict; --force-adopt allows replacing one the row already records; --release <localId> clears a pending create with no remote id after ingest showed no issue carrying its marker (an associated issue records an id, which makes the flag refuse). ONE run per binding, continued from pending and ended here; --take-run replaces a holder you confirmed dead.",
    ingest:
      "Associate a listing your Linear tools returned with the local issues those remote issues mirror. --records takes a file path or - for stdin: [{externalId, url, title, description, state, priority, labels, updatedAt}]. The key is the marker in the description - repo=<owner/name>, local=<issue-id>, author=<Name <email>> - and repo must be this repository, local must exist here, and author must be this checkout's git author. Five buckets, one entry each (localId, externalId, url, and a cause when it is not a clean association): associated (recorded in the ledger, converged), drift (associated, but the remote content no longer matches what mstar last confirmed, or two remote issues claim one local issue - your judgement, nothing is rewritten), foreign (another operator's clone of this repository pushed it), orphan (the local issue is gone), unmanaged (no marker, a marker of the retired format, or another repository's - never adopted by title). No local issue is created, updated or closed.",
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
          if (error instanceof SyncError) return refusalFor(id, error.code, stripCode(error.message));
          return failure(id, error);
        }
      },
    } satisfies CommandDefinition;
  });
}

