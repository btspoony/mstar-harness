import { execFile } from "node:child_process";
import type { Target, ProbeCommandRunner } from "../types";

export type { ProbeCommandRunner };

/**
 * Shared host-binary presence precondition (D14 / spec Q3a): every REAL
 * install (`init` without `--dry-run`) on a target that has a host CLI
 * requires that CLI on PATH; a missing one refuses the real install with an
 * actionable error naming the target's documented install command, before any
 * config write. `--dry-run` NEVER probes or refuses on a missing binary for
 * any target (D15).
 *
 * The presence probe spawns the binary's benign `--version` through the same
 * injectable-runner seam as the version probe, bounded by a short timeout —
 * any failure (ENOENT, non-zero exit, timeout) means "not present", matching
 * the in-repo precedent (`isDshAvailable` / `isCodexAvailable` probe shape).
 */

/** Per-target host binary map; zcode is absent by design because it has no host CLI. */
export const HOST_PRESENCE_BINARIES: Partial<Record<Target, string>> = {
  opencode: "opencode",
  omp: "omp",
  dsh: "dsh", // DSH_BIN (packages/commands/src/host-health/dsh.ts)
  codex: "codex", // CODEX_BIN (packages/commands/src/host-health/codex.ts)
};

/**
 * Presence-probe timeout. The observed healthy path (`opencode --version`)
 * takes ~3s, so "short bounded" must stay above that; this is the same bound
 * the version probe uses by default.
 */
export const HOST_PRESENCE_TIMEOUT_MS = 5_000;

/** Per-target recovery wording mirrors existing adapters; copied to avoid adapter/helper cycles. */
const HOST_PRESENCE_INSTALL_HINTS: Partial<Record<Target, string>> = {
  opencode: "Install the OpenCode CLI (https://opencode.ai), then re-run: npx @mstar-harness/cli init --target opencode --scope <global|project>",
  omp: "Install Oh My Pi (`omp`), then re-run init or manually: omp plugin install @mstar-harness/omp",
  codex: "Install the Codex CLI (https://github.com/openai/codex), e.g. `npm install -g @openai/codex`, then re-run init.",
  dsh: "Install the DeepSeek Harness CLI (@deepseek-ai/dsh), e.g. `pnpm add -g @deepseek-ai/dsh` or `npm install -g @deepseek-ai/dsh`, then re-run init.",
};

export class HostPresenceRefusal extends Error {
  readonly target: Target;
  readonly binary: string;

  constructor(message: string, target: Target, binary: string) {
    super(message);
    this.name = "HostPresenceRefusal";
    this.target = target;
    this.binary = binary;
  }
}

function defaultPresenceRunner(command: readonly string[], opts: { timeoutMs: number }): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile(
    command[0],
    command.slice(1) as string[],
    { timeout: opts.timeoutMs, encoding: "utf8", windowsHide: true },
    (error, stdout) => {
      if (error !== null && error !== undefined) {
        reject(Object.assign(error, { stdout }));
        return;
      }
      resolve(stdout);
    },
  );
  return promise;
}

/**
 * Refuse unless the target's host CLI answers on PATH. Resolves with the
 * binary name when present; throws the typed `HostPresenceRefusal` (naming
 * the target and its documented install command) when not.
 */
export async function ensureHostPresent(target: Target, runner: ProbeCommandRunner = defaultPresenceRunner): Promise<string> {
  const binary = HOST_PRESENCE_BINARIES[target];
  if (binary === undefined) {
    throw new Error(
      `No host CLI is mapped for target ${target} (zcode has no host CLI by design; other targets are wired by their adopting tasks) — presence cannot be checked.`,
    );
  }
  const hint = HOST_PRESENCE_INSTALL_HINTS[target];
  if (hint === undefined) {
    throw new Error(`No documented install command is seeded for target ${target}; the presence refusal would not be actionable.`);
  }
  try {
    await runner([binary, "--version"], { timeoutMs: HOST_PRESENCE_TIMEOUT_MS });
  } catch {
    throw new HostPresenceRefusal(`${binary} CLI not found on PATH. ${hint}`, target, binary);
  }
  return binary;
}
