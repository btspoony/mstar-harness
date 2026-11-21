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
  if (code === undefined) return {
    version: 1, command: id, status: "error", code: `${id}.failed`, exitCode: 1, message,
    recovery: "Correct the reported condition, then rerun the gate. Run mstar pr merge-gate --pr <n>.",
  };
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

async function mergeGate(input: Input, context: InvocationContext): Promise<CommandEnvelope> {
  // why: `gh` resolves the repository from its working directory, so an
  // undeclared workspace would read the HOST checkout's pull request.
  const unnamedRepository = launchDirectoryRefusal(id, context, { subject: "the pull request whose review threads are read" });
  if (unnamedRepository !== undefined) return unnamedRepository;
  const prText = need(input.pr, "--pr");
  if (!/^\d+$/.test(prText) || Number(prText) < 1) throw new UsageError("--pr requires a positive integer");
  const pr = Number(prText);
  const unavailable = (cause: string) => refusalEnvelope({
    command: id, status: "refused", code: `${id}.unavailable`, exitCode: 1, message: cause,
    recovery: "GitHub authentication and access to the requested pull request must be valid. Run mstar pr merge-gate --pr <n>.",
  });
  // why: a truncated or paginated response is not an access failure; each such
  // refusal builds its own literal recovery below, because the envelope's
  // declared retry must name the action that can change that outcome.
  const view = await spawn(context, ["gh", "pr", "view", String(pr), "--json", "url,headRefOid"]);
  if (view.exitCode !== 0 || view.signal !== null) return unavailable(view.stderr || "GitHub authentication/target lookup failed");
  const parsedView: unknown = JSON.parse(view.stdout);
  const viewRecord: Record<string, unknown> = parsedView !== null && typeof parsedView === "object" && !Array.isArray(parsedView) ? Object.fromEntries(Object.entries(parsedView)) : {};
  const url = typeof viewRecord.url === "string" ? viewRecord.url : "";
  const head = typeof viewRecord.headRefOid === "string" ? viewRecord.headRefOid : "";
  // why: `gh pr view` and `gh api` may select different hosts when the
  // environment sets one for each, so the host that served the PR is the only
  // host the thread scan may read.
  const target = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(url);
  if (target === null || !/^[0-9a-f]{7,40}$/.test(head)) return unavailable("pr view returned no resolvable repository url/head");
  if (Number(target[4]) !== pr) {
    return refusalEnvelope({
      command: id, status: "refused", code: `${id}.wrong-target`, exitCode: 1,
      message: `resolved PR ${target[4]} does not match requested PR ${prText}`,
      recovery: "Select the pull request matching the requested number. Run mstar pr merge-gate --pr <n>.",
    });
  }
  const [host, owner, repo] = [target[1]!, target[2]!, target[3]!];
  const maxPages = Number(input.maxPages ?? "50");
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new UsageError("--max-pages requires a positive integer");
  const query = "query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved isOutdated path line comments(first:1){nodes{author{login} body}}}}}}}";
  const threads: ReviewThreadFacts[] = [];
  let after: string | null = null;
  for (let page = 0; ; page += 1) {
    const argv = ["gh", "api", "graphql", "--hostname", host, "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${repo}`, "-F", `number=${pr}`, ...(after === null ? [] : ["-f", `after=${after}`])];
    const response = await spawn(context, argv);
    if (response.exitCode !== 0 || response.signal !== null) return unavailable(response.stderr || "gh api graphql failed");
    const pageResult = parseReviewThreads(JSON.parse(response.stdout));
    if (!pageResult.readable) return refusalEnvelope({
      command: id, status: "refused", code: `${id}.unreadable`, exitCode: 1,
      message: "reviewThreads response carried no readable thread page (missing connection or nodes array)",
      recovery: "The response was truncated rather than denied. Rerun the scan. Run mstar pr merge-gate --pr <n>.",
    });
    if (pageResult.headRefOid === null) return refusalEnvelope({
      command: id, status: "refused", code: `${id}.unreadable`, exitCode: 1,
      message: "reviewThreads response carried no headRefOid",
      recovery: "The response was incomplete rather than denied. Rerun the scan. Run mstar pr merge-gate --pr <n>.",
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
      recovery: "The response was incomplete rather than denied. Rerun the scan. Run mstar pr merge-gate --pr <n>.",
    });
    after = pageResult.endCursor;
    if (page >= maxPages - 1) return refusalEnvelope({
      command: id, status: "refused", code: `${id}.unreadable`, exitCode: 1,
      message: `review thread scan exceeded ${maxPages} page(s) (${maxPages * 100} threads); increase the page cap`,
      recovery: "Raise the page cap for this scan. Run mstar pr merge-gate --pr <n> --max-pages <n>.",
    });
  }
  let confirmation: ThreadGateConfirmation | undefined;
  if (input.confirm !== undefined) {
    const file = abs(context.cwd, input.confirm);
    if (!existsSync(file)) throw new UsageError(
      `confirmation file not found: ${file}`,
      undefined,
      "Resolve every unresolved thread and rerun without the flag: Run mstar pr merge-gate --pr <n>. To merge with a named waiver, supply the record: Run mstar pr merge-gate --pr <n> --confirm <file>.",
    );
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch (error) {
      throw new UsageError(
        `cannot read the confirmation file ${file}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        "Pass a readable confirmation file. Run mstar pr merge-gate --pr <n> --confirm <file>.",
      );
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      throw new UsageError(
        `--confirm must contain valid JSON: ${file}`,
        undefined,
        "Fix the confirmation record. Run mstar pr merge-gate --pr <n> --confirm <file>.",
      );
    }
    const row = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : null;
    if (row === null || typeof row.head !== "string" || typeof row.confirmations !== "number" || !Array.isArray(row.threads) || row.threads.some((value) => typeof value !== "string") || (row.digest !== undefined && typeof row.digest !== "string")) {
      throw new UsageError(
        "--confirm must be a JSON object {head: string, confirmations: number, threads: string[], digest?: string}",
        undefined,
        "Correct the record shape. Run mstar pr merge-gate --pr <n> --confirm <file>.",
      );
    }
    confirmation = { head: row.head, confirmations: row.confirmations, threads: row.threads as string[], ...(typeof row.digest === "string" ? { digest: row.digest } : {}) };
  }
  const decision = decideThreadGate({ head, threads, ...(confirmation === undefined ? {} : { confirmation }) });
  const digest = threadGateDigest(decision.unresolved);
  if (decision.ok) return ok({ mergeAllowed: true, head, total: threads.length, digest, unresolved: decision.unresolved });
  return refusalEnvelope({
    command: id, status: "refused", code: decision.code, exitCode: 1,
    message: decision.code === "pr.merge-gate.unresolved"
      ? `${decision.unresolved.length} unresolved review thread(s) on ${head} - merge is not authorized`
      : `the confirmation record does not authorize a merge on ${head}`,
    details: { head, total: threads.length, digest, unresolved: decision.unresolved, problems: decision.problems },
    recovery: "Resolve every listed thread and rerun without --confirm; to merge with a thread still open, obtain a per-thread waiver from the user, record two confirmations in {head, confirmations: 2, threads: [<thread id>...], digest}, and rerun mstar pr merge-gate --pr <number> --confirm <file>.",
  });
}

const options = [
  { key: "pr", flags: "--pr <n>", required: true },
  { key: "confirm", flags: "--confirm <file.json>", required: false, help: "Optional; the two-confirmation record {head, confirmations: 2, threads: [<thread id>...], digest} that authorizes merging while threads stay unresolved." },
  { key: "maxPages", flags: "--max-pages <n>", required: false, defaultValue: "50", help: "Optional; page cap for the thread scan (100 threads per page). Defaults to 50; raise it when a PR reports more." },
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
