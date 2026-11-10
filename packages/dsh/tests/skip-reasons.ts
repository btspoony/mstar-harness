/**
 * Recorded skip reason for the gated real-composition cases: the local chokidar
 * skill-mount race is not deterministic here (CI is the only execution evidence
 * for those bodies).
 *
 * Import-free leaf module on purpose: the CI report gate
 * (`scripts/check-composition-report.ts`) matches gated case titles by this
 * suffix, so it must read the constant without loading `harness.ts` — that
 * module patches `Function.prototype.toString` and pulls in the whole boot
 * graph, which a build-time validator must not do.
 */
export const LOCAL_SKILL_MOUNT_SKIP_REASON = 'local chokidar skill-mount timing is not deterministic; these real-composition assertions run unchanged in CI'
