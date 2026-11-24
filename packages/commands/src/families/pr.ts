import { existsSync, readFileSync } from "node:fs";
import {
  decideThreadGate, parseReviewThreads, threadGateDigest,
  type ReviewThreadFacts, type ThreadGateConfirmation,
} from "@mstar-harness/engine";
import { z } from "zod";
import { resolveCliPath } from "../host-health.js";
import { commandEnvelopeSchema, refusalEnvelope, type RefusalDiagnostic } from "../envelope.js";
import { engineErrorFacts } from "./family-refusal.js";
import { launchDirectoryRefusal } from "./launch-workspace.js";
import { decodeInputDiagnostics } from "../input-diagnostics.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

/**
 * why: `pr.*` groups operations on a pull request itself, independent of
 * whether a review seat is involved. `merge-gate` answers "may this PR merge?"
 * for the author's own PR as well as a reviewed one, so it does not live under
 * `pr-review` (which names the act of reviewing a PR).
 */

const inputSchema = z.object({
  pr: z.string().optional(),
  confirm: z.string().optional(),
  maxPages: z.string().optional(),
  provider: z.string().optional(),
});
type Input = z.infer<typeof inputSchema>;

const id = "pr.merge-gate";

const ok = (data: unknown): CommandEnvelope => ({ version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data });

/** why: a caller-correctable input error; `recovery` names the supported retry. */
class UsageError extends Error {
  constructor(message: string, readonly diagnostics?: readonly RefusalDiagnostic[], readonly recovery?: string) { super(message); }
}

/** why: a typed engine error keeps its own code/details/recovery; untyped input errors are usage. */
const failure = (error: unknown): CommandEnvelope<never> => {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UsageError) {
    return refusalEnvelope({
      command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message,
      ...(error.diagnostics === undefined ? {} : { diagnostics: error.diagnostics }),
      ...(error.recovery === undefined ? {} : { recovery: error.recovery }),
    });
  }
  const { code, details, recovery } = engineErrorFacts(error);
  // see docs/adr/implemented/architecture/2026-09-28-recovery-first-operations.md
  // why: the shared fallback only says "correct and rerun"; a missing provider
  // executable is repaired by installing the tool that binary belongs to, and
  // the exempted prover cannot see that cause. Spawn adapters name the missing
  // binary on the shared `executable` field; the normalized CLI message text
  // stays a fallback for an error that predates the field.
  if (code === "process.not-found") {
    const declared = error !== null && typeof error === "object" ? (error as Record<string, unknown>).executable : undefined;
    const executable = typeof declared === "string" ? declared : /executable not found in \$PATH: (\S+)/.exec(message)?.[1];
    const install = executable === "gh" ? "the GitHub CLI" : `${executable ?? "the provider"} executable`;
    // see docs/knowledge/best-practices/frozen-invariant-lints-need-ci-at-landing.md
    // reachability: manual — the recovery interpolates the missing executable's own name into one fixed `mstar pr merge-gate` instruction, and every substitution the linter cannot prove is a binary name, not a command path.
    return refusalEnvelope({
      command: id, status: "refused", code, exitCode: 1, message,
      details: details ?? {},
      recovery: `Install ${install} and authenticate it, then rerun the gate. Run mstar pr merge-gate --pr <n>.`,
    });
  }
  if (code === undefined) {
    // why: the refusal builder admits only usage/refused, and an error envelope
    // is returned before the refusal normalizer reads details.recovery — so
    // `message` is the only channel a reader sees here, and details.recovery is
    // a compatibility mirror.
    const hint = "Correct the reported condition, then rerun the gate. Run mstar pr merge-gate --pr <n>.";
    return {
      version: 1, command: id, status: "error", code: `${id}.failed`, exitCode: 1,
      message: `${message}\nRecovery: ${hint}`,
      details: { recovery: hint },
    };
  }
  return refusalEnvelope({
    command: id, status: "refused", code, exitCode: 1, message,
    details: details ?? {},
    recovery: recovery ?? "Correct the reported condition, then rerun the gate. Run mstar pr merge-gate --pr <n>.",
  });
};

