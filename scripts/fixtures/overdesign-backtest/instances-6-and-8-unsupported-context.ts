// scan-only corpus: consumed as text by lint-overdesign-backtest.test.ts; not compiled (outside tsconfig include)
import { refusalEnvelope } from "../../../../packages/engine/src/refusal";

export function createOnlyBackupAsRestore() {
  return refusalEnvelope({ code: "restore.unavailable", message: "Unavailable", recovery: "Run store backup." });
}

export function abortRefusedWithSnapshot() {
  return refusalEnvelope({ code: "catalog.pending", message: "Pending", recovery: "Run catalog reconcile --abort." });
}
