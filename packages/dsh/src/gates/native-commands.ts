/**
 * Native writable command tools (#526) — the mstar command surface as dsh tools.
 *
 * The named writable set (plan bind/prepare/progress/complete + workflow
 * register + issue add/close) is registered over `ctx.tools.register` with the
 * same `defineTool` style as the read-only tools in `tools.ts`. Each tool
 * calls the shared `@mstar-harness/commands` implementation through its
 * programmatic entry (`executeCommand` — the same admission + execution path
 * the CLI uses) and injects `sessionId` from `exec.agent.id` (ADR
 * `dsh-native-identity-channels` constraints 1–2: `Agent.id` IS the session
 * id, and per-caller identity is available at the tool seam). A session id in
 * the tool arguments is STRIPPED before admission — identity is never
 * model-choosable on this surface.
 *
 * Beyond that mapping the surface carries exactly ONE dsh-native tool:
 * `mstar_execution_clear` (Task 5) — the replacement reachability for the
 * durable execution binding's clear after the slash command that hosted it was
 * removed. It wraps the dsh-side clear internals directly (there is no shared
 * `execution.clear` command to map through) and takes no parameters at all —
 * identity comes from `exec.agent.id` the same way.
 *
 * No shell anywhere in the path: `executeCommand` runs in-process, and the
 * injected `effects` carry no process/browser/dashboard implementation, so an
 * effect-taking command can only refuse.
 *
 * Engine refusal envelopes surface verbatim: the tool validates nothing
 * beyond the platform's own parameter schema (mechanically mirrored from the
 * command's published JSON Schema, with the session selector removed) and
 * returns the `CommandEnvelope` it received as the canonical value — no
 * second validation layer, no paraphrase.
 *
 * Module boundary: self-contained for the native adoption (Task 3 bind) and
 * the Task 5 clear — the only imports are the cordis context type, the
 * dsh-tools seam, `@mstar-harness/commands`, the engine's execution-session
 * primitives, the execution-session clear internals, the shared leaf-seat
 * predicate (`leaf-seat.ts`), the adoption-root receipt
 * (`execution-binding-roots.ts`), and the shared cwd reader /
 * workflow-selection resolvers.
 *
 * Leaf guard: the coordinator-seat-capable tools (`mstar_plan_bind`,
 * `mstar_plan_complete`, `mstar_execution_clear`) refuse a known leaf seat
 * FAIL-CLOSED before any admission or engine round-trip — the named guard the
 * removed execution-session command enforced, restored on this surface (the
 * engine has no leaf concept, so this dsh-side check is the sole enforcement).
 */
import { type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  decodeExecutionSessionRef,
  encodeExecutionSessionRef,
  executionContextFor,
  readDshSessionBinding,
  resolveProcessHarnessDir,
  resumeExecutionSession,
} from '@mstar-harness/engine'
import type { ExecutionSessionRef } from '@mstar-harness/engine'
import { executeCommand, getCommandDefinitions, getCommandSchemas, refusalEnvelope } from '@mstar-harness/commands'
import type {
  CommandDefinition,
  CommandEffects,
  CommandEnvelope,
  CommandRequirement,
  CommandSchemaDescriptor,
  InvocationContext,
} from '@mstar-harness/commands'
import { sessionCwdOf } from './_shared.ts'
import { isLeafSeatHeader } from './leaf-seat.ts'
import { adoptExecutionBinding, refusalOf } from './workflow-selection.ts'
import { clearExecutionSessionBinding } from './execution-session.ts'
import { clearExecutionBindingRoot, executionBindingRootOf, recordExecutionBindingRoot } from './execution-binding-roots.ts'

/** The named writable set (issue AC) — the shared command ids that map 1:1 onto tools, in registration order. The surface gains exactly one tool beyond this list: the dsh-native `mstar_execution_clear` (Task 5). */
const NATIVE_COMMAND_IDS = [
  'plan.bind',
  'plan.prepare',
  'plan.progress',
  'plan.complete',
  'workflow.register',
  'issue.add',
  'issue.close',
] as const

/** The tool name for one command id — the same mapping the MCP route uses. */
export function nativeCommandToolName(commandId: string): string {
  return `mstar_${commandId.replace(/[.-]/g, '_')}`
}

/**
 * The caller identity of one tool execution: `exec.agent.id` (ADR constraint
 * 1 — a dsh agent's identity and its session identity are the same value).
 */
