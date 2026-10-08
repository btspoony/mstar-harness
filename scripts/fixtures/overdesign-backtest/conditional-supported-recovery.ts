import { refusalEnvelope } from "../../../../packages/engine/src/refusal";

export function conditionalRecovery(flag: boolean) {
  return refusalEnvelope({
    code: "restore.unavailable",
    message: "Unavailable",
    ...(flag ? { recovery: "Run status validate." } : {}),
  });
}
