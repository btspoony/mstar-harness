import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { readMainWorktree } from "@mstar-harness/engine";
import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { Transport } from "@modelcontextprotocol/server";
import { withToolCorrection } from "./correction.js";
import type { McpEffects } from "./effects.js";
import { createMcpServer } from "./server.js";
import type { ResolveContext, ResolveContextCall } from "./register.js";

/**
 * Commands whose own operation establishes a harness root in a workspace that
 * has none: a null control root is their premise, not a misresolution, so the
 * resolver admits them without one (the bootstrap channel a fresh workspace
 * uses to establish its harness over MCP).
 */
const NULL_ROOT_BOOTSTRAP_COMMANDS = new Set(["harness.scaffold"]);

/**
 * Commands whose CONTRACT reads no control root: the answer they produce does
 * not depend on WHICH workspace the call belongs to, because every path they
 * touch is either an explicit input or the query's own subject. A null root is
 * a complete answer for them, so admitting one is not a misresolution — refusing
 * it would deny discovery and validation over a shared connection, and for most
 * of them the refusal's own recovery (`pass the call's harness selector`) is
 * unavailable, since they publish no such field. The one exception, the
 * `store.execution.*` family, publishes a `harness` that names the operation
 * TARGET: the target is the object, not the root the command executes against.
 *
 * The classification is a CONTRACT fact, not a handler accident, so it cannot be
 * derived from a definition: a command's handler is the only place that knows
 * whether it resolves a harness / review / specs / workflow / project directory.
 * It is therefore hand-classified, and the whole catalog's classification is
 * pinned by `test/mcp-harness-root.test.ts` — a command added without a decision
 * fails that suite instead of silently inheriting a refusal (or silently
 * inheriting a null root).
 *
 * Admission is only half the contract. A null root leaves the invocation
 * `workspace` at this server's launch directory (`launchDirectory: true`),
 * so a member that DEFAULTS a path input to it — or takes the checkout itself as
 * its subject — would read, or worse write, the HOST's own checkout. Such a
 * member is admitted here and then refuses per call (`families/launch-workspace.ts`)
 * with the cause and the recoveries, exactly as `path.resolve` does; the same
 * suite pins which members those are. A write never lands in a directory the
 * caller did not name: `harness.scaffold` keeps its null-root bootstrap
 * exception but requires an explicit root instead of adopting the launch
 * directory.
 *
 * Excluded on purpose, each because it derives something from a root:
 * - every command whose `harness` input or flag is its ROOT selector (the root
 *   is its own input, and admission requires it on an unpinned connection);
 * - commands that read `invocation.controlRoot` (`persist.*`, `dashboard`,
 *   `compound.validate`'s catalog query, `worktree.check`, …) or derive an
 *   implicit harness path from the invocation workspace (`audit.scaffold`'s
 *   `{REVIEW_DIR}`, `pr-review.report-path`'s default review dir, `sdd.workspace`,
 *   `status.validate`);
 * - `pr-review.worktree-setup`, which runs its Git discovery in the invocation
 *   workspace and exposes no workspace field of its own: with a null root it
 *   would either fail outside a checkout or review the host's repository.
 */
const ROOT_FREE_COMMANDS: ReadonlySet<string> = new Set([
  "schema",
  "path.resolve",
  "path.check",
  "host.detect",
  "host.skill-root",
  "doctor",
  "plugin.validate",
  "report",
  "lint",
  "design-md.validate",
  "skill.lint",
  "roles.validate",
  "qc.validate-report",
  "review.seats",
  "dispatch.validate",
  "worktree.qc-alignment",
  "iteration.push-cadence",
  "audit.secret-scan",
  "audit.supply-chain",
  "pr-review.tally",
  "pr-review.budget",
  "pr-review.validate-report",
  "pr-review.size",
  "pr-review.seat-prompt",
  "pr-review.post",
  "pr.merge-gate",
  "pr-review.worktree-cleanup",
  // Their only `harness` field is the operation TARGET they export or restore,
  // not a root they execute against: with no connection root they still have
  // every fact their contract needs, and the family's own target==control-root
  // guard simply has no control root to protect on such a connection.
  "store.execution.export",
  "store.execution.restore-preview",
  "store.execution.restore",
]);

/**
 * The named refusal for a call on a connection that DECLARED no control root
 * and named none itself: the resolver refuses with the cause and every recovery
 * instead of letting the host's launch directory stand in for the caller's
 * workspace. The stdio transport surfaces the message as a tool error.
 */