function callerSessionIdOf(exec: ToolExecution): string {
  const id = (exec.agent as { id?: unknown } | null | undefined)?.id
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('the native mstar command tools require a calling agent identity (exec.agent.id); none is present on this execution')
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
 * this surface before any admission or engine round-trip. The recovery names
 * the actual cause and the supported way out (run it as the coordinating
 * session; a leaf seat never needs a binding).
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

/**
 * The commands whose success mints or exercises a coordinator seat: `plan
 * bind` binds one, `plan complete` is the Done write behind it. These refuse a
 * leaf seat fail-closed; the remaining commands run under the caller's own
 * identity and cannot mint a seat.
 */
const COORDINATOR_SEAT_COMMANDS: ReadonlySet<string> = new Set(['plan.bind', 'plan.complete'])

/**
 * Effects for the native surface: none. The shared implementation owns every
 * process/dashboard/browser effect; this surface provides refusing stubs so
 * an effect-taking command refuses by construction instead of reaching a
 * shell (the no-shell guarantee is the absence of the capability, not a rule
 * about it).
 */
const NATIVE_EFFECTS: CommandEffects = {
  readInput: () => {
    throw new Error('the stdin effect is not available on the dsh native command surface (no shell, no child process)')
  },
  spawn: () => {
    throw new Error('the process effect is not available on the dsh native command surface (no shell, no child process)')
  },
  startDashboard: () => {
    throw new Error('the dashboard effect is not available on the dsh native command surface')
  },
  openBrowser: () => {
    throw new Error('the browser effect is not available on the dsh native command surface')
  },
}

/**
 * The invocation context for one admitted command call: the session's
 * workspace cwd, the resolver's harness dir as the control root, and the
 * caller identity from `exec.agent.id` — never from the arguments.
 */
function invocationContextOf(exec: ToolExecution, resolver: { forAgent(agent: unknown): string | null }): InvocationContext {
  const cwd = sessionCwdOf(exec.agent)
  if (cwd === undefined) {
    throw new Error('the native mstar command tools require a session workspace (session.header.cwd); none is present on this execution')
  }
  return {
    cwd,
    controlRoot: resolver.forAgent(exec.agent),
    host: 'dsh',
    sessionId: callerSessionIdOf(exec),
    versions: { engine: null, cli: null, plugin: null, host: 'dsh', platform: 'dsh' },
    signal: exec.signal,
    effects: NATIVE_EFFECTS,
  }
}

/**
 * The description length cap for one mechanically derived payload summary
 * (the model face stays bounded even for wide payloads like `issue.add`).
 */
const PAYLOAD_SUMMARY_CAP = 1000

/**
 * The scalar/structural type label of one published JSON Schema node,
 * mechanically read from the node itself (never hand-written per command).
 * A `$ref` is not resolved — the label stays at the node's own shape.
 */
function payloadTypeOf(node: unknown, depth: number): string {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return 'json'
  const record = node as Record<string, unknown>
  if (Array.isArray(record.oneOf)) {
    return `(${record.oneOf.map((branch) => payloadTypeOf(branch, depth)).join(' | ')})`
  }
  const type = typeof record.type === 'string' ? record.type : undefined
  if (type === 'object' && depth < 2) return compactPayloadSummary(record, depth + 1) ?? 'object'
  if (type === 'array') return `${payloadTypeOf(record.items, depth + 1)}[]`
  return type ?? 'json'
}

/**
 * The compact member summary of one published JSON Schema node: required
 * members unmarked, optional members suffixed `?`, nested objects expanded
 * one level (depth-capped), unions listed branch-by-branch. The source is
 * ALWAYS the published schema — the payload descriptor's own JSON Schema when
 * the input node is a permissive placeholder (the issue payloads), else the
 * input node itself (the shaped fields like `plan complete`'s evidence).
 */
function compactPayloadSummary(node: unknown, depth = 0): string | undefined {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined
  const record = node as Record<string, unknown>
  if (Array.isArray(record.oneOf)) {
    const branches = record.oneOf
      .map((branch) => compactPayloadSummary(branch, depth + 1) ?? payloadTypeOf(branch, depth + 1))
      .filter((branch): branch is string => branch !== undefined)
    if (branches.length === 0) return undefined
    return capPayloadSummary(`one of: ${branches.join(' | ')}`)
  }
  const properties = record.properties
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return undefined
  const required = Array.isArray(record.required)
    ? record.required.filter((entry): entry is string => typeof entry === 'string')
    : []
  const members = Object.entries(properties as Record<string, unknown>).map(([name, child]) =>
    `${name}: ${payloadTypeOf(child, depth)}${required.includes(name) ? '' : '?'}`,
  )
  if (members.length === 0) return undefined
  return capPayloadSummary(`object { ${members.join(', ')} }`)
}

/** Truncate an overlong summary on the member boundary the cap leaves. */
function capPayloadSummary(summary: string): string {
  if (summary.length <= PAYLOAD_SUMMARY_CAP) return summary
  return `${summary.slice(0, PAYLOAD_SUMMARY_CAP)}…`
}

/**
 * The object branches of a published root schema's `anyOf` union, or
 * `undefined` when the schema is not a union of objects. Read mechanically
 * from the published JSON Schema — the same source every transport serves.
 */
function unionObjectBranches(jsonSchema: Record<string, unknown> | null | undefined): Array<Record<string, unknown>> | undefined {
  if (jsonSchema === null || typeof jsonSchema !== "object") return undefined;
  const branches = jsonSchema.anyOf;
  if (!Array.isArray(branches) || branches.length === 0) return undefined;
  const objects = branches.filter((branch): branch is Record<string, unknown> =>
    branch !== null && typeof branch === "object" && !Array.isArray(branch) &&
    branch.properties !== null && typeof branch.properties === "object",
  );
  return objects.length === branches.length ? objects : undefined;
}

/**
 * The fields every object branch of a root union declares, typed from the
 * first branch's own nodes (the mechanical projection of a union schema
 * into one callable parameter table — `issue.close`'s terminal dispositions
 * share one field set and differ only in which fields each branch
 * requires).
 */
function unionPropertiesOf(branches: Array<Record<string, unknown>>): Record<string, Record<string, unknown>> {
  if (branches.length === 0) return {};
  const first = branches[0]!.properties as Record<string, Record<string, unknown>>;
  let common = Object.keys(first);
  for (const branch of branches.slice(1)) {
    const keys = Object.keys(branch.properties as Record<string, unknown>);
    common = common.filter((key) => keys.includes(key));
  }
  return Object.fromEntries(common.map((key) => [key, first[key]!]));
}

/** The branch labels of a union: the const-valued property naming the branch (`disposition=resolved`), else `default`. */
function unionBranchLabel(branch: Record<string, unknown>): string {
  for (const property of Object.values(branch.properties as Record<string, unknown>)) {
    if (property !== null && typeof property === "object" && !Array.isArray(property)) {
      const value = (property as Record<string, unknown>).const;
      if (typeof value === "string") return value;
    }
  }
  return "default";
}

/** The branch-required names of one union object branch. */
function unionBranchRequired(branch: Record<string, unknown>): string[] {
  return Array.isArray(branch.required)
    ? branch.required.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * The branch-varying requirement text for one projected union field: the
 * branches that require it (labeled by their const value) versus the
 * branches that leave it optional. A field every branch requires — or none —
 * is already covered by the top-level required table and gains no text, so
 * the description stays help-first and the union text only fills the
 * per-branch gap a flat table cannot express.
 */
function unionFieldRequirement(branches: Array<Record<string, unknown>>, field: string): string | undefined {
  const requiring = branches.filter((branch) => unionBranchRequired(branch).includes(field));
  if (requiring.length === 0 || requiring.length === branches.length) return undefined;
  const rest = branches.filter((branch) => !requiring.includes(branch));
  const labels = (list: Array<Record<string, unknown>>): string => [...new Set(list.map(unionBranchLabel))].join("|");
  return `required on ${labels(requiring)}; optional on ${labels(rest)}`;
}

/**
 * The dsh parameter spec for one command, mirrored MECHANICALLY from the
 * command's own published JSON Schema (the single source both transports
 * already serve) with the `sessionId` context selector removed. Scalars keep
 * their type so the model face is typed; every object/union payload stays the
 * annotation-only `json` node — the semantic validation is the shared
 * admission's, never duplicated here. A `json` node whose published schema is
 * an object with members (or a oneOf) gains a mechanically derived
 * `description` naming those members and their types, so a caller can
 * construct a valid payload without guessing at the flattened shape. A root
 * schema that is a UNION of objects (`issue.close`'s terminal dispositions —
 * no top-level `properties`) projects the fields every branch declares into
 * the same table, with each branch's own required set carried as description
 * text instead of a second validation layer.
 */
function parameterSpecOf(descriptor: CommandSchemaDescriptor): Record<string, import('@deepseek-ai/dsh-tools').ParameterPropertySpec> {
  const jsonSchema = descriptor.input as Record<string, unknown> | null | undefined;
  const branches = unionObjectBranches(jsonSchema);
  const rootProperties = jsonSchema !== null && typeof jsonSchema === "object" &&
      jsonSchema.properties !== null && typeof jsonSchema.properties === "object"
    ? jsonSchema.properties as Record<string, Record<string, unknown>>
    : unionPropertiesOf(branches ?? []);
  // The Map generics are anchored on the imported `CommandRequirement` (the
  // real export), not inferred through the constructor: an unparameterized
  // `new Map(...)` falls back to `{}` when the entry-tuple inference fails,
  // which untypes `.help` below.
  const helpByName = new Map<string, CommandRequirement>(
    descriptor.requirements
      .filter((entry) => entry.ownership === 'caller')
      .map((entry): [string, CommandRequirement] => [entry.name, entry]),
  )
  const spec: Record<string, import('@deepseek-ai/dsh-tools').ParameterPropertySpec> = {}
  for (const [field, node] of Object.entries(rootProperties)) {
    // The session selector is transport-resolved (exec.agent.id here), never
    // a published tool parameter (ADR constraints 1–3).
    if (field === 'sessionId') continue
    const nodeType = typeof node.type === "string" ? node.type : undefined;
    const scalar = nodeType === 'string' ? { type: 'string' as const }
      : nodeType === 'integer' ? { type: 'integer' as const }
      : nodeType === 'number' ? { type: 'number' as const }
      : nodeType === 'boolean' ? { type: 'boolean' as const }
      : { type: 'json' as const }
    const help = helpByName.get(field)?.help
    const summary = scalar.type === 'json'
      ? compactPayloadSummary(Object.hasOwn(descriptor.payloadSchemas, field) ? descriptor.payloadSchemas[field] : node)
      : undefined
    const branchText = branches === undefined ? undefined : unionFieldRequirement(branches, field)
    const description = [help, branchText, summary === undefined ? undefined : `Payload: ${summary}.`]
      .filter((part): part is string => part !== undefined)
      .join(' — ')
    spec[field] = {
      ...scalar,
      ...(description === '' ? {} : { description }),
      ...(descriptor.required.includes(field) ? { required: true as const } : {}),
    }
  }
  return spec
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
 * requires lossless JSON, and a shared envelope may carry `undefined` members
 * (e.g. a refusal `details.actual` that is absent). The JSON round-trip is the
 * SAME projection every other transport applies when it serializes the
 * envelope (the CLI writes it, MCP returns it as structured content) — the
 * content is untouched, only the lossy-for-JSON members go.
 */
function toCanonicalValue(envelope: CommandEnvelope): JsonValue {
  return JSON.parse(JSON.stringify(envelope)) as JsonValue
}

/**
 * The engine session reference inside a successful `plan bind` envelope: both
 * bind arms (execution and resume) answer the engine's
 * `ExecutionRead<ExecutionSessionRef>` receipt as the envelope `data`, whose
 * `data` member is the canonical ref. `undefined` — not a recognizable bind
 * receipt (a shared-command shape drift) — is never guessed into a ref.
 */
function bindReceiptRefOf(envelope: CommandEnvelope): ExecutionSessionRef | undefined {
  if (envelope.status !== 'ok') return undefined
  const receipt = (envelope as { data?: unknown }).data
  const candidate = (
    typeof receipt === 'object' && receipt !== null ? (receipt as Record<string, unknown>).data : undefined
  ) as ExecutionSessionRef | undefined
  if (typeof candidate !== 'object' || candidate === null) return undefined
  // The engine's own canonical-value validation (the same acceptance the wire
  // transport applies) — a drifted receipt is never adopted.
  try {
    encodeExecutionSessionRef(candidate)
  } catch {
    return undefined
  }
  return candidate
}

/**
 * The workflow a `plan.bind` call addressed, for a refusal whose bind receipt
 * could not be read: the explicit `workflow` selector, else the workflow named
 * by the caller-supplied `resumeRef` (both bind arms require one of the two,
 * and the shared admission decodes the reference before committing).
 */
function bindWorkflowIdOf(input: Record<string, unknown>): string | undefined {
  if (typeof input.workflow === 'string' && input.workflow.trim() !== '') return input.workflow
  if (typeof input.resumeRef !== 'string') return undefined
  try {
    return decodeExecutionSessionRef(input.resumeRef).workflowId
  } catch {
    return undefined
  }
}

/**
 * The workspace the session's durable records are keyed to, when the store
 * answered `cwd-mismatch` — one extra engine read on the adoption's FAILURE
 * path only (the successful path never pays it). The recorded fact is what
 * makes "run the resume re-bind from the workspace the durable selection is
 * recorded under" a fact the caller can act on instead of a condition it
 * cannot see.
 */
function recordedCwdOf(harnessDir: string, sessionId: string, cwd: string): string | undefined {
  const read = readDshSessionBinding({ harnessDir }, sessionId, cwd)
  return read.kind === 'unavailable' && read.reason === 'cwd-mismatch' ? read.recordedCwd : undefined
}

/**
 * The stage of the POST-COMMIT adoption that refused. Both run only after the
 * shared `plan.bind` returned `ok`, so the engine seat is bound either way —
 * but the two failures have DIFFERENT recoveries and must never be conflated:
 * a refused resume rejects the very reference the resume re-bind would carry,
 * while a refused slot write leaves a resumable seat behind.
 */
export type AdoptionFailureStage = 'resume' | 'durable-slot'

/**
 * The facts a POST-COMMIT adoption refusal carries under `data`, so the
 * recovery it names is performable without the durable slot it could not
 * write. Every member is optional because each refusal knows a different
 * subset: the minted reference is absent when the bind envelope itself was
 * unreadable, and the control root is absent when the adoption could not
 * resolve one (a defensive branch no committed bind reaches).
 */
type AdoptionRefusalFacts = Readonly<{
  /** The engine-minted session reference, in the wire shape the bind accepts back as `resumeRef`. */
  ref?: ExecutionSessionRef
  workflowId?: string
  /** The control root the engine bind committed in — `plan.bind`'s own root, never the plugin's probe. */
  harness?: string
  /** The workspace the session's durable records are keyed to, when the store answered `cwd-mismatch`. */
  recordedCwd?: string
}>

/**
 * The dsh-side adoption refusal: the engine coordinator seat the bind
 * committed stays bound, the durable slot is NOT written, and the text names
 * the actual cause plus the recovery for the stage that failed (see
 * {@link adoptionRecoveryText}). A refusal built AFTER the commit additionally
 * states that the seat is bound (`committed`) and carries
 * {@link AdoptionRefusalFacts} under `data`, so the recovery it names is
 * performable without the slot it could not write. The extra members sit
 * beside the shared refusal shape — the shared `CommandEnvelope` contract and
 * every other command's refusals are untouched.
 */
function adoptionRefusal(
  code: string,
  message: string,
  recovery: string,
  facts?: AdoptionRefusalFacts,
): CommandEnvelope<never> {
  const refusal = refusalEnvelope({ command: 'plan.bind', status: 'refused', code, exitCode: 1, message, recovery })
  if (facts === undefined) return refusal
  const data = {
    ...(facts.ref === undefined ? {} : { resumeRef: encodeExecutionSessionRef(facts.ref) }),
    ...(facts.workflowId === undefined ? {} : { workflowId: facts.workflowId }),
    ...(facts.harness === undefined ? {} : { harness: facts.harness }),
    ...(facts.recordedCwd === undefined ? {} : { recordedCwd: facts.recordedCwd }),
  }
  return Object.assign(
    refusal as CommandEnvelope<never> & { committed?: true; data?: unknown },
    { committed: true as const, ...(Object.keys(data).length === 0 ? {} : { data }) },
  )
}

/**
 * The recovery of a POST-COMMIT adoption refusal, selected by the stage that
 * failed. Pure and exported for the stage regression: the two arms must not
 * advertise the same route.
 *
 * - `resume`: the engine refused its own minted reference (or the resumed
 *   reference did not match the caller). Re-running the same resume re-bind
 *   presents exactly that refused value, so it loops — the engine's own
 *   coordinator recovery (`mstar session recover`, which replaces a recorded
 *   stopped/stale holder after operator attestation) is the way out.
 * - `durable-slot`: the engine resume succeeded and only the dsh slot write
 *   failed, so the resume re-bind re-adopts. When the store reported
 *   `cwd-mismatch`, the recovery names the RECORDED workspace (the durable key
 *   is the session id AND the workspace), as carried in `data.recordedCwd`.
 */
export function adoptionRecoveryText(
  stage: AdoptionFailureStage,
  causeCode: string,
  recordedCwd?: string,
): string {
  if (stage === 'resume') {
    return 'The engine coordinator seat from the bind stays BOUND, but the durable execution binding slot was NOT written: ' +
      `the engine refused to resume this session reference (${causeCode}), so the resume re-bind that re-adopts is not available. ` +
      'Recover the seat through the engine\'s own coordinator recovery: run `mstar session recover --workflow <workflow-id> ' +
      '--prior-session <session-id> --reason <text> --attestation <path> --expect <token> --operation <id>` ' +
      '(both ids are carried in this refusal\'s `data.resumeRef`; use `--unowned=true` instead of `--prior-session` when the ' +
      'workflow records no coordinator row), then re-run the bind.'
  }
  const workspace = recordedCwd === undefined
    ? 'run from the session workspace the durable selection is recorded under'
    : `run from the RECORDED workspace carried in \`data.recordedCwd\` (${recordedCwd}) — the workspace this session's durable records are keyed to`
  return 'The engine coordinator seat from the bind stays BOUND and a plain re-execution bind is refused (a live ACTIVE holder is never replaced). ' +
    'Recovery: re-run the native bind as a resume carrying this refusal\'s `data.resumeRef` as `resumeRef`, with the SAME `harness` selection ' +
    `(\`data.harness\` names the control root the engine bound in) — ${workspace}. The resume re-adopts the binding slot.`
}

/**
 * Task 3 (#527): persist the durable `executionBinding` slot after a native
 * `plan bind` succeeds — the adoption the removed slash command performed,
 * kept on the native path. The binding order's durable-selection
 * rung and the workflow ledger's explicit route
 * (`resolveExecutionLedgerTarget`) read exactly this slot, so ledger
 * attribution works with no slash command.
 *
 * The validation set is the slash command's, unchanged:
 * the reference must name the carrying session, the ENGINE resume must
 * succeed BEFORE the slot write (a foreign, copied, stale-epoch or
 * scope-mismatched reference is refused and never adopted), and the write
 * goes through `adoptExecutionBinding` — the session's user selection is
 * preserved and the exclusion floor merges by max. The adoption target is the
 * root the SHARED ADMISSION bound in — `resolveProcessHarnessDir(cwd,
 * callHarness)`, the one resolution both `plan.bind` arms perform before
 * committing (the explicit per-call `harness` when non-blank, the
 * git-top-level/workspace probe otherwise) — never the plugin's own
 * workspace-only probe: the two answers can differ (a session whose cwd is a
 * subdirectory of the repository declaring the harness, or a linked worktree),
 * and the adoption must resume and persist its slot in the store the engine
 * actually wrote. An adoption failure returns a refused envelope carrying the
 * engine's own code/message verbatim plus the recovery for the stage that
 * failed; the command itself already committed engine-side.
 */
async function adoptNativeExecutionBinding(
  envelope: CommandEnvelope,
  input: Record<string, unknown>,
  exec: ToolExecution,
): Promise<CommandEnvelope> {
  // A refused (or usage) bind IS the engine's verdict — a stale epoch, a
  // foreign store, a scope mismatch, a missing coordinator seat — and the
  // "engine refusals surface verbatim" contract covers it: return the
  // incoming envelope unchanged BEFORE the bind-arm narrowing, so a refused
  // bind is never rewritten as a dsh-side adoption refusal.
  if (envelope.status !== 'ok') return envelope
  // Both bind arms adopt: the execution bind (the engine minted the ref) and
  // the resume bind (the caller supplied a reference). Any other command
  // input never reaches the envelope's bind arms, so this narrow check is
  // exact.
  if (input.execution !== true && input.resumeRef === undefined) return envelope
  // `exec.agent.id` is guaranteed by `invocationContextOf` (it throws before
  // any admission without one); every refusal below names the holder it is
  // actually leaving bound.
  const sessionId = callerSessionIdOf(exec)
  const ref = bindReceiptRefOf(envelope)
  if (ref === undefined) {
    // POST-COMMIT: the engine bind committed, but its envelope carried no
    // readable reference, so the durable slot cannot be written and the
    // resume re-bind has nothing to carry. A plain re-execution bind is
    // refused while the live holder exists — the engine's own coordinator
    // recovery is the way out (it replaces the recorded holder after operator
    // attestation). The workflow is still derivable from the bind input.
    const workflowId = bindWorkflowIdOf(input)
    const workflow = workflowId ?? '<workflow-id>'
    return adoptionRefusal(
      'binding.receipt-unrecognizable',
      'the plan bind envelope carried no recognizable execution session reference — the execution binding was NOT adopted',
      'The engine coordinator seat from the bind stays BOUND (a live ACTIVE holder is never replaced by a bind), but the durable execution binding slot was NOT written: ' +
        'this build could not read the minted reference back out of the bind receipt. ' +
        `Recover the seat through the engine's own coordinator recovery: run \`mstar session recover --workflow ${workflow} ` +
        `--prior-session ${sessionId} --reason <text> --attestation <path> --expect <token> --operation <id>\` ` +
        '(use `--unowned=true` instead of `--prior-session` when the workflow records no coordinator row), then re-run the bind.',
      { ...(workflowId === undefined ? {} : { workflowId }) },
    )
  }
  // The adoption target is the root the shared admission bound in. Both
  // `plan.bind` arms resolve it as `resolveProcessHarnessDir(cwd,
  // input.harness)` and refuse `null` BEFORE committing, so a committed bind
  // has a non-null root and this call answers the same one: an explicit
  // non-blank `harness` is resolved against the same cwd base (the shared
  // `callHarness` narrowing), and the implicit arm uses the engine's
  // git-top-level/main-worktree probe (which also honours `MSTAR_HARNESS_DIR`)
  // — NOT the plugin's workspace-only probe, whose null answer for a
  // subdirectory session used to turn a committed bind into a bare
  // `binding.no-harness` refusal. A relative selector keeps resolving to the
  // same absolute root the engine recorded.
  const cwd = sessionCwdOf(exec.agent)
  const callHarness = typeof input.harness === 'string' && input.harness.trim() !== '' ? input.harness : undefined
  let harnessDir: string | null = null
  try {
    harnessDir = cwd === undefined ? null : resolveProcessHarnessDir(cwd, callHarness)
  } catch {
    // The same resolution that could throw here (the linked-checkout Git
    // verdict) would have thrown in the shared admission instead of committing,
    // so reaching this is the defensive case below — answer the refusal that
    // carries the minted reference rather than escaping as a tool error.
    harnessDir = null
  }
  if (harnessDir === null || cwd === undefined) {
    // DEFENSIVE, not part of the normal contract: the shared admission refuses
    // a null root before committing, so a committed bind reaches this branch
    // only when the root facts changed between the bind and this adoption (the
    // variable removed, a `.mstar`/`.mstarc` declaration created or removed,
    // or the git worktree changed). It therefore must not tell the caller to
    // "re-run the bind" — that bind is refused — so it carries the minted
    // reference and names the engine's coordinator recovery instead.
    return adoptionRefusal(
      'binding.no-harness',
      'the carrying session has no resolved control root or workspace — the execution binding was NOT adopted',
      'The engine coordinator seat from the bind stays BOUND, but the durable execution binding slot was NOT written: this adoption could not resolve the control root the shared bind committed in. ' +
        `Recover the seat through the engine's own coordinator recovery: run \`mstar session recover --workflow ${ref.workflowId} ` +
        `--prior-session ${ref.sessionId} --reason <text> --attestation <path> --expect <token> --operation <id>\` ` +
        '(use `--unowned=true` instead of `--prior-session` when the workflow records no coordinator row), then re-run the bind.',
      { ref, workflowId: ref.workflowId },
    )
  }
  // The reference names the carrying session — the same first check the slash
  // adoption made, before any engine round-trip.
  if (ref.sessionId !== sessionId) {
    return adoptionRefusal(
      'binding.foreign-reference',
      `the bound session reference names ${ref.sessionId}, not the carrying session ${sessionId} — the execution binding was NOT adopted`,
      'Run the bind as the carrying session itself; a reference to another session is never adoptable.',
    )
  }
  // Which post-commit step failed decides the recovery: the engine resume
  // rejecting the reference cannot be recovered by presenting that same
  // reference again.
  let stage: AdoptionFailureStage = 'resume'
  try {
    // The engine resume succeeds BEFORE the slot write: a copied store id, a
    // stale epoch or a scope mismatch refuses here and NOTHING is adopted.
    const resumed = await resumeExecutionSession(
      executionContextFor({ harnessDir }, { source: 'host', sessionId, workflowId: ref.workflowId, role: 'coordinator' }),
      ref,
    )
    if (resumed.data.sessionId !== sessionId || resumed.data.workflowId !== ref.workflowId) {
      throw new Error('the resumed execution session did not match the carrying session')
    }
    stage = 'durable-slot'
    const adopted = adoptExecutionBinding(
      harnessDir,
      sessionId,
      cwd,
      { version: 1, harnessRoot: harnessDir, session: ref },
      { storeId: resumed.storeId, epoch: resumed.epoch },
    )
    if (!adopted) throw new Error('the execution binding store refused the adoption write')
    // The adoption receipt: the consumers (ledger attribution, the native
    // clear) resolve THIS root for the session instead of re-deriving the
    // workspace harness — the durable slot lives here, and nothing is ever
    // copied into the workspace root. Only a successful adoption records.
    recordExecutionBindingRoot(sessionId, cwd, harnessDir)
  } catch (error) {
    // The engine's own refusal code/message surface verbatim. The seat the
    // bind committed stays bound and the durable slot is exactly what this
    // path failed to write, so the refusal must carry the minted reference —
    // otherwise its own recovery is unperformable. The recovery itself depends
    // on the stage (see `adoptionRecoveryText`).
    const { code, message } = refusalOf(error)
    // One extra engine read, on this failure path only, to learn the workspace
    // the durable records are keyed to when the store refused the pair: the
    // refusal's recovery can then name it instead of describing a condition
    // the caller cannot see.
    const recordedCwd = stage === 'durable-slot' ? recordedCwdOf(harnessDir, sessionId, cwd) : undefined
    return adoptionRefusal(code, message, adoptionRecoveryText(stage, code, recordedCwd), {
      ref,
      workflowId: ref.workflowId,
      harness: harnessDir,
      ...(recordedCwd === undefined ? {} : { recordedCwd }),
    })
  }
  return envelope
}

/** Build the native tool for one shared command definition. */
function nativeCommandTool(
  definition: CommandDefinition,
  resolver: { forAgent(agent: unknown): string | null },
) {
  const descriptor = getCommandSchemas([definition])[0]!
  const commandId = definition.id
  const required = descriptor.required.length === 0 ? '' : ` Required inputs: ${descriptor.required.join(', ')}.`
  return defineTool({
    name: nativeCommandToolName(commandId),
    description:
      `${definition.description} Command id: ${commandId}.${required} ` +
      'The sessionId is injected from the calling agent identity (exec.agent.id) and a session id argument is ignored; ' +
      'engine refusals surface verbatim in the returned envelope (status refused/usage + message + recovery).',
    parameters: parameterSpecOf(descriptor),
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: envelopeSummary(commandId, value as CommandEnvelope) }],
    },
    presentCall: args => ({
      card: 'generic',
      title: `Command ${commandId}`,
      kind: 'other',
      rawInput: JSON.stringify(args)?.slice(0, 160) ?? '',
    }),
    // Every command here mutates the execution authority — exclusive (never
    // parallel with siblings), matching the read-only tools' registry default.
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      // Fail-closed leaf guard FIRST: a known leaf seat can never own a
      // coordinator seat, and these are the commands that would mint one —
      // refuse before any admission or engine round-trip.
      if (COORDINATOR_SEAT_COMMANDS.has(commandId) && isLeafSeatHeader(sessionHeaderOf(exec))) {
        return toCanonicalValue(leafSeatRefusal(commandId))
      }
      const input = args as Record<string, unknown>
      // Identity is never model-supplied: strip the session selector before
      // admission so the shared admission resolves it from the injected
      // context (exec.agent.id) instead of an argument value.
      const { sessionId: _ignored, ...commandInput } = input
      const envelope = await executeCommand(commandId, commandInput, invocationContextOf(exec, resolver))
      if (commandId === 'plan.bind') {
        // Task 3 (#527): on a successful bind, persist the durable
        // executionBinding slot (the adoption the slash command performed);
        // every other command returns its envelope untouched.
        return toCanonicalValue(await adoptNativeExecutionBinding(envelope, commandInput, exec))
      }
      return toCanonicalValue(envelope)
    },
  })
}

