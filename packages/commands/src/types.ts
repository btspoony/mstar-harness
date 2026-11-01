import type { z, ZodType } from "zod";
import type { ExecutionIdentity, IssueProvider, RecoveryProblem } from "@mstar-harness/engine";

export type CommandStatus = "ok" | "refused" | "usage" | "error";

export type CommandEnvelope<T = unknown> =
  | { version: 1; command: string; status: "ok"; code: string; exitCode: 0; data: T; details?: Record<string, unknown> }
  | { version: 1; command: string; status: "refused" | "error"; code: string; exitCode: number; message: string; details?: Record<string, unknown>; helpRoute?: string; recovery?: string }
  | { version: 1; command: string; status: "usage"; code: string; exitCode: 2; message: string; details?: Record<string, unknown>; helpRoute?: string; recovery?: string };

export type IndexedDiagnostic = RecoveryProblem & Readonly<{ index: number }>;

export type DecodeResult<T> =
  | Readonly<{ success: true; data: T }>
  | Readonly<{ success: false; diagnostics: readonly IndexedDiagnostic[] }>;

export type PayloadDescriptor = Readonly<{
  schema: ZodType;
  help?: string;
  registryName?: string;
}>;

export type CommandRequirementOwnership = "caller" | "derivable" | "unknown";

export type CommandTokenKind = "root" | "workflow" | "plan" | "revision" | "none";

export type CommandRequirementRoute = "cli" | "mcp";

export type CommandRequirementAlternative = Readonly<{ name: string; whenTrue?: boolean }>;
/**
 * One verified route-specific ownership fact for an input field, recorded by a
 * consumer that has checked how `route` obtains the value: `caller` fields are
 * supplied by the caller on that route, `derivable` fields are filled by the
 * route adapter. Ownership is never inferred from the input schema: the
 * schema's own `required` array remains the enforcement fact, `unknown` makes
 * no requiredness or omission claim, and an absent entry means unknown.
 */
export type CommandRequirementCardinality = "exactly-one" | "at-least-one" | "at-most-one";
export type CommandRequirementPrimitive = string | boolean | number;

export type CommandRequirement = Readonly<{
  name: string;
  ownership: CommandRequirementOwnership;
  route: CommandRequirementRoute;
  help?: string;
  tokenKind?: CommandTokenKind;
  constraint?: string;
  required?: boolean;
  condition?: Readonly<{ field: string; present?: boolean; equals?: string | boolean | number }>;
  allowedValues?: readonly CommandRequirementPrimitive[];
  alternatives?: Readonly<{
    cardinality: CommandRequirementCardinality;
    members: readonly CommandRequirementAlternative[];
  }>;
}>;
export type CommandEffect = "read" | "validate" | "write" | "stdin" | "process" | "service" | "browser";

export type SurfaceVersions = Readonly<{
  engine: string | null;
  cli: string | null;
  plugin: string | null;
  host: string | null;
  platform: string | null;
}>;

export interface CommandEffects {
  readInput(): Promise<string>;
  spawn(request: {
    argv: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    stdin?: string;
    stdinMode?: "inherit" | "ignore";
    signal: AbortSignal;
  }): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }>;
  startDashboard(request: { harnessDir: string; port: number; projectId?: string }): Promise<{ url: string; close(): Promise<void> }>;
  openBrowser(url: string): Promise<void>;
  /**
   * The host's read-only issue provider for one store project, or `null` when
   * this host ships no adapter. The host owns credential custody and the MCP
   * transport (compass D3), so the command asks for a provider and never learns
   * a token. Absent on the CLI, which has no host transport.
   */
  issueProvider?(projectId: string): IssueProvider | null;
  /**
   * Host capability: run the browser authorization leg and return the token set,
   * or null when the host cannot. The command decides what to store; the host
   * only knows how to talk to the authorization server.
   */
  linearAuthorize?(mcpUrl: string): Promise<{
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number | null;
    scope: string | null;
  } | null>;
  writeStderr?(message: string): void;
  captureSddEvidence?(requestPath: string, argv: readonly string[]): Promise<unknown>;
  verifySddEvidence?(request: {
    sddDir: string;
    planId: string;
    taskId: string;
    runId: string;
    targetPath?: string;
  }): Promise<unknown>;
  /**
   * The installed Morning Star plugin version for one host target, detected by
   * the transport that owns per-host discovery (the CLI probes package caches
   * and `plugin list` subprocesses). `null` = not installed / not detectable;
   * an unset hook degrades to the same `null`, so the doctor note builder is
   * the single place that formats every outcome.
   */
  detectPluginVersion?(request: { target: string; scope: string }): string | null;
}

