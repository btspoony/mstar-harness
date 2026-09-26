import type { z, ZodType } from "zod";

export type CommandStatus = "ok" | "refused" | "usage" | "error";

export type CommandEnvelope<T = unknown> =
  | { version: 1; command: string; status: "ok"; code: string; exitCode: 0; data: T }
  | { version: 1; command: string; status: "refused" | "error"; code: string; exitCode: number; message: string; details?: Record<string, unknown> }
  | { version: 1; command: string; status: "usage"; code: string; exitCode: 2; message: string; details?: Record<string, unknown> };

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
    signal: AbortSignal;
  }): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string }>;
  startDashboard(request: { harnessDir: string; port: number }): Promise<{ url: string; close(): Promise<void> }>;
  openBrowser(url: string): Promise<void>;
}

export interface InvocationContext {
  readonly cwd: string;
  readonly controlRoot: string | null;
  readonly host?: string;
  readonly sessionId?: string;
  readonly versions: SurfaceVersions;
  readonly signal: AbortSignal;
  readonly effects: CommandEffects;
}

export type CliSyntax = Readonly<{
  path: readonly string[];
  aliases: readonly string[];
  arguments: readonly { key: string; required: boolean; variadic: boolean }[];
  options: readonly { key: string; flags: string; required: boolean; defaultValue?: unknown; context?: "sessionId" }[];
}>;

export interface CommandDefinition<I = unknown, O = unknown> {
  readonly id: string;
  readonly cli: CliSyntax;
  readonly input: ZodType<I>;
  readonly output: ZodType<CommandEnvelope<O>>;
  readonly effects: readonly CommandEffect[];
  readonly description: string;
  execute(input: I, context: InvocationContext): Promise<CommandEnvelope<O>>;
}

export type CommandInput<T extends CommandDefinition> = z.infer<T["input"]>;
