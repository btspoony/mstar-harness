/**
 * Dev-time minimal functional stand-in for `@deepseek-ai/dsh-tools` — the
 * tool registry (`ctx.tools`), the `defineTool` authoring surface, and the
 * `tools/pre-execute` waterfall seam consumed by `@mstar-harness/dsh`.
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface — `DefineToolOptions` /
 * `ToolDefinition` / `ToolExecution` shapes, the `ParameterSchemaSpec` /
 * `ValueSchemaSpec` typed DSL, the generic presentCall/presentResult cards —
 * and implements just enough runtime behavior for real-composition tests:
 * author-schema compilation to the raw JSON Schema subset, argument and
 * output validation, `defineTool` wrapping with soft presenters, and a
 * registry that registers tools with fiber-scoped disposal and executes them
 * through the pre-execute waterfall. Pinned to dsh-private commit 9451be2
 * (2026-08-07 snapshot). Keep in sync when the dsh-private baseline moves.
 * (`Branded`, `JsonValue`, `ContentBlock`, and `UserMessage` are mirrored
 * locally so the stub stays standalone, same as the dsh-fs / dsh-llm stubs.)
 */

import { Context, Service } from 'cordis'

/** Mirror of `@deepseek-ai/dsh-brand` `Branded<T>` (kept local so the stub stays standalone). */
export type Branded<B extends string> = string & { readonly __brand: B }

/** Call identity of one pending tool call (`@deepseek-ai/dsh-session` `CallId`). */
export type CallId = Branded<'CallId'>

/** Lossless JSON value mirror of `@deepseek-ai/dsh-session` `JsonValue`. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** One model-facing text block (mirror of the consumed `@deepseek-ai/dsh-llm` surface). */
export type ContentBlock = { readonly type: 'text'; readonly text: string }

/**
 * Pre-dispatch decision for `tools/pre-execute`. `allow` runs the call; `deny`
 * materializes an error and blocks it; `ask` defers to the approval channel
 * (missing approval support turns `ask` into denial).
 */
export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; reason?: string }

/**
 * Caller-supplied description of one tool call (`ToolRegistry.execute` adds the
 * registry-owned token to form a pipeline `ToolExecution`).
 */
export interface ToolExecutionInput {
  readonly callId: CallId
  readonly name: string
  /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
  readonly arguments: unknown
  /** The agent on whose behalf the call runs (set by the agent loop). */
  readonly agent?: unknown
  /** Opaque token of the enclosing transport execution, when one exists. */
  readonly parent?: symbol
  /** Required caller-owned cancellation for this invocation. */
  readonly signal: AbortSignal
}

/** One pending tool call inside the registry pipeline, as seen by `tools/pre-execute`. */
export interface ToolExecution extends ToolExecutionInput {
  /** Registry-assigned identity shared with nested calls only as their opaque `parent` token. */
  readonly token: symbol
}

// ---------------------------------------------------------------------------
// Value schema DSL (mirror of dsh-tools/schema.ts — the typed author surface)
// ---------------------------------------------------------------------------

/** Annotation keywords shared by every author-facing schema node. */
export interface ValueSchemaAnnotations {
  /** Human-readable description projected into JSON Schema and generated types. */
  description?: string
  /** Human-readable title projected into JSON Schema. */
  title?: string
  /** Non-validating default annotation; it must be lossless JSON data. */
  default?: JsonValue
  /** Non-validating examples annotation; it must be lossless JSON data. */
  examples?: JsonValue
}

/** String value schema with type-correct literal constraints. */
export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'string'
  enum?: readonly string[]
  const?: string
}

/** Finite JSON-number schema with type-correct literal constraints. */
export interface NumberValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'number'
  enum?: readonly number[]
  const?: number
}

/** Integer schema with type-correct literal constraints. */
export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'integer'
  enum?: readonly number[]
  const?: number
}

/** Boolean value schema with type-correct literal constraints. */
export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'boolean'
  enum?: readonly boolean[]
  const?: boolean
}

/** Null value schema with type-correct literal constraints. */
export interface NullValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'null'
  enum?: readonly null[]
  const?: null
}

