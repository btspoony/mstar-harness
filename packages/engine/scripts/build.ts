/**
 * Engine dist build — `bun run --cwd packages/engine build`.
 *
 * Two things a plain `bun build --target node` invocation cannot do:
 *
 * 1. **Resolve `debug` to an ESM module** (`./debug-esm.ts`). `debug@4` is the
 *    only CommonJS package in the graph — `micromark` imports it under its
 *    `development` export condition — and bundling it makes `bun build` emit the
 *    `createRequire(import.meta.url)` interop banner plus `__commonJS(…)`
 *    wrappers whose eager `require("tty")`/`require("util")` run while the
 *    module graph initializes, throwing wherever `import.meta.url` is undefined
 *    (workerd) — issue #491. Bun 1.4.0 has no `alias` option, so a resolver
 *    plugin is the available mechanism; `--external debug` and `--production`
 *    were measured and rejected (see `./debug-esm.ts`).
 * 2. **Assert the shipped-artifact invariant** after the bundles are written, so
 *    a reintroduced interop shim fails the build instead of shipping. The
 *    artifacts are gitignored and every CI consumer builds them first, so an
 *    absent artifact is a failure here — never a silent skip.
 *
 * The invariant is about the artifact at initialization, not about source
 * style: the engine legitimately acquires `node:sqlite` through a *lazy,
 * function-scoped* `createRequire(import.meta.url)("node:sqlite")` on Node. So
 * the guard rejects a `createRequire(import.meta.url)` that is **not
 * immediately invoked**: the banner's `var __require = createRequire(…)` and a
 * module-scope binding both evaluate at initialization, and `bun build` hoists
 * a module-scope binding into an `__esm(...)` init body at indentation — so a
 * column-0 line scan passes a dist that still throws at Worker startup.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_ROOT = join(import.meta.dir, "..");
const DIST = join(PACKAGE_ROOT, "dist");

const ENTRIES: Array<{ entrypoint: string; name: string }> = [
  { entrypoint: "src/index.ts", name: "engine.js" },
  { entrypoint: "src/audit.ts", name: "audit.js" },
];

/** Resolve `debug` (the graph's only CommonJS node) to the engine's ESM module. */
const engineDebugPlugin: Bun.BunPlugin = {
  name: "engine-debug-esm",
  setup(build) {
    build.onResolve({ filter: /^debug$/ }, () => ({ path: join(PACKAGE_ROOT, "scripts/debug-esm.ts") }));
  },
};

for (const { entrypoint, name } of ENTRIES) {
  const result = await Bun.build({
    entrypoints: [join(PACKAGE_ROOT, entrypoint)],
    target: "node",
    outdir: DIST,
    naming: { entry: name },
    plugins: [engineDebugPlugin],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  console.log(`  ${name}  ${(result.outputs[0].size / 1024).toFixed(2)} KB`);
}

/** Failures of the interop-free invariant, each with its measured count. */
const violations: string[] = [];
for (const { name } of ENTRIES) {
  const artifact = join(DIST, name);
  if (!existsSync(artifact)) {
    violations.push(`${name}: missing (the build must produce it)`);
    continue;
  }
  const lines = readFileSync(artifact, "utf8").split("\n");
  for (const token of ["__require(", "__commonJS("]) {
    const count = lines.filter((line) => line.includes(token)).length;
    if (count > 0) violations.push(`${name}: ${count}x ${token}`);
  }
  // A `createRequire(import.meta.url)` not immediately invoked is evaluated at
  // module initialization instead of lazily — the interop banner's own shape.
  // The identifier may be bundler-aliased (`createRequire2`), so match the call.
  const initTime = lines.filter((line) => /createRequire\w*\(import\.meta\.url\)\s*(?!\()/.test(line)).length;
  if (initTime > 0) violations.push(`${name}: ${initTime}x init-time createRequire(import.meta.url)`);
}

if (violations.length > 0) {
  console.error(`dist-interop invariant violated:\n${violations.map((v) => `  - ${v}`).join("\n")}`);
  console.error(
    "The engine dist must carry no CJS interop: a CommonJS package left in the graph emits " +
      "createRequire(import.meta.url) plus __commonJS wrappers, and a literal dynamic import of a " +
      "node: builtin emits the same banner (issue #491).",
  );
  process.exit(1);
}
