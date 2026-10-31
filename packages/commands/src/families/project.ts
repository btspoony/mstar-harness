/**
 * project family — the project↔provider correspondence verb
 * (binding-config plan Task 5).
 *
 * `mstar project bind --project <id> --provider linear --remote-project <name-or-id>`
 * records which external project a store project mirrors. The connection facts
 * (`workspace`, `team`) are NOT flags: they are read from the repo's `.mstarc`
 * `[linear]` connection block, so a repo names them in exactly one place
 * (compass D2). A Linear project name is never a `.mstarc` key.
 *
 * Refusals carry the contract's `linear.*` vocabulary and a recovery the
 * operator can run through a documented entry:
 * - `linear.provider-disabled` — the provider is not enabled in `.mstarc`
 *   (including a provider other than `linear`, the only one this iteration knows)
 * - `linear.project-unregistered` — the project has no catalog row
 *   (emitted by the engine)
 * - `linear.rebind-refused` — the project already mirrors a different remote
 *   project (emitted by the engine)
 * - `linear.binding-incomplete` / `linear.mode-refused` — the `.mstarc` block
 *   itself is invalid (emitted by `parseLinearBinding`)
 */
import { refusalEnvelope } from "../envelope.js";
import { engineErrorFacts } from "./family-refusal.js";
import { SddScriptError } from "@mstar-harness/engine";
import {
  bindProject,
  readProjectBinding,
  readRepoLinearBinding,
  resolveProcessHarnessDir,
  type ProjectBindingTarget,
} from "@mstar-harness/engine";
import { z } from "zod";
import { commandEnvelopeSchema } from "../envelope.js";
import type { CommandDefinition, CommandEnvelope, CommandRequirement, InvocationContext } from "../types.js";

const schema = z.object({
  project: z.string().optional(),
  provider: z.string().optional(),
  remoteProject: z.string().optional(),
  expectStore: z.number().int().nonnegative().optional(),
  operation: z.string().optional(),
  harness: z.string().optional(),
});
type Input = z.infer<typeof schema>;

const verbs = ["bind", "show"] as const;
type Verb = (typeof verbs)[number];

const flags: Record<keyof Input, string> = {
  project: "--project <id>",
  provider: "--provider <name>",
  remoteProject: "--remote-project <name-or-id>",
  expectStore: "--expect-store <n>",
  operation: "--operation <id>",
  harness: "--harness <root>",
};

const options: Record<Verb, (keyof Input)[]> = {
  bind: ["project", "provider", "remoteProject", "expectStore", "operation", "harness"],
  show: ["project", "harness"],
};

const required: Record<Verb, (keyof Input)[]> = {
  bind: ["project", "provider", "remoteProject", "operation"],
  show: ["project"],
};

class UsageError extends Error {}

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined || !value.trim()) throw new UsageError(`${flag} is required`);
  return value.trim();
}

function envelope(id: string, data: unknown): CommandEnvelope {
  return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data };
}

/** Recovery text per refusal: every one names a documented entry the operator can run. */
const RECOVERY: Record<string, string> = {
  "linear.provider-disabled":
    "Enable the provider in the repo's .mstarc and retry: `[linear]` with `enabled=true`, `mode=mirror`, `workspace=<workspace-slug>`, `team=<team-key>`. Only `linear` is supported this iteration.",
  "linear.project-unregistered":
    "Register the project in the catalog first (`mstar catalog register --kind project --id <project-id> ...`, or `mstar catalog reconcile --list`), then retry the bind.",
  "linear.rebind-refused":
    "A store project mirrors one external project. Bind the intended remote project to its own store project instead of re-pointing this one; check which project already holds the remote id with `mstar project show --project <project-id>`.",
  "linear.binding-incomplete":
    "Complete the .mstarc `[linear]` connection block: `enabled=true` requires both `workspace` and `team`.",
  "linear.mode-refused":
    'Only `mode=mirror` is supported this iteration: set `mode=mirror` in the .mstarc `[linear]` block.',
  "linear.revision-conflict":
    "The store moved since the revision you observed. Re-read it (`mstar status show`), pass the current --expect-store, and retry with a fresh --operation.",
  "store.operation-conflict":
    "The --operation id was already used for a different request. Retry with a new operation id.",
  "linear.binding-conflict":
    "Read the existing correspondence with `mstar project show --project <project-id>` and retry with a fresh --operation when the request differs.",
  "linear.binding-invalid":
    "Fix the value the message names. `[linear] enabled` accepts true/1/yes/on or false/0/no/off (case-insensitive); workspace/team/remoteProject must be non-empty; the store revision must still match when --expect-store is supplied. Check the block with `mstar project show --project <id>` and re-run bind with a fresh --operation.",
  "store.not-active":
    'Activate the store first: `mstar store upgrade --operator <name>`, then retry the bind.',
  "store.not-initialized":
    'Create and activate the store: `mstar harness scaffold` then `mstar store init`; for a workspace holding historical file state use `mstar store upgrade --operator <name>`. Retrying cannot create it.',
  "store.runtime-unsupported":
    "The store on disk was written by a runtime this build does not support. Retrying cannot change that: use the `mstar` release that wrote the store, or read the named condition in the message before touching the file.",
  "store.schema-unsupported":
    "This store's schema is not supported by this build. Retrying cannot resolve it: run the store's own upgrade path with a build that supports that schema (`mstar store upgrade --operator <name>`), or use the release that created the store.",
  "store.schema-drift":
    "The store schema does not match what this build expects. Retrying cannot resolve it: follow the named condition in the message (upgrade the store with `mstar store upgrade --operator <name>`, or use the release that matches the schema).",
  "store.corrupt":
    "The store file is corrupt. Retrying will not repair it: restore a backup (`mstar store restore`), or re-initialize a fresh harness and re-register the catalog.",
  "store.busy":
    "Another process holds the store. Wait for it to finish (or close the other mstar session), then retry.",
};

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
        id === "project.bind"
          ? "Run `mstar project bind --project <id> --provider linear --remote-project <name-or-id> --operation <id>`; workspace and team come from the .mstarc `[linear]` block. Inspect the current correspondence with `mstar project show --project <id>`."
          : "Run `mstar project show --project <id>` with a registered catalog project id.",
    });
  }
  const facts = engineErrorFacts(error);
  const code = facts.code ?? `${id}.internal-error`;
  // Unmapped codes keep their own code and a truthful recovery: "retry" is
  // never the answer for a store this build cannot read (F5).
  const recovery =
    facts.recovery ??
    RECOVERY[code] ??
    (code.startsWith("store.")
      ? "The store refused this operation on its own condition, named in the message. Retrying cannot change it — inspect `mstar status show` and follow the store's named condition."
      : `Run ${id.replaceAll(".", " ")} --help and check the named condition; retry ${id} only after addressing it.`);
  if (error instanceof SddScriptError) {
    return refusalEnvelope({ command: id, status: "usage", code: "usage", exitCode: 2, message, details: { operation: id }, recovery });
  }
  return refusalEnvelope({ command: id, status: "refused", code, exitCode: 1, message, details: { operation: id, ...facts.details }, recovery });
}

