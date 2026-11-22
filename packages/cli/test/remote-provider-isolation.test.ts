/**
 * note: Provider isolation and the remote refusal matrix at the shipped boundary.
 *
 * Two independent proofs: a static walk of the remote modules' reachable
 * production imports and their owning manifests, and a runtime guard preloaded
 * into the BUILT CLI with `NODE_OPTIONS=--require`. The guard denies and records
 * net/HTTP(S)/TLS/WebSocket/fetch connections, reads of a host credential
 * sentinel outside the sandbox, and any subprocess other than Git; the inbound
 * MStar MCP server remains an allowed local surface and is pinned by its own
 * suites.
 *
 * Every refusal runs through the real CLI and the controlled host fixture: the
 * provider state lives in the test runner, each sandbox owns its workspace and
 * `HOME`, and only public JSON documents cross into the child.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import type { RunResult } from "./harness";
import {
  FIXTURE_ISSUE_ID,
  REMOTE_PROJECT,
  RemoteCollaborationFixture,
  boundedRun,
  parseSandboxCommand,
  type OutboxIntent,
  type OutboxPermit,
  type OutboxReceiptDocument,
  type RemoteSandbox,
  type SandboxCommand,
  type ScopeCheckDocument,
} from "./support/remote-collaboration-fixture";

const CLI_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(CLI_ROOT, "../..");
const GUARD = join(import.meta.dir, "support/remote-no-provider.cjs");
const REMOTE = ["store", "collaboration", "remote"] as const;
const SECOND_ISSUE_ID = "88888888-8888-4888-8888-888888888888";

/** note: The remote implementation plus the two bootstrap modules this plan changed. */
const REMOTE_ROOTS = [
  "packages/engine/src/collaboration-remote.ts",
  "packages/engine/src/collaboration-remote-read.ts",
  "packages/engine/src/collaboration-store.ts",
  "packages/engine/src/collaboration-operations.ts",
  "packages/engine/src/collaboration-identity.ts",
  "packages/engine/src/store-activation.ts",
  "packages/commands/src/families/store.ts",
  "packages/commands/src/families/store-remote-outbox.ts",
] as const;

const NETWORK_MODULES: Readonly<Record<string, true>> = {
  http: true, https: true, net: true, tls: true, dgram: true, http2: true,
  "node:http": true, "node:https": true, "node:net": true, "node:tls": true, "node:dgram": true, "node:http2": true,
};
const PROVIDER_MODULES = [
  /^@linear\//, /^linear-sdk/, /^@octokit\//, /^octokit$/, /^graphql$/, /^@modelcontextprotocol\/client/,
  /^@notionhq\//, /^@slack\//, /^googleapis$/, /^jira/, /^@atlassian\//, /^axios$/, /^undici$/,
  /^node-fetch$/, /^ws$/, /^socket\.io-client$/,
];

function forbiddenImport(specifier: string): boolean {
  return NETWORK_MODULES[specifier] === true || PROVIDER_MODULES.some((pattern) => pattern.test(specifier));
}

/** note: A declared workspace export: the sources the walk enters, or why it must not. */
type ExportSource = readonly string[] | "data" | "unresolved";

type WorkspacePackage = Readonly<{ sources: ReadonlyMap<string, ExportSource> }>;

/** note: A module-graph target: JavaScript, or TypeScript source. */
const CODE_TARGET = /\.(?:[cm]?[jt]sx?)$/;

/** note: A `types` target is a declaration, never the module the package executes. */
const DECLARATION_TARGET = /\.d\.[cm]?[jt]s$/;

/**
 * note: A bundle name a package's build script renames: `dist/<bundle>` is built from
 * `src/<source>`, so substituting `dist` for `src` cannot find it. A stale entry leaves the
 * target unresolved, which fails the walk instead of skipping the module.
 */
const BUILD_ENTRIES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  engine: { "dist/engine": "src/index" },
};

/**
 * note: Every module a conditional export can run, across `import`/`require`/`default` and nested
 * conditions. A `types` target is skipped: it names a declaration, not the executed module.
 */
function runtimeTargets(value: unknown): string[] {
  if (typeof value === "string") {
    return CODE_TARGET.test(value) && !DECLARATION_TARGET.test(value) ? [value] : [];
  }
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value)
    .filter(([condition]) => condition !== "types")
    .flatMap(([, target]) => runtimeTargets(target));
}

/**
 * note: The source file behind one build target. Packages compile `src/` into `dist/`, so the
 * target path — not the export key — names the source; an unmatched probe stays unresolved.
 */
