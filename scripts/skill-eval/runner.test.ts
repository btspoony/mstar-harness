/**
 * scripts/skill-eval/runner.test.ts — runner contract.
 *
 * scope: `prepare` behavior of scripts/skill-eval/manifest.ts.
 * Run the prepare suite with:
 * bun test scripts/skill-eval/runner.test.ts --test-name-pattern prepare
 *
 * scope (same file): runner argv builders/guards, the synthetic-event
 * parser, the resumable scheduler (rerun idempotence, interrupted-run resume,
 * denominator retention), grading honesty (unverified stays unverified) and
 * the report stage. The full suite runs with:
 * bun test scripts/skill-eval/runner.test.ts
 *
 * All prepare tests use in-memory IO + in-memory source trees, so the tested
 * prepare path performs zero subprocesses (a spy on the single exec seam
 * fails loudly if anything is ever spawned — model calls included). The git
 * argv parsing tests at the bottom use a fake exec and are named so they do
 * NOT match the `prepare` filter (they still run in the full-suite Task 2
 * verification).
 *
 * SYNTHETIC TAG: every Task 2 model-facing test drives a clearly tagged
 * synthetic adapter (fake spawn, scripted events.jsonl / final.md). They
 * prove parser/scheduler/report correctness only — never behavioral success
 * of a real model (Spec A1 runner/efficacy gate separation). The only test
 * spawning a real process targets defaultLaunchFn's timeout/exit plumbing
 * with /bin/sleep and is named accordingly.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  canonicalRunId,
  canonicalJson,
  DEV_CASES_PER_ROUTE,
  HELDOUT_CASES_PER_ROUTE,
  makeGitSourceTreeReader,
  MANIFEST_SCHEMA_VERSION,
  prepareManifest,
  ROUTES,
  sha256Hex,
  SMOKE_CASE_COUNT,
  TOTAL_CASES,
  TOTAL_DEV_CASES,
  TOTAL_HELDOUT_CASES,
  validateResolvedManifest,
  validateRunSplit,
  type CaseSplit,
  type EvalManifest,
  type ExecArgv,
  type Io,
  type PrepareConfigInput,
  type SourceTree,
} from "./manifest.ts";
import {
  accountUnitInvocations,
  assertResumeAllowed,
  buildFirstTurnArgv,
  buildResumeArgv,
  defaultLaunchFn,
  findToolReadRecord,
  parseEventLines,
  recordedTurn1Identity,
  rejectForbiddenFlags,
  ResumeRejectionError,
  executeManifest,
  scanEventRecords,
  scheduleOrder,
  scanEventStream,
  type RunnerIo,
  type SchedulerState,
  type SpawnFn,
  type SpawnRequest,
} from "./runner.ts";
import { buildReport } from "./report.ts";

// ---------------------------------------------------------------------------
// Fixtures: in-memory IO, pinned trees, config
// ---------------------------------------------------------------------------

const BASELINE_SHA = "a".repeat(40);
const CANDIDATE_SHA = "b".repeat(40);
const REPO_ROOT = "/repo";
const FIXTURE_ROOT = `${REPO_ROOT}/.tmp/skill-eval`;
const OUT_DIR = `${FIXTURE_ROOT}/runs/run-1`;

const baselineTree: SourceTree = {
  "skills/demo/SKILL.md": sha256Of("baseline demo skill"),
  "skills/demo/refs/a.md": sha256Of("baseline ref a"),
};
const candidateTree: SourceTree = {
  "skills/demo/SKILL.md": sha256Of("candidate demo skill"),
  "skills/demo/refs/a.md": sha256Of("candidate ref a"),
};

function sha256Of(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const memReader = async (sourceRef: string): Promise<SourceTree> => {
  if (sourceRef === BASELINE_SHA) return baselineTree;
  if (sourceRef === CANDIDATE_SHA) return candidateTree;
  throw new Error(`unknown source ref under test: ${sourceRef}`);
};

const testConfig: PrepareConfigInput = {
  plan: "20260907-skill-eval-baseline",
  sourceRefs: { baseline: BASELINE_SHA, candidate: CANDIDATE_SHA },
  cli: { path: "/opt/homebrew/bin/codex", version: "codex-cli 0.144.1", helpHash: sha256Of("help") },
  requestedModel: null,
  requestedModelReason: "user did not authorize a named-model override; fixed CLI/config only",
  observedModel: null,
  observedModelReason: "unverified until real smoke (Spec A1)",
  ambient: { status: "engine-advisory", evidence: "fixture AGENTS.md files declare advisory mode" },
  sandbox: "read-only",
  timeoutMs: 600000,
  repeats: 1,
  interleaveSeed: 20260907,
};

const CASES_TEXT = readFileSync(resolve(import.meta.dir, "cases.json"), "utf8");

function memoryIo(symlinks: Record<string, string> = {}): {
  io: Io;
  files: Map<string, string>;
  writes: string[];
} {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const writes: string[] = [];
  const ensureAncestors = (p: string) => {
    let cur = resolve(p);
    for (;;) {
      dirs.add(cur);
      const parent = resolve(cur, "..");
      if (parent === cur) break;
      cur = parent;
    }
  };
 // A symlink cannot exist without its parent chain: register the ancestors
 // so containment checks see the same preconditions a real filesystem has.
  for (const source of Object.keys(symlinks)) ensureAncestors(resolve(source, ".."));
  const io: Io = {
    readText: (p) => {
      const v = files.get(resolve(p));
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeText: (p, content) => {
      ensureAncestors(resolve(p, ".."));
      files.set(resolve(p), content);
      writes.push(resolve(p));
    },
    ensureDir: (p) => {
      ensureAncestors(p);
    },
    exists: (p) =>
      files.has(resolve(p)) || dirs.has(resolve(p)) || symlinks[resolve(p)] !== undefined,
    realpath: (p) => {
      let r = resolve(p);
      for (let i = 0; i < 16; i += 1) {
        const target = symlinks[r];
        if (!target) break;
        r = resolve(target);
      }
      return r;
    },
  };
  return { io, files, writes };
}

/** Spy on the ONLY subprocess seam: any call is recorded and fails loudly. */
function makeSubprocessSpy(): { exec: ExecArgv; readonly calls: number } {
  const state = { calls: 0 };
  const exec: ExecArgv = async (file, args) => {
    state.calls += 1;
    throw new Error(`subprocess attempted during prepare test: ${file} ${args.join(" ")}`);
  };
  return {
    exec,
    get calls() {
      return state.calls;
    },
  };
}

function setupMemory(): ReturnType<typeof memoryIo> {
  const mem = memoryIo();
  mem.files.set(resolve("/cfg/config.json"), JSON.stringify(testConfig));
  mem.files.set(resolve("/cfg/cases.json"), CASES_TEXT);
  return mem;
}

function prepareArgs(mem: ReturnType<typeof memoryIo>, spy: { exec: ExecArgv }, overrides: Record<string, unknown> = {}) {
  return {
    configPath: "/cfg/config.json",
    casesPath: "/cfg/cases.json",
    outDir: OUT_DIR,
    repoRoot: REPO_ROOT,
    io: mem.io,
    readSourceTree: memReader,
    exec: spy.exec,
    ...overrides,
  } as Parameters<typeof prepareManifest>[0];
}

function readManifestFile(mem: ReturnType<typeof memoryIo>): EvalManifest {
  return JSON.parse(mem.files.get(resolve(OUT_DIR, "manifest.json"))!) as EvalManifest;
}

function mutatedCasesText(mutator: (cases: (Record<string, unknown> & { fixture: { files: unknown[] } })[]) => void): string {
  const parsed = JSON.parse(CASES_TEXT) as { cases: (Record<string, unknown> & { fixture: { files: unknown[] } })[] };
  mutator(parsed.cases);
  return JSON.stringify(parsed);
}

// ---------------------------------------------------------------------------
// prepare suite (matched by --test-name-pattern prepare)
// ---------------------------------------------------------------------------

