import { refusalEnvelope } from "../../../../packages/engine/src/refusal";

export function reachableRefusal() {
  return refusalEnvelope({
    code: "execution.not-ready",
    message: "Execution is not ready.",
    recovery: "Run status validate.",
  });
}

export function validUsageEnvelope() {
  return { kind: "usage", message: "Usage: status validate" };
}

export const provenance = { assignmentSha256: sha256(assignmentBytes) };