/** Array value schema; omitted `items` accepts any lossless JSON item. */
export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'array'
  items?: ValueSchemaSpec
}

/**
 * Explicit object value schema. Openness is mandatory so a nested or output
 * object never acquires an accidental JSON Schema default.
 */
export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'object'
  properties?: ParameterSchemaSpec
  additionalProperties: boolean
}

/** Author-only unconstrained lossless JSON node. */
export interface JsonValueSchemaSpec extends ValueSchemaAnnotations {
  type: 'json'
}

/** Exact-one union schema; at least two branches are required. */
export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations {
  oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]]
}

/** One author-facing schema for any lossless JSON value root. */
export type ValueSchemaSpec =
  | StringValueSchemaSpec
  | NumberValueSchemaSpec
  | IntegerValueSchemaSpec
  | BooleanValueSchemaSpec
  | NullValueSchemaSpec
  | ArrayValueSchemaSpec
  | ObjectValueSchemaSpec
  | JsonValueSchemaSpec
  | OneOfValueSchemaSpec

/** One implicit parameter-root property, optionally required. */
export type ParameterPropertySpec = ValueSchemaSpec & { required?: true }

/**
 * Tool parameter schema. The map itself is an implicit open object root;
 * requiredness remains a per-property `required: true` annotation.
 */
export type ParameterSchemaSpec = {
  [key: string]: ParameterPropertySpec
  [key: symbol]: never
}

/** Flatten an intersection into one object type for readable hovers. */
type Simplify<T> = { [K in keyof T]: T[K] } & {}

/** String keys of one property map; runtime compilation rejects symbol keys. */
type StringKeyOf<S> = Extract<keyof S, string>

/** Keys of a property map marked `required: true`. */
type RequiredKeys<S> = {
  [K in StringKeyOf<S>]: S[K] extends { required: true } ? K : never
}[StringKeyOf<S>]

/** Infer the declared value of one parameter property without key optionality. */
type InferProperty<P, Depth extends unknown[]> = InferValueAt<P, Depth>

/** Infer an implicit property map into required and optional object keys. */
type InferProperties<S, Depth extends unknown[]> = Simplify<
  & { [K in RequiredKeys<S>]: InferProperty<S[K], Depth> }
  & { [K in Exclude<StringKeyOf<S>, RequiredKeys<S>>]?: InferProperty<S[K], Depth> }
>

/** Infer an explicit object node, including its declared openness. */
type InferObject<S extends { additionalProperties: boolean }, Depth extends unknown[]> =
  S extends { properties: infer P }
    ? S['additionalProperties'] extends true
      ? InferProperties<P, Depth> & Record<string, JsonValue>
      : InferProperties<P, Depth>
    : S['additionalProperties'] extends true
      ? Record<string, JsonValue>
      : Record<string, never>

/** Infer a scalar node's literal constraint before its broad primitive type. */
type InferScalar<S, Fallback> =
  S extends { const: infer C } ? C :
    S extends { enum: readonly (infer E)[] } ? E :
      Fallback

/** Add one schema-container level to bounded compile-time inference. */
type NextInferenceDepth<Depth extends unknown[]> = [unknown, ...Depth]

/** Infer one node without recursively checking it against the full author union. */
type InferValueAt<S, Depth extends unknown[]> =
  Depth['length'] extends 16 ? JsonValue :
    S extends { type: 'string' } ? InferScalar<S, string> :
      S extends { type: 'number' | 'integer' } ? InferScalar<S, number> :
        S extends { type: 'boolean' } ? InferScalar<S, boolean> :
          S extends { type: 'null' } ? null :
            S extends { type: 'array' }
              ? S extends { items: infer I } ? InferValueAt<I, NextInferenceDepth<Depth>>[] : JsonValue[]
              : S extends { type: 'object'; additionalProperties: boolean }
                ? InferObject<S, NextInferenceDepth<Depth>>
                : S extends { type: 'json' } ? JsonValue :
                  S extends { oneOf: readonly unknown[] }
                    ? InferValueAt<S['oneOf'][number], NextInferenceDepth<Depth>>
                    : never

