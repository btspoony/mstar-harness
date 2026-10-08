// scan-only corpus: consumed as text by lint-overdesign-backtest.test.ts; not compiled (outside tsconfig include)
import { refusalEnvelope } from "../../../../packages/engine/src/refusal";

export function restoreRefusal() {
  return refusalEnvelope({
    code: "execution.restore-unavailable",
    message: "Restore is unavailable.",
    recovery: "Run execution restore-preview.",
  });
}
