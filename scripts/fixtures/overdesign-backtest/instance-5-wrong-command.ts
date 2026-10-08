import { refusalEnvelope } from "../../../../packages/engine/src/refusal";

export function restoreRefusal() {
  return refusalEnvelope({
    code: "execution.restore-unavailable",
    message: "Restore is unavailable.",
    recovery: "Run execution restore-preview.",
  });
}