const abs = (cwd: string, file: string) => resolveCliPath(file, cwd);
const need = (value: string | undefined, name: string): string => {
  if (value === undefined || value === "") throw new UsageError(`${name} is required`);
  return value;
};

async function spawn(context: InvocationContext, argv: string[]) {
  return context.effects.spawn({
    argv,
    cwd: context.cwd,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    signal: context.signal,
  });
}

/** One parsed page of review-thread facts — the exact shape the decision half consumes. */
export interface MergeGateThreadPage {
  threads: ReviewThreadFacts[];
  hasNextPage: boolean;
  endCursor: string | null;
  readable: boolean;
  headRefOid: string | null;
}

/** Either the value the gate consumes, or the refusal envelope it returns unchanged. */
export type MergeGateOutcome<T> = { ok: true; value: T } | { ok: false; refusal: CommandEnvelope };

/**
 * A named forge adapter for the merge gate. `resolve` proves the requested
 * pull request exists, reports the head the enumeration pins and the
 * coordinate `threads` reads from; `threads` returns one parsed page. Head
 * pinning, pagination, the confirmation record and the decision all stay in
 * the gate — provider-neutral.
 */
export interface MergeGateProvider {
  resolve(input: { pr: number; requested: string }, context: InvocationContext): Promise<MergeGateOutcome<{ head: string; host: string; owner: string; repo: string }>>;
  threads(input: { host: string; owner: string; repo: string; pr: number; after: string | null }, context: InvocationContext): Promise<MergeGateOutcome<MergeGateThreadPage>>;
}

const mergeGateProviders = new Map<string, MergeGateProvider>();

/** why: the seam exists so a second forge — or a test fixture — plugs in by id; production registers GitHub only. */
export function registerMergeGateProvider(id: string, provider: MergeGateProvider): void {
  mergeGateProviders.set(id, provider);
}

const unavailable = (cause: string): CommandEnvelope => refusalEnvelope({
  command: id, status: "refused", code: `${id}.unavailable`, exitCode: 1, message: cause,
  recovery: "GitHub authentication and access to the requested pull request must be valid. Run mstar pr merge-gate --pr <n>.",
});

const githubProvider: MergeGateProvider = {
  async resolve({ pr, requested }, context) {
    const view = await spawn(context, ["gh", "pr", "view", String(pr), "--json", "url,headRefOid"]);
    if (view.exitCode !== 0 || view.signal !== null) return { ok: false, refusal: unavailable(view.stderr || "GitHub authentication/target lookup failed") };
    const parsedView: unknown = JSON.parse(view.stdout);
    const viewRecord: Record<string, unknown> = parsedView !== null && typeof parsedView === "object" && !Array.isArray(parsedView) ? Object.fromEntries(Object.entries(parsedView)) : {};
    const url = typeof viewRecord.url === "string" ? viewRecord.url : "";
    const head = typeof viewRecord.headRefOid === "string" ? viewRecord.headRefOid : "";
    // why: `gh pr view` and `gh api` may select different hosts when the
    // environment sets one for each, so the host that served the PR is the
    // only host the thread scan may read.
    // see skills/mstar-roles/references/project-manager/pr-delivery.md
    const target = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url);
    if (target === null || !/^[0-9a-f]{7,40}$/.test(head)) return { ok: false, refusal: unavailable("pr view returned no resolvable repository url/head") };
    if (Number(target[4]) !== pr) {
      return { ok: false, refusal: refusalEnvelope({
        command: id, status: "refused", code: `${id}.wrong-target`, exitCode: 1,
        message: `resolved PR ${target[4]} does not match requested PR ${requested}`,
        recovery: "Select the pull request matching the requested number. Run mstar pr merge-gate --pr <n>.",
      }) };
    }
    return { ok: true, value: { head, host: target[1]!, owner: target[2]!, repo: target[3]! } };
  },
  async threads({ host, owner, repo, pr, after }, context) {
    const query = "query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated path line comments(first:1){nodes{author{login} body}}}}}}}";
    const argv = ["gh", "api", "graphql", "--hostname", host, "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${repo}`, "-F", `number=${pr}`, ...(after === null ? [] : ["-f", `after=${after}`])];
    const response = await spawn(context, argv);
    if (response.exitCode !== 0 || response.signal !== null) return { ok: false, refusal: unavailable(response.stderr || "gh api graphql failed") };
    return { ok: true, value: parseReviewThreads(JSON.parse(response.stdout)) };
  },
};
mergeGateProviders.set("github", githubProvider);

