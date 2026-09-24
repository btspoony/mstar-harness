export {
  CONTRACT_REVISION,
  MAX_RUN_RESERVED_INPUT_TOKENS,
  NATIVE_ENDPOINT,
  NATIVE_MODEL,
  PACK_SCHEMA,
  PILOT_SCHEMA,
  PROTOCOL_NUMERIC_TOLERANCE,
  TOKEN_POLICY_METHOD,
  TOKEN_RESERVATION_PER_ATTEMPT,
  validatePack,
  validatePilot,
} from "./contracts.js";
export type {
  A05Label,
  JudgmentPilot,
  Profile,
  ReviewDecisionPack,
  ReviewTier,
  WorkUnit,
} from "./contracts.js";
export { buildCandidatePairs, buildShadowPack } from "./audit-shadow.js";
export type { CandidatePair, FindingSource, ReviewScope, StructuredFinding } from "./audit-shadow.js";
export { connectEvaluatorChannel, createEvaluatorMailbox } from "./evaluator-channel.js";
export {
  JudgmentRuntimeError,
  evaluateNative,
  resolveJudgmentConfig,
  runReviewAdvice,
  type JudgmentCliResult,
  type JudgmentCliStatus,
  type JudgmentInvocation,
  type ResolvedJudgmentConfig,
  type EvaluatorChannel,
  type EvaluatorChannelResponse,
  type EvaluatorContext,
  type JudgmentResult,
  type RuntimeEffects,
} from "./runtime.js";
export { buildA05Request, canonicalJsonBytes, type CanonicalQuestion, type PreparedRequest } from "./review-advice.js";
export {
  assessShadowRun,
  buildDockerLaunchArgs,
  freezeBaseline,
  recordWorkUnitDisposition,
  runShadowSupervisor,
} from "./shadow-supervisor.js";
export type {
  ApprovedChild,
  ApprovedChildResult,
  BaselineFreezeInput,
  EvidenceClass,
  FrozenBaseline,
  FrozenShadowEvidence,
  ProbeEvent,
  ProbeLauncher,
  ShadowMountPlan,
  ShadowRunAssessment,
  ShadowRunInput,
  WorkUnitDispositionInput,
  WorkUnitReceipt,
} from "./shadow-supervisor.js";
export { allowedAuthorOutputs, authorSlotKeys, createOnlyAuthorSinkWrite, validateAuthorSinkRelativePath } from "./author-sink.js";
export {
  assertAuthorMountPlan,
  buildAuthorDockerLaunchArgs,
  provisionAuthorGateLayout,
  runAuthorPreDispatchGate,
  writeAuthorGateEvidence,
} from "./author-gate.js";
export type { AuthorGateInput, AuthorGateResult, AuthorMountPlan, DenyProbeRecord } from "./author-gate.js";
export { allowedAnnotationOutput, createOnlyAnnotationSinkWrite, validateAnnotationSinkRelativePath } from "./annotation-sink.js";
export type { AnnotationSeat } from "./annotation-sink.js";
export {
  assertAnnotationSeatMountPlan,
  buildAnnotationSeatDockerLaunchArgs,
  provisionAnnotationSeatGateLayout,
  runAnnotationSeatPreDispatchGate,
  writeAnnotationSeatGateEvidence,
} from "./annotation-seat-gate.js";
export type { AnnotationSeatGateInput, AnnotationSeatGateResult, AnnotationSeatMountPlan } from "./annotation-seat-gate.js";

export { classifyOutcome, clopperPearsonLower, summarizeQualification } from "./evaluation.js";
export type { EvaluationOutcome, GoldLabel, OutcomeReason, QualificationRow, QualificationSummary } from "./evaluation.js";
export { opaqueId128, runAnnotationProjection, runLeakCheck } from "./annotation-projection.js";
export type {
  AnnotationProjectionInput,
  AnnotationProjectionResult,
  CrosswalkEntry,
  LeakCheckDimension,
  LeakCheckReport,
  ProjectedGroup,
  ProjectedVariant,
} from "./annotation-projection.js";
