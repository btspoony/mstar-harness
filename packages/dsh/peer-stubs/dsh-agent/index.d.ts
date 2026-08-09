/**
 * Type-only shim for the `@deepseek-ai/dsh-agent` seam consumed by `@mstar-harness/dsh`.
 *
 * The real package is private and ships from the composed dsh app at runtime; its
 * published types are not built in the local dsh-private checkout. This declaration
 * mirrors exactly the consumed surface of the seam — `PreStepDecision` and the
 * `agent/pre-step` waterfall event — pinned to dsh-private commit 9451be2
 * (2026-08-07 snapshot). Keep in sync when the dsh-private baseline moves.
 * (`UserMessage` comes from the `@deepseek-ai/dsh-llm` peer stub; the real
 * agent package types it through `@deepseek-ai/dsh-session`.)
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** Whether and with which messages the loop enters a proposed step. */
export type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[] }

/**
 * The public live-agent handle (consumed surface: the command-handler
 * steering path — `@deepseek-ai/dsh-commands` `CommandInvocation.agent`).
 * Mirrors the real `Agent` interface; only the members the plugin's command
 * handlers use are declared here (the real surface also carries
 * `session`/`inbox`/`cancel`/`whenIdle`/`runMaintenance`/`ctx`).
 */
export interface Agent {
  /** The single identity shared with the session. */
  readonly id: string
  /** The current lifecycle state. */
  readonly status: 'idle' | 'running'
  /**
   * Queue model-facing context for the next pre-step without waking the
   * driver (the command-handler delivery channel: a slash command steers
   * its mstar command body into the receiving agent).
   */
  steer(message: UserMessage): void
  /** Queue an ordinary follow-up turn and wake the driver. */
  followup(message: UserMessage): void
}

declare module 'cordis' {
  interface Events {
    /**
     * Reject a proposed step or replace the messages that enter it. Calling
     * `next()` preserves the current messages.
     * @param payload - the proposed step (agent, inbox messages, turn/step, abort signal).
     * @param next - the remaining chain; its value is the delegated decision.
     * @mode waterfall
     */
    'agent/pre-step'(
      payload: { agent: unknown; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision>
  }
}