/**
 * Infer the TypeScript value accepted by an author-facing value schema. Exact
 * inference is bounded to 16 container levels, then falls back to `JsonValue`.
 */
export type InferValue<S> = InferValueAt<S, []>

/** Infer the TypeScript argument object for an implicit parameter schema. */
export type InferArgs<S> = InferProperties<S, []>

// ---------------------------------------------------------------------------
// Presentation vocabulary (mirror of dsh-tools/presentation.ts — generic card)
// ---------------------------------------------------------------------------

/**
 * Category of a tool call, used by a UI to pick an icon or treatment. The
 * provider-neutral vocabulary lets tools describe themselves without depending
 * on a particular client; `other` is the default.
 */
export type ToolCallKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'

/**
 * The default card: a titled tool-call row with an optional category icon and
 * a salient raw input. Any tool whose call is not a terminal or a diff uses
 * this. (`locations`/`FileLocation` are omitted — not part of the consumed
 * surface of `@mstar-harness/dsh`.)
 */
export interface GenericCallView {
  card: 'generic'
  /** Human-readable, always-visible label describing what THIS call does. */
  title: string
  /** Category for icon/treatment; defaults to `other` when omitted. */
  kind?: ToolCallKind
  /** The salient input to surface in a detail/expanded view. */
  rawInput?: unknown
  /** UI-facing content blocks to show on the pending call alongside the title. */
  content?: ContentBlock[]
}

/** Provider-neutral pending-call presentation (consumed surface: generic card). */
export type ToolCallView = GenericCallView

/**
 * The default completed card: an optional replacement title and reformatted
 * content. Omit a field to keep the pending title / render the raw result content.
 */
export interface GenericResultView {
  card: 'generic'
  /** Replacement title for the completed call. Omit to keep the pending-state title. */
  title?: string
  /** UI-facing result content, reformatted from the model-facing result. */
  content?: ContentBlock[]
}

/** Provider-neutral completed-call presentation (consumed surface: generic card). */
export type ToolResultView = GenericResultView

// ---------------------------------------------------------------------------
// Execution surface (mirror of dsh-tools/index.ts consumed shapes)
// ---------------------------------------------------------------------------

/** Minimal `UserMessage` mirror for the `ToolRunContext.deferContext` signature. */
export interface UserMessage {
  readonly id: unknown
  readonly role: 'user'
  readonly content: readonly ContentBlock[]
  readonly source: unknown
}

/**
 * Runtime context handed to a tool implementation after the registry has
 * validated its arguments.
 */
export interface ToolRunContext extends ToolExecution {
  /** Defer one context until this tool's final result reaches the agent loop. */
  deferContext(context: UserMessage): void
  /** Mark a successful final result as terminal for the current agent turn. */
  concludeTurn(): void
}

/** Structured error metadata for a failed tool call. */
export interface ToolFailure {
  readonly message: string
  readonly code?: string
  readonly info?: unknown
}

/** The completed outcome handed to {@link ToolDefinition.presentResult}. */
export interface ToolResult {
  /** The final model-facing content (or the rendered error text on failure). */
  content: ContentBlock[]
  /** Whether the call failed. */
  isError: boolean
  /** The tool-private presentation payload projected by its output declaration. */
  meta?: JsonValue
}

/** Successful canonical tool execution, including its Native/model projection. */
export interface ToolExecutionSuccess {
  readonly isError: false
  /** Execution-local canonical value; deliberately omitted from durable events. */
  readonly value: JsonValue
  readonly content: ContentBlock[]
  readonly error?: never
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  /** The agent loop stops after committing this successful result batch. */
  readonly concludesTurn?: true
}

/** Failed canonical tool execution; failures never carry a successful value. */
export interface ToolExecutionFailure {
  readonly isError: true
  readonly error: ToolFailure
  readonly value?: never
  readonly content: ContentBlock[]
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  readonly concludesTurn?: never
}

/** The discriminated, execution-local outcome of one tool call. */
export type ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure

