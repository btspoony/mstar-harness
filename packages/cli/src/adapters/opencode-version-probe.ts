import { execFile } from "node:child_process";
import {
  classifyOpencodeProbeError,
  OPENCODE_VERSION_TIMEOUT_MS,
  opencodeProbeFailureMessage,
  parseOpencodeVersionOutput,
  type OpencodeGeneration,
  type OpencodeProbeFailureMode,
} from "@mstar-harness/commands";
import type { ProbeCommandRunner } from "../types";
import { withProbeAbort } from "./probe-timeout";

export type { OpencodeGeneration };

export const OPENCODE_BIN = "opencode";

/**
 * Bounded `opencode --version` generation probe (spec Q3).
 *
 * - The only command ever spawned through the runner seam is
 *   `[opencode, --version]` (`-v` is its documented alias; `opencode models`
 *   and every other subcommand stay banned — the command list is not a
 *   parameter).
 * - The default runner aborts the actual child on timeout (SIGTERM, followed
 *   by SIGKILL if it does not exit); a runner seam that ignores the hint is
 *   additionally cut off by the probe's own timer race.
 * - Every failure resolves to a typed refusal naming its failure mode and
 *   the `--opencode-generation <v1|v2>` recovery — never a guess, no silent
 *   v1 fallback. Missing binaries are normally refused earlier by the
 *   host-presence gate; the probe still fails closed if reached without one.
 */

export class OpencodeVersionProbeRefusal extends Error {
  readonly mode: OpencodeProbeFailureMode;

  constructor(message: string, mode: OpencodeProbeFailureMode) {
    super(message);
    this.name = "OpencodeVersionProbeRefusal";
    this.mode = mode;
  }
}

function defaultRunner(command: readonly string[]): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const child = execFile(
    command[0],
    command.slice(1) as string[],
    { encoding: "utf8", windowsHide: true },
    (error, stdout, stderr) => {
      if (error !== null && error !== undefined) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve(stdout);
    },
  );
  child.once("close", () => clearTimeout(forceKillTimer));
  const abortable = promise as Promise<string> & { abort?: () => void };
  abortable.abort = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!child.kill("SIGTERM")) return;
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 100);
    forceKillTimer.unref();
  };
  return abortable;
}

/** Bounded `opencode --version` generation probe (spec Q3). */

function excerpt(output: string): string {
  const line = output.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

export async function probeOpencodeGeneration(
  runner: ProbeCommandRunner = defaultRunner,
  timeoutMs: number = OPENCODE_VERSION_TIMEOUT_MS,
): Promise<OpencodeGeneration> {
  let output: string;
  try {
    output = await withProbeAbort(runner([OPENCODE_BIN, "--version"], { timeoutMs }), timeoutMs);
  } catch (error) {
    if (error instanceof OpencodeVersionProbeRefusal) throw error;
    const mode = classifyOpencodeProbeError(error);
    const stderr = error !== null && typeof error === "object" && "stderr" in error ? error.stderr : undefined;
    const stdout = error !== null && typeof error === "object" && "stdout" in error ? error.stdout : undefined;
    const detail = typeof stderr === "string" && stderr.trim() !== ""
      ? excerpt(stderr)
      : typeof stdout === "string" && stdout.trim() !== ""
        ? excerpt(stdout)
        : error instanceof Error
          ? excerpt(error.message)
          : undefined;
    throw new OpencodeVersionProbeRefusal(opencodeProbeFailureMessage(mode, detail), mode);
  }
  const generation = parseOpencodeVersionOutput(output);
  if (generation === null) {
    throw new OpencodeVersionProbeRefusal(opencodeProbeFailureMessage("unparseable", excerpt(output)), "unparseable");
  }
  return generation;
}
