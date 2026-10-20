/**
 * The ONE dsh-native tool on the writable mstar surface:
 * `mstar_execution_clear`.
 *
 * This module used to publish fourteen mstar commands as dsh tools — the seven
 * writable commands (`plan.bind`/`plan.prepare`/`plan.progress`/`plan.complete`
 * + `workflow.register` + `issue.add`/`issue.close`) here and the seven
 * read-only ones in `tools.ts` — each duplicating an MCP tool of the SAME name
 * 1:1. Two identical surfaces forced the model to choose between them and cost
 * ~10k characters of fixed context per request, so the duplicates are gone: the
 * scoped MCP mount (`scoped-mcp-mount.ts`, one connection per agent carrying
 * `--identity-env`) is the writable command surface on this host and covers
 * every one of those commands.
 *
 * What remains is the one capability no MCP command provides: clearing the
 * calling session's own durable execution binding — the dsh-side
 * `executionBinding` slot in the control root's store, which is dsh plugin
 * state rather than an engine operation (there is no shared `execution.clear`
 * command to map through). Its shape is unchanged from the version that shipped
 * beside the command tools:
 *
 * - the parameter face is EMPTY and the session id comes from `exec.agent.id`
 *   (ADR `dsh-native-identity-channels` constraints 1–2: `Agent.id` IS the
 *   session id, and per-caller identity is available at the tool seam), so
 *   identity is never model-choosable — a `sessionId` argument is ignored, the
 *   caller's own binding is the only one a call can reach;
 * - a known leaf seat refuses FAIL-CLOSED before the store read (the shared
 *   `leaf-seat.ts` predicate; the engine has no leaf concept, so this dsh-side
 *   check is the sole enforcement);
 * - the named outcomes surface as `CommandEnvelope`s: `cleared` → ok,
 *   `no-binding` → a refusal naming the cross-root case, an unreadable/refused
 *   store → a refusal carrying the store's own reason, and a `cwd-mismatch`
 *   store answer additionally carries the RECORDED workspace under
 *   `data.recordedCwd` so its recovery is performable instead of descriptive.
 *
 * No shell anywhere in the path: the clear calls the dsh-side store internals
 * directly (`execution-session.ts`), never a child process.
 *
 * Module boundary: self-contained for the clear — the imports are the cordis
 * context type, the dsh-tools seam, the engine's session-binding reader (the
 * recorded-workspace fact on the failure path only), the shared refusal
 * envelope, the leaf-seat predicate, the session cwd reader, the clear
 * internals and the per-workspace harness resolver.
 */
import { type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { readDshSessionBinding } from '@mstar-harness/engine'
import { refusalEnvelope } from '@mstar-harness/commands'
import type { CommandEnvelope } from '@mstar-harness/commands'
import { sessionCwdOf } from './_shared.ts'
import { isLeafSeatHeader } from './leaf-seat.ts'
import { clearExecutionSessionBinding } from './execution-session.ts'

/**
 * The caller identity of one tool execution: `exec.agent.id` (ADR constraint
 * 1 — a dsh agent's identity and its session identity are the same value).
 */
function callerSessionIdOf(exec: ToolExecution): string {
  const id = (exec.agent as { id?: unknown } | null | undefined)?.id
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('the native mstar tool requires a calling agent identity (exec.agent.id); none is present on this execution')
  }
  return id
}

/**
 * The session header the leaf-seat contract reads — the same agent shape the
 * scoped MCP mount consumes (`agent.session.header`).
 */
function sessionHeaderOf(exec: ToolExecution): unknown {
  return (exec.agent as { session?: { header?: unknown } } | null | undefined)?.session?.header
}

/**
 * The fail-closed leaf-seat refusal (the shared `leaf-seat.ts` contract): a
 * known leaf seat can never own a coordinator seat or an execution binding —
 * the named guard the removed execution-session command enforced, restored on
 * this surface before any store read. The recovery names the actual cause and
 * the supported way out (run it as the coordinating session; a leaf seat never
 * needs a binding).
 */
function leafSeatRefusal(command: string): CommandEnvelope<never> {
  return refusalEnvelope({
    command,
    status: 'refused',
    code: `${command}.leaf-seat`,
    exitCode: 1,
    message: 'known leaf sessions cannot adopt, clear, or run on any operation',
    recovery:
      'This seat is a leaf (session header origin "subagent" or a delegationDepth > 0); coordinator seats and execution bindings belong to non-leaf sessions — run the operation as the coordinating session itself, or continue without an execution binding.',
  })
}