/** A registered tool: its schema plus the execution function. */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  /** Compiled raw JSON Schema for the implicit open parameter object. */
  readonly parameters: Record<string, unknown>
  /** Mandatory canonical output declaration. */
  readonly output: {
    /** Raw supported JSON Schema enforced against every successful canonical value. */
    readonly schema: Record<string, unknown>
    /** Pure Native/model rendering of one validated canonical value. */
    render(args: unknown, value: JsonValue): ContentBlock[]
    /** Pure replayable presentation projection, computed only for surface calls. */
    presentationMeta?(args: unknown, value: JsonValue): JsonValue
  }
  /**
   * Run one accepted call and return only its canonical lossless-JSON value.
   * Async work must observe or forward `exec.signal`.
   * @param args - losslessly snapshotted, frozen model arguments.
   * @param exec - execution identity, cancellation signal, and context deferral.
   * @returns the canonical value declared by `output.schema`.
   */
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  /**
   * Synchronous last-mile transform for model-facing content, invoked exactly
   * once for every normalized outcome. Returning `undefined` preserves content.
   */
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /** Cooperative tool-call timeout budget in milliseconds; never model-visible. */
  timeoutMs?: number
  /** Pure synchronous classifier for overlap with sibling tool calls. */
  isConcurrencySafe?(args: unknown): boolean
  /** How to present the PENDING state of one call in a UI. */
  presentCall?(args: unknown): ToolCallView | undefined
  /** How to present the COMPLETED state, given the same `args` and the durable result. */
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}

/** Options for {@link defineTool}. */
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
  /** Tool name (must be unique). */
  readonly name: string
  /** Human-readable description sent to the model. */
  readonly description: string
  /** Per-property parameter schema compiled to an implicit open object root. */
  readonly parameters: S
  /** Canonical output schema plus pure Native and presentation projections. */
  readonly output: {
    /** Schema enforced against every successful body or policy-replaced value. */
    readonly schema: O
    /** Pure Native/model rendering of one validated canonical value. */
    render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[]
    /** Pure replayable presentation metadata for direct surface calls. */
    presentationMeta?(args: InferArgs<S>, value: InferValue<NoInfer<O>>): JsonValue
  }
  /** Optional positive cooperative timeout budget in milliseconds. */
  readonly timeoutMs?: number
  /**
   * Pure classifier for sibling overlap.
   * @param args - typed validated arguments.
   * @returns Whether the call may join a parallel group.
   */
  isConcurrencySafe?(args: InferArgs<S>): boolean
  /**
   * Execute the tool after argument validation.
   * @param args - typed validated arguments.
   * @param exec - execution identity, caller, cancellation, and nesting data.
   * @returns The canonical value declared by `output.schema`.
   */
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>
  /**
   * Optional last-mile content transform for every normalized outcome.
   * @param exec - immutable execution identity and arguments.
   * @param result - complete normalized outcome before materialization.
   * @returns replacement content, or `undefined` to preserve it.
   */
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /**
   * Pure pending-state presenter.
   * @param args - typed validated arguments.
   * @returns Tool-owned render intent, or `undefined` for the generic card.
   */
  presentCall?(args: InferArgs<S>): ToolCallView | undefined
  /**
   * Pure completed-state presenter.
   * @param args - typed validated arguments.
   * @param result - final model-facing tool result.
   * @returns Tool-owned render intent, or `undefined` for the generic card.
   */
  presentResult?(args: InferArgs<S>, result: ToolResult): ToolResultView | undefined
}

// ---------------------------------------------------------------------------
// Runtime: schema compilation + validation (dev-time subset)
// ---------------------------------------------------------------------------

/** Raw supported JSON Schema subset used by the dev-time compiler. */
type JsonSchemaNode = Record<string, unknown>

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'] as const