function sourceFor(root: string, target: string): string | null {
  const base = target.replace(/^\.\//, "").replace(/(?:\.d)?\.[cm]?[jt]sx?$/, "");
  const parts = base.split("/");
  const renamed = BUILD_ENTRIES[basename(root)]?.[base];
  const probes = renamed === undefined ? [base] : [base, renamed];
  parts.forEach((part, index) => {
    if (part === "dist") probes.push([...parts.slice(0, index), "src", ...parts.slice(index + 1)].join("/"));
    // note: A declaration root above the package (`dist/<pkg>/src/…`) still ends in the source path.
    if (part === "src") probes.push(parts.slice(index).join("/"));
  });
  for (const probe of probes) {
    for (const candidate of [`${probe}.ts`, `${probe}.tsx`, `${probe}/index.ts`, `${probe}/index.tsx`]) {
      const file = join(root, candidate);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

/**
 * note: What one declared export resolves to. Every runtime target must resolve to a source, so a
 * declaration can never stand in for the module the package actually executes.
 */
function exportSource(root: string, target: unknown): ExportSource {
  const targets = runtimeTargets(target);
  // note: An export of only non-executable paths (a stylesheet, a document) has no module to walk.
  if (targets.length === 0) return "data";
  // note: A glob selects several modules and cannot map to one source.
  if (targets.some((value) => value.includes("*"))) return "unresolved";
  const sources: string[] = [];
  for (const value of targets) {
    const source = sourceFor(root, value);
    // invariant: An unresolved runtime target fails closed; it never falls back to a declaration
    // source the package does not run.
    if (source === null) return "unresolved";
    if (!sources.includes(source)) sources.push(source);
  }
  return sources;
}

/** note: Each workspace package's name and every declared export mapped to its source. */
function workspacePackages(packagesDir: string = join(REPO_ROOT, "packages")): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    const root = join(packagesDir, entry.name);
    const manifestPath = join(root, "package.json");
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown; main?: unknown; exports?: unknown };
    if (typeof manifest.name !== "string") continue;
    const declared =
      typeof manifest.exports === "string"
        ? { ".": manifest.exports }
        : manifest.exports !== null && typeof manifest.exports === "object"
          ? (manifest.exports as Record<string, unknown>)
          : {};
    const sources = new Map<string, ExportSource>();
    for (const [key, value] of Object.entries(declared)) {
      sources.set(key.replace(/^\.\/?/, ""), exportSource(root, value));
    }
    // note: Only a package without an `exports` map falls back to `main`; otherwise a bare import
    // of an undeclared root must fail the walk, as it would fail at runtime.
    if (Object.keys(declared).length === 0 && !sources.has("")) {
      sources.set("", exportSource(root, manifest.main ?? "./src/index.ts"));
    }
    packages.set(manifest.name, { sources });
  }
  return packages;
}

/** note: Resolve one production specifier to its sources: relative, or a workspace package export. */
function resolveProductionFile(
  specifier: string,
  fromFile: string,
  workspace: ReadonlyMap<string, WorkspacePackage>,
): readonly string[] {
  if (specifier.startsWith(".")) return [resolve(fromFile, "..", specifier.replace(/\.js$/, ".ts"))];
  for (const [name, pkg] of workspace) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const subpath = specifier === name ? "" : specifier.slice(name.length + 1);
    const source = pkg.sources.get(subpath);
    // invariant: An unresolved workspace import fails the walk; it is never silently skipped.
    if (source === undefined) throw new Error(`${fromFile} imports ${specifier}, which ${name} does not export`);
    if (source === "unresolved") throw new Error(`${fromFile} imports ${specifier}, whose source cannot be resolved`);
    return source === "data" ? [] : source;
  }
  return [];
}

/** note: Every reachable production file (absolute), following workspace packages across their boundary. */
function walkRemoteImports(
  roots: readonly string[] = REMOTE_ROOTS.map((path) => join(REPO_ROOT, path)),
  workspace: ReadonlyMap<string, WorkspacePackage> = workspacePackages(),
): Map<string, string> {
  const files = new Map<string, string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    const source = readFileSync(file, "utf8");
    files.set(file, source);
    for (const specifier of importSpecifiers(source)) {
      pending.push(...resolveProductionFile(specifier, file, workspace));
    }
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)(["'])([^"']+)\1/g)].map((match) => match[2]!);
}

/** note: Rule violations with their source line, so a failure names the exact regression. */
function offendingText(source: string): string[] {
  const findings: string[] = [];
  const at = (index: number): string => `line ${String(source.slice(0, index).split("\n").length)}`;
  for (const match of source.matchAll(/\bfetch\s*\(/g)) findings.push(`${at(match.index ?? 0)} outbound fetch`);
  for (const match of source.matchAll(/\bnew\s+WebSocket\b/g)) findings.push(`${at(match.index ?? 0)} outbound WebSocket`);
  for (const match of source.matchAll(/process\.env(?:\.([A-Za-z0-9_]+)|\[\s*["']([^"']+)["']\s*\])/g)) {
    const name = match[1] ?? match[2] ?? "";
    if (/(?:TOKEN|SECRET|API_?KEY|CREDENTIAL|PASSWORD|PRIVATE_KEY)/i.test(name)) {
      findings.push(`${at(match.index ?? 0)} provider credential lookup ${name}`);
    }
  }
  for (const match of source.matchAll(/(?:\.netrc|\.aws\/credentials|\.config\/gh\/hosts|credentials\.json)/g)) {
    findings.push(`${at(match.index ?? 0)} provider credential file`);
  }
  return findings;
}

function sandboxCacheFiles(home: string): string[] {
  const root = join(home, ".mstar");
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "collaboration.db") found.push(path);
    }
  };
  walk(root);
  return found;
}

type Guard = Readonly<{ log: string; sentinel: string }>;

function guardUnder(root: string): Guard {
  const sentinel = join(root, "host-credential.sentinel");
  writeFileSync(sentinel, "Bearer fixture-host-token\n");
  return { log: join(root, "provider-guard.log"), sentinel };
}

/** note: The one executable the runtime guard allows; any other `git` on PATH is foreign. */
function pinnedGit(): string {
  const git = Bun.which("git");
  if (git === null) throw new Error("the runtime provider guard needs a `git` binary");
  return realpathSync(git);
}

function guardEnvironment(sandbox: RemoteSandbox, guard: Guard, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...sandbox.environment,
    NODE_OPTIONS: `--require ${GUARD}`,
    MSTAR_NO_PROVIDER_LOG: guard.log,
    MSTAR_NO_PROVIDER_SENTINEL: guard.sentinel,
    MSTAR_NO_PROVIDER_GIT: pinnedGit(),
    ...overrides,
  };
}

/** note: The built CLI runs under node here; the guard is a CJS preload, not a Bun option. */
function guardedRun(sandbox: RemoteSandbox, guard: Guard, args: readonly string[]): RunResult {
  const node = Bun.which("node");
  if (node === null) throw new Error("the runtime provider guard needs a `node` binary for the built CLI");
  return boundedRun([node, sandbox.entry, ...args], { cwd: sandbox.repo, env: guardEnvironment(sandbox, guard) });
}

function guardedJson(sandbox: RemoteSandbox, guard: Guard, args: readonly string[]): SandboxCommand {
  return parseSandboxCommand(guardedRun(sandbox, guard, args));
}

function guardRecords(log: string): Array<{ kind: string; detail?: string }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { kind: string; detail?: string });
}