/** One-line summary of a command envelope for the model-facing render. */
function envelopeSummary(commandId: string, envelope: CommandEnvelope): string {
  if (envelope.status === 'ok') return `${commandId}: ok (exit ${envelope.exitCode})`
  return `${commandId}: ${envelope.status} ${envelope.code} (exit ${envelope.exitCode}) — ${envelope.message}`
}

/**
 * The lossless-JSON value domain the dsh-tools seam accepts as a canonical
 * value (the `json` output node's value domain).
 */
type JsonValue = import('@deepseek-ai/dsh-util-values').JsonValue

/**
 * Project an envelope onto the tool's canonical value: the dsh-tools seam
 * requires lossless JSON, and a shared envelope may carry `undefined` members.
 * The JSON round-trip is the SAME projection every other transport applies when
 * it serializes the envelope — the content is untouched, only the
 * lossy-for-JSON members go.
 */
function toCanonicalValue(envelope: CommandEnvelope): JsonValue {
  return JSON.parse(JSON.stringify(envelope)) as JsonValue
}

/**
 * The workspace the session's durable records are keyed to, when the store
 * answered `cwd-mismatch` — one extra engine read on the clear's FAILURE path
 * only (the successful path never pays it). The recorded fact is what makes
 * "run the clear from the workspace the durable records are keyed to" a fact
 * the caller can act on instead of a condition it cannot see.
 */
function recordedCwdOf(harnessDir: string, sessionId: string, cwd: string): string | undefined {
  const read = readDshSessionBinding({ harnessDir }, sessionId, cwd)
  return read.kind === 'unavailable' && read.reason === 'cwd-mismatch' ? read.recordedCwd : undefined
}

/**
 * The logical command id the native clear reports in its envelope. There is
 * no shared `execution.clear` command to map through a command tool — the
 * clear is a dsh-native tool wrapping the dsh-side binding internals, so its
 * envelope is assembled here with the same shape the shared commands answer.
 */
const EXECUTION_CLEAR_COMMAND = 'execution.clear'

/** The ok envelope of a completed clear (the shared commands' ok shape). */
function executionClearOk(): CommandEnvelope {
  return { version: 1, command: EXECUTION_CLEAR_COMMAND, status: 'ok', code: 'execution.clear.ok', exitCode: 0, data: null }
}

/**
 * The named no-harness refusal of the clear: the remaining case is a session
 * with no workspace at all, or one whose workspace declares no harness and
 * whose plugin config names none. The recovery names both routes that exist in
 * this build — a workspace that declares the control harness, and the plugin's
 * own `harnessDir` config (which wins over workspace probing).
 */
function executionClearNoHarness(): CommandEnvelope<never> {
  return refusalEnvelope({
    command: EXECUTION_CLEAR_COMMAND,
    status: 'refused',
    code: 'execution.clear.no-harness',
    exitCode: 1,
    message: 'the carrying session has no resolved harness dir or workspace — the execution binding could not be read for the clear',
    recovery: 'Open the session in the workspace that declares the control harness (.mstar/ or .mstarc), or point the plugin\'s `harnessDir` config at the control root that holds this session\'s binding, then re-run the clear.',
  })
}

/**
 * The named no-binding refusal of the clear. It is TRUE for both reachable
 * cases, which is why it names neither "nothing exists" nor a nonexistent
 * action:
 *
 * - the resolved root genuinely holds no clearable binding for this session;
 * - the session's binding was adopted into ANOTHER control root, which the
 *   workspace probe cannot reach (the durable key is the session id AND the
 *   session workspace, and the root is whatever the bind selected).
 *
 * The recovery names the route that exists for the second case: the plugin's
 * `harnessDir` config resolves the control root directly and therefore reaches
 * a store the workspace probe answers `null` for — while the session keeps the
 * workspace the durable row is keyed to. A session that never adopted a
 * cross-root binding is the no-action case the recovery also states.
 */
function executionClearNoBinding(): CommandEnvelope<never> {
  return refusalEnvelope({
    command: EXECUTION_CLEAR_COMMAND,
    status: 'refused',
    code: 'execution.clear.no-binding',
    exitCode: 1,
    message: 'no clearable execution binding is reachable from the control root resolved here',
    recovery: 'This clear resolves the control root of the carrying session\'s workspace (or the configured root), and a binding recorded in a DIFFERENT control root is not reachable from it by workspace resolution. ' +
      'Point the plugin\'s `harnessDir` config at that control root — the durable key is the session id AND the session workspace, which this session keeps — then re-run the clear. ' +
      'If no cross-root binding was ever adopted, there is nothing to clear and no action is needed.',
  })
}

