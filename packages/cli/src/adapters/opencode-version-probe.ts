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

export type { OpencodeGeneration };

export const OPENCODE_BIN = "opencode";

/**
 * Bounded `opencode --version` generation probe (spec Q3).
 *
 * - The only command ever spawned through the runner seam is
 *   `[opencode, --version]` (`-v` is its documented alias; `opencode models`
 *   and every other subcommand stay banned — the command list is not a
 *   parameter).
 * - The default runner aborts the child at `timeoutMs`; a runner seam that
 *   ignores the hint (e.g. a never-settling test fake) is additionally cut
 *   off by the probe's own timer race.
 * - Every failure resolves to a typed refusal naming the failure mode and
 *   the `--opencode-generation <v1|v2>` recovery — never a guess, no silent
 *   v1 fallback. A missing binary is normally refused earlier by the
 *   host-presence gate; the probe still fails closed if it is ever reached
 *   without one.
 */

export class OpencodeVersionProbeRefusal extends Error {
  readonly mode: OpencodeProbeFailureMode;

  constructor(message: string, mode: OpencodeProbeFailureMode) {
    super(message);
    this.name = "OpencodeVersionProbeRefusal";
    this.mode = mode;
  }
}

function defaultRunner(command: readonly string[], opts: { timeoutMs: number }): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(
    command[0],
    command.slice(1) as string[],
    { timeout: opts.timeoutMs, encoding: "utf8", windowsHide: true },
    (error, stdout, stderr) => {
      if (error !== null && error !== undefined) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve(stdout);
    },
  );
  return promise;
}

/** Cut off a runner seam that never settles even though it received the timeout hint. */
function withProbeAbort(pending: Promise<string>, timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`\`opencode --version\` probe timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" })),
      timeoutMs,
    );
  });
  abort.catch(() => {}); // the losing branch must never surface as an unhandled rejection
  return Promise.race([pending, abort]).finally(() => clearTimeout(timer));
}

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
