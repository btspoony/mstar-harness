import type { AgentAdapter, Target } from "../types";
import { opencodeAdapter } from "./opencode";

const adapters: Record<Target, AgentAdapter> = {
  opencode: opencodeAdapter,
};

export function getAdapter(target: Target) {
  const adapter = adapters[target];
  if (!adapter) throw new Error(`Unsupported target: ${target}`);
  return adapter;
}
