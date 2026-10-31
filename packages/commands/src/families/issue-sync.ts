/**
 * issue-sync family — the ONE supported import entry (mirror-import plan
 * Task 4):
 *
 *   mstar issue-sync import --project <project_id> [--max-pages <n>]
 *
 * It refuses — before any write — when the binding cannot run, and otherwise
 * pages the bound Linear project into the local store through the ledger and
 * reports what it imported, updated, skipped or failed plus where it stopped.
 *
 * Refusal vocabulary is the frozen contract's (sync-ledger-contract §4): the
 * retired names `linear.binding-not-ready` / `linear.project-unbound` are never
 * emitted. "Cannot run" is `linear.provider-disabled` with the probe state and
 * its cause in the message; "mirrors nothing" is the named absence
 * `linear.binding-absent`.
 *
 * Read-only toward Linear: the only provider call this command makes is
 * `probe()` and `listIssues()`.
 */
import { refusalEnvelope } from "../envelope.js";
import { engineErrorFacts } from "./family-refusal.js";
import {
  IMPORT_DIRECTION,
  importPage,
  openStore,
  readCursor,
  readProjectBinding,
  readRepoLinearBinding,
  resolveProcessHarnessDir,
  SyncError,
  writeCursor,
  type IssueProvider,
} from "@mstar-harness/engine";
import { z } from "zod";
import { commandEnvelopeSchema } from "../envelope.js";
import type { CommandDefinition, CommandEnvelope, CommandRequirement, InvocationContext } from "../types.js";

const schema = z.object({
  project: z.string().optional(),
  maxPages: z.number().int().positive().optional(),
  harness: z.string().optional(),
});
type Input = z.infer<typeof schema>;

const verbs = ["import"] as const;
type Verb = (typeof verbs)[number];

/** Bound one run at 20 pages × 50 items, so a first run cannot run unbounded. */
const DEFAULT_MAX_PAGES = 20;

const flags: Record<keyof Input, string> = {
  project: "--project <id>",
  maxPages: "--max-pages <n>",
  harness: "--harness <root>",
};

const options: Record<Verb, (keyof Input)[]> = { import: ["project", "maxPages", "harness"] };
const required: Record<Verb, (keyof Input)[]> = { import: ["project"] };

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
    "The binding cannot run yet. Fix the .mstarc `[linear]` block (`enabled=true`, `mode=mirror`, `workspace=<slug>`, `team=<key>`), confirm Linear MCP is configured in the host, then re-run `mstar issue-sync import --project <project-id>`. The message names the probe state and its cause.",
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
};

function refusalFor(id: string, code: string, message: string, details?: Record<string, unknown>): CommandEnvelope<never> {
  return refusalEnvelope({
    command: id,
    status: "refused",
    code,
    exitCode: 1,
    message: `[${code}] ${message}`,
    details: { operation: id, ...details },
    recovery: RECOVERY[code] ?? `Run \`mstar issue-sync import --help\` for the supported flags and check the named condition.`,
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
        "Run `mstar issue-sync import --project <project-id> [--max-pages <n>]`; --project is required and names a store project whose Linear project is already bound.",
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

type ImportReport = {
  projectId: string;
  bindingId: string;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  pages: number;
  /** Provider page requests this run made — the rate-limit budget, evidenced. */
  requests: number;
  /** The cursor a later run resumes from (unchanged when nothing advanced). */
  cursor: string | null;
};

async function runImport(id: string, input: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
  const projectId = requireValue(input.project, "--project");
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;
  const harnessDir =
    resolveProcessHarnessDir(invocation.cwd, input.harness) ?? input.harness ?? invocation.controlRoot ?? invocation.cwd;
  const context = { harnessDir };
  const provider: IssueProvider | null = invocation.effects.issueProvider?.(projectId) ?? null;
  if (provider === null) {
    throw new SyncError(
      "linear.list-unimplemented",
      "this host exposes no Linear listing adapter, so no page can be requested; run the import from a host that ships it",
    );
  }

  // Every refusal below happens BEFORE a store write or a provider listing call.
  const probe = await provider.probe();
  if (probe.state !== "ready") {
    throw Object.assign(
      new Error(`[linear.provider-disabled] the binding cannot run: probe state "${probe.state}" — ${probe.cause}`),
      { code: "linear.provider-disabled" },
    );
  }
  const repo = readRepoLinearBinding(harnessDir);
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

  const bindingId = `linear:${projectId}`;
  const report: ImportReport = {
    projectId,
    bindingId,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    pages: 0,
    requests: 0,
    cursor: null,
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
      const counts = importPage(db, bindingId, page.items);
      report.imported += counts.imported;
      report.updated += counts.updated;
      report.skipped += counts.skipped;
      report.failed += counts.failed;
      if (page.nextCursor === null) break;
      writeCursor(db, {
        bindingId,
        direction: IMPORT_DIRECTION,
        cursor: page.nextCursor,
        operationId: `linear-import:${bindingId}:cursor:${page.nextCursor}`,
      });
      cursor = page.nextCursor;
      report.cursor = cursor;
    }
    return envelope(id, report);
  } finally {
    handle.close();
  }
}

export function getIssueSyncCommandDefinitions(): readonly CommandDefinition[] {
  const descriptions: Record<Verb, string> = {
    import:
      "Import the bound Linear project's issues into this store, read-only toward Linear; a second run with unchanged remote state imports nothing. --max-pages bounds one run (default 20 pages of 50) and the reported cursor resumes it.",
  };
  return verbs.map((verb) => {
    const id = `issue-sync.${verb}`;
    const opts = options[verb];
    const requirements: CommandRequirement[] = (["cli", "mcp"] as const).flatMap((route): CommandRequirement[] => [
      ...required[verb].map((name) => ({ name, ownership: "caller" as const, route, required: true })),
      {
        name: "maxPages",
        ownership: "caller" as const,
        route,
        required: false,
        constraint: `optional: bounds one run at <n> pages of 50 items (default ${DEFAULT_MAX_PAGES}); a re-run resumes from the reported cursor`,
      },
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
        })),
      },
      input: schema,
      output: commandEnvelopeSchema,
      effects: ["write"] as const,
      description: descriptions[verb],
      rootInputs: ["harness"],
      requirements,
      async execute(value: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
        try {
          return await runImport(id, value, invocation);
        } catch (error) {
          if (error instanceof SyncError) return refusalFor(id, error.code, error.message.replace(/^\[[^\]]+\]\s*/, ""));
          return failure(id, error);
        }
      },
    } satisfies CommandDefinition;
  });
}