/**
 * The logical command id the native clear reports in its envelope. There is
 * no shared `execution.clear` command to map through `nativeCommandTool` —
 * the clear is a dsh-native tool wrapping the dsh-side binding internals, so
 * its envelope is assembled here with the same shape the shared commands
 * answer.
 */
const EXECUTION_CLEAR_COMMAND = 'execution.clear'

/** The ok envelope of a completed clear (the shared commands' ok shape). */
function executionClearOk(): CommandEnvelope {
  return { version: 1, command: EXECUTION_CLEAR_COMMAND, status: 'ok', code: 'execution.clear.ok', exitCode: 0, data: null }
}

/**
 * The named no-harness refusal of the clear: the remaining case is a session
 * with no workspace at all, or one with NEITHER an adoption receipt NOR a
 * workspace-declared harness. The recovery names both supported routes — open
 * the session in a workspace that declares the harness, and (for a receipt
 * lost with the host process) the resume re-bind that re-records the selected
 * root — because no durable binding can be reached through either root here.
 */
function executionClearNoHarness(): CommandEnvelope<never> {
  return refusalEnvelope({
    command: EXECUTION_CLEAR_COMMAND,
    status: 'refused',
    code: 'execution.clear.no-harness',
    exitCode: 1,
    message: 'the carrying session has no resolved harness dir or workspace — the execution binding could not be read for the clear',
    recovery: 'Open the session in the workspace that declares the control harness (.mstar/ or .mstarc) and re-run the clear. ' +
      'If this session adopted a binding in another control root before a host restart (no receipt survives it), re-run the bind as a resume carrying the original session reference and the same `harness`, then re-run the clear.',
  })
}

