// scan-only corpus: consumed as text by lint-overdesign-backtest.test.ts; not compiled (outside tsconfig include)
import { refusalEnvelope } from "../../../../packages/engine/src/refusal";

const recovery = "Run execution restore-preview.";
export function shorthandRecovery() {
  return refusalEnvelope({ code: "restore.unavailable", message: "Unavailable", recovery });
}