function assertGuardClean(guard: Guard): void {
  const records = guardRecords(guard.log);
  // note: Each guarded child appends its own load record; anything beyond that is an attempt.
  expect(records.length).toBeGreaterThan(0);
  expect(records.filter((record) => record.kind !== "loaded")).toEqual([]);
}

/**
 * note: A host-only credential must never reach the child environment, a host-submitted
 * document, a CLI answer DTO or a persisted cache/outbox row.
 */
function assertCredentialAbsent(
  credential: string,
  sandbox: RemoteSandbox,
  answers: readonly SandboxCommand[],
  guard: Guard,
): void {
  expect(JSON.stringify(sandbox.environment)).not.toContain(credential);
  expect(JSON.stringify(guardEnvironment(sandbox, guard))).not.toContain(credential);
  const documents = join(sandbox.dir, "host");
  for (const name of readdirSync(documents)) {
    expect(readFileSync(join(documents, name), "utf8")).not.toContain(credential);
  }
  for (const answer of answers) {
    expect(answer.result.stdout + answer.result.stderr).not.toContain(credential);
  }
  const caches = sandboxCacheFiles(sandbox.home);
  // invariant: The assertion is never vacuous: the cache and outbox rows were persisted.
  expect(caches).toHaveLength(1);
  for (const path of caches) expect(readFileSync(path, "utf8")).not.toContain(credential);
}