export interface InvocationContext {
  readonly cwd: string;
  readonly controlRoot: string | null;
  /**
   * The explicit `mstar mcp --harness <absolute path>` pin, when the server was
   * mounted with one. `controlRoot` is the admission default for commands that
   * declare a per-call `harness`; this field carries the same pin as the exact
   * harness dir so a command that owns root placement (e.g. `harness.scaffold`)
   * can target it verbatim instead of re-discovering a root from `cwd`.
   * Unpinned MCP servers and the CLI probe never set it.
   */
  readonly harnessPin?: string;
  /**
   * Set only when `cwd` is an MCP server's LAUNCH directory: the connection
   * declared no workspace, so the directory is the HOST's checkout and says
   * nothing about the caller's. Absent everywhere else, including the CLI,
   * whose `cwd` is the directory the caller ran the command from. A command
   * that would default a path input from it, or take the checkout itself as its
   * subject, refuses instead (`launch-workspace.ts`).
   */
  readonly launchDirectory?: true;
  readonly host?: string;
  readonly sessionId?: string;
  readonly sessionIdSource?: "flag" | "env";
  /**
   * The launcher-minted execution identity this invocation resolved from
   * `MSTAR_EXECUTION_IDENTITY` (`session.run` and the managed host gates write
   * it), already validated as one §3.1 tuple. It is an attribution/scope fact
   * only: the engine's own live-binding and owner checks still decide, and the
   * tuple's declared `workflowId`/`role`/`planId` constrain which request the
   * identity may address — it is never itself a credential and never authorizes
   * a scope other than the one it declares. Absent on the flag and ambient
   * environment routes, whose identity carries no scope transport.
   */
  readonly executionIdentity?: ExecutionIdentity;
  /**
   * The shell-transport leaf fact (#548): the trusted shell tool exported
   * `DSH_MSTAR_LEAF_SEAT=1` / `MSTAR_LEAF_SEAT=1` because the calling session
   * header says leaf (`origin: "subagent"` or `delegationDepth > 0`). It is a
   * fail-closed fact only — it can only cause a `coordination.leaf-seat`
   * refusal, never grant anything — and an env channel's inherent limit stands:
   * a leaf that strips the marker from its own environment is not distinguishable.
   */
  readonly leafSeat?: true;
  readonly versions: SurfaceVersions;
  readonly signal: AbortSignal;
  readonly effects: CommandEffects;
}

export type CliSyntax = Readonly<{
  path: readonly string[];
  aliases: readonly string[];
  arguments: readonly { key: string; required: boolean; variadic: boolean; choices?: readonly string[] }[];
  options: readonly { key: string; flags: string; required: boolean; defaultValue?: unknown; context?: "sessionId"; variadic?: boolean; help?: string }[];
}>;

export interface CommandDefinition<I = unknown, O = unknown> {
  readonly id: string;
  readonly cli: CliSyntax;
  readonly input: ZodType<I>;
  readonly output: ZodType<CommandEnvelope<O>>;
  readonly effects: readonly CommandEffect[];
  readonly description: string;
  /**
   * The input fields that select WHICH ROOT this command executes against, in
   * precedence order. The default is the `harness` field the command publishes.
   *
   * Name a different field when a family resolves its own root from it
   * (`sdd.workspace` takes `controlRoot`), and declare an EMPTY list when the
   * field only names an operation TARGET rather than the root the command runs
   * from (`store.execution.*` take the foreign harness they export or restore,
   * not their own store). The MCP connection pin governs these fields: a pinned
   * connection overwrites a root selector and leaves a target untouched.
   */
  readonly rootInputs?: readonly string[];
  readonly payloads?: Readonly<Record<string, PayloadDescriptor>>;
  readonly requirements?: readonly CommandRequirement[];
  decodeCliInput?(input: Record<string, unknown>): Record<string, unknown> | null;
  execute(input: I, context: InvocationContext): Promise<CommandEnvelope<O>>;
}

export type CommandInput<T extends CommandDefinition> = z.infer<T["input"]>;
