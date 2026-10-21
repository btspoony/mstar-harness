import { dirname, resolve } from "node:path";
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

function unresolvedControlRootMessage(cwd: string): string {
  return (
    `[mcp.control-root-unresolved] No control root was DECLARED for this MCP connection. ` +
    `The launch cwd (${cwd}) is the HOST's directory and is never used as one: it says nothing about which workspace a caller belongs to, so adopting it would root writes on an unrelated project. ` +
    "Recovery \u2014 the two launcher recoveries work for EVERY command: " +
    "launch the server with `mstar mcp --harness <absolute path>`; " +
    "set MSTAR_HARNESS_DIR in the server environment to the harness directory. " +
    "The per-call recovery is tool-dependent: only a command that publishes a `harness` input accepts one, so pass the call's `harness` selector naming the workspace's harness \u2014 or use `mstar_schema` to pick a command that does not need a root at all."
  );
}

/** The seat values a launcher can declare; a leaf connection refuses the coordinator-seat commands. */
export type McpSeat = "leaf";

export interface McpStdioOptions {
  /**
   * Harness root the launcher DECLARES for the whole connection (`--harness`).
   * It pins every call's `controlRoot` and is the admission default for any
   * command that resolves its own root from `input.harness`. A non-blank
   * `MSTAR_HARNESS_DIR` in the server environment is the same declaration when
   * this option is unset; a call's own `harness` selector is used only when the
   * launch declared neither. The launch cwd is never a root candidate.
   */
  harnessRoot?: string;
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

/**
 * The root the launch declared for the whole connection, or undefined when it
 * declared none. The `--harness` flag wins over `MSTAR_HARNESS_DIR`: both are
 * launcher facts, and the explicit flag is the stronger one; neither is
 * overridable by a caller. A blank variable is not a declaration.
 *
 * Both forms are resolved to an absolute path here: `--harness` already refuses
 * a relative value at the CLI boundary (it is a usage error, not a guess), while
 * the ENVIRONMENT form is a launcher fact with no CLI boundary to refuse it, so a
 * relative `MSTAR_HARNESS_DIR` means "relative to the server's launch directory".
 * Resolving once, at the seam, is what keeps every downstream `dirname` anchor
 * absolute. Read ONCE when the factory runs — the declared root is a launch fact.
 */
function declaredRoot(options: McpStdioOptions): string | undefined {
  if (options.harnessRoot !== undefined) return resolve(options.harnessRoot);
  const fromEnv = process.env.MSTAR_HARNESS_DIR;
  return typeof fromEnv === "string" && fromEnv.trim() !== "" ? resolve(fromEnv) : undefined;
}

/**
 * Build the stdio context resolver for one launch. The exported `resolveContext`
 * below is this factory with no options: a generic shared connection that
 * declares no root and carries no identity.
 *
 * Root selection is one ordered rule, and the launch cwd is never a candidate:
 *
 * 1. the connection pin — `--harness`, else a non-blank `MSTAR_HARNESS_DIR`;
 * 2. the root the ADMITTED CALL named (`harness` selector, validated by shared
 *    admission), resolved to an absolute path;
 * 3. a null root for the commands whose contract needs none — the bootstrap
 *    exception (`harness.scaffold`, which establishes a root) and the
 *    root-free class (`ROOT_FREE_COMMANDS`);
 * 4. otherwise the call is REFUSED (`mcp.control-root-unresolved`) with the
 *    cause and every recovery.
 *
 * A connection pin always beats a per-call selector, so a caller can never root
 * a call on a workspace the launcher did not declare. The order matters:
 * testing the call selector before `MSTAR_HARNESS_DIR` would let a caller
 * override a launcher-declared pin — the bug this rule exists to prevent.
 *
 * The rule the resolution uses also anchors the invocation **workspace**: `cwd`
 * is the root's parent directory, never `process.cwd()`, so every implicit
 * harness-derived path — a command's review root (e.g. `audit.scaffold` without
 * `--reviews-dir`), a relative `--dir` / findings path — follows the root the
 * call actually uses instead of the host's directory. The null-root paths (the
 * bootstrap exception and the root-free class) keep `process.cwd()`: they have
 * no root to anchor on, so the workspace is marked `launchDirectory: true` and
 * the commands that would default a path from it refuse instead of reading or
 * writing the host's checkout. A launcher that declares the workspace itself
 * (`--workspace`) names that directory, so the marker is absent.
 *
 * The `--harness` pin is also published as `harnessPin` (the exact harness dir,
 * not its parent), so a command that owns root placement — `harness.scaffold`
 * with no explicit path — initializes the pinned harness itself instead of
 * re-discovering a root from the workspace anchor. An environment-declared root
 * needs no separate pin: the command's own resolution reads the same variable.
 */
export function createContextResolver(options: McpStdioOptions = {}): ResolveContext {
  const pinned = declaredRoot(options);
  const resolver: ResolveContext = (definition, _sessionId, signal, _services, effects: McpEffects, call?: ResolveContextCall) => {
    // The root the ADMITTED CALL named. A blank value is not a declaration:
    // the command resolvers treat it as absent, so it must not become a root
    // candidate here either. It is resolved against the launch directory for
    // the same reason the pin is: `cwd` below is derived from `dirname(root)`,
    // so a relative root would be re-resolved against its own parent and
    // double-join the path.
    const callHarness = typeof call?.harness === "string" && call.harness.trim() !== "" ? resolve(call.harness) : undefined;
    let controlRoot: string | null;
    if (pinned !== undefined) controlRoot = pinned;
    else if (callHarness !== undefined) controlRoot = callHarness;
    else if (NULL_ROOT_BOOTSTRAP_COMMANDS.has(definition.id)) controlRoot = null;
    else if (ROOT_FREE_COMMANDS.has(definition.id)) controlRoot = null;
    else {
      const cwd = process.cwd();
      throw new McpControlRootError(unresolvedControlRootMessage(cwd), { cwd });
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
      // A flag pin is also the exact harness dir: commands that own root
      // placement (e.g. `harness.scaffold`) must target it verbatim, not
      // re-derive it. An environment-declared root needs no separate pin: the
      // command's own resolution reads the same variable.
      ...(options.harnessRoot === undefined ? {} : { harnessPin: resolve(options.harnessRoot) }),
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
      signal,
      effects,
    };
  };
  // The declared root is the connection's default for admission: a command that
  // resolves its own root from `input.harness` has that field filled from it,
  // and registration publishes `harness` as REQUIRED when this is undefined —
  // an unpinned connection, where the caller must name the root on every call.
  Object.defineProperty(resolver, "defaultHarness", {
    get: () => pinned,
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
