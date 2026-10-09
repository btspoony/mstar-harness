// scan-only corpus: consumed as text by lint-overdesign-backtest.test.ts; not compiled (outside tsconfig include)
import { refusalEnvelope } from "../../../../packages/engine/src/refusal";

export function reachableRefusal() {
  return refusalEnvelope({
    code: "execution.not-ready",
    message: "Execution is not ready.",
    recovery: "Run status validate.",
  });
}

export function validUsageEnvelope() {
  return refusalEnvelope({ status: "usage", code: "command.usage", message: "Usage: status validate" });
}

export const provenance = { assignmentSha256: sha256(assignmentBytes) };