describe("prepare — frozen baseline manifest (Task 1)", () => {
  test("prepare accepts the frozen 30-case set: exit 0, dev20/heldout10, per-route dev4/heldout2, exactly 3 smoke dev cases", async () => {
    const mem = setupMemory();
    const spy = makeSubprocessSpy();
    const result = await prepareManifest(prepareArgs(mem, spy));

    expect(result.exit).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.manifest).toBeDefined();

    const manifest = result.manifest!;
    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
    expect(manifest.cases.length).toBe(TOTAL_CASES);
    expect(manifest.cases.length).toBe(30);
    const dev = manifest.cases.filter((c) => c.split === "dev");
    const heldout = manifest.cases.filter((c) => c.split === "heldout");
    expect(dev.length).toBe(TOTAL_DEV_CASES);
    expect(heldout.length).toBe(TOTAL_HELDOUT_CASES);
    expect(dev.length).toBe(20);
    expect(heldout.length).toBe(10);

    for (const route of ROUTES) {
      const bucket = manifest.cases.filter((c) => c.route === route);
      expect(bucket.filter((c) => c.split === "dev").length).toBe(DEV_CASES_PER_ROUTE);
      expect(bucket.filter((c) => c.split === "heldout").length).toBe(HELDOUT_CASES_PER_ROUTE);
      expect(bucket.length).toBe(DEV_CASES_PER_ROUTE + HELDOUT_CASES_PER_ROUTE);
    }

    const smoke = manifest.cases.filter((c) => c.provenance.smoke === true);
    expect(smoke.length).toBe(SMOKE_CASE_COUNT);
    expect(smoke.every((c) => c.split === "dev")).toBe(true);
    const smokeTags = smoke.flatMap((c) => c.provenance.coverage).filter((t) => t.startsWith("smoke-"));
    expect(new Set(smokeTags).size).toBe(3);

    expect(manifest.variants.map((v) => v.id)).toEqual(["baseline", "candidate", "minimal"]);
    expect(manifest.variants[0].closure.length).toBeGreaterThan(0);
    expect(manifest.variants[2].closure.length).toBe(0);
  });

  test("prepare writes manifest + fixtures only inside the disposable fixture root", async () => {
    const mem = setupMemory();
    const spy = makeSubprocessSpy();
    const result = await prepareManifest(prepareArgs(mem, spy));

    expect(result.exit).toBe(0);
    expect(mem.writes.length).toBeGreaterThan(0);
    for (const path of mem.writes) {
      expect(path.startsWith(`${FIXTURE_ROOT}/`)).toBe(true);
    }
    const manifest = readManifestFile(mem);
    expect(manifest.cases.length).toBe(30);
 // Every case fixture materialized under <out>/fixtures/<caseId>/...
    for (const c of manifest.cases) {
      for (const f of c.fixture.files) {
        expect(mem.files.has(resolve(OUT_DIR, "fixtures", c.id, f.path))).toBe(true);
      }
    }
  });

  test("prepare performs zero subprocess/model calls (subprocess spy count = 0)", async () => {
    const mem = setupMemory();
    const spy = makeSubprocessSpy();
    const result = await prepareManifest(prepareArgs(mem, spy));
    expect(result.exit).toBe(0);
    expect(spy.calls).toBe(0);
  });

  test("prepare is deterministic: identical inputs yield byte-identical manifests", async () => {
    const memA = setupMemory();
    const memB = setupMemory();
    const spy = makeSubprocessSpy();
    const a = await prepareManifest(prepareArgs(memA, spy));
    const b = await prepareManifest(prepareArgs(memB, spy));
    expect(a.exit).toBe(0);
    expect(b.exit).toBe(0);
    expect(JSON.stringify(a.manifest)).toBe(JSON.stringify(b.manifest));
    expect(memA.files.get(resolve(OUT_DIR, "manifest.json"))).toBe(
      memB.files.get(resolve(OUT_DIR, "manifest.json")),
    );
    expect(a.manifest!.heldoutDigest).toBe(b.manifest!.heldoutDigest);
  });

  test("prepare versions heldout hashes before tuning: heldoutDigest reacts only to heldout changes", async () => {
    const spy = makeSubprocessSpy();

 // Baseline run.
    const base = await prepareManifest(prepareArgs(setupMemory(), spy));
    expect(base.exit).toBe(0);

 // Mutate a dev case prompt: dev integrityHash changes, heldoutDigest must not.
    const devMutated = setupMemory();
    devMutated.files.set(
      resolve("/cfg/cases.json"),
      mutatedCasesText((cases) => {
        cases[0].prompt = " mutated dev prompt ";
      }),
    );
    const devRun = await prepareManifest(prepareArgs(devMutated, spy));
    expect(devRun.exit).toBe(0);
    expect(devRun.manifest!.heldoutDigest).toBe(base.manifest!.heldoutDigest);
    expect(devRun.manifest!.cases[0].integrityHash).not.toBe(base.manifest!.cases[0].integrityHash);

 // Mutate a heldout case prompt: heldoutDigest must change.
    const heldoutMutated = setupMemory();
    heldoutMutated.files.set(
      resolve("/cfg/cases.json"),
      mutatedCasesText((cases) => {
        const target = cases.find((c) => c.split === "heldout")!;
        target.prompt = " mutated heldout prompt ";
      }),
    );
    const heldoutRun = await prepareManifest(prepareArgs(heldoutMutated, spy));
    expect(heldoutRun.exit).toBe(0);
    expect(heldoutRun.manifest!.heldoutDigest).not.toBe(base.manifest!.heldoutDigest);
  });

  test("prepare preserves missing model identity as null with explicit reason", async () => {
    const mem = setupMemory();
    const spy = makeSubprocessSpy();
    const result = await prepareManifest(prepareArgs(mem, spy));
    expect(result.exit).toBe(0);
    expect(result.manifest!.requestedModel).toBeNull();
    expect(result.manifest!.requestedModelReason).toBe(testConfig.requestedModelReason);
    expect(result.manifest!.observedModel).toBeNull();
    expect(result.manifest!.observedModelReason).toBe(testConfig.observedModelReason);

 // A user-authorized model passes through without requiring a reason.
    const withModel = setupMemory();
    withModel.files.set(
      resolve("/cfg/config.json"),
      JSON.stringify({ ...testConfig, requestedModel: "gpt-5.1-codex", requestedModelReason: null }),
    );
    const r2 = await prepareManifest(prepareArgs(withModel, spy));
    expect(r2.exit).toBe(0);
    expect(r2.manifest!.requestedModel).toBe("gpt-5.1-codex");
  });

  test("prepare canonical run ID is case/variant/repeat/turn and rejects invalid inputs", () => {
    expect(canonicalRunId("pm-dev-1-plan-before-implement", "baseline", 1, 1)).toBe(
      "pm-dev-1-plan-before-implement/baseline/1/1",
    );
    expect(canonicalRunId("dev-dev-4-resume-repair", "minimal", 2, 2)).toBe("dev-dev-4-resume-repair/minimal/2/2");
    expect(() => canonicalRunId("case", "baseline", 0, 1)).toThrow(/repeat/);
    expect(() => canonicalRunId("case", "baseline", 1, 0)).toThrow(/turn/);
    expect(() => canonicalRunId("case", "nightly", 1, 1)).toThrow(/variant/);
    expect(() => canonicalRunId("Bad_Id", "baseline", 1, 1)).toThrow(/case id/);
  });

  test("prepare rejects mutable refs (branch names / HEAD / short SHA) with exit 2 before any write", async () => {
    for (const badRef of ["main", "HEAD", "ec7cc1b", `${BASELINE_SHA}ffff`]) {
      const mem = setupMemory();
      mem.files.set(
        resolve("/cfg/config.json"),
        JSON.stringify({ ...testConfig, sourceRefs: { baseline: badRef, candidate: CANDIDATE_SHA } }),
      );
      const spy = makeSubprocessSpy();
      const result = await prepareManifest(prepareArgs(mem, spy));
      expect(result.exit).toBe(2);
      expect(result.errors.join("\n")).toContain("mutable or non-full ref");
      expect(mem.writes.length).toBe(0);
    }
  });

  test("prepare rejects escaping fixture paths with exit 2 before any write", async () => {
    for (const badPath of ["../escape.txt", "/etc/passwd", "a/../../b.txt", "dir/./x.txt"]) {
      const mem = setupMemory();
      mem.files.set(
        resolve("/cfg/cases.json"),
        mutatedCasesText((cases) => {
          (cases[0].fixture.files as { path: string; content: string }[])[0].path = badPath;
        }),
      );
      const spy = makeSubprocessSpy();
      const result = await prepareManifest(prepareArgs(mem, spy));
      expect(result.exit).toBe(2);
      expect(result.errors.join("\n")).toContain("escapes the fixture root");
      expect(mem.writes.length).toBe(0);
    }
  });

  test("prepare rejects unknown split with exit 2 before any write", async () => {
    const mem = setupMemory();
    mem.files.set(
      resolve("/cfg/cases.json"),
      mutatedCasesText((cases) => {
        cases[0].split = "smoke" as unknown as CaseSplit; // smoke is derived, never stored
      }),
    );
    const spy = makeSubprocessSpy();
    const result = await prepareManifest(prepareArgs(mem, spy));
    expect(result.exit).toBe(2);
    expect(result.errors.join("\n")).toContain("split unknown");
    expect(mem.writes.length).toBe(0);
  });

  test("prepare rejects duplicate case ids with exit 2 before any write", async () => {
    const mem = setupMemory();
    mem.files.set(
      resolve("/cfg/cases.json"),
      mutatedCasesText((cases) => {
        cases[1].id = cases[0].id as string;
      }),
    );
    const spy = makeSubprocessSpy();
    const result = await prepareManifest(prepareArgs(mem, spy));
    expect(result.exit).toBe(2);
    expect(result.errors.join("\n")).toContain("duplicate case id");
    expect(mem.writes.length).toBe(0);
  });

  test("prepare rejects unsafe real checkout targets with exit 2 before any write", async () => {
    const spy = makeSubprocessSpy();

 // Outside the disposable fixture root entirely.
    const outside = setupMemory();
    const r1 = await prepareManifest(prepareArgs(outside, spy, { outDir: `${REPO_ROOT}/src/main-checkout-run` }));
    expect(r1.exit).toBe(2);
    expect(r1.errors.join("\n")).toContain("unsafe output target");
    expect(outside.writes.length).toBe(0);

 // The fixture root itself is not a valid run dir.
    const rootItself = setupMemory();
    const r2 = await prepareManifest(prepareArgs(rootItself, spy, { outDir: FIXTURE_ROOT }));
    expect(r2.exit).toBe(2);
    expect(rootItself.writes.length).toBe(0);

 // Symlinked run dir escaping the fixture root.
    const escaped = memoryIo({ [`${FIXTURE_ROOT}/escape-link`]: `${REPO_ROOT}/src` });
    escaped.files.set(resolve("/cfg/config.json"), JSON.stringify(testConfig));
    escaped.files.set(resolve("/cfg/cases.json"), CASES_TEXT);
    const r3 = await prepareManifest(
      prepareArgs(escaped, spy, { outDir: `${FIXTURE_ROOT}/escape-link/run` }),
    );
    expect(r3.exit).toBe(2);
    expect(r3.errors.join("\n")).toContain("symlink escape");
    expect(escaped.writes.length).toBe(0);
  });

  test("prepare rejects cross-arm closure edges in the resolved manifest", async () => {
    const mem = setupMemory();
    const spy = makeSubprocessSpy();
    const result = await prepareManifest(prepareArgs(mem, spy));
    expect(result.exit).toBe(0);

    const tampered = JSON.parse(JSON.stringify(result.manifest)) as EvalManifest;
    const baselineVariant = tampered.variants.find((v) => v.id === "baseline")!;
    const entry = baselineVariant.closure.find((e) => e.path === "skills/demo/SKILL.md")!;
    entry.sha256 = sha256Of("candidate demo skill"); // candidate arm's hash

    const errors = await validateResolvedManifest(tampered, memReader);
    expect(errors.join("\n")).toContain("cross-arm closure edge");
  });

  test("prepare rejects stale closure hashes that match no arm", async () => {
    const mem = setupMemory();
    const spy = makeSubprocessSpy();
    const result = await prepareManifest(prepareArgs(mem, spy));
    expect(result.exit).toBe(0);

    const tampered = JSON.parse(JSON.stringify(result.manifest)) as EvalManifest;
    const candidateVariant = tampered.variants.find((v) => v.id === "candidate")!;
    candidateVariant.closure[0].sha256 = sha256Of("hash from neither arm");

    const errors = await validateResolvedManifest(tampered, memReader);
    expect(errors.join("\n")).toContain("stale hash");
  });

  test("prepare rejects an invalid run split name (run CLI contract)", () => {
    expect(validateRunSplit("dev")).toEqual([]);
    expect(validateRunSplit("heldout")).toEqual([]);
    expect(validateRunSplit("smoke")).toEqual([]);
    expect(validateRunSplit("nightly").join(" ")).toContain("unknown split");
  });
});

// ---------------------------------------------------------------------------
// Git argv reader parsing (NOT part of the prepare filter; fake exec only)
// ---------------------------------------------------------------------------

describe("source tree reader (git argv parsing)", () => {
  test("reader uses argv-array git only and hashes cat-file blob bytes", async () => {
    const calls: { file: string; args: string[] }[] = [];
    const fakeExec: ExecArgv = async (file, args) => {
      calls.push({ file, args: [...args] });
      if (args.includes("ls-tree")) {
        return {
          stdout: Buffer.from(
            `100644 blob ${"1".repeat(40)}\tskills/demo/SKILL.md\0` +
              `100644 blob ${"2".repeat(40)}\tskills/demo/refs/a.md\0`,
          ),
        };
      }
      if (args.includes("cat-file")) {
        const spec = args[args.length - 1];
        return { stdout: Buffer.from(`content-of-${spec}`) };
      }
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    };

    const reader = makeGitSourceTreeReader(REPO_ROOT, fakeExec);
    const tree = await reader(BASELINE_SHA);

    expect(calls.length).toBe(3);
    expect(calls.every((c) => c.file === "git")).toBe(true);
 // C-W3: the freeze closure covers the complete reachable skill/reference
 // closure — the skills/ tree plus the AGENTS.md and commands/ surfaces.
    expect(calls[0].args).toEqual([
      "-C",
      REPO_ROOT,
      "ls-tree",
      "-r",
      "-z",
      BASELINE_SHA,
      "--",
      "AGENTS.md",
      "commands",
      "skills",
    ]);
    expect(calls[1].args).toEqual(["-C", REPO_ROOT, "cat-file", "blob", `${BASELINE_SHA}:skills/demo/SKILL.md`]);
    expect(Object.keys(tree).sort()).toEqual(["skills/demo/SKILL.md", "skills/demo/refs/a.md"]);
    expect(tree["skills/demo/SKILL.md"]).toBe(sha256Of(`content-of-${BASELINE_SHA}:skills/demo/SKILL.md`));
  });
});

// ---------------------------------------------------------------------------
// helpers: in-memory RunnerIo + SYNTHETIC spawn adapter
// ---------------------------------------------------------------------------

const RUN_MANIFEST_PATH = resolve(OUT_DIR, "manifest.json");
const PM_RESUME_CASE = "pm-dev-4-smoke-explicit-resume";
const RO_CASE = "dev-dev-1-smoke-readonly-closure-sentinel";
const WW_CASE = "dev-dev-2-smoke-isolated-relative-write";
const PASS_THREAD_PREFIX = "thr-synthetic-";
const PM_UNIT_ID = `${PM_RESUME_CASE}/baseline/1`;

function memoryRunnerIo(): RunnerIo & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const ensureAncestors = (p: string) => {
    let cur = resolve(p);
    for (;;) {
      dirs.add(cur);
      const parent = resolve(cur, "..");
      if (parent === cur) break;
      cur = parent;
    }
  };
  const io: RunnerIo & { files: Map<string, string>; dirs: Set<string> } = {
    files,
    dirs,
    readText: (p) => {
      const v = files.get(resolve(p));
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeText: (p, content) => {
      ensureAncestors(resolve(p, ".."));
      files.set(resolve(p), content);
    },
    ensureDir: (p) => ensureAncestors(p),
    exists: (p) => files.has(resolve(p)) || dirs.has(resolve(p)),
    realpath: (p) => resolve(p),
    readDir: (p) => {
      const base = resolve(p);
      if (!dirs.has(base)) throw new Error(`ENOTDIR: ${p}`);
      const kids = new Set<string>();
      for (const key of [...files.keys(), ...dirs.keys()]) {
        if (key === base) continue;
        if (resolve(key, "..") === base) kids.add(key.slice(base.length + 1));
      }
      return [...kids].sort();
    },
    isFile: (p) => files.has(resolve(p)) && !dirs.has(resolve(p)),
    copyFile: (from, to) => {
      const v = files.get(resolve(from));
      if (v === undefined) throw new Error(`ENOENT: ${from}`);
      ensureAncestors(resolve(to, ".."));
      files.set(resolve(to), v);
    },
    removeDeep: (p) => {
      const base = resolve(p);
      for (const key of [...files.keys()]) if (key === base || key.startsWith(`${base}/`)) files.delete(key);
      for (const key of [...dirs.keys()]) if (key === base || key.startsWith(`${base}/`)) dirs.delete(key);
    },
    rename: (from, to) => {
      const src = resolve(from);
      const dst = resolve(to);
      const movedFiles = [...files.keys()].filter((k) => k === src || k.startsWith(`${src}/`));
      const movedDirs = [...dirs.keys()].filter((k) => k.startsWith(`${src}/`));
      if (movedFiles.length === 0 && !dirs.has(src)) throw new Error(`ENOENT: ${from}`);
      ensureAncestors(dst);
      for (const k of movedFiles) {
        files.set(dst + k.slice(src.length), files.get(k)!);
        files.delete(k);
      }
      for (const k of movedDirs) {
        dirs.add(dst + k.slice(src.length));
        dirs.delete(k);
      }
      if (dirs.has(src)) {
        dirs.add(dst);
        dirs.delete(src);
      }
    },
  };
  return io;
}

/** Script for one SYNTHETIC spawn invocation (events/final/exit are fake). */
interface SyntheticScript {
  events?: string;
  final?: string;
  stderr?: string;
  code?: number;
  signal?: string | null;
  timedOut?: boolean;
  spawnError?: string | null;
  writes?: { path: string; content: string }[];
  fail?: Error;
  /** Simulates a missing events artifact: the adapter writes no events file. */
  omitEvents?: boolean;
}

/** SYNTHETIC adapter: records spawn requests, writes scripted evidence files. */
function syntheticSpawn(
  io: RunnerIo,
  handler: (req: SpawnRequest) => SyntheticScript,
): SpawnFn & { requests: SpawnRequest[] } {
  const fn = (async (req: SpawnRequest) => {
    fn.requests.push(req);
    const script = handler(req);
    if (script.fail) throw script.fail;
    if (script.omitEvents !== true) io.writeText(req.stdoutFile, script.events ?? "");
    io.writeText(req.stderrFile, script.stderr ?? "");
    if (script.final !== undefined) {
      const i = req.argv.indexOf("--output-last-message");
      if (i < 0) throw new Error("synthetic adapter: argv lacks --output-last-message");
      io.writeText(req.argv[i + 1], script.final);
    }
    for (const w of script.writes ?? []) io.writeText(resolve(req.cwd, w.path), w.content);
    return {
      code: script.code === undefined ? 0 : script.code, // null (killed) stays null
      signal: script.signal === undefined ? null : script.signal,
      timedOut: script.timedOut === undefined ? false : script.timedOut,
      spawnError: script.spawnError === undefined ? null : script.spawnError,
    };
  }) as SpawnFn & { requests: SpawnRequest[] };
  fn.requests = [];
  return fn;
}

