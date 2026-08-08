/**
 * Dev-time minimal functional stand-in for `@deepseek-ai/dsh-llm` — the
 * message vocabulary seam (`MessageSourceMap` merge target, `MessageSource`,
 * `Message`/`UserMessage` shapes, `createUserMessage`) consumed by
 * `@mstar-harness/dsh` and the `@deepseek-ai/dsh-agent` peer stub.
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this stub mirrors the consumed contract surface of `packages/llm/llm/src/
 * message.ts` — the merge-extensible `MessageSourceMap`, the catalog-form
 * `ContextFormed` subset, the one shared immutable `Message` representation,
 * and the frozen message creators — and implements just enough behavior for
 * real-composition tests (detach + deep-freeze on creation, stable random
 * identity). Pinned to dsh-private commit 9451be2 (2026-08-07 snapshot). Keep
 * in sync when the dsh-private baseline moves.
 */

/** Mirror of `@deepseek-ai/dsh-brand` `Branded<T>` (kept local so the stub stays standalone). */
export type Branded<B extends string> = string & { readonly __brand: B }

/** Stable identity preserved across every representation boundary. */
export type MessageId = Branded<'MessageId'>

/** Brand a string as a {@link MessageId}. For creator use only. */
export function MessageId(value: string): MessageId {
  return value as MessageId
}

/** One model-facing text block (the consumed block surface; other block kinds live in dsh-session). */
export type ContentBlock = { readonly type: 'text'; readonly text: string }

/** Producer-declared context form and the fields that form requires (consumed subset: catalog). */
export type ContextFormed =
  | { readonly form?: never }
  | { readonly form: 'catalog' }

/** Minimal model-produced source shape (consumed surface: kind only). */
export interface ModelMessageSource {
  readonly kind: 'model'
}

/** Minimal tool-result source shape (consumed surface: kind + call identity). */
export interface ToolMessageSource {
  readonly kind: 'tool'
  readonly callId: string
}

/**
 * Where a message (or injected content) came from.
 * Merge-extensible sum type — plugins add their own `kind`s.
 */
export interface MessageSourceMap {
  user: { kind: 'user' }
  plugin: { kind: 'plugin'; plugin: string } & ContextFormed
  model: ModelMessageSource
  tool: ToolMessageSource
}

/** Any known message source, derived from {@link MessageSourceMap}; switch on `kind` and fall through unknowns (merge-extensible). */
export type MessageSource = MessageSourceMap[keyof MessageSourceMap]

/** One immutable message representation shared by delivery, durable history, and model requests. */
export interface Message {
  /** Stable identity preserved across every representation boundary. */
  readonly id: MessageId
  /** Provider-neutral conversation role. */
  readonly role: 'system' | 'user' | 'assistant'
  /** Exact model-facing blocks. */
  readonly content: ContentBlock[]
  /** Required producer provenance. */
  readonly source: MessageSource
}

/** A user-role specialization of the one shared message representation. */
export interface UserMessage extends Message {
  readonly role: 'user'
}

/** Detach and deep-freeze a message whose identity already exists. */
export function freezeMessage<T extends Message>(message: T): T {
  return deepFreeze(structuredClone(message))
}

/** Create one identified message and freeze it before publication. */
export function createMessage<T extends Omit<Message, 'id'>>(
  input: T & { readonly id?: never },
): T & Pick<Message, 'id'> {
  return freezeMessage({
    ...input,
    id: MessageId(crypto.randomUUID()),
  })
}

/** Create one identified user-role message and freeze it before publication. */
export function createUserMessage<T extends Omit<UserMessage, 'id' | 'role'>>(
  input: T & { readonly id?: never; readonly role?: never },
): T & Pick<UserMessage, 'id' | 'role'> {
  return createMessage({
    ...input,
    role: 'user',
  })
}

/** Deep-freeze a value (the llm seam's immutability contract). */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}