/** Throw one author-schema violation (the real package uses `JsonSchemaError`). */
function authorError(message: string): never {
  throw new Error(`dsh-tools schema: ${message}`)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** Copy own annotation fields for validation by the raw-schema boundary. */
function copyAnnotations(source: Record<string, unknown>, target: JsonSchemaNode): void {
  for (const key of ANNOTATION_KEYS) {
    if (Object.hasOwn(source, key)) target[key] = source[key] as JsonValue
  }
}

/** Reject author-only keys outside one node's declared vocabulary. */
function assertAuthorKeys(source: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`)
  }
}

/**
 * Compile one author-facing value schema into the enforced raw JSON Schema
 * subset. The author-only `json` node becomes an annotation-only schema.
 * `required: true` is only a property annotation (`allowRequired` — it is
 * consumed by the property-map compiler and never copied to the node).
 * `simplify:` dev-time stub — plain recursion with a cycle guard (the real
 * compiler is stack-safe); swap the real package at P3 e2e.
 */
function compileValueSchema(input: unknown, path: string, seen: Set<object>, allowRequired = false): JsonSchemaNode {
  if (!isPlainObject(input)) authorError(`${path} must be a value schema object`)
  if (seen.has(input)) authorError(`${path} is circular`)
  seen.add(input)
  const node: JsonSchemaNode = {}
  const authorKeys = allowRequired ? [...ANNOTATION_KEYS, 'required'] : [...ANNOTATION_KEYS]

  if (Object.hasOwn(input, 'oneOf')) {
    assertAuthorKeys(input, path, [...authorKeys, 'oneOf'])
    if (!Array.isArray(input.oneOf) || input.oneOf.length < 2) {
      authorError(`${path}.oneOf must be an array of at least two value schemas`)
    }
    node.oneOf = input.oneOf.map((branch, index) => compileValueSchema(branch, `${path}.oneOf[${index}]`, seen))
    copyAnnotations(input, node)
    seen.delete(input)
    return node
  }

  const inputType = Object.hasOwn(input, 'type') ? input.type : undefined
  switch (inputType) {
    case 'json':
      assertAuthorKeys(input, path, [...authorKeys, 'type'])
      copyAnnotations(input, node)
      break
    case 'object': {
      assertAuthorKeys(input, path, [...authorKeys, 'type', 'properties', 'additionalProperties'])
      if (typeof input.additionalProperties !== 'boolean') {
        authorError(`${path}.additionalProperties must be explicitly true or false`)
      }
      node.type = 'object'
      node.additionalProperties = input.additionalProperties
      copyAnnotations(input, node)
      if (Object.hasOwn(input, 'properties')) {
        const map = compilePropertyMap(input.properties, `${path}.properties`, seen)
        node.properties = map.properties
        if (map.required !== undefined) node.required = map.required
      }
      break
    }
    case 'array':
      assertAuthorKeys(input, path, [...authorKeys, 'type', 'items'])
      node.type = 'array'
      copyAnnotations(input, node)
      if (Object.hasOwn(input, 'items')) node.items = compileValueSchema(input.items, `${path}.items`, seen)
      break
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      assertAuthorKeys(input, path, [...authorKeys, 'type', 'enum', 'const'])
      node.type = inputType
      copyAnnotations(input, node)
      if (Object.hasOwn(input, 'enum')) {
        if (!Array.isArray(input.enum) || input.enum.length === 0 || !input.enum.every(isScalar)) {
          authorError(`${path}.enum must be a non-empty array of scalar values`)
        }
        node.enum = input.enum
      }
      if (Object.hasOwn(input, 'const')) {
        if (!isScalar(input.const)) authorError(`${path}.const must be a scalar value`)
        node.const = input.const
      }
      break
    default:
      authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`)
  }
  seen.delete(input)
  return node
}

/**
 * Compile one implicit property map (parameter root or object properties),
 * collecting per-property requiredness into the compiled `required` array.
 */
function compilePropertyMap(
  input: unknown,
  path: string,
  seen: Set<object>,
): { properties: Record<string, JsonSchemaNode>; required?: string[] } {
  if (!isPlainObject(input)) authorError(`${path} must be an object of value schemas`)
  const properties: Record<string, JsonSchemaNode> = {}
  const required: string[] = []
  for (const key of Object.keys(input)) {
    const property = input[key]
    if (!isPlainObject(property)) authorError(`${path}.${key} must be a value schema object`)
    if (Object.hasOwn(property, 'required')) {
      if (property.required !== true) authorError(`${path}.${key}.required must be true when present`)
      required.push(key)
    }
    properties[key] = compileValueSchema(property, `${path}.${key}`, seen, true)
  }
  return { properties, ...(required.length > 0 ? { required } : {}) }
}

