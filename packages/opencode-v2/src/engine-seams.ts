/** Lazy, cached access to engine APIs so optional/newer exports cannot make the
 * native plugin fail module linking. Coordination/store seams expose only the
 * ACTIVE execution-authority route; there is no pre-activation snapshot/file
 * fallback or retired register API in this package. */

import type * as Engine from "@mstar-harness/engine";

type EngineModule = typeof Engine;
type CoordinationValidators = Pick<EngineModule, "validateStatus" | "validateWorkflowSnapshot">;
type DirectoryResolvers = Pick<EngineModule, "resolveHarnessDir" | "resolveWorkflowDir" | "resolveProjectDir">;
type ActiveStoreApi = Pick<
  EngineModule,
  | "detectStoreRuntime"
  | "assertStoreRuntimeSupported"
  | "openStore"
  | "readExecutionAuthority"
  | "readExecutionSource"
  | "resolveExecutionReadRoute"
>;
export type DispatchGateApi = Pick<
  EngineModule,
  | "applyEnforcement"
  | "composeDispatchGate"
  | "isReadOnlyAssignmentRole"
  | "parseAssignmentFields"
  | "resolveHarnessDir"
  | "resolveRepoEnforcement"
>;
export type WriteGateApi = Pick<
  EngineModule,
  | "applyEnforcement"
  | "harnessDocKindOfTarget"
  | "queryIssueFlow"
  | "resolveExecutionReadRoute"
  | "resolveHarnessDir"
  | "resolveProjectDir"
  | "resolveRepoEnforcement"
  | "resolveWorkflowDir"
  | "validateStatusWriteDoc"
  | "withStoreRead"
>;


let validatorsPromise: Promise<CoordinationValidators | null> | undefined;
let directoryResolversPromise: Promise<DirectoryResolvers | null> | undefined;
let activeStoreApiPromise: Promise<ActiveStoreApi | null> | undefined;
let dispatchGateApiPromise: Promise<DispatchGateApi | null> | undefined;
let writeGateApiPromise: Promise<WriteGateApi | null> | undefined;


export function loadCoordinationValidators(): Promise<CoordinationValidators | null> {
  validatorsPromise ??= import("@mstar-harness/engine").then((engine) => {
    if (typeof engine.validateStatus !== "function" || typeof engine.validateWorkflowSnapshot !== "function") return null;
    return {
      validateStatus: engine.validateStatus,
      validateWorkflowSnapshot: engine.validateWorkflowSnapshot,
    };
  }).catch(() => null);
  return validatorsPromise;
}

export function loadDirectoryResolvers(): Promise<DirectoryResolvers | null> {
  directoryResolversPromise ??= import("@mstar-harness/engine").then((engine) => {
    if (
      typeof engine.resolveHarnessDir !== "function" ||
      typeof engine.resolveWorkflowDir !== "function" ||
      typeof engine.resolveProjectDir !== "function"
    ) return null;
    return {
      resolveHarnessDir: engine.resolveHarnessDir,
      resolveWorkflowDir: engine.resolveWorkflowDir,
      resolveProjectDir: engine.resolveProjectDir,
    };
  }).catch(() => null);
  return directoryResolversPromise;
}

export function loadActiveStoreApi(): Promise<ActiveStoreApi | null> {
  activeStoreApiPromise ??= import("@mstar-harness/engine").then((engine) => {
    if (
      typeof engine.detectStoreRuntime !== "function" ||
      typeof engine.assertStoreRuntimeSupported !== "function" ||
      typeof engine.openStore !== "function" ||
      typeof engine.readExecutionAuthority !== "function" ||
      typeof engine.readExecutionSource !== "function" ||
      typeof engine.resolveExecutionReadRoute !== "function"
    ) return null;
    return {
      detectStoreRuntime: engine.detectStoreRuntime,
      assertStoreRuntimeSupported: engine.assertStoreRuntimeSupported,
      openStore: engine.openStore,
      readExecutionAuthority: engine.readExecutionAuthority,
      readExecutionSource: engine.readExecutionSource,
      resolveExecutionReadRoute: engine.resolveExecutionReadRoute,
    };
  }).catch(() => null);
  return activeStoreApiPromise;
}
export function loadDispatchGateApi(): Promise<DispatchGateApi | null> {
  dispatchGateApiPromise ??= import("@mstar-harness/engine").then((engine) => {
    if (
      typeof engine.applyEnforcement !== "function" ||
      typeof engine.composeDispatchGate !== "function" ||
      typeof engine.isReadOnlyAssignmentRole !== "function" ||
      typeof engine.parseAssignmentFields !== "function" ||
      typeof engine.resolveHarnessDir !== "function" ||
      typeof engine.resolveRepoEnforcement !== "function"
    ) return null;
    return {
      applyEnforcement: engine.applyEnforcement,
      composeDispatchGate: engine.composeDispatchGate,
      isReadOnlyAssignmentRole: engine.isReadOnlyAssignmentRole,
      parseAssignmentFields: engine.parseAssignmentFields,
      resolveHarnessDir: engine.resolveHarnessDir,
      resolveRepoEnforcement: engine.resolveRepoEnforcement,
    };
  }).catch(() => null);
  return dispatchGateApiPromise;
}
export function loadWriteGateApi(): Promise<WriteGateApi | null> {
  writeGateApiPromise ??= import("@mstar-harness/engine").then((engine) => {
    if (
      typeof engine.applyEnforcement !== "function" ||
      typeof engine.harnessDocKindOfTarget !== "function" ||
      typeof engine.queryIssueFlow !== "function" ||
      typeof engine.resolveExecutionReadRoute !== "function" ||
      typeof engine.resolveHarnessDir !== "function" ||
      typeof engine.resolveProjectDir !== "function" ||
      typeof engine.resolveRepoEnforcement !== "function" ||
      typeof engine.resolveWorkflowDir !== "function" ||
      typeof engine.validateStatusWriteDoc !== "function" ||
      typeof engine.withStoreRead !== "function"
    ) return null;
    return {
      applyEnforcement: engine.applyEnforcement,
      harnessDocKindOfTarget: engine.harnessDocKindOfTarget,
      queryIssueFlow: engine.queryIssueFlow,
      resolveExecutionReadRoute: engine.resolveExecutionReadRoute,
      resolveHarnessDir: engine.resolveHarnessDir,
      resolveProjectDir: engine.resolveProjectDir,
      resolveRepoEnforcement: engine.resolveRepoEnforcement,
      resolveWorkflowDir: engine.resolveWorkflowDir,
      validateStatusWriteDoc: engine.validateStatusWriteDoc,
      withStoreRead: engine.withStoreRead,
    };
  }).catch(() => null);
  return writeGateApiPromise;
}
