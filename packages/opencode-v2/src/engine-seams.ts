/** Lazy, cached access to engine APIs so optional/newer exports cannot make the
 * native plugin fail module linking. These seams intentionally expose only the
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

let validatorsPromise: Promise<CoordinationValidators | null> | undefined;
let directoryResolversPromise: Promise<DirectoryResolvers | null> | undefined;
let activeStoreApiPromise: Promise<ActiveStoreApi | null> | undefined;

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