/**
 * The named no-binding refusal of the clear. It is TRUE for both reachable
 * cases, which is why it names neither "nothing exists" nor a nonexistent
 * action:
 *
 * - the resolved root genuinely holds no clearable binding for this session;
 * - the session adopted a binding into ANOTHER control root whose in-process
 *   adoption receipt the host lost (a restart or a plugin reload drops the
 *   receipt, not the durable slot). Reaching that slot requires re-recording
 *   the selected root, and the only supported route that does so is a RESUME
 *   re-bind carrying the binding's original session reference and the same
 *   `harness` — which this recovery names, because no other clear route
 *   reaches a cross-root slot.
 *
 * A session that never adopted a cross-root binding is the no-action case the
 * recovery also states. (A durable selected-root pointer would remove this
 * cross-root gap; it needs a host-durable per-session store the workspace root
 * must not carry, so it is not part of this refusal's fix.)
 */
function executionClearNoBinding(): CommandEnvelope<never> {
  return refusalEnvelope({
    command: EXECUTION_CLEAR_COMMAND,
    status: 'refused',
    code: 'execution.clear.no-binding',
    exitCode: 1,
    message: 'no clearable execution binding is reachable from the control root resolved here',
    recovery: 'This clear resolves the control root of the carrying session\'s workspace (or the configured root), and a binding adopted into a DIFFERENT control root is not reachable from it — the in-process adoption receipt that recorded that root does not survive a host restart or a plugin reload. ' +
      'If this session adopted a binding in another control root, re-run the native bind as a resume carrying that binding\'s ORIGINAL session reference as `resumeRef` and the SAME `harness` selection (this re-records the selected root for the session), then re-run this clear. ' +
      'If no cross-root binding was ever adopted, there is nothing to clear and no action is needed.',
  })
}

