import type { z, ZodType } from "zod";
import type { ExecutionIdentity, RecoveryProblem } from "@mstar-harness/engine";

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
}>;

export type CommandRequirementOwnership = "caller" | "derivable" | "unknown";

export type CommandTokenKind = "root" | "workflow" | "plan" | "revision" | "none";

export type CommandRequirementRoute = "cli" | "mcp";

/**
 * One verified route-specific ownership fact for an input field, recorded by a
 * consumer that has checked how `route` obtains the value: `caller` fields are
 * supplied by the caller on that route, `derivable` fields are filled by the
 * route adapter. Ownership is never inferred from the input schema: the
 * schema's own `required` array remains the enforcement fact, `unknown` makes
 * no requiredness or omission claim, and an absent entry means unknown.
 */
export type CommandRequirement = Readonly<{
  name: string;
  ownership: CommandRequirementOwnership;
  route: CommandRequirementRoute;
  help?: string;
  tokenKind?: CommandTokenKind;
  constraint?: string;
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
  readonly payloads?: Readonly<Record<string, PayloadDescriptor>>;
  readonly requirements?: readonly CommandRequirement[];
  decodeCliInput?(input: Record<string, unknown>): Record<string, unknown> | null;
  execute(input: I, context: InvocationContext): Promise<CommandEnvelope<O>>;
}

export type CommandInput<T extends CommandDefinition> = z.infer<T["input"]>;