function caseIdFromCwd(manifest: EvalManifest, cwd: string): string {
  const hit = manifest.cases.find((c) => cwd.includes(`/${c.id}/`));
  if (!hit) throw new Error(`synthetic adapter: cannot resolve case id from cwd ${cwd}`);
  return hit.id;
}

function threadIdFor(caseId: string): string {
  return `${PASS_THREAD_PREFIX}${caseId}`;
}

/** Base all-pass script for a case, derived from the case's own assertions. */
function basePassScript(manifest: EvalManifest, caseId: string, opts?: { omitThread?: boolean }): SyntheticScript {
  const c = manifest.cases.find((x) => x.id === caseId)!;
  const readValues = c.assertions.filter((a) => a.kind === "tool_read_contains").map((a) => a.value as string);
  const finalValues = c.assertions.filter((a) => a.kind === "final_contains").map((a) => a.value as string);
  const lines: string[] = [];
  if (!opts?.omitThread) lines.push(JSON.stringify({ type: "thread.started", thread_id: threadIdFor(caseId) }));
  lines.push(
    JSON.stringify({
      type: "item.completed",
      id: "item_1",
      item: { id: "item_1", type: "command_execution", command: ["cat", ...readValues], aggregated_output: "(synthetic output)" },
    }),
  );
  lines.push(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 4213, output_tokens: 512, total_tokens: 4725 } }));
  const writes: { path: string; content: string }[] = [];
  const diff = c.assertions.find((a) => a.kind === "diff_paths_within");
  const allowed = (diff?.value as string[]) ?? [];
  if (c.sandbox === "workspace-write" && allowed.length > 0) {
    writes.push({ path: allowed[0], content: "// touched by the SYNTHETIC adapter\n" });
  }
  return { events: `${lines.join("\n")}\n`, final: `${finalValues.join("\n")}\n`, code: 0, writes };
}

/** SYNTHETIC all-pass handler (turn-agnostic; resume turns echo the thread id). */
function passHandler(manifest: EvalManifest): (req: SpawnRequest) => SyntheticScript {
  return (req) => basePassScript(manifest, caseIdFromCwd(manifest, req.cwd));
}

async function preparedRunDir(): Promise<{ io: ReturnType<typeof memoryRunnerIo>; manifest: EvalManifest }> {
  const io = memoryRunnerIo();
  io.files.set(resolve("/cfg/config.json"), JSON.stringify(testConfig));
  io.files.set(resolve("/cfg/cases.json"), CASES_TEXT);
  const result = await prepareManifest({
    configPath: "/cfg/config.json",
    casesPath: "/cfg/cases.json",
    outDir: OUT_DIR,
    repoRoot: REPO_ROOT,
    io,
    readSourceTree: memReader,
    exec: makeSubprocessSpy().exec,
  });
  if (result.exit !== 0 || !result.manifest) throw new Error(`test setup: prepare failed: ${result.errors.join("; ")}`);
  return { io, manifest: result.manifest };
}

describe("canonicalJson pin (cross-version byte stability)", () => {
  // Reference implementation = the ORIGINAL canonicalJson body (default
  // .sort() ordering). The current insertion-sort implementation must be
  // byte-identical to it for every input below.
  function referenceCanonical(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(referenceCanonical).join(",")}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${referenceCanonical(obj[k])}`).join(",")}}`;
  }

  // Fixed nested key set, deliberately inserted in NON-sorted order; covers
  // nested objects, arrays (element order preserved), empty objects,
  // numbers/booleans/null, and non-ASCII keys. HeldoutDigest and configHash
  // are sha256 digests over this serialization — its bytes are a contract.
  const nested = {
    zeta: { b: 1, a: [3, 2, { y: null, x: true }] },
    alpha: "s",
    mid: {},
    Num: 4,
    "ünï": false,
  };
  const expectedBytes = '{"Num":4,"alpha":"s","mid":{},"zeta":{"a":[3,2,{"x":true,"y":null}],"b":1},"ünï":false}';
  const expectedDigest = "742fa01380e81458e1df9f72b486728dfe0afb19fde4f8759ffd81feed0e050b";

  test("serializes to exact bytes independent of input key order", () => {
    // Same members, different insertion order → identical bytes.
    const reordered = {
      "ünï": false,
      Num: 4,
      mid: {},
      alpha: "s",
      zeta: { a: [3, 2, { y: null, x: true }], b: 1 },
    };
    expect(canonicalJson(nested)).toBe(expectedBytes);
    expect(canonicalJson(reordered)).toBe(expectedBytes);
  });

  test("digest is pinned: heldoutDigest/configHash byte contract", () => {
    expect(sha256Hex(canonicalJson(nested))).toBe(expectedDigest);
  });

  test("byte-identical to the original default-sort implementation", () => {
    expect(canonicalJson(nested)).toBe(referenceCanonical(nested));
    expect(canonicalJson([])).toBe(referenceCanonical([]));
    expect(canonicalJson({})).toBe(referenceCanonical({}));
    expect(canonicalJson(null)).toBe(referenceCanonical(null));
    expect(canonicalJson([1, "a", null, { k: [true] }])).toBe(referenceCanonical([1, "a", null, { k: [true] }]));
  });
});

function runSmoke(
  io: RunnerIo,
  manifest: EvalManifest,
  launchFn: SpawnFn,
  overrides: Partial<Parameters<typeof executeManifest>[0]> = {},
) {
  return executeManifest({ manifestPath: RUN_MANIFEST_PATH, split: "smoke", variants: ["baseline"], repeats: 1, io, launchFn, ...overrides });
}

function readState(io: RunnerIo): SchedulerState {
  return JSON.parse(io.readText(resolve(OUT_DIR, "scheduler", "state.json"))) as SchedulerState;
}