export class McpControlRootError extends Error {
  readonly code = "mcp.control-root-unresolved";
  constructor(
    message: string,
    readonly details: { cwd: string },
  ) {
    super(message);
    this.name = "McpControlRootError";
  }
}

function unresolvedControlRootMessage(cwd: string, rootInputs: readonly string[]): string {
  const recovery = rootInputs.length > 0
    ? `Recovery: pass the call's \`${rootInputs[0]}\` selector naming the control root \u2014 the absolute \`<main worktree>/.mstar\` path; \`mstar path resolve\` prints it as \`controlHarnessDir\`.`
    : "Recovery: this command publishes no root selector on a shared connection. Run it through the CLI from the repository (`mstar <command>`), or use a command that publishes a root selector.";
  return (
    `[mcp.control-root-unresolved] This call named no control root. ` +
    `The MCP server is one shared service, so its launch cwd (${cwd}) and its launch configuration never choose a repository. ` +
    recovery
  );
}

/** The seat values a launcher can declare; a leaf connection refuses the coordinator-seat commands. */
export type McpSeat = "leaf";

export interface McpStdioOptions {
  /**
   * Session workspace every call runs from (the invocation `cwd`). Unset
   * anchors it on the declared root's parent directory, so cwd-derived paths
   * land under the declared harness. The launch process cwd is used only when
   * the connection declared neither, and the invocation is then marked
   * `launchDirectory: true`: a root-free command may not default a path from it
   * (it is the HOST's checkout), so declaring this flag is also how a mounting
   * host names the directory `harness.scaffold` may bootstrap.
   */
  workspace?: string;
  /**
   * The connection's seat. `leaf` refuses the coordinator-seat commands
   * (`plan.bind`, `plan.complete`) before execution with the named cause and
   * recovery; every other command stays reachable, so a leaf session keeps
   * its writable subset instead of having no route at all.
   */
  seat?: McpSeat;
  /**
   * Explicit opt-in: trust a caller-declared `sessionId` as an execution
   * identity (`--trust-caller-session-id`, off by default). An MCP server is a
   * child process with no host-proven caller identity, so accepting the value
   * lets any caller address another session's coordinator row. Leave it unset
   * on a shared connection; the dsh native tools and the CLI are the
   * host-proven routes.
   */
  trustCallerSessionId?: boolean;
}

/** why: The root one admitted CALL named, as a root fact: absolute, and equal to the
 * fixed `<main worktree>/.mstar`. A relative selector has no launch-directory
 * anchor — the invocation workspace is anchored at the root's parent, so
 * resolving it against the launch directory would name a directory the caller
 * never did. A selector naming a linked worktree, a legacy directory or any
 * other path is refused instead of adopted, because the process root is one
 * Git-derived location.
 */
function callRoot(selector: string, commandId: string): string {
  if (!isAbsolute(selector)) {
    throw new McpControlRootError(
      `[mcp.control-root-unresolved] ${commandId}'s "harness" selector must be an absolute path; got ${JSON.stringify(selector)}. ` +
        "Recovery: pass `mstar path resolve`'s `controlHarnessDir` (an absolute `<main worktree>/.mstar` path).",
      { cwd: process.cwd() },
    );
  }
  const root = resolve(selector);
  if (!existsSync(root) || basename(root) !== ".mstar") {
    throw new McpControlRootError(
      `[mcp.control-root-unresolved] ${commandId}'s "harness" selector must name the fixed existing control root .mstar; got ${JSON.stringify(root)}. ` +
        "Recovery: run `mstar path resolve` and pass its `controlHarnessDir`.",
      { cwd: process.cwd() },
    );
  }
  const parent = dirname(root);
  let parentReal: string;
  try {
    parentReal = realpathSync(parent);
  } catch {
    throw new McpControlRootError(
      `[mcp.control-root-unresolved] ${commandId}'s "harness" selector has an unreadable parent ${JSON.stringify(parent)}. ` +
        "Recovery: run `mstar path resolve` and pass its `controlHarnessDir`.",
      { cwd: process.cwd() },
    );
  }
  const main = readMainWorktree(parent);
  if (main === null || main.root !== parentReal) {
    throw new McpControlRootError(
      `[mcp.control-root-unresolved] ${commandId}'s "harness" selector ${JSON.stringify(root)} is not the Git main worktree's .mstar; ` +
        (main === null ? "Git cannot name a main worktree there" : `the main worktree is ${main.root}`) +
        ". Recovery: run `mstar path resolve` from the repository and pass its `controlHarnessDir`.",
      { cwd: process.cwd() },
    );
  }
  return root;
}

