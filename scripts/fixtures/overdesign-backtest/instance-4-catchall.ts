// scan-only corpus: consumed as text by lint-overdesign-backtest.test.ts; not compiled (outside tsconfig include)
import { refusalEnvelope } from "../../../../packages/engine/src/refusal";

export function upgradeBlocked() {
  return refusalEnvelope({
    code: "store.upgrade-blocked",
    message: "Upgrade blocked. Rerun the upgrade; it will refuse with the same catch-all.",
  });
}
