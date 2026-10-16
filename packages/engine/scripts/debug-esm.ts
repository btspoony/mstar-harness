/**
 * ESM stand-in for the CommonJS `debug@4` package.
 *
 * Why this file exists: `micromark` (reached from `mdast-util-from-markdown` /
 * `micromark-extension-gfm`) imports `debug` in its `development` export
 * condition, and it is the ONLY CommonJS package in the engine's bundle graph.
 * `bun build --target node` wraps it in `__commonJS(…)` and emits the
 * `createRequire(import.meta.url)` interop banner, whose eager
 * `require("tty")`/`require("util")` throws at module initialization wherever
 * `import.meta.url` is undefined (workerd) — see issue #491. The engine build
 * resolves `debug` to this module so no CommonJS node is left to wrap.
 *
 * Scope: this is NOT a reimplementation of `debug`. The engine never enables
 * debug output, so every instance is an inert callable reporting `enabled:
 * false`; only the member surface micromark touches has to exist.
 */

export interface EngineDebugger {
  (formatter: unknown, ...args: unknown[]): void;
  enabled: boolean;
  namespace: string;
  extend: (namespace: string, delimiter?: string) => EngineDebugger;
  destroy: () => boolean;
  diff: number;
  color: string | undefined;
}

export default function createDebug(namespace: string): EngineDebugger {
  const debug = (() => undefined) as unknown as EngineDebugger;
  debug.enabled = false;
  debug.namespace = namespace;
  debug.extend = (child: string) => createDebug(`${namespace}:${child}`);
  debug.destroy = () => true;
  debug.diff = 0;
  debug.color = undefined;
  return debug;
}
