/** Lazy, cached access to engine APIs so optional/newer exports cannot make the
 * native plugin fail module linking. Coordination/store seams expose only the
 * ACTIVE execution-authority route; there is no pre-activation snapshot/file
 * fallback or retired register API in this package. */

import type * as Engine from "@mstar-harness/engine";

import { defaultStatusLogger } from "./log";

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
  | "caseFoldedDocKind"
  | "harnessDocKindOfTarget"
  | "isStoreAuthorityTarget"
  | "landedPathOf"
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
let dispatchGateApiPromise: Promise<EngineSeam<DispatchGateApi>> | undefined;
let writeGateApiPromise: Promise<EngineSeam<WriteGateApi>> | undefined;

/** Why a gate seam degraded: the dynamic import rejected, or the engine loaded
 * but does not export what this plugin build requires. The two need different
 * recoveries, so the gates name which one happened. */
export type EngineSeamFailure = "import-failed" | "exports-missing";
export type EngineSeam<T> = { api: T; failure?: undefined } | { api: null; failure: EngineSeamFailure };

/** A rejected import lives only in this process's promise cache, so it is
 * retried by a reload. A missing export is a version mismatch: the reinstall
 * has to land first, then a reload discards this cached result. */
export function engineSeamRefusal(failure: EngineSeamFailure, cause?: unknown): string {
  if (failure === "exports-missing") {
    return "The bundled engine loaded but does not export the gate exports this plugin build requires, so the installed plugin and engine do not match. Reinstall @mstar-harness/opencode-v2, which bundles the matching engine, then reload or restart the OpenCode host to discard this cached result; reloading before the reinstall reproduces the same mismatch. The engine is bundled with the plugin, not a runtime dependency.";
  }
  const reason = cause === undefined ? "the cause is in the host log" : cause instanceof Error ? cause.message : String(cause);
  return `The bundled engine failed to load (${reason}). Reload or restart the OpenCode host to retry the engine import: a failed load is cached for the process lifetime, so upgrading alone does not clear it. The engine is bundled with the plugin, not a runtime dependency.`;
}

const logLoadFailure = (seam: string, error: unknown): void => {
  defaultStatusLogger(
    "error",
    `${seam} unavailable: ${error instanceof Error ? error.message : String(error)}. Reload or restart the OpenCode host to retry the engine import; the failed load is cached for the process lifetime.`,
  );
};

/** A rejected engine import is cached as null for the process lifetime, so the
 * cause must be logged here or it is lost to the later refusal. The cache is
 * deliberately kept: clearing it would retry the import on every call. */
const loadFailure = (seam: string) => (error: unknown): null => {
  logLoadFailure(seam, error);
  return null;
};

const seamFailure = (seam: string) =>
  (error: unknown): { api: null; failure: "import-failed" } => {
    logLoadFailure(seam, error);
    return { api: null, failure: "import-failed" };
  };

const missingExports = (seam: string): { api: null; failure: "exports-missing" } => {
  defaultStatusLogger("warn", `${seam} unavailable: ${engineSeamRefusal("exports-missing")}`);
  return { api: null, failure: "exports-missing" };
};


export function loadCoordinationValidators(): Promise<CoordinationValidators | null> {
  validatorsPromise ??= import("@mstar-harness/engine").then((engine) => {
    if (typeof engine.validateStatus !== "function" || typeof engine.validateWorkflowSnapshot !== "function") return null;
    return {
      validateStatus: engine.validateStatus,
      validateWorkflowSnapshot: engine.validateWorkflowSnapshot,
    };
  }).catch(loadFailure("coordination validators"));
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
  }).catch(loadFailure("directory resolvers"));
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
  }).catch(loadFailure("ACTIVE store API"));
  return activeStoreApiPromise;
}
export function loadDispatchGateApi(): Promise<EngineSeam<DispatchGateApi>> {
  dispatchGateApiPromise ??= import("@mstar-harness/engine").then((engine) => {
    if (
      typeof engine.applyEnforcement !== "function" ||
      typeof engine.composeDispatchGate !== "function" ||
      typeof engine.isReadOnlyAssignmentRole !== "function" ||
      typeof engine.parseAssignmentFields !== "function" ||
      typeof engine.resolveHarnessDir !== "function" ||
      typeof engine.resolveRepoEnforcement !== "function"
    ) return missingExports("dispatch gate exports");
    return {
      api: {
        applyEnforcement: engine.applyEnforcement,
        composeDispatchGate: engine.composeDispatchGate,
        isReadOnlyAssignmentRole: engine.isReadOnlyAssignmentRole,
        parseAssignmentFields: engine.parseAssignmentFields,
        resolveHarnessDir: engine.resolveHarnessDir,
        resolveRepoEnforcement: engine.resolveRepoEnforcement,
      },
    };
  }).catch(seamFailure("dispatch gate exports"));
  return dispatchGateApiPromise;
}
export function loadWriteGateApi(): Promise<EngineSeam<WriteGateApi>> {
  writeGateApiPromise ??= import("@mstar-harness/engine").then((engine) => {
    if (
      typeof engine.applyEnforcement !== "function" ||
      typeof engine.caseFoldedDocKind !== "function" ||
      typeof engine.harnessDocKindOfTarget !== "function" ||
      typeof engine.isStoreAuthorityTarget !== "function" ||
      typeof engine.landedPathOf !== "function" ||
      typeof engine.queryIssueFlow !== "function" ||
      typeof engine.resolveExecutionReadRoute !== "function" ||
      typeof engine.resolveHarnessDir !== "function" ||
      typeof engine.resolveProjectDir !== "function" ||
      typeof engine.resolveRepoEnforcement !== "function" ||
      typeof engine.resolveWorkflowDir !== "function" ||
      typeof engine.validateStatusWriteDoc !== "function" ||
      typeof engine.withStoreRead !== "function"
    ) return missingExports("write gate exports");
    return {
      api: {
        applyEnforcement: engine.applyEnforcement,
        caseFoldedDocKind: engine.caseFoldedDocKind,
        harnessDocKindOfTarget: engine.harnessDocKindOfTarget,
        isStoreAuthorityTarget: engine.isStoreAuthorityTarget,
        landedPathOf: engine.landedPathOf,
        queryIssueFlow: engine.queryIssueFlow,
        resolveExecutionReadRoute: engine.resolveExecutionReadRoute,
        resolveHarnessDir: engine.resolveHarnessDir,
        resolveProjectDir: engine.resolveProjectDir,
        resolveRepoEnforcement: engine.resolveRepoEnforcement,
        resolveWorkflowDir: engine.resolveWorkflowDir,
        validateStatusWriteDoc: engine.validateStatusWriteDoc,
        withStoreRead: engine.withStoreRead,
      },
    };
  }).catch(seamFailure("write gate exports"));
  return writeGateApiPromise;
}