/**
 * Task 5 (#530): the native `mstar_execution_clear` tool — the replacement
 * reachability for `clearExecutionBinding` after the removal of the slash
 * command whose `clear` arm was its only caller. It wraps
 * `clearExecutionSessionBinding` (the slash clear's validation set: readable
 * record guard, nothing-to-clear guard, and the observed-generation
 * `selectedGeneration` read) with the identity from `exec.agent.id` — the
 * parameter face is EMPTY, so identity is never model-choosable. The resolved
 * root is the session's SELECTED harness (the bind adoption's receipt) when
 * one exists, the workspace harness otherwise. The named outcomes surface as
 * envelopes: `cleared` → ok, `no-binding` → the named refusal (which names the
 * cross-root case a lost receipt leaves behind), an unreadable/refused store →
 * refusal carrying the store's own reason.
 */
function executionClearTool(
  resolver: { forAgent(agent: unknown): string | null },
) {
  return defineTool({
    name: 'mstar_execution_clear',
    description:
      "Clear the calling session's own durable mstar execution binding (the one the native mstar_plan_bind tool adopted). " +
      'The session id comes from the calling agent identity (exec.agent.id) — there are no parameters and identity is never model-choosable; ' +
      "the user's workflow selection and exclusion floor are preserved. " +
      'Clearing a session whose binding is not reachable from the resolved control root is a named refusal (no clearable execution binding) naming the cross-root resume re-bind, ' +
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
    // Mutates the execution authority's binding slot — exclusive, matching
    // the command tools above.
    isConcurrencySafe: () => false,
    async execute(_args, exec) {
      // The same fail-closed leaf guard: a leaf seat holds no execution
      // binding and can never hold one — refuse before reading the store.
      if (isLeafSeatHeader(sessionHeaderOf(exec))) {
        return toCanonicalValue(leafSeatRefusal(EXECUTION_CLEAR_COMMAND))
      }
      // Only the workspace PRESENCE is checked first; the root itself is
      // resolved AFTER the adoption receipt (below).
      const cwd = sessionCwdOf(exec.agent)
      if (cwd === undefined) {
        return toCanonicalValue(executionClearNoHarness())
      }
      // The clear resolves the session's SELECTED harness (the root the bind
      // adoption recorded) BEFORE any workspace probe: a bind naming another
      // control root recorded that root for this session, and clearing it must
      // act on THAT root. Probing the workspace first refuses `no-harness` for
      // a session that validly bound from a workspace declaring no harness —
      // and no other clear route reaches that slot. The workspace harness only
      // backs a session that never selected an explicit root: the unchanged
      // pre-existing path.
      const sessionId = callerSessionIdOf(exec)
      const harnessDir = executionBindingRootOf(sessionId, cwd) ?? resolver.forAgent(exec.agent)
      if (harnessDir === null) {
        return toCanonicalValue(executionClearNoHarness())
      }
      const outcome = await clearExecutionSessionBinding(harnessDir, sessionId, cwd)
      if (outcome.kind === 'cleared') {
        // Drop the adoption receipt: the slot is gone, so a later clear
        // resolves the workspace root instead of re-resolving a cleared slot —
        // it answers `no-binding` when the workspace declares a harness there,
        // and the named no-harness refusal otherwise.
        clearExecutionBindingRoot(sessionId, cwd)
        return toCanonicalValue(executionClearOk())
      }
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
 * Register the native writable command tools. The registrations are deferred
 * with `ctx.inject(['tools'], …)` (the optional-unit pattern, as in
 * `tools.ts`) and each registration's disposer is returned as the inject
 * teardown, so an HMR reload of the plugin fiber unregisters the tools
 * cleanly (a post-dispose lookup finds none).
 * @param ctx - registrant context carrying the tool registry.
 * @param resolver - the per-workspace `{HARNESS_DIR}` resolver (the control
 * root resolves per the calling session's workspace — never the process cwd).
 */
export function registerNativeCommandTools(ctx: Context, resolver: { forAgent(agent: unknown): string | null }): void {
  ctx.inject(['tools'], (toolsCtx) => {
    const definitions = getCommandDefinitions()
    const disposers: Array<() => void> = []
    for (const commandId of NATIVE_COMMAND_IDS) {
      const definition = definitions.find((candidate: CommandDefinition) => candidate.id === commandId)
      if (definition === undefined) throw new Error(`no shared command definition for the native tool: ${commandId}`)
      disposers.push(toolsCtx.tools.register(nativeCommandTool(definition, resolver)))
    }
    // Task 5 (#530): the one dsh-native tool beyond the shared-command mapping
    // — the surface's total is these 7 command tools + mstar_execution_clear.
    disposers.push(toolsCtx.tools.register(executionClearTool(resolver)))
    return () => {
      for (const dispose of disposers.splice(0)) dispose()
    }
  })
}
