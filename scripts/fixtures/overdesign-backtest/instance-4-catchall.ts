import { refusalEnvelope } from "../../../../packages/engine/src/refusal";

export function upgradeBlocked() {
  return refusalEnvelope({
    code: "store.upgrade-blocked",
    message: "Upgrade blocked.",
  });
}
