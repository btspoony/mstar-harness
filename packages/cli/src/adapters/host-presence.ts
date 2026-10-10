import { execFile } from "node:child_process";
import { OPENCODE_VERSION_TIMEOUT_MS } from "@mstar-harness/commands";
import type { Target, ProbeCommandRunner } from "../types";
import { withProbeAbort } from "./probe-timeout";

export type { ProbeCommandRunner };

/**
 * Shared host-binary presence precondition : every REAL
 * install (`init` without `--dry-run`) on a target that has a host CLI
 * requires that CLI on PATH; a missing one refuses the real install with an
 * actionable error naming the target's documented install command, before any
 * config write. `--dry-run` NEVER probes or refuses on a missing binary for
 * any target .
 *
 * Presence resolves the executable on PATH; it does not require `<binary>
 * --version` to succeed. An independent race also cuts off a hung lookup.
 */

/** Per-target host binary map; zcode is absent by design because it has no host CLI. */
export const HOST_PRESENCE_BINARIES: Partial<Record<Target, string>> = {
 opencode: "opencode",
 omp: "omp",
 dsh: "dsh", // DSH_BIN (packages/commands/src/host-health/dsh.ts)
 codex: "codex", // CODEX_BIN (packages/commands/src/host-health/codex.ts)
 cursor: "cursor-agent",
 kimi: "kimi",
};

/** Share the version-probe deadline while bounding PATH lookup independently. */
export const HOST_PRESENCE_TIMEOUT_MS = OPENCODE_VERSION_TIMEOUT_MS;

/** Per-target recovery wording mirrors existing adapters; copied to avoid adapter/helper cycles. */
const HOST_PRESENCE_INSTALL_HINTS: Partial<Record<Target, string>> = {
 opencode: "Install the OpenCode CLI (https://opencode.ai), then re-run: npx @mstar-harness/cli init --target opencode --scope <global|project>",
 omp: "Install Oh My Pi (`omp`), then re-run init or manually: omp plugin install @mstar-harness/omp",
 codex: "Install the Codex CLI (https://github.com/openai/codex), e.g. `npm install -g @openai/codex`, then re-run init.",
 dsh: "Install the DeepSeek Harness CLI (@deepseek-ai/dsh), e.g. `pnpm add -g @deepseek-ai/dsh` or `npm install -g @deepseek-ai/dsh`, then re-run init.",
 cursor: "Install the Cursor CLI with `curl https://cursor.com/install -fsS | bash`, confirm `cursor-agent` is available on PATH, then re-run init.",
 kimi: "Install the Kimi Code CLI (https://www.kimi.com/code/docs/kimi-code-cli/), then re-run: npx @mstar-harness/cli init --target kimi --scope <global|project>",
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

function executableLookupCommand(binary: string): string[] {
 return process.platform === "win32"
 ? ["where.exe", binary]
 : ["/bin/sh", "-c", "command -v \"$1\" >/dev/null 2>&1", "sh", binary];
}

/**
 * Refuse unless the target's host CLI resolves on PATH. Resolves with the
 * mapped executable name when present; throws typed refusal when lookup fails
 * or exceeds its independent timeout.
 */
export async function ensureHostPresent(target: Target, runner: ProbeCommandRunner = defaultPresenceRunner): Promise<string> {
 const binary = HOST_PRESENCE_BINARIES[target];
 if (binary === undefined) {
 throw new Error(
 `No host CLI is mapped for target ${target} (zcode has no host CLI by design; other targets are wired by their adopting tasks) \u2014 presence cannot be checked.`,
 );
 }
 const hint = HOST_PRESENCE_INSTALL_HINTS[target];
 if (hint === undefined) {
 throw new Error(`No documented install command is seeded for target ${target}; the presence refusal would not be actionable.`);
 }
 try {
 const pending = runner(executableLookupCommand(binary), { timeoutMs: HOST_PRESENCE_TIMEOUT_MS });
 await withProbeAbort(pending, HOST_PRESENCE_TIMEOUT_MS);
 } catch {
 throw new HostPresenceRefusal(`${binary} CLI not found on PATH. ${hint}`, target, binary);
 }
 return binary;
}

