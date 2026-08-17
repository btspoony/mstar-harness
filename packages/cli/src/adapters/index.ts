import type { AgentAdapter, Target } from "../types";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { dshAdapter } from "./dsh";
import { ompAdapter } from "./omp";
import { opencodeAdapter } from "./opencode";
import { zcodeAdapter } from "./zcode";

const adapters: Record<Target, AgentAdapter> = {
  opencode: opencodeAdapter,
  cursor: cursorAdapter,
  codex: codexAdapter,
  zcode: zcodeAdapter,
  omp: ompAdapter,
  dsh: dshAdapter,
};

export function getAdapter(target: Target) {
  const adapter = adapters[target];
  if (!adapter) throw new Error(`Unsupported target: ${target}`);
  return adapter;
}
