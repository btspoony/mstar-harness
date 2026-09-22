import {
  executionContextFor,
  resumeExecutionSession,
  type ExecutionBinding,
  type ExecutionCaller,
  type ExecutionIdentity,
  type ExecutionSessionRef,
} from '@mstar-harness/engine'
import { sessionHeaderIdOf, sessionCwdOf } from './_shared.ts'

/** Scope supplied by the already-admitted C1 binding; never inferred from DSh arguments. */
export type ExecutionSessionScope = Omit<ExecutionCaller, 'sessionId'>

/** Read the SDK-owned carrying session identity; Agent.id is deliberately excluded. */
export function nativeSessionIdOf(agent: unknown): string | undefined {
  return sessionHeaderIdOf(agent)
}

/** Read the SDK-owned workspace of the carrying session. */
export function nativeSessionCwdOf(agent: unknown): string | undefined {
  return sessionCwdOf(agent)
}

/**
 * Build the trusted host identity after native admission supplied a real session id
 * and C1 supplied the closed workflow/role/plan scope. This does not mint or infer
 * any scope and therefore cannot promote a leaf to coordinator.
 */
export function executionIdentityForSession(sessionId: string, scope: ExecutionSessionScope): ExecutionIdentity {
  if (sessionId.trim() === '') throw new Error('native execution session identity is required')
  return { source: 'host', sessionId, ...scope }
}

/** Resume the current C1 session reference, refusing stale/foreign/copy-only refs. */
export async function resumeNativeExecutionSession(
  harnessDir: string,
  nativeSessionId: string,
  binding: ExecutionBinding,
): Promise<ExecutionSessionRef> {
  if (binding.harnessRoot !== harnessDir || binding.session.sessionId !== nativeSessionId) {
    throw new Error('native execution binding does not match the carrying session')
  }
  const identity = executionIdentityForSession(nativeSessionId, {
    workflowId: binding.session.workflowId,
    role: binding.session.role,
    planId: binding.session.planId,
  })
  const resumed = await resumeExecutionSession(executionContextFor({ harnessDir }, identity), binding.session)
  return resumed.data
}
