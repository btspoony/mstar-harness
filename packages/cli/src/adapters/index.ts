import type { AgentAdapter, Target } from "../types";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { kimiAdapter } from "./kimi";
import { opencodeAdapter } from "./opencode";

const adapters: Record<Target, AgentAdapter> = {
  opencode: opencodeAdapter,
  cursor: cursorAdapter,
  codex: codexAdapter,
  kimi: kimiAdapter,
};

export function getAdapter(target: Target) {
  const adapter = adapters[target];
  if (!adapter) throw new Error(`Unsupported target: ${target}`);
  return adapter;
}
