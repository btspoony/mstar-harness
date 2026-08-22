import { execFileSync } from "node:child_process";

export type RunCliCommandOptions = {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  dryRun?: boolean;
};

/**
 * Run an external command via execFileSync (shell-safe — no shell parsing).
 * `command[0]` is the binary; `command.slice(1)` is the args array.
 * dry-run never spawns; timeout/env/cwd default to no overrides (the global
 * process env + cwd + no timeout — the same shape `runCommand` / `runOmp` had).
 */
export function runCliCommand(command: string[], opts: RunCliCommandOptions = {}): string {
  if (opts.dryRun) return "";
  return execFileSync(command[0], command.slice(1), {
    cwd: opts.cwd,
    encoding: "utf8",
    env: opts.env,
    stdio: "pipe",
    timeout: opts.timeoutMs,
  });
}