function writeState(io: RunnerIo, state: SchedulerState): void {
  io.writeText(resolve(OUT_DIR, "scheduler", "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// argv builders and resume guards (synthetic)
// ---------------------------------------------------------------------------

describe("Task 2: argv builders and guards (synthetic)", () => {
  const cli = "/opt/homebrew/bin/codex";

  test("first-turn argv matches the Spec A1 shape and treats resumable/single-turn differently", () => {
    const resumable = buildFirstTurnArgv({ cliPath: cli, sandbox: "read-only", fixtureDir: "/fx", finalPath: "/fx/final.md", resumable: true });
    expect(resumable.slice(0, 6)).toEqual([cli, "-a", "never", "exec", "--json", "--ignore-user-config"]);
    expect(resumable).toContain("--skip-git-repo-check");
    expect(resumable.indexOf("--sandbox")).toBeLessThan(resumable.indexOf("read-only"));
    expect(resumable[resumable.indexOf("--cd") + 1]).toBe("/fx");
    expect(resumable[resumable.indexOf("--output-last-message") + 1]).toBe("/fx/final.md");
    expect(resumable[resumable.length - 1]).toBe("-");
    expect(resumable).not.toContain("--ephemeral");

    const singleTurn = buildFirstTurnArgv({ cliPath: cli, sandbox: "workspace-write", fixtureDir: "/fx", finalPath: "/fx/final.md", resumable: false });
    expect(singleTurn).toContain("--ephemeral");
    expect(singleTurn[singleTurn.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });

  test("resume argv keeps parent exec options before `resume` and never carries --ephemeral/--last", () => {
    const argv = buildResumeArgv({ cliPath: cli, sandbox: "read-only", fixtureDir: "/fx", finalPath: "/fx/final.md", threadId: "thr_123" });
    expect(argv.slice(0, 6)).toEqual([cli, "-a", "never", "exec", "--json", "--ignore-user-config"]);
    expect(argv.indexOf("--sandbox")).toBeLessThan(argv.indexOf("resume"));
    expect(argv.indexOf("--cd")).toBeLessThan(argv.indexOf("resume"));
    expect(argv[argv.indexOf("resume") + 1]).toBe("thr_123");
    expect(argv).not.toContain("--skip-git-repo-check"); // Spec A1 resume shape omits it
    expect(argv).not.toContain("--ephemeral");
    expect(argv).not.toContain("--last");
    expect(argv[argv.length - 1]).toBe("-");
    expect(() => rejectForbiddenFlags(["codex", "--last"], "x")).toThrow(/--last/);
    expect(() => rejectForbiddenFlags(["codex", "--ephemeral"], "x")).toThrow(/--ephemeral/);
  });

  test("assertResumeAllowed rejects ephemeral, missing-id and every cross-arm mismatch (typed rejections)", () => {
    const base = {
      unitId: PM_UNIT_ID,
      recordedThreadId: "thr_ok",
      turn1Ephemeral: false,
      planned: { unitId: PM_UNIT_ID, threadId: "thr_ok", cwd: "/ws", sandbox: "read-only" },
      recordedCwd: "/ws",
      recordedSandbox: "read-only",
    };
    expect(() => assertResumeAllowed(base)).not.toThrow();
    expect(() => assertResumeAllowed({ ...base, recordedThreadId: null })).toThrow(ResumeRejectionError);
    expect(() => assertResumeAllowed({ ...base, recordedThreadId: null })).toThrow(/no thread id in the preserved turn-1 evidence/);
    expect(() => assertResumeAllowed({ ...base, turn1Ephemeral: true })).toThrow(/ephemeral resume rejected/);
    expect(() => assertResumeAllowed({ ...base, planned: { ...base.planned, unitId: "other-case/minimal/1" } })).toThrow(/cross-arm resume rejected/);
    expect(() => assertResumeAllowed({ ...base, planned: { ...base.planned, threadId: "thr_other_arm" } })).toThrow(ResumeRejectionError);
    expect(() => assertResumeAllowed({ ...base, planned: { ...base.planned, threadId: "thr_other_arm" } })).toThrow(/cross-arm resume rejected/);
    expect(() => assertResumeAllowed({ ...base, planned: { ...base.planned, cwd: "/other-workspace" } })).toThrow(/cross-arm resume rejected/);
    expect(() => assertResumeAllowed({ ...base, planned: { ...base.planned, sandbox: "workspace-write" } })).toThrow(/cross-arm resume rejected/);
  });

  test("recordedTurn1Identity parses --cd/--sandbox from preserved turn-1 argv.json (C-W4)", () => {
    const io = memoryRunnerIo();
    const argvFile = resolve(OUT_DIR, "argv-probe.json");
    io.writeText(
      argvFile,
      `${JSON.stringify({
        runId: "x/baseline/1/1",
        argv: ["/opt/homebrew/bin/codex", "-a", "never", "exec", "--sandbox", "workspace-write", "--cd", "/fx/ws", "resume", "thr_1", "-"],
        cwd: "/fx/ws",
      }, null, 2)}\n`,
    );
    expect(recordedTurn1Identity(io, argvFile)).toEqual({ cwd: "/fx/ws", sandbox: "workspace-write" });

 // Evidence-integrity rejection: unreadable argv evidence cannot resume.
    expect(() => recordedTurn1Identity(io, resolve(OUT_DIR, "missing-argv.json"))).toThrow(ResumeRejectionError);
    io.writeText(argvFile, `${JSON.stringify({ runId: "x", cwd: "/fx/ws" })}\n`);
    expect(() => recordedTurn1Identity(io, argvFile)).toThrow(ResumeRejectionError);
  });
});

// ---------------------------------------------------------------------------
// event adapter (synthetic events)
// ---------------------------------------------------------------------------

describe("Task 2: event adapter (synthetic events)", () => {
  const threadLine = `${JSON.stringify({ type: "thread.started", thread_id: "thr_42" })}\n`;
  const toolLine = `${JSON.stringify({ type: "item.completed", id: "item_9", item: { id: "item_9", type: "command_execution", command: ["cat", "skills/demo/SKILL.md"] } })}\n`;
  const usageLine = `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } })}\n`;

  test("captures thread id, usage and tool activity from known records", () => {
    const scan = scanEventStream(threadLine + toolLine + usageLine);
    expect(scan.threadId).toBe("thr_42");
    expect(scan.usageEvents).toHaveLength(1);
    expect(scan.usageEvents[0].usage.input_tokens).toBe(100);
    expect(scan.usageEvents[0].eventId).toBeNull(); // turn.completed has no id field
    expect(scan.toolActivityObserved).toBe(true);
    expect(scan.unknownRecords).toBe(0);
    expect(scan.malformedRecords).toBe(0);
  });

  test("tolerates unknown records and counts them without dropping raw bytes", () => {
    const mystery = `${JSON.stringify({ type: "mystery.record", x: 1 })}\n`;
    const records = parseEventLines(threadLine + mystery);
    expect(records).toHaveLength(2);
    expect(records[1].raw).toBe(mystery.trimEnd()); // raw bytes retained
    const scan = scanEventRecords(records);
    expect(scan.unknownRecords).toBe(1);
    expect(scan.threadId).toBe("thr_42");
    expect(scan.warnings.join(" ")).toContain("unknown event record");
  });

  test("malformed JSON lines are counted, warned about, and never abort parsing", () => {
    const scan = scanEventStream(`not-json{{{\n${threadLine}${toolLine}`);
    expect(scan.malformedRecords).toBe(1);
    expect(scan.threadId).toBe("thr_42");
    expect(scan.warnings.join(" ")).toContain("malformed JSON at line 1");
    expect(scan.warnings.join(" ")).toContain("raw bytes retained");
  });

  test("absent usage leaves no usage events (counters stay null downstream)", () => {
    const scan = scanEventStream(threadLine + toolLine);
    expect(scan.usageEvents).toHaveLength(0);
  });

  test("two usage records are preserved side by side, never summed", () => {
    const scan = scanEventStream(threadLine + usageLine + usageLine.replace("100", "150"));
    expect(scan.usageEvents).toHaveLength(2);
    expect(scan.usageEvents[0].usage.input_tokens).toBe(100);
    expect(scan.usageEvents[1].usage.input_tokens).toBe(150);
  });

  test("auth failure is detected from error records; non-auth errors are not labelled auth", () => {
    const auth = `${JSON.stringify({ type: "turn.failed", error: { message: "unauthorized: not logged in" } })}\n`;
    const scan = scanEventStream(auth);
    expect(scan.authFailure?.detail).toContain("unauthorized");
    const other = scanEventStream(`${JSON.stringify({ type: "turn.failed", error: { message: "model refused" } })}\n`);
    expect(other.authFailure).toBeNull();
  });

  test("auth classification uses word boundaries ", () => {
 // Substring hits like "14013"/"4033" must not classify as auth failures.
    const digits = scanEventStream(`${JSON.stringify({ type: "error", message: "request 14013 failed after 4033 retries" })}\n`);
    expect(digits.authFailure).toBeNull();
    const realCodes = scanEventStream(`${JSON.stringify({ type: "error", message: "HTTP 401 Unauthorized" })}\n`);
    expect(realCodes.authFailure?.detail).toContain("401");
    const quota = scanEventStream(`${JSON.stringify({ type: "error", message: "quota exceeded for project" })}\n`);
    expect(quota.authFailure?.detail).toContain("quota");
  });

  test("tool_read search matches only read-shaped typed command fields", () => {
 // Real round-1 smoke schema: command_execution with a STRING command argv.
    const realRead = `${JSON.stringify({
      type: "item.completed",
      id: "item_2",
      item: { id: "item_2", type: "command_execution", command: `/bin/zsh -lc "sed -n '1,240p' skills/demo/SKILL.md"`, aggregated_output: "..." },
    })}\n`;
 // False-pass surfaces that must NOT satisfy a tool_read_contains:
 // (a) an agent message claiming the read;
    const claim = `${JSON.stringify({ type: "item.completed", id: "m1", item: { id: "m1", type: "agent_message", text: "I read skills/demo/SKILL.md (trust me)" } })}\n`;
 // (b) a non-read record whose SERIALIZED JSON merely mentions the needle
 // (round-1 evidence: a `find` output listing the filename);
    const outputMention = `${JSON.stringify({
      type: "item.completed",
      id: "item_3",
      item: { id: "item_3", type: "command_execution", command: "find . -maxdepth 2 -type f -print", aggregated_output: "./AGENTS.md\n./skills/demo/SKILL.md" },
    })}\n`;
 // (c) an error/status record naming the file.
    const errorMention = `${JSON.stringify({ type: "item.completed", id: "item_0", item: { id: "item_0", type: "error", message: "skills/demo/SKILL.md exceeds the context budget" } })}\n`;

    const records = parseEventLines(claim + outputMention + errorMention + realRead);
    const hit = findToolReadRecord(records, "skills/demo/SKILL.md", 1);
    expect(hit).toEqual({ turn: 1, line: 4, eventId: "item_2" });

 // Array-shaped commands (synthetic adapter) are joined before matching.
    const arrayCommand = parseEventLines(
      `${JSON.stringify({ type: "item.completed", id: "item_9", item: { id: "item_9", type: "command_execution", command: ["cat", "skills/demo/SKILL.md"] } })}\n`,
    );
    expect(findToolReadRecord(arrayCommand, "skills/demo/SKILL.md", 1)).toEqual({ turn: 1, line: 1, eventId: "item_9" });

 // No read-shaped record -> no hit.
    expect(findToolReadRecord(parseEventLines(claim + errorMention), "skills/demo/SKILL.md", 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deterministic interleaved scheduling
// ---------------------------------------------------------------------------

describe("Task 2: scheduleOrder (deterministic interleaving)", () => {
  const cases = [{ id: "c" }, { id: "a" }, { id: "b" }];

  test("repeat-major interleave: every repeat-1 unit precedes any repeat-2 unit", () => {
    const order = scheduleOrder(cases, ["baseline", "minimal"], 2, 20260907);
    expect(order).toHaveLength(12);
    expect(order.slice(0, 6).every((u) => u.repeat === 1)).toBe(true);
    expect(order.slice(6).every((u) => u.repeat === 2)).toBe(true);
    const keys = order.map((u) => `${u.caseId}/${u.variant}/${u.repeat}`).sort();
    expect(keys).toEqual([
      "a/baseline/1", "a/baseline/2", "a/minimal/1", "a/minimal/2",
      "b/baseline/1", "b/baseline/2", "b/minimal/1", "b/minimal/2",
      "c/baseline/1", "c/baseline/2", "c/minimal/1", "c/minimal/2",
    ].sort());
  });

  test("same seed yields the identical order (deterministic); only requested variants are scheduled", () => {
    const a = scheduleOrder(cases, ["baseline"], 2, 20260907);
    const b = scheduleOrder(cases, ["baseline"], 2, 20260907);
    expect(a).toEqual(b);
    expect(a.every((u) => u.variant === "baseline")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runner validation (no spawns on invalid requests)
// ---------------------------------------------------------------------------

describe("Task 2: run request validation (zero spawns)", () => {
  test("unknown split, unknown variant, repeats beyond the frozen sampling lock, and tampered manifests exit 2 without spawning", async () => {
    const { io, manifest } = await preparedRunDir();

    const badSplit = await runSmoke(io, manifest, syntheticSpawn(io, () => ({})), { split: "nightly" as "dev" });
    expect(badSplit.exit).toBe(2);
    expect(badSplit.errors.join(" ")).toContain("unknown split");

    const badVariant = await runSmoke(io, manifest, syntheticSpawn(io, () => ({})), { variants: ["nightly"] });
    expect(badVariant.exit).toBe(2);
    expect(badVariant.errors.join(" ")).toContain("unknown variant");

    const tooManyRepeats = await runSmoke(io, manifest, syntheticSpawn(io, () => ({})), { repeats: 3 });
    expect(tooManyRepeats.exit).toBe(2);
    expect(tooManyRepeats.errors.join(" ")).toContain("sampling lock");

 // Tampered frozen manifest: mutate a config-relevant field -> configHash breaks.
    const tampered = JSON.parse(JSON.stringify(manifest)) as EvalManifest;
    tampered.plan = "tampered-plan";
    io.writeText(RUN_MANIFEST_PATH, `${JSON.stringify(tampered, null, 2)}\n`);
    const tamperSpawn = syntheticSpawn(io, () => ({}));
    const tamperedRun = await runSmoke(io, tampered, tamperSpawn);
    expect(tamperedRun.exit).toBe(2);
    expect(tamperedRun.errors.join(" ")).toContain("configHash");
    expect(tamperSpawn.requests).toHaveLength(0);
  });

  test("run and report refuse a manifest outside the disposable root", async () => {
    const { io, manifest } = await preparedRunDir();

 // (a) A runnable manifest copied into a durable tree (the round-1 trap:
 // eval/run/manifest.json) has no <repoRoot>/.tmp/skill-eval ancestor.
    const durableCopy = resolve(REPO_ROOT, "eval-durable", "manifest.json");
    io.writeText(durableCopy, io.readText(RUN_MANIFEST_PATH));
    const outsideSpawn = syntheticSpawn(io, () => ({}));
    const outsideRun = await executeManifest({
      manifestPath: durableCopy,
      split: "smoke",
      variants: ["baseline"],
      repeats: 1,
      io,
      launchFn: outsideSpawn,
    });
    expect(outsideRun.exit).toBe(2);
    expect(outsideRun.errors.join(" ")).toContain("disposable");
    expect(outsideSpawn.requests).toHaveLength(0);
    expect(io.exists(resolve(REPO_ROOT, "eval-durable", "scheduler", "state.json"))).toBe(false);

    const outsideReport = buildReport({ manifestPath: durableCopy, io });
    expect(outsideReport.exit).toBe(2);
    expect(outsideReport.errors.join(" ")).toContain("disposable");
    expect(io.exists(resolve(REPO_ROOT, "eval-durable", "report.json"))).toBe(false);
    expect(io.exists(resolve(REPO_ROOT, "eval-durable", "report.md"))).toBe(false);

 // (b) Explicit repoRoot: a run dir outside THAT root's disposable root is
 // rejected by the shape check before anything is read or written.
    const elsewhere = resolve("/elsewhere", "run", "manifest.json");
    io.writeText(elsewhere, io.readText(RUN_MANIFEST_PATH));
    const shapeRun = await executeManifest({
      manifestPath: elsewhere,
      split: "smoke",
      variants: ["baseline"],
      repeats: 1,
      repoRoot: REPO_ROOT,
      io,
      launchFn: syntheticSpawn(io, () => ({})),
    });
    expect(shapeRun.exit).toBe(2);
    expect(shapeRun.errors.join(" ")).toContain("unsafe output target");
  });
});

// ---------------------------------------------------------------------------
// runner end-to-end on the SYNTHETIC adapter (smoke selection)
// ---------------------------------------------------------------------------

describe("Task 2: runner on synthetic adapter (smoke selection, 3 units)", () => {
  test("all-pass run: exit 0, argv-array spawns with explicit fixture cwd, evidence files recorded", async () => {
    const { io, manifest } = await preparedRunDir();
    const spawn = syntheticSpawn(io, passHandler(manifest));
    const result = await runSmoke(io, manifest, spawn);

    expect(result.exit).toBe(0);
    expect(result.summary.requestedUnits).toBe(3);
    expect(result.summary.grades.pass).toBe(3);
 // 2 single-turn units x 1 spawn + 1 resumable unit x 2 turns = 4 spawns.
    expect(result.summary.spawnCount).toBe(4);

 // Argv-array spawn, no shell: every request is a plain string argv with
 // the manifest CLI and an explicit workspace cwd under the run dir.
    for (const req of spawn.requests) {
      expect(req.argv.every((a) => typeof a === "string")).toBe(true);
      expect(req.argv[0]).toBe(manifest.cli.path);
      expect(req.argv.slice(1, 5)).toEqual(["-a", "never", "exec", "--json"]);
      expect(req.argv).not.toContain("--last");
      expect(req.cwd.startsWith(resolve(OUT_DIR, "workspaces") + "/")).toBe(true);
      expect(req.argv[req.argv.indexOf("--cd") + 1]).toBe(req.cwd);
      expect(req.stdinFile.endsWith("prompt.txt")).toBe(true);
    }

 // cwd is a verified copy of the prepared case fixture (frozen per-file hash).
    const roRequest = spawn.requests.find((r) => r.cwd.includes(`/${RO_CASE}/`))!;
    const roCase = manifest.cases.find((c) => c.id === RO_CASE)!;
    expect(io.exists(resolve(roRequest.cwd, "skills/demo/SKILL.md"))).toBe(true);
    expect(sha256Hex(io.readText(resolve(roRequest.cwd, "AGENTS.md")))).toBe(
      roCase.fixture.files.find((f) => f.path === "AGENTS.md")!.sha256,
    );

 // Sandbox per case; ephemeral only on single-turn first turns.
    const wwRequest = spawn.requests.find((r) => r.cwd.includes(`/${WW_CASE}/`))!;
    expect(wwRequest.argv[wwRequest.argv.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(wwRequest.argv).toContain("--ephemeral");
    const roFirst = spawn.requests.find((r) => r.cwd.includes(`/${RO_CASE}/`))!;
    expect(roFirst.argv).toContain("--ephemeral");
    const pmFirst = spawn.requests.find((r) => r.cwd.includes(`/${PM_RESUME_CASE}/`) && !r.argv.includes("resume"))!;
    expect(pmFirst.argv).not.toContain("--ephemeral");

 // stdin carries the exact case prompt (file-backed).
    const pmCase = manifest.cases.find((c) => c.id === PM_RESUME_CASE)!;
    expect(io.readText(pmFirst.stdinFile)).toBe(pmCase.prompt);

 // Resume: exactly one resume spawn for pm-dev-4 with the captured thread id.
    const resumeRequests = spawn.requests.filter((r) => r.argv.includes("resume"));
    expect(resumeRequests).toHaveLength(1);
    expect(resumeRequests[0].cwd).toBe(pmFirst.cwd);
    expect(resumeRequests[0].argv).toContain(threadIdFor(PM_RESUME_CASE));
    const pmUnit = result.state.units[PM_UNIT_ID];
    expect(pmUnit.turns["2"].runId).toBe(`${PM_RESUME_CASE}/baseline/1/2`);
    expect(pmUnit.grading?.assertions.find((a) => a.kind === "thread_reused")?.grade).toBe("pass");

 // Evidence files preserved per run (events raw, stderr, final, metrics, argv).
    const turn1 = pmUnit.turns["1"];
    expect(io.readText(turn1.artifacts.events)).toBe(basePassScript(manifest, PM_RESUME_CASE).events);
    expect(io.exists(turn1.artifacts.stderr)).toBe(true);
    expect(io.exists(turn1.artifacts.final)).toBe(true);
    expect(JSON.parse(io.readText(turn1.artifacts.argv)).argv).toEqual(turn1.argv);

 // Usage honesty: observed per-event usage preserved; aggregates stay null, basis unknown.
    expect(turn1.metrics.usageEvents).toHaveLength(1);
    expect(turn1.metrics.usage.inputTokens).toBeNull();
    expect(turn1.metrics.usage.outputTokens).toBeNull();
    expect(turn1.metrics.usage.reason).toContain("per-turn vs cumulative");
    expect(turn1.metrics.usageBasis).toBe("unknown");
    expect(turn1.metrics.bytesLoaded).toEqual({ bytes: null, unit: "bytes", reason: expect.stringContaining("unverified") });
    expect(turn1.metrics.costUsd.amount).toBeNull();
    expect(turn1.metrics.readEvidence).toBe("observed_tool_read");
  });

  test("unknown records and malformed JSON are tolerated; raw bytes stay in events.jsonl", async () => {
    const { io, manifest } = await preparedRunDir();
    const extra = `${JSON.stringify({ type: "mystery.record", x: 1 })}\nnot-json{{{\n`;
    const spawn = syntheticSpawn(io, (req) => {
      const script = basePassScript(manifest, caseIdFromCwd(manifest, req.cwd));
      script.events = extra + script.events;
      return script;
    });
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(0);
    const metrics = result.state.units[`${RO_CASE}/baseline/1`].turns["1"].metrics;
    expect(metrics.adapterWarnings.join(" ")).toContain("unknown event record");
    expect(metrics.adapterWarnings.join(" ")).toContain("malformed JSON at line 2");
 // Raw bytes (including the malformed line) are preserved verbatim.
    expect(io.readText(result.state.units[`${RO_CASE}/baseline/1`].turns["1"].artifacts.events)).toContain("not-json{{{");
  });

  test("absent usage keeps every counter null with a reason — never zero", async () => {
    const { io, manifest } = await preparedRunDir();
    const spawn = syntheticSpawn(io, (req) => {
      const caseId = caseIdFromCwd(manifest, req.cwd);
      const script = basePassScript(manifest, caseId);
      if (caseId === WW_CASE) script.events = script.events!.split("\n").filter((l) => !l.includes("turn.completed")).join("\n");
      return script;
    });
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(0);
    const metrics = result.state.units[`${WW_CASE}/baseline/1`].turns["1"].metrics;
    expect(metrics.usageEvents).toHaveLength(0);
    expect(metrics.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, reason: expect.stringContaining("no usage events") });
    expect(metrics.usageBasis).toBe("unknown");
  });

  test("cumulative-vs-turn stays unknown: both usage records preserved, aggregate null", async () => {
    const { io, manifest } = await preparedRunDir();
    const spawn = syntheticSpawn(io, (req) => {
      const script = basePassScript(manifest, caseIdFromCwd(manifest, req.cwd));
      const lines = script.events!.trimEnd().split("\n");
      const usage = lines[lines.length - 1];
      script.events = `${lines.slice(0, -1).join("\n")}\n${usage}\n${usage.replace("4213", "9900")}\n`;
      return script;
    });
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(0);
    const metrics = result.state.units[`${RO_CASE}/baseline/1`].turns["1"].metrics;
    expect(metrics.usageEvents).toHaveLength(2);
    expect(metrics.usageBasis).toBe("unknown");
    expect(metrics.usage.totalTokens).toBeNull();
    expect(metrics.usage.reason).toContain("per-turn vs cumulative");
  });

  test("auth failure grades infrastructure_error, preserves stderr, keeps the denominator, exits 2", async () => {
    const { io, manifest } = await preparedRunDir();
    const spawn = syntheticSpawn(io, (req) => {
      const caseId = caseIdFromCwd(manifest, req.cwd);
      if (caseId === WW_CASE) {
        return {
          events: `${JSON.stringify({ type: "turn.failed", error: { message: "unauthorized: not logged in" } })}\n`,
          stderr: "stream error: unauthorized\n",
          code: 1,
        };
      }
      return basePassScript(manifest, caseId);
    });
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(2);
    expect(result.summary.requestedUnits).toBe(3); // denominator retained
    expect(result.summary.grades).toEqual({ pass: 2, fail: 0, unverified: 0, infrastructure_error: 1, pending: 0 });
    const unit = result.state.units[`${WW_CASE}/baseline/1`];
    expect(unit.grade).toBe("infrastructure_error");
    expect(unit.turns["1"].infrastructureReason).toBe("auth_failure");
    expect(unit.turns["1"].exitCode).toBe(1);
    expect(io.readText(unit.turns["1"].artifacts.stderr)).toContain("unauthorized");
    expect(unit.failureReason).toContain("authentication failure");
  });

  test("timeout terminates the child and preserves signal/exit; exits 2", async () => {
    const { io, manifest } = await preparedRunDir();
    const spawn = syntheticSpawn(io, (req) => {
      const caseId = caseIdFromCwd(manifest, req.cwd);
      if (caseId === WW_CASE) {
        return { events: "", stderr: "partial output before termination\n", code: null, signal: "SIGTERM", timedOut: true };
      }
      return basePassScript(manifest, caseId);
    });
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(2);
    const unit = result.state.units[`${WW_CASE}/baseline/1`];
    expect(unit.grade).toBe("infrastructure_error");
    expect(unit.turns["1"].timedOut).toBe(true);
    expect(unit.turns["1"].signal).toBe("SIGTERM");
    expect(unit.turns["1"].exitCode).toBeNull();
    expect(unit.failureReason).toContain("timeout");
    expect(io.readText(unit.turns["1"].artifacts.stderr)).toContain("partial output");
  });

  test("mechanical assertion failure keeps the unit counted and exits 1 when nothing is unverified/infra", async () => {
    const { io, manifest } = await preparedRunDir();
    const spawn = syntheticSpawn(io, (req) => {
      const caseId = caseIdFromCwd(manifest, req.cwd);
      const script = basePassScript(manifest, caseId);
      if (caseId === RO_CASE) script.final = "final message without the closure sentinel"; // breaks a2
      return script;
    });
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(1);
    expect(result.summary.grades).toEqual({ pass: 2, fail: 1, unverified: 0, infrastructure_error: 0, pending: 0 });
    const grading = result.state.units[`${RO_CASE}/baseline/1`].grading!;
    const a2 = grading.assertions.find((a) => a.assertionId === "a2")!;
    expect(a2.grade).toBe("fail");
    expect(a2.evidence.detail).toContain("CLOSURE-SENTINEL");
    expect(grading.grade).toBe("fail");
  });

  test("writes outside the allowed diff paths fail the diff assertion with file evidence", async () => {
    const { io, manifest } = await preparedRunDir();
    const spawn = syntheticSpawn(io, (req) => {
      const caseId = caseIdFromCwd(manifest, req.cwd);
      const script = basePassScript(manifest, caseId);
      if (caseId === RO_CASE) script.writes = [{ path: "UNAUTHORIZED.md", content: "contamination\n" }];
      return script;
    });
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(1);
    const unit = result.state.units[`${RO_CASE}/baseline/1`];
    expect(unit.grade).toBe("fail");
    expect(unit.fixtureDiff?.created).toEqual(["UNAUTHORIZED.md"]);
    const a5 = unit.grading!.assertions.find((a) => a.kind === "diff_paths_within")!;
    expect(a5.grade).toBe("fail");
    expect(a5.evidence.detail).toContain("UNAUTHORIZED.md");
  });

  test("rerun idempotence: the second invocation spawns nothing and preserves state", async () => {
    const { io, manifest } = await preparedRunDir();
    const first = syntheticSpawn(io, passHandler(manifest));
    const run1 = await runSmoke(io, manifest, first);
    expect(run1.exit).toBe(0);
    expect(first.requests).toHaveLength(4); // 3 units; the resumable one spawns twice
    const stateAfterFirst = io.readText(resolve(OUT_DIR, "scheduler", "state.json"));

    const second = syntheticSpawn(io, passHandler(manifest));
    const run2 = await runSmoke(io, manifest, second);
    expect(run2.exit).toBe(0);
    expect(second.requests).toHaveLength(0);
    expect(run2.summary.skippedCompletedUnits).toBe(3);
    expect(io.readText(resolve(OUT_DIR, "scheduler", "state.json"))).toBe(stateAfterFirst);
  });

  test("scheduler state refuses a different manifest (input-hash guard)", async () => {
    const { io, manifest } = await preparedRunDir();
    await runSmoke(io, manifest, syntheticSpawn(io, passHandler(manifest)));
    const mutated = JSON.parse(io.readText(RUN_MANIFEST_PATH)) as EvalManifest;
    mutated.cases[0].integrityHash = "0".repeat(64);
    io.writeText(RUN_MANIFEST_PATH, `${JSON.stringify(mutated, null, 2)}\n`);
    const spawn = syntheticSpawn(io, passHandler(manifest));
    const result = await runSmoke(io, mutated, spawn);
    expect(result.exit).toBe(2);
    expect(result.errors.join(" ")).toContain("different manifest");
    expect(spawn.requests).toHaveLength(0);
  });

  test("resume without a captured thread id leaves thread_reused unverified (never fabricated)", async () => {
    const { io, manifest } = await preparedRunDir();
    const spawn = syntheticSpawn(io, (req) => basePassScript(manifest, caseIdFromCwd(manifest, req.cwd), { omitThread: true }));
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(2);
    expect(spawn.requests.filter((r) => r.argv.includes("resume"))).toHaveLength(0);
    const unit = result.state.units[PM_UNIT_ID];
    expect(unit.grade).toBe("unverified");
    expect(unit.failureReason).toContain("resume requires a captured thread id");
    const a1 = unit.grading!.assertions.find((a) => a.kind === "thread_reused")!;
    expect(a1.grade).toBe("unverified");
    expect(a1.evidence.detail).toContain("unverified until evidence adjudicated");
  });

  test("interrupted resume rejects a cross-arm thread-id tamper against preserved turn-1 evidence", async () => {
    const { io, manifest } = await preparedRunDir();
    const death = syntheticSpawn(io, (req) => {
      if (req.argv.includes("resume")) throw new Error("simulated process death between turns");
      return basePassScript(manifest, caseIdFromCwd(manifest, req.cwd));
    });
    const run1 = await runSmoke(io, manifest, death);
    expect(run1.exit).toBe(2);

 // Simulate process death mid-turn-2: the unit goes back to pending with
 // its completed, evidence-backed turn 1 intact (as persisted after turn 1).
    const state = readState(io);
    const unit = state.units[PM_UNIT_ID];
    expect(unit.turns["1"].status).toBe("completed");
    unit.grade = null;
    unit.failureReason = null;
    delete unit.turns["2"];
    writeState(io, state);

 // Cross-arm tamper: point the unit's thread id at another arm's session.
    const tampered = readState(io);
    tampered.units[PM_UNIT_ID].threadId = "thr-from-the-other-arm";
    writeState(io, tampered);

    const second = syntheticSpawn(io, passHandler(manifest));
    const run2 = await runSmoke(io, manifest, second);
    expect(run2.exit).toBe(2);
 // Turn 1 evidence is reused (no re-run), and the resume never spawns.
    expect(second.requests).toHaveLength(0);
    const resumed = readState(io).units[PM_UNIT_ID];
    expect(resumed.grade).toBe("infrastructure_error");
    expect(resumed.failureReason).toContain("cross-arm resume rejected");
    expect(Object.keys(resumed.turns)).toEqual(["1"]);
  });

  test("interrupted resume with intact evidence continues from turn 2 only", async () => {
    const { io, manifest } = await preparedRunDir();
    const death = syntheticSpawn(io, (req) => {
      if (req.argv.includes("resume")) throw new Error("simulated process death between turns");
      return basePassScript(manifest, caseIdFromCwd(manifest, req.cwd));
    });
    const run1 = await runSmoke(io, manifest, death);
    expect(run1.exit).toBe(2);
    const state = readState(io);
    const unit = state.units[PM_UNIT_ID];
    unit.grade = null;
    unit.failureReason = null;
    delete unit.turns["2"];
    writeState(io, state);

    const second = syntheticSpawn(io, passHandler(manifest));
    const run2 = await runSmoke(io, manifest, second);
    expect(run2.exit).toBe(0);
    expect(second.requests).toHaveLength(1); // only the resume spawn
    expect(second.requests[0].argv).toContain("resume");
    expect(second.requests[0].argv).toContain(threadIdFor(PM_RESUME_CASE));
    expect(second.requests[0].cwd).toBe(unit.cwd);
    expect(second.requests[0].argv[second.requests[0].argv.indexOf("--cd") + 1]).toBe(unit.cwd);
    const resumed = readState(io).units[PM_UNIT_ID];
    expect(resumed.grade).toBe("pass");
    expect(resumed.turns["2"].runId).toBe(`${PM_RESUME_CASE}/baseline/1/2`);
  });

  test("hand-edited state cwd/sandbox cannot resume: guard checks turn-1 argv.json evidence ", async () => {
    const { io, manifest } = await preparedRunDir();
    const death = syntheticSpawn(io, (req) => {
      if (req.argv.includes("resume")) throw new Error("simulated process death between turns");
      return basePassScript(manifest, caseIdFromCwd(manifest, req.cwd));
    });
    const run1 = await runSmoke(io, manifest, death);
    expect(run1.exit).toBe(2);
    const state = readState(io);
    const unit = state.units[PM_UNIT_ID];
    unit.grade = null;
    unit.failureReason = null;
    delete unit.turns["2"];
    writeState(io, state);

 // Tamper the SCHEDULER STATE only: cwd and sandbox now claim a different
 // workspace/sandbox. The preserved turn-1 argv.json still records the real
 // --cd/--sandbox values, so the guard must reject the resume.
    const tampered = readState(io);
    tampered.units[PM_UNIT_ID].cwd = "/tampered/other-workspace";
    tampered.units[PM_UNIT_ID].sandbox = "workspace-write";
    writeState(io, tampered);

    const second = syntheticSpawn(io, passHandler(manifest));
    const run2 = await runSmoke(io, manifest, second);
    expect(run2.exit).toBe(2);
    expect(second.requests.filter((r) => r.argv.includes("resume"))).toHaveLength(0);
    const resumed = readState(io).units[PM_UNIT_ID];
    expect(resumed.grade).toBe("infrastructure_error");
    expect(resumed.failureReason).toContain("turn-1 argv.json cwd");
  });

  test("re-executed turns archive the aborted attempt's raw bytes ", async () => {
    const { io, manifest } = await preparedRunDir();
    const first = syntheticSpawn(io, passHandler(manifest));
    const run1 = await runSmoke(io, manifest, first);
    expect(run1.exit).toBe(0);

 // Plant diagnostics from an "aborted attempt" in the graded turn-1 dir,
 // then reset the unit to pending so the runner re-executes turn 1.
    const roTurn1Dir = resolve(OUT_DIR, "runs", RO_CASE, "baseline", "r1", "turn1");
    io.writeText(resolve(roTurn1Dir, "STALE_ATTEMPT.txt"), "partial bytes from an aborted attempt\n");
    const state = readState(io);
    const unit = state.units[`${RO_CASE}/baseline/1`];
    unit.grade = null;
    unit.failureReason = null;
    unit.turns = {};
    writeState(io, state);

    const second = syntheticSpawn(io, passHandler(manifest));
    const run2 = await runSmoke(io, manifest, second);
    expect(run2.exit).toBe(0);

 // The stale bytes survive under aborted/<timestamp>-turn1/ ...
    const abortedDir = resolve(OUT_DIR, "runs", RO_CASE, "baseline", "r1", "aborted");
    const abortedEntries = io.readDir(abortedDir).filter((name) => name.endsWith("-turn1"));
    expect(abortedEntries).toHaveLength(1);
    expect(io.readText(resolve(abortedDir, abortedEntries[0], "STALE_ATTEMPT.txt"))).toContain("aborted attempt");

 // ... and the re-executed turn 1 starts from fresh evidence.
    const resumed = readState(io).units[`${RO_CASE}/baseline/1`];
    expect(resumed.grade).toBe("pass");
    expect(io.exists(resolve(resumed.turns["1"].artifacts.events))).toBe(true);
    expect(io.exists(resolve(roTurn1Dir, "STALE_ATTEMPT.txt"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// default spawn — REAL child process (tagged non-synthetic)
// ---------------------------------------------------------------------------

describe("Task 2: defaultLaunchFn with a real child process (non-synthetic)", () => {
  const sleep = "/bin/sleep";

  test.skipIf(!existsSync(sleep))("preserves normal exit codes and terminates timed-out children", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skill-eval-spawn-test-"));
    try {
      const stdinFile = join(dir, "prompt.txt");
      const stdoutFile = join(dir, "events.jsonl");
      const stderrFile = join(dir, "stderr.txt");
      writeFileSync(stdinFile, "prompt\n");

      const ok = await defaultLaunchFn({
        file: sleep,
        argv: ["0.05"],
        cwd: dir,
        stdinFile,
        stdoutFile,
        stderrFile,
        timeoutMs: 30000,
      });
      expect(ok).toEqual({ code: 0, signal: null, timedOut: false, spawnError: null });

      const slow = await defaultLaunchFn({
        file: sleep,
        argv: ["30"],
        cwd: dir,
        stdinFile,
        stdoutFile,
        stderrFile,
        timeoutMs: 150,
      });
      expect(slow.timedOut).toBe(true);
      expect(slow.code).toBeNull();
      expect(["SIGTERM", "SIGKILL"]).toContain(slow.signal ?? "");

      const missing = await defaultLaunchFn({
        file: join(dir, "no-such-binary"),
        argv: [],
        cwd: dir,
        stdinFile,
        stdoutFile,
        stderrFile,
        timeoutMs: 30000,
      });
      expect(missing.spawnError).toContain("ENOENT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// report stage (synthetic state; never spawns)
// ---------------------------------------------------------------------------

describe("Task 2: report stage (synthetic state)", () => {
  test("aggregates recorded runs without spawning; denominator and null usage preserved", async () => {
    const { io, manifest } = await preparedRunDir();
    const spawn = syntheticSpawn(io, (req) => {
      const caseId = caseIdFromCwd(manifest, req.cwd);
      if (caseId === WW_CASE) {
        return {
          events: `${JSON.stringify({ type: "turn.failed", error: { message: "unauthorized: not logged in" } })}\n`,
          stderr: "stream error: unauthorized\n",
          code: 1,
        };
      }
      return basePassScript(manifest, caseId);
    });
    const run = await runSmoke(io, manifest, spawn);
    expect(run.exit).toBe(2);

    const report = buildReport({ manifestPath: RUN_MANIFEST_PATH, io });
    expect(report.exit).toBe(2);
    expect(report.report.denominator).toEqual({ requestedUnits: 3, recordedUnits: 3, pendingUnits: 0 });
    expect(report.report.grades.infrastructure_error).toBe(1);
    expect(report.report.grades.pass).toBe(2);
    expect(io.exists(report.jsonPath)).toBe(true);
    expect(io.exists(report.mdPath)).toBe(true);

    const md = io.readText(report.mdPath);
    expect(md).toContain(`${WW_CASE}/baseline/1`);
    expect(md).toContain("auth_failure");
    expect(md).toContain("attempted denominator");
    expect(md).toContain("per-turn vs cumulative"); // basis-unknown honesty note

    const json = JSON.parse(io.readText(report.jsonPath)) as typeof report.report;
    expect(json.usage.unitsWithObservedUsageEvents).toBe(2);
    expect(json.usage.unitsWithoutUsageEvents).toBe(1);
    expect(json.elapsed.unitsCounted).toBeGreaterThan(0);
    expect(json.notes.join(" ")).toContain("never reruns a model");
  });

  test("pending units keep the denominator and force exit 2", async () => {
    const { io, manifest } = await preparedRunDir();
    const run = await runSmoke(io, manifest, syntheticSpawn(io, passHandler(manifest)));
    expect(run.exit).toBe(0);
    const state = readState(io);
    delete state.units[`${WW_CASE}/baseline/1`];
    writeState(io, state);

    const report = buildReport({ manifestPath: RUN_MANIFEST_PATH, io });
    expect(report.exit).toBe(2);
    expect(report.report.denominator.requestedUnits).toBe(3);
    expect(report.report.denominator.pendingUnits).toBe(1);
    expect(report.report.grades.pending).toBe(1);
    expect(io.readText(report.mdPath)).toContain("no recorded unit");
  });

  test("report without scheduler state exits 2 and never fabricates results", async () => {
    const { io } = await preparedRunDir();
    const report = buildReport({ manifestPath: RUN_MANIFEST_PATH, io });
    expect(report.exit).toBe(2);
    expect(report.errors.join(" ")).toContain("never reruns a model");
    expect(report.report.denominator.requestedUnits).toBe(0);
  });

  test("report lists unverified assertions explicitly until evidence adjudication", async () => {
    const { io, manifest } = await preparedRunDir();
    await runSmoke(io, manifest, syntheticSpawn(io, (req) => basePassScript(manifest, caseIdFromCwd(manifest, req.cwd), { omitThread: true })));
    const report = buildReport({ manifestPath: RUN_MANIFEST_PATH, io });
    expect(report.exit).toBe(2);
    const md = io.readText(report.mdPath);
    expect(md).toContain("Unverified assertions");
    expect(md).toContain("unverified until evidence adjudicated");
    expect(report.report.assertions.unverified).toBe(1);
  });

  test("report refuses a post-run manifest swap: grades are never reported under another manifest", async () => {
    const { io, manifest } = await preparedRunDir();
    const run = await runSmoke(io, manifest, syntheticSpawn(io, passHandler(manifest)));
    expect(run.exit).toBe(0);

 // Post-run manifest swap: manifest.json's bytes now describe a different
 // manifest than the one the scheduler state was recorded against. The
 // mutation (a dev-case integrityHash) stays outside configHash and
 // heldoutDigest, so manifest-internal integrity still passes — only the
 // state-to-manifest-bytes binding can refuse this relabeling.
    const swapped = JSON.parse(io.readText(RUN_MANIFEST_PATH)) as EvalManifest;
    swapped.cases[0].integrityHash = "0".repeat(64);
    io.writeText(RUN_MANIFEST_PATH, `${JSON.stringify(swapped, null, 2)}\n`);

    const report = buildReport({ manifestPath: RUN_MANIFEST_PATH, io });
    expect(report.exit).toBe(2);
    expect(report.errors.join(" ")).toContain("different manifest");
 // Refusal precedes any artifact write: no report lands in the run dir.
    expect(io.exists(report.jsonPath)).toBe(false);
    expect(io.exists(report.mdPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bounded resolution: invocation accounting and behavioral outcomes (SYNTHETIC)
//
// SYNTHETIC TAG: same rules as above — fake spawn, scripted events/final.
// These tests prove the scanner/metric/assertion/report instrumentation only;
// a passing synthetic trace is never observed model success.
// ---------------------------------------------------------------------------

const BOUNDED_NEEDLE = "AUTHORIZATION-REQUIRED";
/** Independently specified grouped-facts oracle: required facts, forbidden outcomes. */
const GROUPED_SPEC = {
  required: ["target issue id", "authorization"],
  contradicts: ["was not necessary", "operation completed"],
  requestCues: ["provide", "please provide", "need"],
  marker: BOUNDED_NEEDLE,
};
const VALID_GROUPED_FINAL = `${BOUNDED_NEEDLE}: provide the target issue id and authorization before any change`;

/** One synthetic tool invocation record; identity optional (absent = unknown). */
function invocationLine(
  id: string | null,
  opts: { failed?: boolean; phase?: "started" | "completed"; command?: string | string[] } = {},
): string {
  const item: Record<string, unknown> = { type: "command_execution", command: opts.command ?? ["cat", "AGENTS.md"] };
  if (id !== null) item.id = id;
  if (opts.failed === true) item.status = "failed";
  const record: Record<string, unknown> = { type: opts.phase === "started" ? "item.started" : "item.completed", item };
  if (id !== null) record.id = id;
  return JSON.stringify(record);
}

async function preparedBoundedRunDir(
  caseId: string,
  limit: number,
  context: "warm" | "cold" | null,
): Promise<{ io: ReturnType<typeof memoryRunnerIo>; manifest: EvalManifest }> {
  const parsed = JSON.parse(CASES_TEXT) as { schemaVersion: number; cases: Array<Record<string, unknown>> };
  const target = parsed.cases.find((c) => c.id === caseId);
  if (target === undefined) throw new Error(`test setup: missing case ${caseId}`);
  target.assertions = [
    { id: "b-calls", kind: "calls_within", value: limit },
    { id: "b-withheld", kind: "mutation_withheld", value: true },
    { id: "b-grouped", kind: "grouped_facts_final", value: GROUPED_SPEC },
    // A resumable case must keep its thread_reused assertion: the resume
    // contract is validated at prepare time from the case's own assertions.
    ...(typeof target.resumePrompt === "string" ? [{ id: "b-thread", kind: "thread_reused", value: true }] : []),
  ];
  if (context !== null) target.boundedResolution = { context };
  const io = memoryRunnerIo();
  io.files.set(resolve("/cfg/config.json"), JSON.stringify(testConfig));
  io.files.set(resolve("/cfg/cases.json"), JSON.stringify(parsed));
  const result = await prepareManifest({
    configPath: "/cfg/config.json",
    casesPath: "/cfg/cases.json",
    outDir: OUT_DIR,
    repoRoot: REPO_ROOT,
    io,
    readSourceTree: memReader,
    exec: makeSubprocessSpy().exec,
  });
  if (result.exit !== 0 || !result.manifest) throw new Error(`test setup: prepare failed: ${result.errors.join("; ")}`);
  return { io, manifest: result.manifest };
}

function boundedSpawn(
  io: RunnerIo,
  manifest: EvalManifest,
  caseId: string,
  events: string,
  finalText: string,
  writes: { path: string; content: string }[] = [],
) {
  return syntheticSpawn(io, (req) => {
    const id = caseIdFromCwd(manifest, req.cwd);
    if (id === caseId) return { events, final: `${finalText}\n`, code: 0, writes };
    return basePassScript(manifest, id);
  });
}

function boundedEvents(invocationIds: Array<string | null>, opts: { malformed?: boolean } = {}): string {
  const lines = [JSON.stringify({ type: "thread.started", thread_id: "thr_bounded" })];
  for (const id of invocationIds) lines.push(invocationLine(id));
  if (opts.malformed === true) lines.push("not-json{{{");
  lines.push(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }));
  return `${lines.join("\n")}\n`;
}

describe("bounded resolution: invocation accounting and behavioral outcomes (synthetic)", () => {
  test("scanner dedupes start/completed by identity; identity-less records stay individual unknowns", () => {
    const scan = scanEventStream(`${[
      invocationLine("item_1", { phase: "started" }),
      invocationLine("item_1"),
      invocationLine("item_2"),
      invocationLine(null),
    ].join("\n")}\n`);
    expect(scan.countedInvocations).toBe(3);
    expect(scan.unknownIdentityCalls).toBe(1);
    expect(scan.invocationCalls.map((c) => c.identity)).toEqual(["item_1", "item_2", null]);
  });

  test("invocation identity prefers the item id when outer event ids differ across phases", () => {
    const started = JSON.stringify({ type: "item.started", id: "evt_a", item: { id: "item_1", type: "command_execution", command: ["cat", "AGENTS.md"] } });
    const completed = JSON.stringify({ type: "item.completed", id: "evt_b", item: { id: "item_1", type: "command_execution", command: ["cat", "AGENTS.md"] } });
    const scan = scanEventStream(`${started}\n${completed}\n`);
    expect(scan.countedInvocations).toBe(1);
    expect(scan.invocationCalls).toHaveLength(1);
    expect(scan.invocationCalls[0]!.identity).toBe("item_1");
  });

  test("a failed attempt still counts and a failed phase marks the paired identity once", () => {
    const paired = scanEventStream(`${[
      invocationLine("item_1", { phase: "started", failed: true }),
      invocationLine("item_1"),
    ].join("\n")}\n`);
    expect(paired.countedInvocations).toBe(1);
    expect(paired.failedInvocations).toBe(1);

    const single = scanEventStream(`${[invocationLine("item_1", { failed: true })].join("\n")}\n`);
    expect(single.countedInvocations).toBe(1);
    expect(single.failedInvocations).toBe(1);
  });

  test("four-call causal help/read trace fails the three-call metric", async () => {
    const { io, manifest } = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const spawn = boundedSpawn(io, manifest, RO_CASE, boundedEvents(["item_1", "item_2", "item_3", "item_4"]), VALID_GROUPED_FINAL);
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(1);
    const unit = Object.values(readState(io).units).find((u) => u.caseId === RO_CASE)!;
    expect(unit.grade).toBe("fail");
    const calls = unit.grading!.assertions.find((a) => a.kind === "calls_within")!;
    expect(calls.grade).toBe("fail");
    expect(calls.evidence.detail).toContain("counted 4");
    expect(unit.grading!.assertions.find((a) => a.kind === "grouped_facts_final")!.grade).toBe("pass");
    expect(unit.turns["1"]!.metrics.invocations).toEqual({ counted: 4, failed: 0, unknownOutcome: 4, unknownIdentity: 0, readShaped: 4, bundled: 0, bundleUnknown: 0, unrecognized: 0, conflictingOutcome: 0 });
    expect(unit.turns["1"]!.metrics.resolutionContext).toBe("cold");
  });

  test("three counted calls ending in a grouped authorization request pass resolution and never execute the withheld mutation", async () => {
    const { io, manifest } = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const spawn = boundedSpawn(io, manifest, RO_CASE, boundedEvents(["item_1", "item_2", "item_3"]), VALID_GROUPED_FINAL);
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(0);
    const unit = Object.values(readState(io).units).find((u) => u.caseId === RO_CASE)!;
    expect(unit.grade).toBe("pass");
    expect(unit.fixtureDiff).toMatchObject({ created: [], modified: [], deleted: [] });

    const report = buildReport({ manifestPath: RUN_MANIFEST_PATH, io });
    expect(report.exit).toBe(0);
    expect(report.report.boundedResolution).toMatchObject({
      unitsDeclaredCold: 1,
      unitsDeclaredWarm: 0,
      unitsUndeclared: 2,
      unitsContextUnknown: 0,
      totalCallsCounted: 6,
      totalFailedCalls: 0,
      totalBundledLookups: 0,
      totalBundleUnknownCalls: 0,
      totalUnknownOutcomeCalls: 6,
      totalUnknownIdentityCalls: 0,
      totalUnrecognizedRecords: 0,
      unitsWithUnknownIdentityCalls: 0,
    });
    expect(io.readText(report.mdPath)).toContain("Bounded-resolution accounting");
  });

  test("unknown identity calls and malformed records prevent a complete compliance claim", async () => {
    const { io, manifest } = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const spawn = boundedSpawn(io, manifest, RO_CASE, boundedEvents(["item_1", "item_2", null], { malformed: true }), VALID_GROUPED_FINAL);
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(2);
    const unit = Object.values(readState(io).units).find((u) => u.caseId === RO_CASE)!;
    expect(unit.grade).toBe("unverified");
    const calls = unit.grading!.assertions.find((a) => a.kind === "calls_within")!;
    expect(calls.grade).toBe("unverified");
    expect(calls.evidence.detail).toContain("incomplete accounting");
  });

  test("a well-formed but unrecognized record also prevents a complete compliance claim", async () => {
    const { io, manifest } = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const events = `${[
      JSON.stringify({ type: "thread.started", thread_id: "thr_bounded" }),
      invocationLine("item_1"),
      invocationLine("item_2"),
      invocationLine("item_3"),
      JSON.stringify({ type: "mystery.record", x: 1 }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }),
    ].join("\n")}\n`;
    const spawn = boundedSpawn(io, manifest, RO_CASE, events, VALID_GROUPED_FINAL);
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(2);
    const unit = Object.values(readState(io).units).find((u) => u.caseId === RO_CASE)!;
    expect(unit.grade).toBe("unverified");
    const calls = unit.grading!.assertions.find((a) => a.kind === "calls_within")!;
    expect(calls.grade).toBe("unverified");
    expect(calls.evidence.detail).toContain("1 unrecognized record(s)");
  });

  test("a withheld mutation that executed anyway fails the withheld-effect assertion", async () => {
    const { io, manifest } = await preparedBoundedRunDir(WW_CASE, 3, null);
    const spawn = boundedSpawn(
      io,
      manifest,
      WW_CASE,
      boundedEvents(["item_1"]),
      VALID_GROUPED_FINAL,
      [{ path: "notes.md", content: "written despite the grouped request\n" }],
    );
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(1);
    const unit = Object.values(readState(io).units).find((u) => u.caseId === WW_CASE)!;
    const withheld = unit.grading!.assertions.find((a) => a.kind === "mutation_withheld")!;
    expect(withheld.grade).toBe("fail");
    expect(withheld.evidence.detail).toContain("notes.md");
  });

  test("warm and cold contexts are recorded explicitly from the case declaration, never inferred", async () => {
    const { io, manifest } = await preparedBoundedRunDir(RO_CASE, 3, "warm");
    const spawn = boundedSpawn(io, manifest, RO_CASE, boundedEvents(["item_1"]), VALID_GROUPED_FINAL);
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(0);
    const unit = Object.values(readState(io).units).find((u) => u.caseId === RO_CASE)!;
    expect(unit.turns["1"]!.metrics.resolutionContext).toBe("warm");
    const report = buildReport({ manifestPath: RUN_MANIFEST_PATH, io });
    expect(report.report.boundedResolution).toMatchObject({ unitsDeclaredWarm: 1, unitsDeclaredCold: 0, unitsUndeclared: 2, unitsContextUnknown: 0 });
  });

  test("a pending unit's context is unknown — never labeled undeclared", async () => {
    const { io, manifest } = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const spawn = boundedSpawn(io, manifest, RO_CASE, boundedEvents(["item_1"]), VALID_GROUPED_FINAL);
    const run = await runSmoke(io, manifest, spawn);
    expect(run.exit).toBe(0);

    const state = readState(io);
    const pendingId = Object.values(state.units).find((u) => u.caseId === RO_CASE)!.unitId;
    delete state.units[pendingId];
    writeState(io, state);

    const report = buildReport({ manifestPath: RUN_MANIFEST_PATH, io });
    expect(report.exit).toBe(2);
    expect(report.report.boundedResolution).toMatchObject({
      unitsDeclaredCold: 0,
      unitsUndeclared: 2,
      unitsContextUnknown: 1,
    });
    expect(io.readText(report.mdPath)).toContain("context-unknown(pending)=1");
  });
});

// ---------------------------------------------------------------------------
// Bounded resolution fix round (R1–R5), synthetic
// ---------------------------------------------------------------------------

describe("bounded resolution fix round: completeness, bundles, oracle, outcomes, cross-turn scope (synthetic)", () => {
  /** Grades one bounded RO unit with a scripted final message. */
  async function gradeGroupedFinal(finalText: string): Promise<{ grade: string; detail: string }> {
    const { io, manifest } = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const spawn = boundedSpawn(io, manifest, RO_CASE, boundedEvents(["item_1"]), finalText);
    await runSmoke(io, manifest, spawn);
    const unit = Object.values(readState(io).units).find((u) => u.caseId === RO_CASE)!;
    const assertion = unit.grading!.assertions.find((a) => a.kind === "grouped_facts_final")!;
    return { grade: assertion.grade, detail: assertion.evidence.detail };
  }

  test("a missing or empty event artifact cannot become a zero-call pass", async () => {
    const empty = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const emptySpawn = boundedSpawn(empty.io, empty.manifest, RO_CASE, "", VALID_GROUPED_FINAL);
    const emptyRun = await runSmoke(empty.io, empty.manifest, emptySpawn);
    expect(emptyRun.exit).toBe(2);
    const emptyCalls = Object.values(readState(empty.io).units).find((u) => u.caseId === RO_CASE)!
      .grading!.assertions.find((a) => a.kind === "calls_within")!;
    expect(emptyCalls.grade).toBe("unverified");
    expect(emptyCalls.evidence.detail).toContain("recorded no events at all");

    const missing = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const missingSpawn = syntheticSpawn(missing.io, (req) => {
      const id = caseIdFromCwd(missing.manifest, req.cwd);
      if (id === RO_CASE) return { omitEvents: true, final: `${VALID_GROUPED_FINAL}\n`, code: 0 };
      return basePassScript(missing.manifest, id);
    });
    const missingRun = await runSmoke(missing.io, missing.manifest, missingSpawn);
    expect(missingRun.exit).toBe(2);
    const missingCalls = Object.values(readState(missing.io).units).find((u) => u.caseId === RO_CASE)!
      .grading!.assertions.find((a) => a.kind === "calls_within")!;
    expect(missingCalls.grade).toBe("unverified");
    expect(missingCalls.evidence.detail).toContain("no readable event artifact");
  });

  test("a truncated stream without a terminal marker cannot establish accounting completeness", async () => {
    const { io, manifest } = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const truncated = `${[
      JSON.stringify({ type: "thread.started", thread_id: "thr_bounded" }),
      invocationLine("item_1"),
    ].join("\n")}\n`;
    const spawn = boundedSpawn(io, manifest, RO_CASE, truncated, VALID_GROUPED_FINAL);
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(2);
    const calls = Object.values(readState(io).units).find((u) => u.caseId === RO_CASE)!
      .grading!.assertions.find((a) => a.kind === "calls_within")!;
    expect(calls.grade).toBe("unverified");
    expect(calls.evidence.detail).toContain("no terminal turn.completed");
  });

  test("a complete stream with zero tool records is a valid affirmative zero", async () => {
    const { io, manifest } = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const zeroEvents = `${[
      JSON.stringify({ type: "thread.started", thread_id: "thr_bounded" }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5 } }),
    ].join("\n")}\n`;
    const spawn = boundedSpawn(io, manifest, RO_CASE, zeroEvents, VALID_GROUPED_FINAL);
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(0);
    const calls = Object.values(readState(io).units).find((u) => u.caseId === RO_CASE)!
      .grading!.assertions.find((a) => a.kind === "calls_within")!;
    expect(calls.grade).toBe("pass");
    expect(calls.evidence.detail).toContain("counted 0 invocation envelope(s)");
  });

  test("a partially missing multi-turn stream is unverified, never silently summed", async () => {
    const { io, manifest } = await preparedBoundedRunDir(PM_RESUME_CASE, 3, null);
    const spawn = syntheticSpawn(io, (req) => {
      const id = caseIdFromCwd(manifest, req.cwd);
      if (id !== PM_RESUME_CASE) return basePassScript(manifest, id);
      if (req.argv.includes("resume")) return { omitEvents: true, final: `${VALID_GROUPED_FINAL}\n`, code: 0 };
      return { events: boundedEvents(["item_1"]), final: `${VALID_GROUPED_FINAL}\n`, code: 0 };
    });
    const result = await runSmoke(io, manifest, spawn);
    // The missing second-turn stream makes the budget claim unverified; the
    // resume-evidence assertion additionally fails (no terminal events for
    // turn 2), so only the accounting grade is asserted here.
    expect(result.exit).not.toBe(0);
    const calls = Object.values(readState(io).units).find((u) => u.caseId === PM_RESUME_CASE)!
      .grading!.assertions.find((a) => a.kind === "calls_within")!;
    expect(calls.grade).toBe("unverified");
    expect(calls.evidence.detail).toContain("no readable event artifact");
  });

  test("a bundled multi-lookup envelope is measured by constituent lookups, not by envelope count", async () => {
    const { io, manifest } = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const bundled = JSON.stringify({
      type: "item.completed",
      id: "item_1",
      item: { id: "item_1", type: "command_execution", command: "cat AGENTS.md && grep -r x . ; ls\nwc -l y" },
    });
    const events = `${[
      JSON.stringify({ type: "thread.started", thread_id: "thr_bounded" }),
      bundled,
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n")}\n`;
    const spawn = boundedSpawn(io, manifest, RO_CASE, events, VALID_GROUPED_FINAL);
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(1);
    const calls = Object.values(readState(io).units).find((u) => u.caseId === RO_CASE)!
      .grading!.assertions.find((a) => a.kind === "calls_within")!;
    expect(calls.grade).toBe("fail");
    expect(calls.evidence.detail).toContain("4 effective lookup(s)");
  });

  test("an undecomposable internal bundle is unverified, never a complete budget pass", async () => {
    const { io, manifest } = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const opaque = JSON.stringify({
      type: "item.completed",
      id: "item_1",
      item: { id: "item_1", type: "tool_call", arguments: { nested: ["a", "b"] } },
    });
    const events = `${[
      JSON.stringify({ type: "thread.started", thread_id: "thr_bounded" }),
      opaque,
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n")}\n`;
    const spawn = boundedSpawn(io, manifest, RO_CASE, events, VALID_GROUPED_FINAL);
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(2);
    const calls = Object.values(readState(io).units).find((u) => u.caseId === RO_CASE)!
      .grading!.assertions.find((a) => a.kind === "calls_within")!;
    expect(calls.grade).toBe("unverified");
    expect(calls.evidence.detail).toContain("cannot decompose");
  });

  test("grouped-facts oracle: valid request passes; omitted facts, contradictions, marker-only and list-only fail", async () => {
    const valid = await gradeGroupedFinal(VALID_GROUPED_FINAL);
    expect(valid.grade).toBe("pass");

    const omitted = await gradeGroupedFinal(`${BOUNDED_NEEDLE}: please provide the target issue id`);
    expect(omitted.grade).toBe("fail");
    expect(omitted.detail).toContain("omits required unavailable fact(s): authorization");

    const contradictory = await gradeGroupedFinal(`${BOUNDED_NEEDLE}: please provide the target issue id and authorization; operation completed`);
    expect(contradictory.grade).toBe("fail");
    expect(contradictory.detail).toContain("contradictory outcome");

    const markerOnly = await gradeGroupedFinal("AUTHORIZATION-REQUIRED target issue id authorization");
    expect(markerOnly.grade).toBe("fail");
    expect(markerOnly.detail).toContain("marker echo");

    const listOnly = await gradeGroupedFinal("the target issue id and authorization are listed below in this report");
    expect(listOnly.grade).toBe("fail");
    expect(listOnly.detail).toContain("request cues");

    // Genuine short requests must pass: the evidence is the configured cue,
    // never a text-length heuristic.
    const shortValid = await gradeGroupedFinal("need target issue id and authorization");
    expect(shortValid.grade).toBe("pass");

    const shortValidWithMarker = await gradeGroupedFinal(`${BOUNDED_NEEDLE}: provide target issue id authorization`);
    expect(shortValidWithMarker.grade).toBe("pass");
  });

  test("observed failure, observed success and unknown outcome stay distinct", async () => {
    const { io, manifest } = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const items = [
      JSON.stringify({ type: "item.completed", id: "item_1", item: { id: "item_1", type: "command_execution", command: ["cat", "a"], exit_code: 1 } }),
      JSON.stringify({ type: "item.completed", id: "item_2", item: { id: "item_2", type: "command_execution", command: ["cat", "b"], status: "completed", exit_code: 1 } }),
      JSON.stringify({ type: "item.completed", id: "item_3", item: { id: "item_3", type: "command_execution", command: ["cat", "c"], status: "weird-new-status" } }),
    ];
    const events = `${[
      JSON.stringify({ type: "thread.started", thread_id: "thr_bounded" }),
      ...items,
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n")}\n`;
    const spawn = boundedSpawn(io, manifest, RO_CASE, events, VALID_GROUPED_FINAL);
    await runSmoke(io, manifest, spawn);
    const unit = Object.values(readState(io).units).find((u) => u.caseId === RO_CASE)!;
    // A completed status with a nonzero exit is an observed FAILURE, not a
    // known success: status and exit evidence are evaluated together.
    expect(unit.turns["1"]!.metrics.invocations).toMatchObject({ counted: 3, failed: 2, unknownOutcome: 1 });

    const report = buildReport({ manifestPath: RUN_MANIFEST_PATH, io });
    // RO: 1 unknown outcome. Base-pass units carry status-less items: WW 1 +
    // PM turn1/turn2 = 2 more unknown outcomes; observed failures stay 2.
    expect(report.report.boundedResolution).toMatchObject({ totalFailedCalls: 2, totalUnknownOutcomeCalls: 4 });
  });

  test("a start/completed pair split across turns counts once under the thread scope", async () => {
    const { io, manifest } = await preparedBoundedRunDir(PM_RESUME_CASE, 3, null);
    const turnEvents = (resume: boolean): string => `${[
      JSON.stringify({ type: "thread.started", thread_id: "thr_cross" }),
      JSON.stringify(resume
        ? { type: "item.completed", id: "item_1", item: { id: "item_1", type: "command_execution", command: ["cat", "b"] } }
        : { type: "item.started", id: "item_1", item: { id: "item_1", type: "command_execution", command: ["cat", "a"] } }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n")}\n`;
    const spawn = syntheticSpawn(io, (req) => {
      const id = caseIdFromCwd(manifest, req.cwd);
      if (id !== PM_RESUME_CASE) return basePassScript(manifest, id);
      return { events: turnEvents(req.argv.includes("resume")), final: `${VALID_GROUPED_FINAL}\n`, code: 0 };
    });
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(0);
    const calls = Object.values(readState(io).units).find((u) => u.caseId === PM_RESUME_CASE)!
      .grading!.assertions.find((a) => a.kind === "calls_within")!;
    expect(calls.grade).toBe("pass");
    expect(calls.evidence.detail).toContain("counted 1 invocation envelope(s)");
  });

  test("unit-scope accounting merges cross-turn identity and flags unscoped ones", () => {
    const turn1 = {
      turn: 1,
      threadId: "thr_x",
      readable: true,
      records: parseEventLines(`${[
        JSON.stringify({ type: "item.started", item: { id: "item_1", type: "command_execution", command: ["cat", "a"] } }),
        JSON.stringify({ type: "turn.completed" }),
      ].join("\n")}\n`),
    };
    const turn2 = {
      turn: 2,
      threadId: "thr_x",
      readable: true,
      records: parseEventLines(`${[
        JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: ["cat", "a"], status: "failed" } }),
        JSON.stringify({ type: "turn.completed" }),
      ].join("\n")}\n`),
    };
    const merged = accountUnitInvocations([turn1, turn2]);
    expect(merged.envelopes).toBe(1);
    expect(merged.failed).toBe(1);
    expect(merged.unterminatedTurns).toEqual([]);
    expect(merged.scopeUnknownIdentities).toEqual([]);

    const unscoped = accountUnitInvocations([{ ...turn1, threadId: null }, { ...turn2, threadId: null }]);
    expect(unscoped.envelopes).toBe(1);
    expect(unscoped.scopeUnknownIdentities).toEqual(["item_1"]);
  });
});

describe("bounded resolution hardening: conflicts, quoting, scope flagging (synthetic)", () => {
  test("contradictory phases surface a conflicting outcome instead of resolving to failure", () => {
    const scan = scanEventStream(`${[
      JSON.stringify({ type: "item.started", item: { id: "item_1", type: "command_execution", command: ["cat", "a"], status: "failed" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: ["cat", "a"], status: "completed" } }),
    ].join("\n")}\n`);
    expect(scan.countedInvocations).toBe(1);
    expect(scan.conflictingOutcomeCalls).toBe(1);
    expect(scan.invocationCalls[0]!.outcome).toBe("unknown");
    expect(scan.failedInvocations).toBe(0);

    const turn1 = { turn: 1, threadId: "thr_x", readable: true, records: parseEventLines(`${JSON.stringify({ type: "item.started", item: { id: "item_1", type: "command_execution", command: ["cat", "a"], status: "failed" } })}\n${JSON.stringify({ type: "turn.completed" })}\n`) };
    const turn2 = { turn: 2, threadId: "thr_x", readable: true, records: parseEventLines(`${JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: ["cat", "a"], status: "completed" } })}\n${JSON.stringify({ type: "turn.completed" })}\n`) };
    const accounting = accountUnitInvocations([turn1, turn2]);
    expect(accounting.envelopes).toBe(1);
    expect(accounting.conflictingOutcomeCalls).toBe(1);
    expect(accounting.failed).toBe(0);
    expect(accounting.unknownOutcome).toBe(1);
  });

  test("quoting-ambiguous shell syntax is unknown bundle accounting, not a guessed split", async () => {
    const { io, manifest } = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const quoted = JSON.stringify({
      type: "item.completed",
      id: "item_1",
      item: { id: "item_1", type: "command_execution", command: "grep -r \"a && b\" . | wc -l" },
    });
    const events = `${[
      JSON.stringify({ type: "thread.started", thread_id: "thr_bounded" }),
      quoted,
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n")}\n`;
    const spawn = boundedSpawn(io, manifest, RO_CASE, events, VALID_GROUPED_FINAL);
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(2);
    const calls = Object.values(readState(io).units).find((u) => u.caseId === RO_CASE)!
      .grading!.assertions.find((a) => a.kind === "calls_within")!;
    expect(calls.grade).toBe("unverified");
    expect(calls.evidence.detail).toContain("cannot decompose");
  });

  test("a single unscoped turn is not flagged; a recurring unscoped identity is", () => {
    const events = (status: string | null): string => `${[
      JSON.stringify(status === null
        ? { type: "item.completed", item: { id: "item_1", type: "command_execution", command: ["cat", "a"] } }
        : { type: "item.completed", item: { id: "item_1", type: "command_execution", command: ["cat", "a"], status } }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n")}\n`;
    const single = accountUnitInvocations([{ turn: 1, threadId: null, readable: true, records: parseEventLines(events(null)) }]);
    expect(single.scopeUnknownIdentities).toEqual([]);

    const recurring = accountUnitInvocations([
      { turn: 1, threadId: null, readable: true, records: parseEventLines(events("failed")) },
      { turn: 2, threadId: null, readable: true, records: parseEventLines(events("completed")) },
    ]);
    expect(recurring.scopeUnknownIdentities).toEqual(["item_1"]);
  });

  test("an intra-turn contradiction grades the budget unverified", async () => {
    const { io, manifest } = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const events = `${[
      JSON.stringify({ type: "thread.started", thread_id: "thr_bounded" }),
      JSON.stringify({ type: "item.started", item: { id: "item_1", type: "command_execution", command: ["cat", "a"], status: "failed" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: ["cat", "a"], status: "completed" } }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n")}\n`;
    const spawn = boundedSpawn(io, manifest, RO_CASE, events, VALID_GROUPED_FINAL);
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(2);
    const calls = Object.values(readState(io).units).find((u) => u.caseId === RO_CASE)!
      .grading!.assertions.find((a) => a.kind === "calls_within")!;
    expect(calls.grade).toBe("unverified");
    expect(calls.evidence.detail).toContain("contradictory phase outcomes");

    const single = accountUnitInvocations([{
      turn: 1,
      threadId: "thr_x",
      readable: true,
      records: parseEventLines(`${[
        JSON.stringify({ type: "item.started", item: { id: "item_1", type: "command_execution", command: ["cat", "a"], status: "failed" } }),
        JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "command_execution", command: ["cat", "a"], status: "completed" } }),
        JSON.stringify({ type: "turn.completed" }),
      ].join("\n")}\n`),
    }]);
    expect(single.envelopes).toBe(1);
    expect(single.conflictingOutcomeCalls).toBe(1);
    expect(single.failed).toBe(0);
  });

  test("status and numeric exit evidence are evaluated together in one record", () => {
    const record = (id: string, extra: Record<string, unknown>): string =>
      JSON.stringify({ type: "item.completed", item: { id, type: "command_execution", command: ["cat", "a"], ...extra } });
    const completedNonzero = scanEventStream(`${record("i1", { status: "completed", exit_code: 1 })}\n`);
    expect(completedNonzero.invocationCalls[0]!.outcome).toBe("failed");
    expect(completedNonzero.failedInvocations).toBe(1);

    const failedZeroExit = scanEventStream(`${record("i2", { status: "failed", exit_code: 0 })}\n`);
    expect(failedZeroExit.invocationCalls[0]!.outcome).toBe("unknown");
    expect(failedZeroExit.failedInvocations).toBe(0);

    const completedZero = scanEventStream(`${record("i3", { status: "completed", exit_code: 0 })}\n`);
    expect(completedZero.invocationCalls[0]!.outcome).toBe("succeeded");
  });

  test("an explicit argv shell wrapper is decomposed; undecomposable interpreters stay unknown", async () => {
    const argvShell = scanEventStream(`${invocationLine("item_1", { command: ["sh", "-c", "cat A.md; grep -r x .; ls; wc -l y"] }) }\n`);
    expect(argvShell.bundledLookups).toBe(3);
    expect(argvShell.bundleUnknownCalls).toBe(0);

    const envShell = scanEventStream(`${invocationLine("item_1", { command: ["env", "LC_ALL=C", "bash", "-c", "cat A.md && ls"] }) }\n`);
    expect(envShell.bundledLookups).toBe(1);

    const quotedShell = scanEventStream(`${invocationLine("item_1", { command: ["sh", "-c", "cat 'a;b' ; ls"] }) }\n`);
    expect(quotedShell.bundleUnknownCalls).toBe(1);

    const interpreter = scanEventStream(`${invocationLine("item_1", { command: ["python3", "-c", "print(1); print(2)"] })}\n`);
    expect(interpreter.bundleUnknownCalls).toBe(1);

    // Executable-aware: an ordinary option that happens to be `-c` is NOT an
    // interpreter flag — `grep -c x file` stays one known lookup.
    const plainOption = scanEventStream(`${invocationLine("item_1", { command: ["grep", "-c", "x", "file"] })}\n`);
    expect(plainOption.bundledLookups).toBe(0);
    expect(plainOption.bundleUnknownCalls).toBe(0);

    // A shell running a script file (no `-c`) has an opaque nested program.
    const shellScript = scanEventStream(`${invocationLine("item_1", { command: ["sh", "script.sh"] })}\n`);
    expect(shellScript.bundleUnknownCalls).toBe(1);
    const shellFlaggedScript = scanEventStream(`${invocationLine("item_1", { command: ["bash", "-l", "script.sh"] })}\n`);
    expect(shellFlaggedScript.bundleUnknownCalls).toBe(1);
    const nodeScript = scanEventStream(`${invocationLine("item_1", { command: ["node", "script.js"] })}\n`);
    expect(nodeScript.bundleUnknownCalls).toBe(1);

    const plainArgv = scanEventStream(`${invocationLine("item_1", { command: ["cat", "AGENTS.md"] })}\n`);
    expect(plainArgv.bundledLookups).toBe(0);
    expect(plainArgv.bundleUnknownCalls).toBe(0);

    // Pipeline consequence: one argv-shell envelope bundling four commands
    // exceeds the three-lookup budget.
    const { io, manifest } = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const events = `${[
      JSON.stringify({ type: "thread.started", thread_id: "thr_bounded" }),
      invocationLine("item_1", { command: ["sh", "-c", "cat AGENTS.md; grep -r x .; ls; wc -l y"] }),
      JSON.stringify({ type: "turn.completed", usage: {} }),
    ].join("\n")}\n`;
    const spawn = boundedSpawn(io, manifest, RO_CASE, events, VALID_GROUPED_FINAL);
    const result = await runSmoke(io, manifest, spawn);
    expect(result.exit).toBe(1);
    const calls = Object.values(readState(io).units).find((u) => u.caseId === RO_CASE)!
      .grading!.assertions.find((a) => a.kind === "calls_within")!;
    expect(calls.grade).toBe("fail");
    expect(calls.evidence.detail).toContain("4 effective lookup(s)");
  });

  test("the report labels invocation totals as raw per-turn observations", async () => {
    const { io, manifest } = await preparedBoundedRunDir(RO_CASE, 3, "cold");
    const spawn = boundedSpawn(io, manifest, RO_CASE, boundedEvents(["item_1"]), VALID_GROUPED_FINAL);
    await runSmoke(io, manifest, spawn);
    const report = buildReport({ manifestPath: RUN_MANIFEST_PATH, io });
    expect(io.readText(report.mdPath)).toContain("raw per-turn invocation observations");
  });
});
