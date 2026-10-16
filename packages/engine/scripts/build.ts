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
 * the guard checks that property instead of any call shape — it imports a
 * scratch copy of each artifact with every `import.meta.url` forced to
 * `undefined` (what the artifact sees under workerd, where the property is not
 * defined) and fails on any throw. A deferred function-scoped acquisition never
 * runs there; the banner's `var __require = createRequire(…)`, a module-scope
 * binding, and a module-scope *immediately invoked* acquisition all do,
 * whatever they look like, and `bun build` may hoist a module-scope binding
 * into an indented `__esm(...)` init body where a column-0 line scan would not
 * see it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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

/** Failures of the interop-free invariant, each with its measurement. */
const violations: string[] = [];
/** Scratch dir for the probe copies; never inside `dist/`, removed either way. */
const probeDir = mkdtempSync(join(tmpdir(), "mstar-engine-dist-probe-"));
try {
  /** `[artifact name, scratch copy path]` for every artifact that built. */
  const probes: Array<[string, string]> = [];
  for (const { name } of ENTRIES) {
    const artifact = join(DIST, name);
    if (!existsSync(artifact)) {
      violations.push(`${name}: missing (the build must produce it)`);
      continue;
    }
    const source = readFileSync(artifact, "utf8");
    for (const token of ["__require(", "__commonJS("]) {
      const count = source.split("\n").filter((line) => line.includes(token)).length;
      if (count > 0) violations.push(`${name}: ${count}x ${token}`);
    }
    // The invariant is a property of initialization, not of call shape: force
    // every `import.meta.url` to `undefined` (what a runtime without it sees)
    // in a scratch copy. All copies are written before the first import — bun's
    // resolver does not reliably see a sibling written into the probe dir
    // afterwards, reporting a false resolution failure.
    const probe = join(probeDir, name);
    writeFileSync(probe, source.replaceAll("import.meta.url", "undefined"));
    probes.push([name, probe]);
  }
  for (const [name, probe] of probes) {
    // Whatever the artifact evaluates at initialization throws here: the
    // interop banner, a module-scope binding, and a module-scope *immediately
    // invoked* acquisition alike. A deferred, function-scoped acquisition
    // never runs during import and stays permitted. The specifier is a runtime
    // scratch path, so this cannot be a static import.
    try {
      const probeModule: object = await import(pathToFileURL(probe).href);
      console.log(`  ${name}  probe ok: imports without import.meta.url, ${Object.keys(probeModule).length} exports`);
    } catch (error) {
      violations.push(
        `${name}: throws at initialization without import.meta.url — ` +
          `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      );
    }
  }
} finally {
  rmSync(probeDir, { recursive: true, force: true });
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