async function mergeGate(input: Input, context: InvocationContext): Promise<CommandEnvelope> {
  // see skills/mstar-use-cli/references/checks-and-lints.md
  // why: a provider resolves the repository from its working directory, so an
  // undeclared workspace would read the HOST checkout's pull request.
  const unnamedRepository = launchDirectoryRefusal(id, context, { subject: "the pull request whose review threads are read" });
  if (unnamedRepository !== undefined) return unnamedRepository;
  const prText = need(input.pr, "--pr");
  if (!/^\d+$/.test(prText) || Number(prText) < 1) throw new UsageError("--pr requires a positive integer");
  const pr = Number(prText);
  const providerId = input.provider ?? "github";
  const provider = mergeGateProviders.get(providerId);
  if (provider === undefined) {
    // see docs/knowledge/best-practices/frozen-invariant-lints-need-ci-at-landing.md
    // reachability: manual — the interpolation lists registered provider ids (names, not command paths); the runnable retry is the literal `mstar pr merge-gate --pr <n> --provider <id>` this recovery names.
    return refusalEnvelope({
      command: id, status: "refused", code: `${id}.unsupported-provider`, exitCode: 1,
      message: `merge-gate provider ${providerId} is not registered`,
      details: { provider: providerId, registered: [...mergeGateProviders.keys()] },
      // see skills/mstar-roles/references/project-manager/pr-delivery.md
      // why: an id that names a different forge is not a typo to correct — a
      // registered adapter can only inspect its own forge's PR, so the
      // recovery must route an unsupported forge to the documented
      // project-tooling path instead of naming a GitHub adapter for a GitLab MR.
      recovery: `If ${providerId} is a typo, rerun with a registered provider id (${[...mergeGateProviders.keys()].join(", ")}): Run mstar pr merge-gate --pr <n> --provider <id>. A registered id may be selected only when it matches the target forge's provider. For a forge no registered adapter serves, enumerate the threads with the project's own tooling per skills/mstar-roles/references/project-manager/pr-delivery.md (same owner-approval and waiver rules); when no documented equivalent exists, STOP — never merge.`,
    });
  }
  // see docs/adr/implemented/architecture/2026-09-28-recovery-first-operations.md
  // why: a truncated or paginated response is not an access failure; each such
  // refusal builds its own literal recovery below, because the envelope's
  // declared retry must name the action that can change that outcome.
  const resolved = await provider.resolve({ pr, requested: prText }, context);
  if (!resolved.ok) return resolved.refusal;
  const { head, host, owner, repo } = resolved.value;
  const maxPages = Number(input.maxPages ?? "50");
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new UsageError("--max-pages requires a positive integer");
  const threads: ReviewThreadFacts[] = [];
  let after: string | null = null;
  for (let page = 0; ; page += 1) {
    const pageResponse = await provider.threads({ host, owner, repo, pr, after }, context);
    if (!pageResponse.ok) return pageResponse.refusal;
    const pageResult = pageResponse.value;
    if (!pageResult.readable) return refusalEnvelope({
      command: id, status: "refused", code: `${id}.unreadable`, exitCode: 1,
      message: "reviewThreads response carried no readable thread page (missing connection or nodes array)",
      recovery: "The thread payload could not be read. Rerun the scan; if it repeats, verify GitHub access to this PR. Run mstar pr merge-gate --pr <n>.",
    });
    if (pageResult.headRefOid === null) return refusalEnvelope({
      command: id, status: "refused", code: `${id}.unreadable`, exitCode: 1,
      message: "reviewThreads response carried no headRefOid",
      recovery: "The thread payload could not be read. Rerun the scan; if it repeats, verify GitHub access to this PR. Run mstar pr merge-gate --pr <n>.",
    });
    // why: threads are read across several requests, so a head that moves
    // mid-scan makes the enumeration — and any waiver bound to it — stale.
    if (pageResult.headRefOid !== head) {
      return refusalEnvelope({
        command: id, status: "refused", code: `${id}.head-moved`, exitCode: 1,
        message: `PR head moved from ${head} to ${pageResult.headRefOid} while reading review threads`,
        details: { expected: head, actual: pageResult.headRefOid },
        recovery: "A confirmation bound to the earlier head cannot merge; rerun the gate against the new head. Run mstar pr merge-gate --pr <n>.",
      });
    }
    threads.push(...pageResult.threads);
    if (!pageResult.hasNextPage) break;
    if (pageResult.endCursor === null) return refusalEnvelope({
      command: id, status: "refused", code: `${id}.unreadable`, exitCode: 1,
      message: "reviewThreads reported more pages without an end cursor",
      recovery: "The thread payload could not be read. Rerun the scan; if it repeats, verify GitHub access to this PR. Run mstar pr merge-gate --pr <n>.",
    });
    after = pageResult.endCursor;
    if (page >= maxPages - 1) return refusalEnvelope({
      command: id, status: "refused", code: `${id}.page-cap`, exitCode: 1,
      message: `review thread scan exceeded ${maxPages} page(s) (${maxPages * 100} threads); increase the page cap`,
      recovery: "Raise the page cap for this scan. Run mstar pr merge-gate --pr <n> --max-pages <n>.",
    });
  }
  let confirmation: ThreadGateConfirmation | undefined;
  if (input.confirm !== undefined) {
    const file = abs(context.cwd, input.confirm);
    // see docs/adr/implemented/architecture/2026-09-28-recovery-first-operations.md
    // why: each retry below re-runs this same invocation, so it must name the
    // selected provider id — dropping it would silently switch to GitHub.
    const retry = `mstar pr merge-gate --pr <n> --provider ${providerId} --confirm <file>`;
    if (!existsSync(file)) throw new UsageError(
      `confirmation file not found: ${file}`,
      undefined,
      `Resolve every unresolved thread and rerun without the flag: Run mstar pr merge-gate --pr <n> --provider ${providerId}. To merge with a named waiver, supply the record: Run ${retry}.`,
    );
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch (error) {
      throw new UsageError(
        `cannot read the confirmation file ${file}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        `Pass a readable confirmation file. Run ${retry}.`,
      );
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      throw new UsageError(
        `--confirm must contain valid JSON: ${file}`,
        undefined,
        `Fix the confirmation record. Run ${retry}.`,
      );
    }
    const row = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : null;
    if (row === null || typeof row.head !== "string" || typeof row.confirmations !== "number" || !Array.isArray(row.threads) || row.threads.some((value) => typeof value !== "string") || (row.digest !== undefined && typeof row.digest !== "string")) {
      throw new UsageError(
        "--confirm must be a JSON object {head: string, confirmations: number, threads: string[], digest?: string}",
        undefined,
        `Correct the record shape. Run ${retry}.`,
      );
    }
    confirmation = { head: row.head, confirmations: row.confirmations, threads: row.threads as string[], ...(typeof row.digest === "string" ? { digest: row.digest } : {}) };
  }
  const decision = decideThreadGate({ head, threads, ...(confirmation === undefined ? {} : { confirmation }) });
  const digest = threadGateDigest(decision.unresolved);
  if (decision.ok) return ok({ mergeAllowed: true, head, total: threads.length, digest, unresolved: decision.unresolved });
  // see docs/knowledge/best-practices/frozen-invariant-lints-need-ci-at-landing.md
  return refusalEnvelope({
    command: id, status: "refused", code: decision.code, exitCode: 1,
    message: decision.code === "pr.merge-gate.unresolved"
      ? `${decision.unresolved.length} unresolved review thread(s) on ${head} - merge is not authorized`
      : `the confirmation record does not authorize a merge on ${head}`,
    details: { head, total: threads.length, digest, unresolved: decision.unresolved, problems: decision.problems },
    // see docs/adr/implemented/architecture/2026-09-28-recovery-first-operations.md
    recovery: `Resolve every listed thread and rerun without --confirm; to merge with a thread still open, obtain a per-thread waiver from the user, record two confirmations in {head, confirmations: 2, threads: [<thread id>...], digest}, and rerun mstar pr merge-gate --pr <number> --provider <id> --confirm <file>, passing the provider id this run selected.`,
  });
}

const options = [
  { key: "pr", flags: "--pr <n>", required: true },
  { key: "confirm", flags: "--confirm <file.json>", required: false, help: "Optional; the two-confirmation record {head, confirmations: 2, threads: [<thread id>...], digest} that authorizes merging while threads stay unresolved." },
  { key: "maxPages", flags: "--max-pages <n>", required: false, defaultValue: "50", help: "Optional; page cap for the thread scan (100 threads per page). Defaults to 50; raise it when a PR reports more." },
  { key: "provider", flags: "--provider <id>", required: false, defaultValue: "github", help: "Optional; the registered forge adapter that resolves the PR and enumerates its review threads. Defaults to github; an unregistered id refuses." },
] as const;

export function getPrCommandDefinitions(): readonly CommandDefinition[] {
  return [{
    id,
    cli: { path: ["pr", "merge-gate"], aliases: [], arguments: [], options },
    input: inputSchema,
    output: commandEnvelopeSchema,
    requirements: [
      { name: "pr", ownership: "caller" as const, route: "cli" as const, required: true },
      { name: "pr", ownership: "caller" as const, route: "mcp" as const, required: true },
      { name: "confirm", ownership: "caller" as const, route: "cli" as const, required: false, constraint: "optional; required only when unresolved threads stay open" },
      { name: "confirm", ownership: "caller" as const, route: "mcp" as const, required: false, constraint: "optional; required only when unresolved threads stay open" },
      { name: "maxPages", ownership: "derivable" as const, route: "cli" as const, required: false, constraint: "defaults to 50 pages (100 threads per page)" },
      { name: "maxPages", ownership: "derivable" as const, route: "mcp" as const, required: false, constraint: "defaults to 50 pages (100 threads per page)" },
      { name: "provider", ownership: "derivable" as const, route: "cli" as const, required: false, constraint: "defaults to github; a named registered adapter id" },
      { name: "provider", ownership: "derivable" as const, route: "mcp" as const, required: false, constraint: "defaults to github; a named registered adapter id" },
    ],
    effects: ["read", "validate", "process", "service"],
    description: "Decide the review-thread half of the merge gate: enumerate every review thread on the PR's current head and refuse while any stays unresolved, unless a confirmation record binds that head, records two confirmations, names exactly those thread ids and matches their digest. Merge authorization itself also needs the recorded policy or the owner's approval; this is not a review action.",
    async execute(raw, context) {
      const parsed = inputSchema.safeParse(raw);
      if (parsed.success) {
        try {
          return await mergeGate(parsed.data, context);
        } catch (error) {
          return failure(error);
        }
      }
      return refusalEnvelope({
        command: id, status: "usage", code: "command.invalid-input", exitCode: 2,
        message: "Invalid input.", diagnostics: decodeInputDiagnostics(parsed.error, raw),
      });
    },
  }];
}
