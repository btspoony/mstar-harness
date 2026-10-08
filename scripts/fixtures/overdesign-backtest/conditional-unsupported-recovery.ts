import { refusalEnvelope } from "../../../../packages/engine/src/refusal";

export function conditionalRecovery(flag: boolean) {
  return refusalEnvelope({
    code: "restore.unavailable",
    message: "Unavailable",
    ...(flag ? { recovery: "Run execution restore-preview." } : { recovery: "Run execution restore-preview." }),
  });
}
