/**
 * Dev-time type-only shim for `@deepseek-ai/dsh-client-ui-conversation/client` —
 * the conversation slot declarations consumed by the `@mstar-harness/dsh`
 * client panel plugin.
 *
 * The real package is private and ships from the composed dsh app at runtime;
 * this declaration mirrors exactly the consumed surface of the seam, pinned to
 * dsh-private commit 9451be2 (2026-08-07 snapshot):
 *
 * - the `'conversation.view'` SlotMap row — `{ kind: 'list'; scope: 'session' }`
 *   with the `ConvViewOwnerProps` owner share (the view ring: one list entry
 *   per view tab, rendered one-at-a-time by the session body via `only: <id>`);
 * - `ConvViewProps` = `PropsRuntime<'conversation.view'>` — the base props of a
 *   conversation view entry (standard kit `useSession`/`sessionId`/
 *   `useProjection` + global kit `useSessions`/`useWorkspaces`);
 * - `ViewTab` — the projected `{ id, label }` ring row (fixture assertions).
 *
 * Type-only: value imports from this package are erased by the bundle purity
 * gate at build time and never reach the loader module table. Keep in sync
 * when the dsh-private baseline moves. (`PropsRuntime` comes from the
 * `@deepseek-ai/dsh-client-ui-slots` peer stub; the standard-kit members merge
 * through the `@deepseek-ai/dsh-client-runtime` peer stub.)
 */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The conversation view ring: one list entry per view tab (chat /
     * trajectory / waterfall), rendered one-at-a-time by the session body via
     * `only: <active id>`. Session scope: views read the conversation
     * snapshot through the standard kit.
     */
    'conversation.view': { kind: 'list'; scope: 'session'; owner: ConvViewOwnerProps }
  }
}

/** View-slot owner share: the cross-view inspect handoff (otherwise views need nothing from the render site). */
export interface ConvViewOwnerProps {
  /** One-shot inspect request from another view; null when idle. */
  inspect?: { callId: string } | null
  /** Acknowledge the inspect request once applied. */
  onInspectDone?: () => void
}

/** Base props of a conversation view entry: the framework standard kit for the session-scope 'conversation.view' slot. */
export type ConvViewProps = PropsRuntime<'conversation.view'>

/** One projected view-ring tab (id + resolved label). */
export interface ViewTab {
  id: string
  label: string
}