describe("provider isolation: the shipped remote path", () => {
  test("changed remote modules reach no provider client, credential lookup or outbound transport", () => {
    const files = walkRemoteImports();
    const forbiddenImports = [...files.entries()].flatMap(([file, source]) =>
      importSpecifiers(source)
        .filter(forbiddenImport)
        .map((specifier) => `${file.slice(REPO_ROOT.length + 1)} imports ${specifier}`),
    );
    expect(forbiddenImports).toEqual([]);

    const forbiddenText = [...files.entries()].flatMap(([file, source]) =>
      offendingText(source).map((finding) => `${file.slice(REPO_ROOT.length + 1)}: ${finding}`),
    );
    expect(forbiddenText).toEqual([]);

    for (const manifestPath of ["packages/engine/package.json", "packages/commands/package.json", "packages/cli/package.json"]) {
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, manifestPath), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      const runtime = Object.keys(manifest.dependencies ?? {});
      expect(runtime.filter(forbiddenImport)).toEqual([]);
    }

    // invariant: The inbound MStar MCP server is the legitimate local surface and stays in place.
    const cliManifest = JSON.parse(readFileSync(join(REPO_ROOT, "packages/cli/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(cliManifest.dependencies ?? {})).toContain("@modelcontextprotocol/server");
    const stdio = readFileSync(join(REPO_ROOT, "packages/cli/src/mcp/stdio.ts"), "utf8");
    expect(stdio).toContain('from "@modelcontextprotocol/server/stdio"');
    expect(stdio).not.toContain("@modelcontextprotocol/client");
  });

  test("the walk crosses a workspace package boundary and would reject a provider import behind it", () => {
    const files = walkRemoteImports();
    // invariant: The commands family imports the engine by package name; the walk must enter it.
    expect([...files.keys()]).toContain(join(REPO_ROOT, "packages/engine/src/index.ts"));
    // invariant: A declared non-root export resolves to its source instead of being dropped.
    expect(
      resolveProductionFile("@mstar-harness/engine/src/audit", join(REPO_ROOT, "packages/cli/src/index.ts"), workspacePackages()),
    ).toEqual([join(REPO_ROOT, "packages/engine/src/audit.ts")]);

    // note: Negative control - a provider SDK reached only through a non-root exported subpath is
    // still found, so the walk cannot silently drop a workspace export it fails to map.
    const root = mkdtempSync(join(tmpdir(), "mstar-static-boundary-"));
    try {
      const entry = join(root, "entry.ts");
      const pkg = join(root, "packages/synthetic");
      const aliased = join(pkg, "src/internal.ts");
      const conditional = join(pkg, "src/conditional.ts");
      const declaration = join(pkg, "src/decoy.ts");
      const splitRequire = join(pkg, "src/split-require.ts");
      mkdirSync(join(pkg, "src"), { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "@mstar-harness/synthetic",
          exports: {
            ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
            // invariant: The key names the API; the declared target names the source it walks.
            "./audit": { types: "./dist/internal.d.ts", default: "./dist/internal.js" },
            // invariant: A conditional code export without `default` is a module, not data.
            "./conditional": { import: "./dist/conditional.js" },
            // invariant: `types` and the runtime default name different sources; the walk enters
            // the runtime module, never the decoy declaration.
            "./aliased": { types: "./dist/decoy.d.ts", default: "./dist/internal.js" },
            // invariant: Every runtime condition is walked, not just the first one declared.
            "./split": { import: "./dist/split-import.js", require: "./dist/split-require.js" },
            // invariant: A resolvable declaration never masks an unresolved runtime target.
            "./declared-only": { types: "./dist/index.d.ts", default: "./dist/missing.js" },
            // invariant: A conditional code export with no source fails closed, not as data.
            "./broken": { import: "./dist/broken.js" },
          },
        }),
      );
      writeFileSync(entry, 'import { audit } from "@mstar-harness/synthetic/audit";\n');
      writeFileSync(join(pkg, "src/index.ts"), 'export { audit } from "./internal.js";\n');
      writeFileSync(join(pkg, "src/audit.ts"), 'export const audit = "decoy";\n');
      writeFileSync(aliased, 'import { LinearClient } from "@linear/sdk";\n');
      writeFileSync(conditional, 'import { LinearClient } from "@linear/sdk";\n');
      writeFileSync(declaration, 'export const decoy = "clean";\n');
      writeFileSync(join(pkg, "src/split-import.ts"), 'export const splitImport = "clean";\n');
      writeFileSync(splitRequire, 'import { LinearClient } from "@linear/sdk";\n');
      const walked = walkRemoteImports([entry], workspacePackages(join(root, "packages")));
      const forbidden = [...walked.entries()].flatMap(([file, source]) =>
        importSpecifiers(source)
          .filter(forbiddenImport)
          .map((specifier) => `${file} imports ${specifier}`),
      );
      expect(forbidden).toEqual([`${aliased} imports @linear/sdk`]);
      expect([...walked.keys()]).not.toContain(join(pkg, "src/audit.ts"));

      writeFileSync(entry, 'import { conditional } from "@mstar-harness/synthetic/conditional";\n');
      expect([...walkRemoteImports([entry], workspacePackages(join(root, "packages"))).keys()]).toContain(conditional);

      // invariant: A `types` declaration never substitutes for the runtime module; the differing
      // runtime target is walked and the decoy declaration is not scanned.
      writeFileSync(entry, 'import { audit } from "@mstar-harness/synthetic/aliased";\n');
      const differing = walkRemoteImports([entry], workspacePackages(join(root, "packages")));
      expect([...differing.keys()]).toContain(aliased);
      expect([...differing.keys()]).not.toContain(declaration);
      expect(importSpecifiers(differing.get(aliased) ?? "")).toContain("@linear/sdk");

      // invariant: Both runtime branches are walked, so neither `import` nor `require` hides one.
      writeFileSync(entry, 'import { split } from "@mstar-harness/synthetic/split";\n');
      expect([...walkRemoteImports([entry], workspacePackages(join(root, "packages"))).keys()]).toContain(splitRequire);

      // invariant: A resolvable declaration does not mask an unresolved runtime target.
      writeFileSync(entry, 'import { declared } from "@mstar-harness/synthetic/declared-only";\n');
      expect(() => walkRemoteImports([entry], workspacePackages(join(root, "packages")))).toThrow(/declared-only/);

      // invariant: An import outside the manifest's exports fails the walk instead of vanishing.
      writeFileSync(entry, 'import { audit } from "@mstar-harness/synthetic/src/private";\n');
      expect(() => walkRemoteImports([entry], workspacePackages(join(root, "packages")))).toThrow(/src\/private/);

      // invariant: A declared export whose source cannot be established fails the walk.
      writeFileSync(entry, 'import { broken } from "@mstar-harness/synthetic/broken";\n');
      expect(() => walkRemoteImports([entry], workspacePackages(join(root, "packages")))).toThrow(/broken/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the runtime guard refuses a network call, a sentinel read and a foreign spawn", () => {
    const root = mkdtempSync(join(tmpdir(), "mstar-provider-guard-"));
    const guard = guardUnder(root);
    const node = Bun.which("node");
    if (node === null) throw new Error("the runtime provider guard needs a `node` binary");
    const git = pinnedGit();
    const environment = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: root,
      TMPDIR: tmpdir(),
      TZ: "UTC",
      NODE_OPTIONS: `--require ${GUARD}`,
      MSTAR_NO_PROVIDER_LOG: guard.log,
      MSTAR_NO_PROVIDER_SENTINEL: guard.sentinel,
      MSTAR_NO_PROVIDER_GIT: git,
    };
    const attempt = (script: string, overrides: Record<string, string> = {}): number | null =>
      Bun.spawnSync([node, "-e", script], { env: { ...environment, ...overrides }, stdout: "pipe", stderr: "pipe" }).exitCode;
    const attemptModule = (script: string): number | null =>
      Bun.spawnSync([node, "--input-type=module", "-e", script], { env: environment, stdout: "pipe", stderr: "pipe" }).exitCode;

    try {
      expect(attempt('globalThis.fetch("https://example.test/linear")')).not.toBe(0);
      expect(attempt('require("node:net").connect(80, "127.0.0.1")')).not.toBe(0);
      expect(attempt('require("node:http").request("http://127.0.0.1:1/")')).not.toBe(0);
      expect(attempt('require("node:https").request("https://127.0.0.1:1/")')).not.toBe(0);
      expect(attempt('require("node:tls").connect(443, "127.0.0.1")')).not.toBe(0);
      expect(attempt('new WebSocket("wss://example.test/socket")')).not.toBe(0);
      expect(attempt(`require("node:fs").readFileSync(${JSON.stringify(guard.sentinel)})`)).not.toBe(0);
      // note: The sentinel is compared by canonical identity: a symlink to it, a `file:` URL and a
      // `..`-spelled path name the same file and are all refused.
      const sentinelLink = join(root, "host-credential.link");
      symlinkSync(guard.sentinel, sentinelLink);
      expect(attempt(`require("node:fs").readFileSync(${JSON.stringify(sentinelLink)})`)).not.toBe(0);
      expect(attempt(`require("node:fs").readFileSync(new URL("file://${guard.sentinel}"))`)).not.toBe(0);
      // invariant: Copying the sentinel discloses it just as reading it does, and the copy never lands.
      const copied = join(root, "copied-credential.txt");
      expect(
        attempt(`require("node:fs").copyFileSync(${JSON.stringify(guard.sentinel)}, ${JSON.stringify(copied)})`),
      ).not.toBe(0);
      expect(existsSync(copied)).toBe(false);
      expect(
        attempt(`require("node:fs").cpSync(${JSON.stringify(sentinelLink)}, ${JSON.stringify(join(root, "copied-tree.txt"))})`),
      ).not.toBe(0);
      // note: A recursive copy of the sentinel's own directory discloses it just the same.
      expect(
        attempt(`require("node:fs").cpSync(${JSON.stringify(root)}, ${JSON.stringify(join(root, "tree-copy"))})`),
      ).not.toBe(0);
      // note: A descriptor that already IS the sentinel (an inherited fd) is refused by identity;
      // this child's stdin is the credential file.
      const readv = Bun.spawnSync([node, "-e", "require(\"node:fs\").readvSync(0, [Buffer.alloc(8)])"], {
        env: environment,
        stdin: Bun.file(guard.sentinel),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(readv.exitCode).not.toBe(0);
      expect(attempt('require("node:child_process").execFileSync("sh", ["-c", "true"])')).not.toBe(0);
      // note: The one allowed subprocess is exactly the pinned Git executable, by path or by PATH.
      expect(attempt(`require("node:child_process").execFileSync(${JSON.stringify(git)}, ["--version"])`)).toBe(0);
      expect(attempt('require("node:child_process").execFileSync("git", ["--version"])')).toBe(0);

      // note: A same-named executable earlier on PATH is foreign even though its basename is `git`.
      const foreign = join(root, "git");
      const marker = join(root, "foreign-git-ran");
      writeFileSync(foreign, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`);
      chmodSync(foreign, 0o755);
      expect(
        attempt('require("node:child_process").execFileSync("git", ["--version"])', {
          PATH: `${root}:${environment.PATH}`,
        }),
      ).not.toBe(0);
      expect(existsSync(marker)).toBe(false);

      // note: The spawn options, not this process, decide the executable; an option-level PATH
      // must not pass the pin and then run the foreign `git` it points at.
      expect(
        attempt(
          `require("node:child_process").execFileSync("git", ["--version"], { env: { PATH: ${JSON.stringify(root)} } })`,
        ),
      ).not.toBe(0);
      expect(existsSync(marker)).toBe(false);

      // note: An empty PATH entry means the child's cwd, where the foreign `git` lives; skipping
      // it would approve the pinned Git from the later entry and then run the foreign one.
      expect(
        attempt(
          `require("node:child_process").execFileSync("git", ["--version"], { cwd: ${JSON.stringify(root)}, env: { PATH: ${JSON.stringify(`:${dirname(git)}`)} } })`,
        ),
      ).not.toBe(0);
      expect(existsSync(marker)).toBe(false);

      // note: A shell wrapper interprets the command itself, so it is refused even for pinned Git.
      expect(
        attempt(`require("node:child_process").execFileSync(${JSON.stringify(git)}, ["--version"], { shell: true })`),
      ).not.toBe(0);

      // note: A Node ESM child imports builtins by name; the same channels must deny it too.
      expect(attemptModule(`import { readFileSync } from "node:fs"; readFileSync(${JSON.stringify(guard.sentinel)});`)).not.toBe(0);
      expect(
        attemptModule('import { readFile } from "node:fs/promises"; await readFile(process.env.MSTAR_NO_PROVIDER_SENTINEL);'),
      ).not.toBe(0);
      expect(attemptModule('import { execFileSync } from "node:child_process"; execFileSync("sh", ["-c", "true"]);')).not.toBe(0);
      expect(
        attemptModule(`import { execFileSync } from "node:child_process"; execFileSync(${JSON.stringify(git)}, ["--version"]);`),
      ).toBe(0);

      const kinds = guardRecords(guard.log).map((record) => record.kind);
      expect(kinds).toContain("network:fetch");
      expect(kinds).toContain("network:net");
      expect(kinds).toContain("network:http");
      expect(kinds).toContain("network:https");
      expect(kinds).toContain("network:tls");
      expect(kinds).toContain("network:websocket");
      expect(kinds.filter((kind) => kind === "fs:credential-read")).toHaveLength(9);
      expect(kinds.filter((kind) => kind === "spawn")).toHaveLength(5);
      expect(kinds.filter((kind) => kind === "spawn:shell")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("provider isolation: the built CLI under the deny-and-record guard", () => {
  let fixture: RemoteCollaborationFixture | undefined;

  afterEach(() => {
    fixture?.dispose();
    fixture = undefined;
  });

  test("the bootstrap loop and one confirmed outbox effect run with zero provider attempts", () => {
    const credential = "fixture-host-credential-never-serialized";
    // invariant: The process-global credential is restored to its exact prior state, so a later
    // case in this worker never inherits or loses a caller-supplied key.
    const ambientCredential = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = credential;
    try {
      fixture = new RemoteCollaborationFixture("remote-provider-isolation");
      const published = fixture.publish(1);
      const sandbox = fixture.sandbox("guarded");
      const guard = guardUnder(sandbox.dir);
      const answers: SandboxCommand[] = [];
      const cli = (args: readonly string[]): SandboxCommand => {
        const answer = guardedJson(sandbox, guard, args);
        answers.push(answer);
        return answer;
      };
      const harness = sandbox.harness;

      const bound = cli([
        ...REMOTE, "bind", "--harness", harness,
        "--input", sandbox.writeJson("bind", {
          version: 1,
          selectorCommit: published.commit,
          generation: published.generation,
          checks: [fixture.verify()],
        }),
      ]);
      expect(bound.exitCode).toBe(0);
      expect(cli(["store", "init", "--harness", harness]).exitCode).toBe(0);
      const observed = cli([
        ...REMOTE, "observe", "--harness", harness,
        "--input", sandbox.writeJson("observe", fixture.observe(REMOTE_PROJECT, 0)),
      ]);
      expect(observed.exitCode).toBe(0);
      expect(cli(["issue", "list", "--harness", harness]).data.providerIssues).toHaveLength(1);

      const operation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const adopted = cli([
        ...REMOTE, "adopt-issue", "--harness", harness,
        "--project", REMOTE_PROJECT.localProjectId,
        "--issue", FIXTURE_ISSUE_ID,
        "--operation", operation,
        "--input", sandbox.writeJson("adopt", adoptionDocument(operation)),
      ]);
      expect(adopted.exitCode).toBe(0);
      expect(adopted.data.state).toBe("enqueued");

      const dispatched = cli([...REMOTE, "outbox-dispatch", "--harness", harness, "--operation", operation]);
      expect(dispatched.exitCode).toBe(0);
      const permit = dispatched.data.permit as unknown as OutboxPermit;
      const confirmed = fixture.send(permit);
      const recorded = cli([
        ...REMOTE, "outbox-receipt", "--harness", harness,
        "--input", sandbox.writeJson("receipt", confirmed),
      ]);
      expect(recorded.exitCode).toBe(0);
      expect(recorded.data.state).toBe("confirmed");

      const status = cli([...REMOTE, "status", "--harness", harness]);
      expect(status.data).toMatchObject({
        available: false,
        projects: [expect.objectContaining({ completeness: "unavailable", code: "remote.effect-confirmed" })],
      });
      // invariant: An invalidated cache answers no count at all, rather than a zero total.
      const listed = cli(["issue", "list", "--harness", harness]);
      expect(listed.exitCode).toBe(1);
      expect(listed.code).toBe("remote.unavailable");
      expect(listed.data.total).toBeUndefined();
      expect(fixture.providerCalls).toEqual([{ kind: "send", operationId: operation }]);
      // invariant: The host credential is present only in host state; it reaches no child or row.
      assertCredentialAbsent(credential, sandbox, answers, guard);
      assertGuardClean(guard);
    } finally {
      if (ambientCredential === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = ambientCredential;
    }
  }, 60_000);
});

describe("remote refusals at the CLI boundary", () => {
  let fixture: RemoteCollaborationFixture | undefined;

  afterEach(() => {
    fixture?.dispose();
    fixture = undefined;
  });

  test("wrong workspace, team and project never bind and never create a cache", () => {
    fixture = new RemoteCollaborationFixture("remote-scope-refusals");
    fixture.publish(1);
    const verify = fixture.verify();
    const attempts: ReadonlyArray<readonly [string, ScopeCheckDocument]> = [
      ["workspace", { ...verify, scope: { ...verify.scope, workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } }],
      ["team", { ...verify, scope: { ...verify.scope, teamId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } }],
      ["project", { ...verify, scope: { ...verify.scope, projectId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } }],
    ];
    for (const [dimension, check] of attempts) {
      const sandbox = fixture.sandbox(`mismatch-${dimension}`);
      const refused = sandbox.bind(check);
      expect(refused.exitCode).toBe(1);
      expect(refused.code).toBe("remote.scope-mismatch");
      expect(sandboxCacheFiles(sandbox.home)).toEqual([]);
      expect(sandbox.status().data.binding).toMatchObject({ state: "unbound" });
    }
    // invariant: The refusal refused only the foreign tuple; the exact tuple still binds.
    const exact = fixture.sandbox("mismatch-exact");
    expect(exact.bind(fixture.verify()).exitCode).toBe(0);
    expect(sandboxCacheFiles(exact.home)).toHaveLength(1);
  }, 30_000);

  test("each negative access check invalidates the addressed cache and issues no permit", () => {
    fixture = new RemoteCollaborationFixture("remote-negative-refusals");
    fixture.publish(1);
    const sandbox = fixture.sandbox("negative");
    const harness = sandbox.harness;
    let tick = Date.now() - 40_000;
    const nextAt = (): string => new Date((tick += 2_000)).toISOString();
    const positive = (): ScopeCheckDocument => ({ ...fixture!.verify(), checkedAt: nextAt() });
    const negative = (kind: "denied" | "revoked" | "scope-mismatch" | "unsafe-fidelity"): ScopeCheckDocument => ({
      ...fixture!.verify(),
      checkedAt: nextAt(),
      outcome: { kind },
    });
    const submission = (check: ScopeCheckDocument, expectRevision: number, withSnapshot: boolean) => {
      const base = fixture!.observe(REMOTE_PROJECT, expectRevision);
      return {
        ...base,
        check,
        snapshot: withSnapshot
          ? { ...(base.snapshot as Record<string, unknown>), asOf: new Date(Date.parse(check.checkedAt) - 5_000).toISOString() }
          : null,
      };
    };

    expect(sandbox.bind(positive()).exitCode).toBe(0);
    expect(sandbox.init().exitCode).toBe(0);
    const first = sandbox.observe(submission(positive(), 0, true));
    expect(first.exitCode).toBe(0);
    expect(first.data).toMatchObject({ revision: 1, completeness: "complete" });

    const operation = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const adopted = sandbox.runJson([
      ...REMOTE, "adopt-issue", "--harness", harness,
      "--project", REMOTE_PROJECT.localProjectId,
      "--issue", FIXTURE_ISSUE_ID,
      "--operation", operation,
      "--input", sandbox.writeJson("adopt", adoptionDocument(operation)),
    ]);
    expect(adopted.data.state).toBe("enqueued");

    let revision = 1;
    const refusals = [
      ["denied", "remote.denied"],
      ["revoked", "remote.revoked"],
      ["scope-mismatch", "remote.scope-mismatch"],
      ["unsafe-fidelity", "remote.unsafe-fidelity"],
    ] as const;
    for (const [kind, code] of refusals) {
      const refused = sandbox.observe(submission(negative(kind), revision, false));
      expect(refused.exitCode).toBe(1);
      expect(refused.code).toBe(code);
      revision += 1;

      const status = sandbox.status();
      expect(status.data.available).toBe(false);
      expect(status.data.projects).toEqual([
        expect.objectContaining({ revision, completeness: "unavailable", code }),
      ]);
      const listed = sandbox.runJson(["issue", "list", "--harness", harness]);
      expect(listed.exitCode).toBe(1);
      expect(listed.code).toBe("remote.unavailable");
      expect(listed.data.total).toBeUndefined();

      // invariant: No send permit and no gate/count success while the check is negative.
      const dispatched = sandbox.runJson([...REMOTE, "outbox-dispatch", "--harness", harness, "--operation", operation]);
      expect(dispatched.exitCode).toBe(1);
      expect(dispatched.code).toBe("remote.dispatch-refused");
      expect(dispatched.data.permit).toBeUndefined();

      const restored = sandbox.observe(submission(positive(), revision, true));
      expect(restored.exitCode).toBe(0);
      revision += 1;
      expect(restored.data).toMatchObject({ revision, completeness: "complete" });
      expect(sandbox.runJson(["issue", "list", "--harness", harness]).data.providerIssues).toHaveLength(1);
    }

    // invariant: A positive snapshot carrying a portable field the cache cannot keep refuses the
    // observation by name AND invalidates the addressed cache, so no reader keeps serving the
    // previous complete revision behind the refusal.
    const oversizeCheck = positive();
    const base = submission(oversizeCheck, revision, true);
    const snapshot = base.snapshot as Record<string, unknown>;
    const at = oversizeCheck.checkedAt;
    const marked = {
      identity: {
        provider: "linear",
        workspaceId: REMOTE_PROJECT.workspaceId,
        teamId: REMOTE_PROJECT.teamId,
        projectId: REMOTE_PROJECT.projectId,
        issueId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
      nativeTitle: "Oversize portable field",
      nativeStatus: "Todo",
      providerUpdatedAt: new Date(Date.parse(at) - 10_000).toISOString(),
      mstar: {
        issueRef: "mstar:issue:dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        head: ["2".repeat(64)],
        fields: {
          title: "Oversize portable field",
          kind: "bug",
          severity: "high",
          disposition: "open",
          impact: "A host field exceeds the portable representation.",
          acceptance: "The cache refuses the observation instead of dropping the field.",
          owner: null,
          registeredAt: null,
          closedAt: null,
          closureNote: null,
          createdAt: at,
          updatedAt: at,
          revision: 1,
          milestoneId: null,
        },
        occurrences: [],
        transitions: [],
        relations: [],
        projectMoves: [],
        provenance: [
          {
            eventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            kind: "plan",
            target: "plan-oversize",
            sourceHash: "3".repeat(64),
            origin: "scoped",
            legacyProject: null,
            legacyBucket: null,
            legacyEntryId: null,
            legacyRecord: { title: "x".repeat(600), lifecycle: "active" },
            importedAt: null,
          },
        ],
      },
    };
    const oversize = sandbox.observe({ ...base, snapshot: { ...snapshot, issues: [...(snapshot.issues as unknown[]), marked] } });
    expect(oversize.exitCode).toBe(1);
    expect(oversize.code).toBe("remote.unsafe-fidelity");
    revision += 1;
    const invalidated = sandbox.status();
    expect(invalidated.data.available).toBe(false);
    expect(invalidated.data.projects).toEqual([
      expect.objectContaining({ revision, completeness: "unavailable", code: "remote.unsafe-fidelity" }),
    ]);
    const blockedRead = sandbox.runJson(["issue", "list", "--harness", harness]);
    expect(blockedRead.exitCode).toBe(1);
    expect(blockedRead.code).toBe("remote.unavailable");
    expect(blockedRead.data.total).toBeUndefined();
    // invariant: The decoder-detected unsafe snapshot revokes the verified writer in the same
    // transaction as the invalidation, so the outbox discloses state only, without the frozen
    // event it cannot prove is faithful.
    const blockedShow = sandbox.runJson([...REMOTE, "outbox-show", "--harness", harness, "--operation", operation]);
    expect(blockedShow.exitCode).toBe(0);
    expect(blockedShow.data).toMatchObject({ state: "enqueued", disclosure: "metadata", event: null });
    const blockedDispatch = sandbox.runJson([...REMOTE, "outbox-dispatch", "--harness", harness, "--operation", operation]);
    expect(blockedDispatch.exitCode).toBe(1);
    expect(blockedDispatch.code).toBe("remote.dispatch-refused");
    expect(blockedDispatch.data.permit).toBeUndefined();
  }, 60_000);

  test("the outbox settles a pre-send refusal, a lost response and an ambiguous lookup without provider access", () => {
    fixture = new RemoteCollaborationFixture("remote-outbox-recovery");
    const published = fixture.publish(1);
    const sandbox = fixture.sandbox("outbox");
    const harness = sandbox.harness;
    const guard = guardUnder(sandbox.dir);
    const cli = (args: readonly string[]): SandboxCommand => guardedJson(sandbox, guard, args);
    const adopt = (operation: string, issueId: string): SandboxCommand =>
      cli([
        ...REMOTE, "adopt-issue", "--harness", harness,
        "--project", REMOTE_PROJECT.localProjectId,
        "--issue", issueId,
        "--operation", operation,
        "--input", sandbox.writeJson("adopt", adoptionDocument(operation)),
      ]);
    const dispatch = (operation: string): SandboxCommand =>
      cli([...REMOTE, "outbox-dispatch", "--harness", harness, "--operation", operation]);
    const show = (operation: string): SandboxCommand =>
      cli([...REMOTE, "outbox-show", "--harness", harness, "--operation", operation]);
    const receipt = (document: unknown): SandboxCommand =>
      cli([...REMOTE, "outbox-receipt", "--harness", harness, "--input", sandbox.writeJson("receipt", document)]);
    const reconcile = (document: unknown): SandboxCommand =>
      cli([...REMOTE, "outbox-reconcile", "--harness", harness, "--input", sandbox.writeJson("reconcile", document)]);

    expect(cli([
      ...REMOTE, "bind", "--harness", harness,
      "--input", sandbox.writeJson("bind", {
        version: 1,
        selectorCommit: published.commit,
        generation: published.generation,
        checks: [fixture.verify()],
      }),
    ]).exitCode).toBe(0);
    expect(cli(["store", "init", "--harness", harness]).exitCode).toBe(0);
    expect(cli([
      ...REMOTE, "observe", "--harness", harness,
      "--input", sandbox.writeJson("observe", fixture.observe(REMOTE_PROJECT, 0)),
    ]).exitCode).toBe(0);

    // note: Pre-send refusal - the host never calls send, and records its own not-sent proof.
    const refusedOperation = "11111111-1111-4111-8111-111111111111";
    expect(adopt(refusedOperation, FIXTURE_ISSUE_ID).data.state).toBe("enqueued");
    const refusedPermit = dispatch(refusedOperation);
    expect(refusedPermit.exitCode).toBe(0);
    const permitOne = refusedPermit.data.permit as unknown as OutboxPermit;
    const notSent: OutboxReceiptDocument = {
      version: 1,
      selectorCommit: published.commit,
      generation: published.generation,
      projectId: REMOTE_PROJECT.localProjectId,
      operationId: refusedOperation,
      attemptId: permitOne.attemptId,
      requestHash: permitOne.requestHash,
      observedAt: new Date().toISOString(),
      outcome: { kind: "not-sent", code: "host.pre-send-refusal" },
    };
    const recordedNotSent = receipt(notSent);
    expect(recordedNotSent.exitCode).toBe(0);
    expect(recordedNotSent.data.state).toBe("unconfirmed");
    const replay = dispatch(refusedOperation);
    expect(replay.exitCode).toBe(0);
    expect(replay.data).toMatchObject({ kind: "state", state: "unconfirmed" });
    expect(replay.data.permit).toBeUndefined();
    const abandoned = cli([
      ...REMOTE, "outbox-abandon", "--harness", harness,
      "--operation", refusedOperation,
      "--reason", "the host refused before sending",
    ]);
    expect(abandoned.exitCode).toBe(0);
    expect(abandoned.data.state).toBe("abandoned");
    expect(fixture.providerCalls).toEqual([]);

    // note: Lost response - the effect landed, the response did not, and only a unique
    // exact lookup may confirm it.
    const lostOperation = "22222222-2222-4222-8222-222222222222";
    expect(adopt(lostOperation, FIXTURE_ISSUE_ID).data.state).toBe("enqueued");
    const lostPermit = dispatch(lostOperation);
    expect(lostPermit.exitCode).toBe(0);
    const permitTwo = lostPermit.data.permit as unknown as OutboxPermit;
    const effect = fixture.send(permitTwo);
    const lostResponse: OutboxReceiptDocument = {
      ...effect,
      observedAt: new Date().toISOString(),
      outcome: { kind: "unconfirmed", reason: "no-response" },
    };
    const uncertain = receipt(lostResponse);
    expect(uncertain.exitCode).toBe(0);
    expect(uncertain.data.state).toBe("unconfirmed");
    expect(uncertain.data.confirmed).toBeNull();

    const disclosed = show(lostOperation);
    expect(disclosed.data.state).toBe("unconfirmed");
    const unique = fixture.lookup(disclosed.data as unknown as OutboxIntent);
    expect(unique.outcome).toMatchObject({ kind: "confirmed" });
    const reconciled = reconcile(unique);
    expect(reconciled.exitCode).toBe(0);
    expect(reconciled.data.state).toBe("confirmed");
    expect(cli([...REMOTE, "status", "--harness", harness]).data).toMatchObject({
      available: false,
      projects: [expect.objectContaining({ completeness: "unavailable", code: "remote.effect-confirmed" })],
    });
    expect(cli(["issue", "list", "--harness", harness]).code).toBe("remote.unavailable");

    // note: Ambiguity - a duplicate provider record is never a confirmation.
    const status = cli([...REMOTE, "status", "--harness", harness]);
    const revision = (status.data.projects as Array<Record<string, unknown>>)[0]!.revision as number;
    fixture.setIssues([
      { issueId: FIXTURE_ISSUE_ID, title: "Observed native issue", status: "Todo", updatedAt: "2026-11-20T00:00:00.000Z" },
      { issueId: SECOND_ISSUE_ID, title: "Second native issue", status: "Todo", updatedAt: "2026-11-20T00:00:00.000Z" },
    ]);
    expect(cli([
      ...REMOTE, "observe", "--harness", harness,
      "--input", sandbox.writeJson("observe", fixture.observe(REMOTE_PROJECT, revision)),
    ]).exitCode).toBe(0);

    const ambiguousOperation = "33333333-3333-4333-8333-333333333333";
    expect(adopt(ambiguousOperation, SECOND_ISSUE_ID).data.state).toBe("enqueued");
    const ambiguousPermit = dispatch(ambiguousOperation);
    expect(ambiguousPermit.exitCode).toBe(0);
    const permitThree = ambiguousPermit.data.permit as unknown as OutboxPermit;
    fixture.send(permitThree);
    fixture.send(permitThree);

    const ambiguousIntent = show(ambiguousOperation);
    const ambiguous = fixture.lookup(ambiguousIntent.data as unknown as OutboxIntent);
    expect(ambiguous.outcome).toMatchObject({ kind: "unconfirmed", reason: "ambiguous" });
    const unresolved = reconcile(ambiguous);
    expect(unresolved.exitCode).toBe(0);
    expect(unresolved.data.state).toBe("unconfirmed");
    expect(unresolved.data.confirmed).toBeNull();
    const blocked = dispatch(ambiguousOperation);
    expect(blocked.exitCode).toBe(0);
    expect(blocked.data).toMatchObject({ kind: "state", state: "unconfirmed" });
    expect(blocked.data.permit).toBeUndefined();

    // invariant: Every provider call was the TEST RUNNER's; the CLI made none.
    expect(fixture.providerCalls).toEqual([
      { kind: "send", operationId: lostOperation },
      { kind: "lookup", operationId: lostOperation },
      { kind: "send", operationId: ambiguousOperation },
      { kind: "send", operationId: ambiguousOperation },
      { kind: "lookup", operationId: ambiguousOperation },
    ]);
    assertGuardClean(guard);
  }, 60_000);
});

/** note: The strict adoption document the host submits; one durable intent, never a local write. */
function adoptionDocument(operation: string): unknown {
  const at = new Date().toISOString();
  return {
    version: 1,
    kind: "new",
    capture: {
      kind: "bug",
      severity: "high",
      impact: "Remote recovery is exercised at the shipped boundary.",
      acceptance: "The outbox settles the exact attempt or reports its true state.",
      sourceIdentity: `review:${operation}`,
      rootCauseKey: "remote.outbox.recovery",
      acceptanceKey: "remote.outbox.recovery.settled",
      occurrenceKey: `occurrence-${operation}`,
      sourceKind: "review",
      location: "remote-provider-isolation.test.ts",
      observedBehavior: "An uncertain attempt is reconciled under its original binding.",
      evidence: ["controlled host fixture"],
      discoveredAt: at,
    },
  };
}
