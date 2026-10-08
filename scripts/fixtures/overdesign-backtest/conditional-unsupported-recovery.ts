// scan-only corpus: consumed as text by lint-overdesign-backtest.test.ts; not compiled (outside tsconfig include)
import { refusalEnvelope } from "../../../../packages/engine/src/refusal";

export function conditionalRecovery(flag: boolean) {
  return refusalEnvelope({
    code: "restore.unavailable",
    message: "Unavailable",
    ...(flag ? { recovery: "Run status validate." } : { recovery: "Run execution restore-preview." }),
  });
}