/**
 * The native `mstar_execution_clear` tool: the reachability for
 * `clearExecutionBinding` after the removal of the slash command whose `clear`
 * arm was its only caller. It wraps `clearExecutionSessionBinding` (the readable
 * record guard, the nothing-to-clear guard, and the observed-generation
 * `selectedGeneration` read) with the identity from `exec.agent.id` — the
 * parameter face is EMPTY, so identity is never model-choosable. The resolved
 * root is the session's configured/workspace harness.
 */
function executionClearTool(
  resolver: { forAgent(agent: unknown): string | null },
) {
  return defineTool({
    name: 'mstar_execution_clear',
    description:
      "Clear the calling session's own durable mstar execution binding — the `executionBinding` slot a successful plan bind recorded in this session's control-root store. " +
      'The session id comes from the calling agent identity (exec.agent.id) — there are no parameters and identity is never model-choosable; ' +
      "the user's workflow selection and exclusion floor are preserved. " +
      'Clearing a session whose binding is not reachable from the resolved control root is a named refusal (no clearable execution binding) naming the `harnessDir` config route, ' +
      'and an unreadable or refused binding record is a refusal carrying the store reason, never a silent no-op.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: envelopeSummary(EXECUTION_CLEAR_COMMAND, value as CommandEnvelope) }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Command ${EXECUTION_CLEAR_COMMAND}`,
      kind: 'other',
      rawInput: JSON.stringify(args)?.slice(0, 160) ?? '',
    }),
    // Mutates the execution authority's binding slot — exclusive.
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      // The fail-closed leaf guard: a leaf seat holds no execution binding and
      // can never hold one — refuse before reading the store. `_args` is never
      // read: the only identity this tool acts on is `exec.agent.id`, so a
      // model-supplied `sessionId` (or any other argument) has no effect.
      if (isLeafSeatHeader(sessionHeaderOf(exec))) {
        return toCanonicalValue(leafSeatRefusal(EXECUTION_CLEAR_COMMAND))
      }
      const cwd = sessionCwdOf(exec.agent)
      if (cwd === undefined) {
        return toCanonicalValue(executionClearNoHarness())
      }
      const sessionId = callerSessionIdOf(exec)
      const harnessDir = resolver.forAgent(exec.agent)
      if (harnessDir === null) {
        return toCanonicalValue(executionClearNoHarness())
      }
      const outcome = await clearExecutionSessionBinding(harnessDir, sessionId, cwd)
      if (outcome.kind === 'cleared') return toCanonicalValue(executionClearOk())
      if (outcome.kind === 'no-binding') return toCanonicalValue(executionClearNoBinding())
      // The store refused the durable record. When the cause is a workspace
      // mismatch the read already knows the RECORDED workspace, so this
      // failure path spends one extra engine read to carry it: "the record must
      // be readable for this session and its exact cwd" was a key the caller
      // could not see. Every other store refusal keeps its unchanged text.
      const recordedCwd = outcome.reason === 'cwd-mismatch' ? recordedCwdOf(harnessDir, sessionId, cwd) : undefined
      const refused = refusalEnvelope({
        command: EXECUTION_CLEAR_COMMAND,
        status: 'refused',
        code: 'execution.clear.store-refused',
        exitCode: 1,
        message: `no clearable execution binding (${outcome.reason})`,
        recovery: recordedCwd === undefined
          ? 'Resolve the store refusal named in the message (the durable binding record must be readable and writable for this session and its exact cwd), then re-run the clear.'
          : `This session's durable records are keyed to the workspace carried in \`data.recordedCwd\` (${recordedCwd}), not the workspace this clear runs from — the durable key is the session id AND the session workspace. Run the clear from that workspace (reopen the session there), or from a session whose workspace is that one, then re-run the clear.`,
      })
      return toCanonicalValue(recordedCwd === undefined
        ? refused
        : Object.assign(refused as CommandEnvelope<never> & { data?: unknown }, { data: { recordedCwd } }))
    },
  })
}

/**
 * Register the one native mstar tool. The registration is deferred with
 * `ctx.inject(['tools'], …)` (the optional-unit pattern, as in every tool
 * module) and the registration's disposer is returned as the inject teardown,
 * so an HMR reload of the plugin fiber unregisters the tool cleanly (a
 * post-dispose lookup finds none).
 * @param ctx - registrant context carrying the tool registry.
 * @param resolver - the per-workspace `{HARNESS_DIR}` resolver (the control
 * root resolves per the calling session's workspace — never the process cwd).
 */
export function registerNativeCommandTools(ctx: Context, resolver: { forAgent(agent: unknown): string | null }): void {
  ctx.inject(['tools'], (toolsCtx) => toolsCtx.tools.register(executionClearTool(resolver)))
}