/**
 * Compile the implicit open parameter object into raw JSON Schema.
 * @param spec - per-property parameter definitions.
 * @returns An object-rooted raw schema with no implicit-root openness override.
 */
export function parameterSchemaSpecToJsonSchema(spec: ParameterSchemaSpec): Record<string, unknown> {
  const map = compilePropertyMap(spec, 'parameters', new Set())
  return {
    type: 'object',
    properties: map.properties,
    ...(map.required === undefined ? {} : { required: map.required }),
  }
}

/**
 * Compile one author-facing value schema to the enforced raw JSON Schema
 * subset. The author-only `json` node becomes an annotation-only schema.
 * @param spec - schema for any JSON-value root.
 * @returns The asserted raw schema projection.
 */
export function valueSchemaSpecToJsonSchema(spec: ValueSchemaSpec): Record<string, unknown> {
  return compileValueSchema(spec, 'schema', new Set())
}

/**
 * Validate an unknown value against a compiled schema node, collecting
 * path-qualified violations. Supports the compiled DSL subset: scalar types +
 * enum/const, arrays with items, objects with properties/required/
 * additionalProperties, and oneOf unions.
 * @param schema - compiled schema node.
 * @param value - candidate value, however malformed.
 * @param path - current JSON path ('' at the root).
 * @returns Path-qualified violations; empty means valid.
 */
function validateJsonSchemaValue(schema: JsonSchemaNode, value: unknown, path: string): string[] {
  const name = path === '' ? 'value' : path
  const at = (suffix: string): string => (path === '' ? suffix : `${path}.${suffix}`)
  const violations: string[] = []

  if (schema.oneOf !== undefined) {
    const branches = schema.oneOf as JsonSchemaNode[]
    if (!branches.some((branch) => validateJsonSchemaValue(branch, value, path).length === 0)) {
      violations.push(`${name} does not match any oneOf branch`)
    }
    return violations
  }

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') violations.push(`${name} must be a string`)
      break
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) violations.push(`${name} must be a number`)
      break
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) violations.push(`${name} must be an integer`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') violations.push(`${name} must be a boolean`)
      break
    case 'null':
      if (value !== null) violations.push(`${name} must be null`)
      break
    case 'array':
      if (!Array.isArray(value)) {
        violations.push(`${name} must be an array`)
      } else if (schema.items !== undefined) {
        const items = schema.items as JsonSchemaNode
        value.forEach((item, index) => violations.push(...validateJsonSchemaValue(items, item, at(String(index)))))
      }
      break
    case 'object':
      if (!isPlainObject(value)) {
        violations.push(`${name} must be an object`)
        break
      }
      if (schema.required !== undefined) {
        for (const key of schema.required as string[]) {
          if (!Object.hasOwn(value, key)) violations.push(`${at(key)} is required`)
        }
      }
      const properties = schema.properties as Record<string, JsonSchemaNode> | undefined
      if (schema.additionalProperties === false && properties !== undefined) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(properties, key)) violations.push(`${at(key)} is not allowed`)
        }
      }
      if (properties !== undefined) {
        for (const key of Object.keys(properties)) {
          if (Object.hasOwn(value, key)) {
            violations.push(...validateJsonSchemaValue(properties[key]!, value[key], at(key)))
          }
        }
      }
      break
    default:
      // Annotations-only node (`json` compiles to no type keyword) — no checks.
      break
  }

  if (schema.enum !== undefined && !(schema.enum as unknown[]).some((entry) => entry === value)) {
    violations.push(`${name} must be one of: ${JSON.stringify(schema.enum)}`)
  }
  if (schema.const !== undefined && schema.const !== value) {
    violations.push(`${name} must equal ${JSON.stringify(schema.const)}`)
  }
  return violations
}