/**
 * Build the stdio context resolver for one launch. The exported `resolveContext`
 * below is this factory with no options: a generic shared connection that
 * carries no root of its own and no identity.
 *
 * Root selection, and the launch cwd is never a candidate:
 *
 * 1. the root the ADMITTED CALL named (`harness` selector), which must be the
 *    fixed `<main worktree>/.mstar`;
 * 2. a null root for the commands whose contract needs none — the bootstrap
 *    exception (`harness.scaffold`, which establishes a root) and the
 *    root-free class (`ROOT_FREE_COMMANDS`);
 * 3. otherwise the call is REFUSED (`mcp.control-root-unresolved`) with the
 *    cause and recovery.
 *
 * The MCP server is one long-lived service: no launch flag or environment
 * variable names a repository, because that would root unrelated calls at the
 * same harness. The caller's session is the only place the repository is
 * known, so the per-call selector is the only route.
 *
 * The resolved root also anchors the invocation **workspace**: `cwd` is the
 * root's parent directory, never `process.cwd()`, so every implicit
 * harness-derived path follows the root the call uses instead of the host's
 * directory. The null-root paths keep `process.cwd()` and mark the workspace
 * `launchDirectory: true`, so a command that would default a path from it
 * refuses rather than reading the host's checkout.
 */
export function createContextResolver(options: McpStdioOptions = {}): ResolveContext {
  const resolver: ResolveContext = (definition, _sessionId, signal, _services, effects: McpEffects, call?: ResolveContextCall) => {
    // why: The root the ADMITTED CALL named. A blank value is not a declaration:
    // the command resolvers treat it as absent, so it must not become a root
    // candidate here either. It must be ABSOLUTE and equal to the fixed
    // control root; `callRoot` refuses everything else with the recovery.
    const callHarness = typeof call?.harness === "string" && call.harness.trim() !== "" ? callRoot(call.harness, definition.id) : undefined;
    let controlRoot: string | null;
    if (callHarness !== undefined) controlRoot = callHarness;
    else if (NULL_ROOT_BOOTSTRAP_COMMANDS.has(definition.id)) controlRoot = null;
    else if (ROOT_FREE_COMMANDS.has(definition.id)) controlRoot = null;
    else {
      const cwd = process.cwd();
      throw new McpControlRootError(unresolvedControlRootMessage(cwd, definition.rootInputs ?? []), { cwd });
    }
    return {
      cwd: options.workspace ?? (controlRoot === null ? process.cwd() : dirname(controlRoot)),
      controlRoot,
      // `cwd` is a NAMED directory only when the launcher declared the workspace
      // itself (`--workspace`) or a root was resolved: then it is that root's
      // parent. Otherwise it is this server's own launch directory, which is the
      // HOST's checkout and says nothing about the caller's workspace, so a
      // command may neither default a path input from it nor answer about it.
      ...(options.workspace === undefined && controlRoot === null ? { launchDirectory: true as const } : {}),
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
      signal,
      effects,
    };
  };
  // why: The connection declares no root: every call that touches process state
  // names one, and registration publishes `harness` as required.
  Object.defineProperty(resolver, "defaultHarness", {
    get: () => undefined,
    enumerable: true,
  });
  // Registration reads this to decide whether the per-call `sessionId`
  // selector exists at all. A construction-time snapshot is right here: the
  // opt-in is a launch flag, not a mutable fact.
  Object.defineProperty(resolver, "callerIdentity", {
    value: options.trustCallerSessionId === true,
    enumerable: true,
  });
  return resolver;
}

export const resolveContext: ResolveContext = createContextResolver();

export function serveMcpStdio(options: McpStdioOptions = {}): StdioServerHandle {
  return serveMcpStdioOver(new StdioServerTransport(), options);
}

/**
 * The production stdio assembly, parameterized over the transport so tests can
 * drive the exact serving path (real command catalog → catalog provider →
 * corrective transport) with an in-memory transport. The catalog must be
 * populated through the same `onNames` callback wiring the process entry uses;
 * a broken wiring shows up as a missing suggestion in end-to-end tests.
 */
export function serveMcpStdioOver(transport: Transport, options: McpStdioOptions = {}): StdioServerHandle {
  const catalog = new Set<string>();
  const corrected = withToolCorrection(transport, () => catalog);
  return serveStdio(() => createMcpServer(createContextResolver(options), undefined, (names) => {
    for (const name of names) catalog.add(name);
  }, options.seat), { legacy: "serve", transport: corrected });
}

if (import.meta.main) {
  await serveMcpStdio();
}