async function run(id: string, input: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
  try {
    const verb = id.slice("project.".length) as Verb;
    const projectId = requireValue(input.project, "--project");
    const harnessDir = resolveProcessHarnessDir(invocation.cwd, input.harness) ?? input.harness ?? invocation.controlRoot ?? invocation.cwd;
    const context = { harnessDir };

    if (verb === "show") return envelope(id, await readProjectBinding(context, projectId));

    // The connection layer is `.mstarc`, and only `.mstarc`: a Linear project
    // name never lives there, and workspace/team never become flags (D2).
    // The repo's OWN `.mstarc` is the authority — a parent directory's config
    // is never inherited (F4), so a worktree cannot borrow another repo's
    // workspace/team.
    const repo = readRepoLinearBinding(harnessDir);
    if (repo.kind === "invalid") return failure(id, Object.assign(new Error(repo.message), { code: repo.code }));
    const provider = requireValue(input.provider, "--provider");
    const enabled = repo.kind === "bound" && repo.binding.enabled;
    if (!enabled || provider !== "linear") {
      const why = repo.kind === "absent" ? repo.message : `[linear] enabled is not true in ${repo.file}`;
      return failure(
        id,
        Object.assign(new Error(`[linear.provider-disabled] Provider "${provider}" is not enabled here: ${why}`), {
          code: "linear.provider-disabled",
        }),
      );
    }
    // Narrowed by `enabled` above: only a `bound` repo block reaches here.
    if (repo.kind !== "bound") return failure(id, new Error("[linear.provider-disabled] no repo [linear] block"));
    const target: ProjectBindingTarget = {
      provider,
      workspace: repo.binding.workspace,
      team: repo.binding.team,
      remoteProject: requireValue(input.remoteProject, "--remote-project"),
    };
    return envelope(
      id,
      await bindProject(context, projectId, target, {
        operationId: requireValue(input.operation, "--operation"),
        ...(input.expectStore === undefined ? {} : { expectedStoreRevision: input.expectStore }),
      }),
    );
  } catch (error) {
    return failure(id, error);
  }
}

export function getProjectCommandDefinitions(): readonly CommandDefinition[] {
  const descriptions: Record<Verb, string> = {
    bind: "Record which external project a store project mirrors; workspace and team come from the .mstarc [linear] connection block.",
    show: "Show the external project a store project mirrors, or the named absence when it mirrors none.",
  };
  return verbs.map((verb) => {
    const id = `project.${verb}`;
    const opts = options[verb];
    const requirements: CommandRequirement[] = (["cli", "mcp"] as const).flatMap((route): CommandRequirement[] => [
      ...required[verb].map((name) => ({
        name,
        ownership: "caller" as const,
        route,
        required: true,
      })),
      ...(verb === "bind"
        ? [
            {
              name: "expectStore",
              ownership: "caller" as const,
              route,
              required: false,
              tokenKind: "revision" as const,
              constraint: "optional: when supplied, the observed store revision must still hold",
            },
          ]
        : []),
    ]);
    return {
      id,
      cli: {
        path: ["project", verb],
        aliases: [],
        arguments: [],
        options: opts.map((key) => ({
          key,
          flags: flags[key],
          required: required[verb].includes(key),
          ...(key === "expectStore" ? { help: "Optional store revision; when supplied the binding is refused if the store moved." } : {}),
          ...(key === "provider" && verb === "bind" ? { help: "Provider name; only `linear` is supported this iteration." } : {}),
          ...(key === "remoteProject" && verb === "bind"
            ? { help: "The external project this store project mirrors. workspace/team are not flags — they come from .mstarc [linear]." }
            : {}),
        })),
      },
      input: schema.pick(Object.fromEntries(opts.map((key) => [key, true])) as never),
      output: commandEnvelopeSchema,
      effects: verb === "show" ? ["read"] : ["write"],
      description: descriptions[verb],
      requirements,
      execute: (input: Input, invocation: InvocationContext) => run(id, input, invocation),
    };
  });
}