/** Invalid model-generated arguments for a typed tool. */
export class ToolArgsError extends Error {
  /** Individual violations in schema-walk order. */
  readonly violations: string[]
  readonly code = 'INVALID_ARGS' as const

  constructor(violations: string[]) {
    super(`invalid arguments: ${violations.join('; ')}`)
    this.name = 'ToolArgsError'
    this.violations = violations
  }
}

/** Thrown when a tool body or post-policy value violates its declared output. */
export class ToolOutputError extends Error {
  readonly code = 'INVALID_OUTPUT' as const

  constructor(toolName: string, violations: string[]) {
    super(`invalid output: ${violations.join('; ')}`)
    this.name = 'ToolOutputError'
  }
}

// ---------------------------------------------------------------------------
// Runtime: defineTool + registry
// ---------------------------------------------------------------------------

/**
 * Define a first-party tool with inferred arguments and strict execution
 * validation. Replay-only presenters validate softly and fall back to generic
 * rendering for obsolete logged arguments.
 * @param options - typed definition and optional finalizer and presenters.
 * @returns A registry-ready definition.
 */
export function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
  options: DefineToolOptions<S, O>,
): ToolDefinition {
  // Object-literal methods do not use `this`; retaining references is safe.
  const userExecute = options.execute
  const userFinalizeContent = options.finalizeContent
  const userRender = options.output.render
  const userPresentationMeta = options.output.presentationMeta
  const userPresentCall = options.presentCall
  const userPresentResult = options.presentResult
  const userIsConcurrencySafe = options.isConcurrencySafe
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`)
  }
  const parameters = parameterSchemaSpecToJsonSchema(options.parameters)
  const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema)
  const validate = (args: unknown): string[] => validateJsonSchemaValue(parameters, args, '')
  const tool: ToolDefinition = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render(args: unknown, value: JsonValue): ContentBlock[] {
        return userRender(args as InferArgs<S>, value as unknown as InferValue<NoInfer<O>>)
      },
      ...(userPresentationMeta !== undefined ? {
        presentationMeta(args: unknown, value: JsonValue): JsonValue {
          return userPresentationMeta(args as InferArgs<S>, value as unknown as InferValue<NoInfer<O>>)
        },
      } : {}),
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    async execute(args: unknown, exec: ToolRunContext): Promise<JsonValue> {
      const violations = validate(args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return userExecute(args as InferArgs<S>, exec) as Promise<JsonValue>
    },
  }
  if (userFinalizeContent) {
    tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result)
  }
  // Presentation is display-only and may run on REPLAY of arbitrary logged args
  // (possibly from an older schema), so it must never throw: validate softly and
  // fall back to `undefined` (a generic UI presentation) on any mismatch.
  if (userPresentCall) {
    tool.presentCall = (args: unknown): ToolCallView | undefined => {
      if (validate(args).length > 0) return undefined
      return userPresentCall(args as InferArgs<S>)
    }
  }
  if (userPresentResult) {
    tool.presentResult = (args: unknown, result: ToolResult): ToolResultView | undefined => {
      if (validate(args).length > 0) return undefined
      return userPresentResult(args as InferArgs<S>, result)
    }
  }
  if (userIsConcurrencySafe) {
    tool.isConcurrencySafe = (args: unknown): boolean => {
      if (validate(args).length > 0) return false
      return userIsConcurrencySafe(args as InferArgs<S>)
    }
  }
  return tool
}

/** Best-effort human-readable message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Map a thrown error to its canonical failure code (dev-time subset). */
function errorCode(error: unknown): string {
  if (error instanceof ToolArgsError) return error.code
  if (error instanceof ToolOutputError) return error.code
  return 'TOOL_ERROR'
}

/** One canonical failure result for an executed tool call. */
function failureResult(name: string, message: string, code: string, info?: unknown): ToolExecutionFailure {
  return {
    isError: true,
    error: { message, code, ...(info !== undefined ? { info } : {}) },
    content: [{ type: 'text', text: message }],
  }
}

declare module 'cordis' {
  interface Context {
    tools: ToolRegistry
  }

  interface Events {
    /**
     * Allow, deny, or ask before dispatch. `next()` delegates to allow; a
     * listener that returns `{ kind: 'deny'; reason }` without calling `next()`
     * owns the decision and blocks the call. Async gates must observe
     * `exec.signal`; the registry rechecks cancellation after they settle but
     * never abandons their promise.
     * @param exec - the pending call (name, parsed arguments, caller agent).
     * @param next - the remaining chain; its value is the delegated decision.
     * @mode waterfall
     */
    'tools/pre-execute'(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
  }
}

/**
 * Tool registry and execution pipeline (dev-time minimal functional
 * stand-in). Registers definitions with fiber-scoped disposal and executes
 * calls through the `tools/pre-execute` waterfall with argument validation,
 * body invocation, output validation, and Native rendering.
 *
 * `simplify:` dev-time stub — no scoped layers, timeout policy, execution
 * guards, post-result pipeline, concurrency scheduling, or durable-event
 * emission; swap the real `@deepseek-ai/dsh-tools` package at P3 e2e for the
 * production semantics.
 */
export class ToolRegistry extends Service {
  private readonly definitions = new Map<string, ToolDefinition>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  /**
   * Register one tool definition. Duplicate names throw; fiber disposal
   * unregisters the tool.
   * @param def - the definition to register.
   * @returns the exact Cordis effect disposer that unregisters this tool.
   */
  register(def: ToolDefinition): () => void {
    if (this.definitions.has(def.name)) {
      throw new Error(`a tool named "${def.name}" is already registered`)
    }
    const definitions = this.definitions
    return this.ctx.effect(() => {
      definitions.set(def.name, def)
      return () => {
        definitions.delete(def.name)
      }
    }, 'tools.register()')
  }

  /** Look up a registered definition by name. */
  lookup(name: string): ToolDefinition | undefined {
    return this.definitions.get(name)
  }

  /**
   * Run one pending tool call: pre-execute waterfall → argument validation →
   * body → output validation → render. Failures never throw; they settle as
   * `ToolExecutionFailure` results (mirror of the real registry).
   * @param input - caller-supplied call description.
   * @returns the normalized execution outcome.
   */
  async execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
    const tool = this.definitions.get(input.name)
    if (tool === undefined) {
      return failureResult(input.name, `tool not found: ${input.name}`, 'TOOL_NOT_FOUND')
    }
    const exec: ToolRunContext = {
      callId: input.callId,
      name: input.name,
      arguments: input.arguments,
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.parent !== undefined ? { parent: input.parent } : {}),
      signal: input.signal,
      token: Symbol('dsh.tool.execution'),
      // simplify: dev-time stub — context deferral/conclusion are no-ops.
      deferContext: () => {},
      concludeTurn: () => {},
    }

    const decision = await this.ctx.waterfall(
      'tools/pre-execute',
      exec,
      () => Promise.resolve({ kind: 'allow' } as PreToolDecision),
    )
    if (decision.kind !== 'allow') {
      return failureResult(input.name, `tool call denied: ${decision.reason ?? 'no reason'}`, 'PRE_EXECUTE_DENIED')
    }

    const violations = validateJsonSchemaValue(tool.parameters, input.arguments, '')
    if (violations.length > 0) {
      return failureResult(input.name, `invalid arguments: ${violations.join('; ')}`, 'INVALID_ARGS', violations)
    }

    let value: unknown
    try {
      value = await tool.execute(input.arguments, exec)
    } catch (error) {
      return failureResult(input.name, errorMessage(error), errorCode(error))
    }

    const outputViolations = validateJsonSchemaValue(tool.output.schema, value, '')
    if (outputViolations.length > 0) {
      return failureResult(input.name, `invalid output: ${outputViolations.join('; ')}`, 'INVALID_OUTPUT', outputViolations)
    }

    let content: ContentBlock[]
    try {
      content = tool.output.render(input.arguments, value as JsonValue)
    } catch (error) {
      return failureResult(input.name, `output.render failed: ${errorMessage(error)}`, 'INVALID_OUTPUT')
    }
    return { isError: false, value: value as JsonValue, content }
  }
}

export default ToolRegistry
