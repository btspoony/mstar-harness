/**
 * scripts/drift-lint.ts — guard semantics. Pins the committed guard behavior that previously had zero
 * automated coverage:
 * - checkBilingualPairing (guard 2 pairing logic) — all four change sets.
 * - evaluateBilingualGuard — the CI fail-loudly contract (GITHUB_ACTIONS
 * env injection): a null range fails in CI, skips locally; an empty range
 * (direct-to-main push) skips by design; a non-empty range runs the check.
 * - extractCategoryRowTokens (guard 1) — the docs/cli.md `<category>` row
 * yields exactly AUDIT_CATEGORIES; fabricated tokens are kept for the
 * membership check; `Category` / `<category>` placeholders are filtered.
 * - citesKnowledgeConventions (W-2) — the exemption is anchored to the
 * cited token itself (the citation path starts with `conventions/`);
 * proximity alone no longer exempts unrelated citations.
 * - checkFiveQuestionCorpus (guard 5) — five-question runtime smoke over
 * the shipped `mstar-*` corpus: the real corpus passes runtime-mode
 * lint; deleting an alias-covered heading (mstar-audit `## Output
 * format`) or a Step-3 aligned heading (mstar-sdd `## Progress ledger`)
 * fails; non-corpus files are ignored (load-bearing per plan Step 7).
 * Classifier wiring: the
 * runtime corpus is selected by the shared Engine classifier and agrees
 * row for row with the canonical fixture table consumed by the Engine,
 * CLI and dsh suites. Task 3 red probes (isolated injection): an
 * intentionally mismatched classification (core hub body under a
 * runtime identity) fails the corpus, and removing a real load-order
 * heading fails it — each restored to green through the same seam.
 * - checkRolesCorpus (guard 4) — roles/load-order corpus smoke: the real
 * corpus passes load-order lint + role mapping (19 skills, 0 mapping
 * violations); deleting a Load Order section
 * (roles.loadorder.section.missing) or losing the core mention
 * (roles.loadorder.core.missing) fails; a roles dir missing mapped
 * reference files fails (roles.mapping.reference.missing); non-corpus
 * files are ignored (load-bearing per plan Step 3).
 * - readDeclaredBins (F-S2) — Guard 1's manifest read is guard-or-clear:
 * missing / corrupt / bin-less manifests each return one explicit
 * failure row (never a silent skip that would flood every citation).
 * - checkEngineCallouts real-corpus pin (F-S3) — the shipped skills corpus
 * yields exactly 48 Engine-check callouts / 46 CLI citations against the
 * live CLI inventory + declared bins (4 lease/seats callouts consolidated
 * to canonical pointers);
 * corpus drift goes red.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";
import { AUDIT_CATEGORIES } from "../packages/engine/src/index.ts";
import {
  AUDIT_CATEGORY_DOC,
  buildCliCommandInventory,
  buildEngineExportNames,
  checkBilingualContentParity,
  checkBilingualPairing,
  checkCalloutDuplication,
  checkEngineCallouts,
  checkFiveQuestionCorpus,
  checkProvenanceScan,
  checkRolesCorpus,
  checkUseCliSkillCliCitations,
  citesKnowledgeConventions,
  collectProvenanceScanFiles,
  evaluateBilingualGuard,
  extractCategoryRowTokens,
  isGitHubActions,
  readDeclaredBins,
  readRolesCorpus,
  readTrackedFiles,
  readUseCliSkillMarkdown,
  supplementCliCommandInventory,
} from "./drift-lint.ts";

describe("checkBilingualPairing — README pairing logic (guard 2)", () => {
  test("both READMEs changed passes", () => {
    expect(checkBilingualPairing(["README.md", "README_CN.md", "docs/cli.md"])).toEqual([]);
  });

  test("neither README changed passes", () => {
    expect(checkBilingualPairing(["docs/cli.md", "scripts/drift-lint.ts"])).toEqual([]);
  });

  test("empty change list passes", () => {
    expect(checkBilingualPairing([])).toEqual([]);
  });

  test("only README.md changed fails naming the missing CN file", () => {
    const failures = checkBilingualPairing(["README.md"]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("README.md changed but README_CN.md did not");
  });

  test("only README_CN.md changed fails naming the missing EN file", () => {
    const failures = checkBilingualPairing(["README_CN.md"]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("README_CN.md changed but README.md did not");
  });
});

describe("checkBilingualContentParity — README changed-set mirroring (S-f)", () => {
  test("matching added/deleted counts on both READMEs passes", () => {
    expect(
      checkBilingualContentParity([
        { file: "README.md", added: 9, deleted: 5 },
        { file: "README_CN.md", added: 9, deleted: 5 },
        { file: "scripts/drift-lint.ts", added: 40, deleted: 10 },
      ]),
    ).toEqual([]);
  });

  test("mismatched added counts fail naming both numbers", () => {
    const failures = checkBilingualContentParity([
      { file: "README.md", added: 9, deleted: 5 },
      { file: "README_CN.md", added: 2, deleted: 5 },
    ]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("README.md +9/-5 vs README_CN.md +2/-5");
  });

  test("mismatched deleted counts fail naming both numbers", () => {
    const failures = checkBilingualContentParity([
      { file: "README.md", added: 9, deleted: 5 },
      { file: "README_CN.md", added: 9, deleted: 1 },
    ]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("README.md +9/-5 vs README_CN.md +9/-1");
  });

  test("either README absent from the change set passes (presence guard owns that case)", () => {
    expect(
      checkBilingualContentParity([{ file: "README.md", added: 9, deleted: 5 }]),
    ).toEqual([]);
    expect(
      checkBilingualContentParity([
        { file: "README.md", added: 0, deleted: 0 },
        { file: "README_CN.md", added: 0, deleted: 0 },
      ]),
    ).toEqual([]);
  });

  test("empty change set passes", () => {
    expect(checkBilingualContentParity([])).toEqual([]);
  });
});

describe("evaluateBilingualGuard — CI fail-loudly vs local skip", () => {
  test("null range + GITHUB_ACTIONS fails loudly with a fetch-depth hint", () => {
    const out = evaluateBilingualGuard(null, { ci: true });
    if (out.status !== "failed") throw new Error(`expected failed, got ${out.status}`);
    expect(out.failures.length).toBe(1);
    expect(out.failures[0]).toContain("fetch-depth: 0");
  });

  test("null range + non-CI skips silently", () => {
    const out = evaluateBilingualGuard(null, { ci: false });
    if (out.status !== "skipped") throw new Error(`expected skipped, got ${out.status}`);
  });

  test("empty range (direct-to-main push) skips by design even in CI", () => {
    const out = evaluateBilingualGuard([], { ci: true });
    if (out.status !== "skipped") throw new Error(`expected skipped, got ${out.status}`);
    expect(out.reason).toContain("empty range");
  });

  test("non-empty range runs the pairing check in CI", () => {
    const unpaired = evaluateBilingualGuard(["README.md"], { ci: true });
    if (unpaired.status !== "checked") throw new Error(`expected checked, got ${unpaired.status}`);
    expect(unpaired.failures.length).toBe(1);
    const paired = evaluateBilingualGuard(["README.md", "README_CN.md"], { ci: true });
    if (paired.status !== "checked") throw new Error(`expected checked, got ${paired.status}`);
    expect(paired.failures).toEqual([]);
  });

  test("GITHUB_ACTIONS env var injection flips the guard to fail-loudly", () => {
    const prev = process.env.GITHUB_ACTIONS;
    try {
      process.env.GITHUB_ACTIONS = "true";
      expect(isGitHubActions()).toBe(true);
      const ciOut = evaluateBilingualGuard(null);
      if (ciOut.status !== "failed") throw new Error(`expected failed, got ${ciOut.status}`);
      process.env.GITHUB_ACTIONS = "false";
      expect(isGitHubActions()).toBe(false);
      const localOut = evaluateBilingualGuard(null);
      if (localOut.status !== "skipped") throw new Error(`expected skipped, got ${localOut.status}`);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = prev;
    }
  });
});

describe("extractCategoryRowTokens — checks-and-lints `<category>` row (guard 1)", () => {
  test("real checks-and-lints.md <category> row yields exactly AUDIT_CATEGORIES", () => {
    const cliMd = readFileSync(join(import.meta.dir, "..", AUDIT_CATEGORY_DOC), "utf8");
    const row = cliMd.split(/\r?\n/).find((l) => /^\|\s*`<category>`\s*\|/.test(l));
    expect(row).toBeDefined();
    expect(extractCategoryRowTokens(row!)).toEqual([...AUDIT_CATEGORIES]);
  });

  test("fabricated token is kept for the membership check (extraction is faithful)", () => {
    const row = "| `<category>` | recon then focus: `bug`, `deps` | all nine |";
    expect(extractCategoryRowTokens(row)).toEqual(["bug", "deps"]);
  });

  test("plan-field `Category` reference and `<category>` placeholder are filtered", () => {
    const row = "| `<category>` | plan `Category` field values: `bug` | all nine |";
    expect(extractCategoryRowTokens(row)).toEqual(["bug"]);
  });
});

describe("checkEngineCallouts — Guard 1 CLI citation binary-prefix check", () => {
  /** Declared bin names from the manifest — the guard's SSOT (a rename in
 * packages/cli/package.json must move this pin with it, mirroring the
 * manifest test from . */
  const declaredBins = () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "packages", "cli", "package.json"), "utf8"),
    ) as { bin?: Record<string, string> };
    return Object.keys(manifest.bin ?? {});
  };

 /** One Engine-check callout blockquote with `body` as its content. */
  const callout = (body: string) =>
    `> **Engine check (when available):** ${body}\n> On \`fail\` -> do not proceed.`;

  test("both declared bin names pass — `mstar …` and `mstar-harness …` citations (load-bearing)", () => {
    const binNames = declaredBins();
    expect(binNames).toEqual(expect.arrayContaining(["mstar", "mstar-harness"]));
    const { calloutsChecked, cliCitationsChecked, failures } = checkEngineCallouts(
      [
        { rel: "skills/mstar-foo/SKILL.md", text: callout("run `mstar status validate <path>`") },
        { rel: "skills/mstar-foo/SKILL.md", text: callout("run `mstar-harness dispatch validate <file>`") },
      ],
      {
        cliCommands: new Set(["status validate", "dispatch validate"]),
        engineExports: new Set(["validateStatus"]),
        binNames,
      },
    );
    expect(calloutsChecked).toBe(2);
    expect(cliCitationsChecked).toBe(2);
    expect(failures).toEqual([]);
  });

  test("undeclared binary prefix fails — `mstarr status validate` (load-bearing)", () => {
    const binNames = declaredBins();
    const { failures } = checkEngineCallouts(
      [{ rel: "skills/mstar-foo/SKILL.md", text: callout("run `mstarr status validate <path>`") }],
      { cliCommands: new Set(["status validate"]), engineExports: new Set(), binNames },
    );
    expect(failures).toEqual([
      `skills/mstar-foo/SKILL.md:1 citation binary "mstarr" is not a declared CLI bin (${binNames.join(" | ")})`,
    ]);
  });

  test("unknown command path still fails under a declared bin", () => {
    const { failures } = checkEngineCallouts(
      [{ rel: "skills/mstar-foo/SKILL.md", text: callout("run `mstar bogus validate <path>`") }],
      {
        cliCommands: new Set(["status validate"]),
        engineExports: new Set(),
        binNames: declaredBins(),
      },
    );
    expect(failures).toEqual([
      expect.stringContaining('callout references unknown CLI command "mstar bogus validate"'),
    ]);
  });

  test("prose outside Engine-check callouts is not scanned", () => {
    const { calloutsChecked, failures } = checkEngineCallouts(
      [{ rel: "skills/mstar-foo/SKILL.md", text: "run `mstarr status validate` in prose" }],
      {
        cliCommands: new Set(["status validate"]),
        engineExports: new Set(),
        binNames: declaredBins(),
      },
    );
    expect(calloutsChecked).toBe(0);
    expect(failures).toEqual([]);
  });

  test("real corpus pins 49 Engine-check callouts / 48 CLI citations (F-S3, drift goes red)", () => {
    const REPO_ROOT = join(import.meta.dir, "..");
    const SKILLS_ROOT = join(REPO_ROOT, "skills");

    /** Every `.md` file under skills/ with the repo-relative `rel` Guard 1
 * sees in main — the 48/46 counts are a regression pin: adding or
 * removing a backticked CLI citation inside an Engine-check callout
 * (or adding a callout) fails this test loudly. */
    const realCorpus = () => {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (entry.name.endsWith(".md")) files.push(p);
        }
      };
      walk(SKILLS_ROOT);
      return files
        .sort()
        .map((file) => ({ rel: relative(REPO_ROOT, file), text: readFileSync(file, "utf8") }));
    };

    const cliSrc = readFileSync(join(REPO_ROOT, "packages", "cli", "src", "index.ts"), "utf8");
    const { cliCommands, failures: cliFailures } = buildCliCommandInventory(cliSrc);
    expect(cliFailures).toEqual([]);
    const engineExports = buildEngineExportNames(
      readFileSync(join(REPO_ROOT, "packages", "engine", "src", "index.ts"), "utf8"),
    );
    expect(engineExports.size).toBeGreaterThan(0);
    const { binNames, failures: manifestFailures } = readDeclaredBins(
      join(REPO_ROOT, "packages", "cli", "package.json"),
    );
    expect(manifestFailures).toEqual([]);
    expect(binNames).toEqual(expect.arrayContaining(["mstar", "mstar-harness"]));

    const { calloutsChecked, cliCitationsChecked, failures } = checkEngineCallouts(realCorpus(), {
      cliCommands,
      engineExports,
      binNames,
    });
    expect(calloutsChecked).toBe(49);
    expect(cliCitationsChecked).toBe(48);
    expect(failures).toEqual([]);
  });
});

describe("supplementCliCommandInventory — scoped registrar paths (Task 3)", () => {
  const REPO_ROOT = join(import.meta.dir, "..");

  test("index.ts inventory stays at 93 paths; supplement adds 16 scoped paths", () => {
    const cliSrc = readFileSync(join(REPO_ROOT, "packages/cli/src/index.ts"), "utf8");
    const { cliCommands: base, failures: baseFailures } = buildCliCommandInventory(cliSrc);
    expect(baseFailures).toEqual([]);
    expect(base.size).toBe(93);
    const merged = new Set(base);
    const { failures } = supplementCliCommandInventory(merged, REPO_ROOT);
    expect(failures).toEqual([]);
    expect(merged.has("plan handoff")).toBe(true);
    expect(merged.has("workflow show-prepare")).toBe(true);
    expect(merged.has("sdd evidence")).toBe(true);
    expect(merged.size - base.size).toBe(16);
  });
});

describe("checkUseCliSkillCliCitations — mstar-use-cli skill scan (Task 3)", () => {
  const REPO_ROOT = join(import.meta.dir, "..");
  const inventory = () => {
    const cliSrc = readFileSync(join(REPO_ROOT, "packages/cli/src/index.ts"), "utf8");
    const { cliCommands, failures } = buildCliCommandInventory(cliSrc);
    expect(failures).toEqual([]);
    supplementCliCommandInventory(cliCommands, REPO_ROOT);
    return cliCommands;
  };
  const binNames = () => {
    const { binNames, failures } = readDeclaredBins(join(REPO_ROOT, "packages/cli/package.json"));
    expect(failures).toEqual([]);
    return binNames;
  };

  test("fabricated command path in the use-cli skill fails", () => {
    const { failures } = checkUseCliSkillCliCitations(
      [{ rel: "skills/mstar-use-cli/SKILL.md", text: "run `mstar plan totally-fake-verb` here" }],
      { cliCommands: inventory(), binNames: binNames() },
    );
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain('unknown CLI command "mstar plan totally-fake-verb"');
  });

  test("correct plan verb citation passes (inventory supplement regression)", () => {
    const { failures, cliCitationsChecked } = checkUseCliSkillCliCitations(
      [{ rel: "skills/mstar-use-cli/SKILL.md", text: "then `mstar plan handoff` with tokens" }],
      { cliCommands: inventory(), binNames: binNames() },
    );
    expect(cliCitationsChecked).toBe(1);
    expect(failures).toEqual([]);
  });

  test("real mstar-use-cli corpus passes with supplemented inventory", () => {
    const { files, failures } = readUseCliSkillMarkdown(REPO_ROOT);
    expect(failures).toEqual([]);
    expect(files.length).toBeGreaterThan(0);
    const { failures: citeFailures } = checkUseCliSkillCliCitations(files, {
      cliCommands: inventory(),
      binNames: binNames(),
    });
    expect(citeFailures).toEqual([]);
  });

  test("readUseCliSkillMarkdown scans repoRoot when process cwd differs (D2)", () => {
    const outer = mkdtempSync(join(tmpdir(), "drift-use-cli-cwd-"));
    const prev = process.cwd();
    try {
      process.chdir(outer);
      const { files, failures } = readUseCliSkillMarkdown(REPO_ROOT);
      expect(failures).toEqual([]);
      expect(files.length).toBe(5);
      expect(files.every((f) => f.rel.startsWith("skills/mstar-use-cli/"))).toBe(true);
    } finally {
      process.chdir(prev);
      rmSync(outer, { recursive: true, force: true });
    }
  });

  test("missing use-cli skill dir returns one explicit failure row (D1 guard-or-clear)", () => {
    const dir = mkdtempSync(join(tmpdir(), "drift-use-cli-missing-"));
    try {
      const { files, failures } = readUseCliSkillMarkdown(dir);
      expect(files).toEqual([]);
      expect(failures.length).toBe(1);
      expect(failures[0]).toContain("skills/mstar-use-cli is missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty use-cli skill dir returns one explicit failure row (D1 zero-md)", () => {
    const dir = mkdtempSync(join(tmpdir(), "drift-use-cli-empty-"));
    try {
      mkdirSync(join(dir, "skills", "mstar-use-cli"), { recursive: true });
      const { files, failures } = readUseCliSkillMarkdown(dir);
      expect(files).toEqual([]);
      expect(failures.length).toBe(1);
      expect(failures[0]).toContain("contains no .md files");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("drift-lint executable — use-cli scan wiring (Task 3 fix round)", () => {
  const REPO_ROOT = join(import.meta.dir, "..");
  const SCRIPT = join(REPO_ROOT, "scripts/drift-lint.ts");

  test("clean repo exits 0 and reports use-cli skill file scan count (D3)", () => {
    const out = execFileSync("bun", [SCRIPT], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(out).toMatch(/\d+ use-cli skill files/);
    expect(out).toContain("full-text citations");
  });

  test("running outside repo root does not exit 0 silently (D1/D2 executable)", () => {
    const outer = mkdtempSync(join(tmpdir(), "drift-use-cli-exec-"));
    try {
      let failed = false;
      try {
        execFileSync("bun", [SCRIPT], { cwd: outer, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        failed = true;
        const err = error as { status?: number };
        expect(err.status).toBe(1);
      }
      expect(failed).toBe(true);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  test("temp fixture with fabricated CLI citation fails the executable guard (D3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "drift-use-cli-fixture-"));
    try {
      for (const rel of [
        "packages/engine/src/index.ts",
        "packages/cli/src/index.ts",
        "packages/cli/package.json",
        "packages/cli/src/plan-coordination.ts",
        "packages/cli/src/sdd-evidence.ts",
        "skills/mstar-use-cli/SKILL.md",
        "skills/mstar-use-cli/references/checks-and-lints.md",
        "README.md",
        "README_CN.md",
      ]) {
        const dest = join(dir, rel);
        mkdirSync(join(dest, ".."), { recursive: true });
        writeFileSync(dest, readFileSync(join(REPO_ROOT, rel), "utf8"));
      }
      writeFileSync(
        join(dir, "skills/mstar-use-cli/SKILL.md"),
        "run `mstar plan totally-fake-verb` here\n",
      );
      const checks = readFileSync(join(REPO_ROOT, AUDIT_CATEGORY_DOC), "utf8");
      writeFileSync(join(dir, AUDIT_CATEGORY_DOC), checks);
      const skillMd = readFileSync(join(REPO_ROOT, "skills/mstar-harness-core/SKILL.md"), "utf8");
      mkdirSync(join(dir, "skills/mstar-harness-core"), { recursive: true });
      writeFileSync(join(dir, "skills/mstar-harness-core/SKILL.md"), skillMd);
      let failed = false;
      try {
        execFileSync("bun", [SCRIPT], { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        failed = true;
        const err = error as { status?: number; stderr?: string };
        expect(err.status).toBe(1);
        expect(String(err.stderr ?? "")).toMatch(/totally-fake-verb/);
      }
      expect(failed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildCliCommandInventory — enumerated .argument composites (SP3 fix wave 1)", () => {
  test("enumerated <kind> argument registers `parent <token>` composites on the command and its subcommand", () => {
    const { cliCommands, failures } = buildCliCommandInventory(
      [
        'const persistCommand = program\n  .command("persist");',
        'persistCommand\n  .argument("<kind>", "status | snapshot | residuals | review | json");',
        'persistCommand\n  .command("get")\n  .argument("<kind>", "status | snapshot | residuals | review | json");',
      ].join("\n"),
    );
    expect(failures).toEqual([]);
    for (const cmd of [
      "persist",
      "persist status",
      "persist snapshot",
      "persist residuals",
      "persist review",
      "persist json",
      "persist get",
      "persist get status",
      "persist get review",
      "persist get json",
    ]) {
      expect(cliCommands.has(cmd)).toBe(true);
    }
  });

  test("non-enumeration argument descriptions register no composites", () => {
    const { cliCommands, failures } = buildCliCommandInventory(
      'const harnessCommand = program\n  .command("harness");\n' +
        'harnessCommand\n  .command("scaffold")\n  .argument("[path]", "Root to scaffold (default: cwd)");',
    );
    expect(failures).toEqual([]);
    expect(cliCommands.has("harness")).toBe(true);
    expect(cliCommands.has("harness scaffold")).toBe(true);
    expect(cliCommands.has("harness scaffold path")).toBe(false);
    expect([...cliCommands].some((c) => c.includes("default: cwd"))).toBe(false);
  });

  test("argument on an unknown command var fails loud", () => {
    const { failures } = buildCliCommandInventory('mysteryCommand\n  .argument("<kind>", "status | review");');
    expect(failures).toEqual([
      expect.stringContaining('CLI parent of "mysteryCommand.argument("<kind>")" is not a known command var'),
    ]);
  });
});

describe("buildCliCommandInventory — detached group declarations (`new Command` + attach)", () => {
  /** The shape `packages/cli/src/index.ts` uses for its `workflow` verbs: the
   * group is built detached (an eager `program.command("workflow")` aborts the
   * whole CLI with commander's duplicate-command error when the scoped
   * registrar already owns that group name) and attached at the end of the
   * registration pass. */
  const DETACHED_GROUP_SRC = [
    'const workflowCommand = new Command("workflow").description("Workflow lifecycle verbs");',
    "workflowCommand",
    '  .command("register")',
    '  .description("Register a standalone plan workflow")',
    "  .action(async () => {});",
    "workflowCommand",
    '  .command("evidence")',
    '  .description("Record the delivery evidence")',
    "  .action(async () => {});",
    "function attachWorkflowGroup(target: Command): void {",
    "  target.addCommand(workflowCommand);",
    "}",
  ].join("\n");

  test("a detached group attached via addCommand resolves its verbs (no false parent failures)", () => {
    const { cliCommands, failures } = buildCliCommandInventory(DETACHED_GROUP_SRC);
    expect(failures).toEqual([]);
    expect(cliCommands.has("workflow")).toBe(true);
    expect(cliCommands.has("workflow register")).toBe(true);
    expect(cliCommands.has("workflow evidence")).toBe(true);
  });

  test("an orphan detached group is never registered: its verbs stay unknown parents (fail loud)", () => {
    const { cliCommands, failures } = buildCliCommandInventory(
      'const ghostCommand = new Command("ghost");\nghostCommand\n  .command("haunt")\n  .action(async () => {});',
    );
    expect(cliCommands.has("ghost")).toBe(false);
    expect(failures).toEqual([
      expect.stringContaining('CLI parent of "ghostCommand.command("haunt")" is not a known command var'),
    ]);
  });
});

describe("checkCalloutDuplication — Guard 6 Engine-check callout dedup", () => {
 /** One Engine-check callout blockquote with `body` as its content. */
  const callout = (body: string) =>
    `> **Engine check (when available):** ${body}\n> On \`fail\` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.`;

  test("identical callout bodies in >1 file fail (load-bearing)", () => {
    const body = "run `mstar lease verify --workflow <id>`";
    const { failures } = checkCalloutDuplication([
      { rel: "skills/mstar-a/SKILL.md", text: callout(body) },
      { rel: "skills/mstar-b/SKILL.md", text: callout(body) },
    ]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("skills/mstar-a/SKILL.md");
    expect(failures[0]).toContain("skills/mstar-b/SKILL.md");
  });

  test("bilingual variant (`或 import` vs `or import`) of the same callout fails (load-bearing)", () => {
    const zh = "run `mstar lease validate` 或 import `validateExecutionLease` from `@mstar-harness/engine`";
    const en = "run `mstar lease validate` or import `validateExecutionLease` from `@mstar-harness/engine`";
    const { failures } = checkCalloutDuplication([
      { rel: "skills/mstar-a/SKILL.md", text: callout(zh) },
      { rel: "skills/mstar-b/SKILL.md", text: callout(en) },
    ]);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("skills/mstar-a/SKILL.md");
    expect(failures[0]).toContain("skills/mstar-b/SKILL.md");
  });

  test("unique callout passes", () => {
    const { failures } = checkCalloutDuplication([
      { rel: "skills/mstar-a/SKILL.md", text: callout("run `mstar lease validate`") },
      { rel: "skills/mstar-b/SKILL.md", text: callout("run `mstar status validate <path>`") },
    ]);
    expect(failures).toEqual([]);
  });

  test("same file may hold multiple distinct callouts", () => {
    const { failures } = checkCalloutDuplication([
      { rel: "skills/mstar-a/SKILL.md", text: `${callout("run `mstar lease validate`")}\n${callout("run `mstar status validate`")}` },
    ]);
    expect(failures).toEqual([]);
  });

  test("non-callout blockquotes and prose are ignored", () => {
    const text = [
      "> A plain blockquote, no Engine-check marker.",
      "run `mstar lease validate` in prose",
      "> **Engine check (when available):** run `mstar lease validate`",
    ].join("\n");
    const { failures } = checkCalloutDuplication([
      { rel: "skills/mstar-a/SKILL.md", text },
      { rel: "skills/mstar-b/SKILL.md", text: callout("run `mstar lease validate`") },
    ]);
    expect(failures).toEqual([]);
  });

  test("callouts that differ in substantive tail prose do not collide", () => {
    const { failures } = checkCalloutDuplication([
      { rel: "skills/mstar-a/SKILL.md", text: callout("run `mstar lease verify` to validate the leases above") },
      { rel: "skills/mstar-b/SKILL.md", text: callout("run `mstar lease verify` to validate the other leases") },
    ]);
    expect(failures).toEqual([]);
  });
});

describe("readDeclaredBins — Guard 1 manifest read fail-loud (F-S2)", () => {
  test("missing / corrupt / bin-less manifests each return one explicit failure row, never a silent skip", () => {
    const dir = mkdtempSync(join(tmpdir(), "drift-bins-"));
    try {
      expect(readDeclaredBins(join(dir, "missing.json"))).toEqual({
        binNames: [],
        failures: [expect.stringContaining("could not read CLI manifest")],
      });

      writeFileSync(join(dir, "corrupt.json"), "{ not json");
      expect(readDeclaredBins(join(dir, "corrupt.json"))).toEqual({
        binNames: [],
        failures: [expect.stringContaining("is not valid JSON")],
      });

      writeFileSync(join(dir, "empty-bin.json"), JSON.stringify({ name: "x", bin: {} }));
      expect(readDeclaredBins(join(dir, "empty-bin.json"))).toEqual({
        binNames: [],
        failures: [expect.stringContaining("declares no bin names")],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("valid manifest returns the declared bin names with no failures", () => {
    const dir = mkdtempSync(join(tmpdir(), "drift-bins-ok-"));
    try {
      const manifest = join(dir, "ok.json");
      writeFileSync(
        manifest,
        JSON.stringify({
          name: "@mstar-harness/cli",
          bin: { "mstar-harness": "dist/mstar-harness.js", mstar: "dist/mstar-harness.js" },
        }),
      );
      expect(readDeclaredBins(manifest)).toEqual({
        binNames: ["mstar-harness", "mstar"],
        failures: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("citesKnowledgeConventions — anchored exemption (W-2)", () => {
  const idxOf = (text: string, token: string) => text.indexOf(token);

  test("knowledge `conventions/<file>` citation is exempt", () => {
    const text = "spec: knowledge `conventions/skill-content-porting-discipline.md`";
    expect(citesKnowledgeConventions(text, idxOf(text, "skill-content-porting-discipline.md"))).toBe(true);
  });

  test("plain conventions/<file> (no knowledge prefix) is exempt", () => {
    const text = "spec: conventions/skill-content-porting-discipline.md";
    expect(citesKnowledgeConventions(text, idxOf(text, "skill-content-porting-discipline.md"))).toBe(true);
  });

  test("parenthesized conventions/<file> is exempt", () => {
    const text = "(conventions/skill-content-porting-discipline.md)";
    expect(citesKnowledgeConventions(text, idxOf(text, "skill-content-porting-discipline.md"))).toBe(true);
  });

  test("x-conventions/<file> is NOT exempt (citation path must start with conventions/)", () => {
    const text = "spec: x-conventions/skill-content-porting-discipline.md";
    expect(citesKnowledgeConventions(text, idxOf(text, "skill-content-porting-discipline.md"))).toBe(false);
  });

  test("sub/conventions/<file> is NOT exempt (citation path must start with conventions/)", () => {
    const text = "spec: sub/conventions/skill-content-porting-discipline.md";
    expect(citesKnowledgeConventions(text, idxOf(text, "skill-content-porting-discipline.md"))).toBe(false);
  });

  test("unrelated skills/<file> citation is NOT exempt", () => {
    const text = "spec: skills/mstar-foo.md";
    expect(citesKnowledgeConventions(text, idxOf(text, "mstar-foo.md"))).toBe(false);
  });

  test("nearby unrelated token is no longer swallowed by a prior conventions/ mention", () => {
 // The old 60-char proximity window exempted `missing.md` here because
 // "conventions/" appeared within 60 chars before it; the anchored check
 // exempts only the token immediately preceded by "conventions/".
    const text = "knowledge `conventions/real-doc.md`\n\nspec: typo'd missing.md on an adjacent line";
    expect(citesKnowledgeConventions(text, idxOf(text, "missing.md"))).toBe(false);
  });

  test("token on the next line after conventions/ is NOT exempt (path is broken)", () => {
    const text = "spec: conventions/\nskill-content-porting-discipline.md";
    expect(citesKnowledgeConventions(text, idxOf(text, "skill-content-porting-discipline.md"))).toBe(false);
  });
});

describe("checkFiveQuestionCorpus — Guard 5 five-question runtime smoke", () => {
  const SKILLS_ROOT = join(import.meta.dir, "..", "skills");

  /** The real shipped corpus as the guard sees it: every
 * `skills/mstar-*` SKILL.md, with the repo-relative `rel` the guard
 * filters on. */
  const realCorpus = () =>
    readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("mstar-"))
      .map((entry) => ({
        rel: `skills/${entry.name}/SKILL.md`,
        text: readFileSync(join(SKILLS_ROOT, entry.name, "SKILL.md"), "utf8"),
      }));

  /** Corpus fixture with every heading line matching `pattern` dropped
 * from the entry at `rel` — simulates a Step-3 heading being removed. */
  const dropHeading = (corpus: Array<{ rel: string; text: string }>, rel: string, pattern: RegExp) =>
    corpus.map((entry) =>
      entry.rel === rel
        ? { ...entry, text: entry.text.split(/\r?\n/).filter((line) => !pattern.test(line)).join("\n") }
        : entry,
    );

  test("real corpus passes runtime-mode five-question lint (count derived from readdir)", () => {
    const { checked, failures } = checkFiveQuestionCorpus(realCorpus());
 // 20 mstar-* skill dirs minus the two exempt (mstar-harness-core,
 // mstar-skill-authoring) — count derived from readdir so adding a
 // properly-aligned skill never forces a multi-site pin update; a new
 // unaligned skill still fails this test via the failures array.
    const mstarSkillCount = readdirSync(SKILLS_ROOT, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("mstar-"),
    ).length;
    expect(checked).toBe(mstarSkillCount - 2);
    expect(failures).toEqual([]);
  });

  test("removing an alias-covered heading (mstar-audit ## Output format) fails the guard", () => {
    const corpus = realCorpus();
    const audit = corpus.find((entry) => entry.rel === "skills/mstar-audit/SKILL.md");
    expect(audit).toBeDefined();
    expect(audit!.text).toContain("## Output format");
    const gapped = dropHeading(corpus, "skills/mstar-audit/SKILL.md", /^#{1,6}\s+Output format\s*$/);
    const { failures } = checkFiveQuestionCorpus(gapped);
    expect(failures.length).toBeGreaterThan(0);
    expect(
      failures.some(
        (row) => row.includes("skills/mstar-audit/SKILL.md") && row.includes("five-question.evidence"),
      ),
    ).toBe(true);
  });

  test("removing a Step-3 aligned heading (mstar-sdd ## Progress ledger) fails the guard", () => {
    const corpus = realCorpus();
    const sdd = corpus.find((entry) => entry.rel === "skills/mstar-sdd/SKILL.md");
    expect(sdd).toBeDefined();
    expect(sdd!.text).toContain("## Progress ledger");
    const gapped = dropHeading(corpus, "skills/mstar-sdd/SKILL.md", /^#{1,6}\s+Progress ledger/);
    const { failures } = checkFiveQuestionCorpus(gapped);
    expect(failures.length).toBeGreaterThan(0);
    expect(
      failures.some(
        (row) => row.includes("skills/mstar-sdd/SKILL.md") && row.includes("five-question.evidence"),
      ),
    ).toBe(true);
  });

  test("non-corpus files are ignored (references/, non-mstar, exempt pair)", () => {
    const { checked, failures } = checkFiveQuestionCorpus([
      { rel: "skills/mstar-roles/references/fullstack-dev-shared.md", text: "# no five questions here" },
      { rel: "skills/grill-me/SKILL.md", text: "# no five questions here" },
      { rel: "skills/mstar-harness-core/SKILL.md", text: "# hub headings — exempt by design" },
      { rel: "skills/mstar-skill-authoring/SKILL.md", text: "# strict mode — exempt" },
    ]);
    expect(checked).toBe(0);
    expect(failures).toEqual([]);
  });

  test("canonical fixture corpus: the classifier selects exactly the runtime rows (spec A4 parity)", () => {
 // The same canonical rows the Engine, CLI and dsh suites consume —
 // Guard5's corpus selection must agree row for row (cross-consumer
 // decision parity).
    type FixtureRow = {
      id: string;
      skillId: string | null;
      doc: string;
      expectedKind: "core" | "runtime" | "authoring";
      expectedFiveQuestionCodes: string[] | null;
    };
    const fixtures = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "packages", "engine", "test", "fixtures", "skill-lint-profiles.json"),
        "utf8",
      ),
    ) as { schemaVersion: number; rows: FixtureRow[] };
    const codeOf = (failureRow: string) =>
      failureRow.match(/ five-question runtime smoke ([\w.-]+) - /)?.[1] ?? "";

 // Runtime rows: guard checks them and reports exactly the expected codes.
    for (const row of fixtures.rows.filter((r) => r.expectedKind === "runtime")) {
      const single = checkFiveQuestionCorpus([
        { rel: `skills/${row.skillId}/SKILL.md`, text: row.doc },
      ]);
      expect(single.checked).toBe(1);
      expect(single.failures.map(codeOf)).toEqual(row.expectedFiveQuestionCodes ?? []);
    }

 // Non-runtime rows (core exemption + standard-bearing authoring + strict
 // defaults) never enter the runtime corpus, regardless of their bodies —
 // the fence/alias bodies that would fail authoring produce no guard rows.
    for (const row of fixtures.rows.filter((r) => r.expectedKind !== "runtime")) {
      const single = checkFiveQuestionCorpus([
        { rel: `skills/${row.skillId ?? "unparented-skill"}/SKILL.md`, text: row.doc },
      ]);
      expect(single).toEqual({ checked: 0, failures: [] });
    }

 // Aggregate over the full table: checked = runtime rows only; the only
 // expected failure is the fence-only workflow gap on the shared fixture
 // identity (load-bearing: the corpus decision is the fixture decision).
    const all = checkFiveQuestionCorpus(
      fixtures.rows.map((row) => ({
        rel: `skills/${row.skillId ?? "unparented-skill"}/SKILL.md`,
        text: row.doc,
      })),
    );
    expect(all.checked).toBe(fixtures.rows.filter((r) => r.expectedKind === "runtime").length);
    expect(all.failures).toHaveLength(1);
    expect(all.failures[0]).toContain("skills/mstar-topic-fixture/SKILL.md");
    expect(codeOf(all.failures[0])).toBe("skill-authoring.five-question.workflow");
  });

  test("red probe: intentionally mismatched classification fails the corpus; restore passes", () => {
 // Inject the core hub body under mstar-audit's runtime identity: the
 // classifier still selects runtime for the rel basename, but the
 // injected content does not answer the runtime corpus contract — the
 // guard must go RED (spec A4 / AC5: the drift guard rejects an
 // intentionally mismatched classification). Isolated test injection
 // only — no shipped file and no production rule is touched.
    const corpus = realCorpus();
    const core = corpus.find((e) => e.rel === "skills/mstar-harness-core/SKILL.md");
    const audit = corpus.find((e) => e.rel === "skills/mstar-audit/SKILL.md");
    expect(core).toBeDefined();
    expect(audit).toBeDefined();
    const mismatched = corpus.map((e) =>
      e.rel === "skills/mstar-audit/SKILL.md" ? { ...e, text: core!.text } : e,
    );
    const red = checkFiveQuestionCorpus(mismatched);
    expect(red.checked).toBe(corpus.length - 2); // runtime corpus selection unchanged
 // The thinned hub body answers none of the five runtime alias rows, so
 // under injection every runtime question is uncovered: load-order,
 // workflow, decision-rules, evidence, references all go red.
    expect(red.failures).toHaveLength(5);
    expect(red.failures.every((row) => row.includes("skills/mstar-audit/SKILL.md"))).toBe(true);
 // Restore the real shipped content through the same seam — green again.
    expect(checkFiveQuestionCorpus(corpus)).toEqual({ checked: corpus.length - 2, failures: [] });
  });

  test("red probe: removing a real heading (mstar-branch-worktree Load order) fails the corpus; restore passes", () => {
 // load-order has no alias row, so the
 // single real `Load order` heading is the only cover — dropping it must
 // flip the guard red for exactly that question. In-memory drop only;
 // the shipped file is never modified.
    const rel = "skills/mstar-branch-worktree/SKILL.md";
    const corpus = realCorpus();
    const sample = corpus.find((e) => e.rel === rel);
    expect(sample).toBeDefined();
    expect(sample!.text).toMatch(/^#{1,6}\s+Load order/m);
    const gapped = dropHeading(corpus, rel, /^#{1,6}\s+Load order\b.*$/);
    const red = checkFiveQuestionCorpus(gapped);
    expect(red.checked).toBe(corpus.length - 2);
    expect(red.failures).toHaveLength(1);
    expect(red.failures[0]).toContain(rel);
    expect(red.failures[0]).toContain("five-question.load-order");
 // Restore: the untouched corpus is green through the same seam.
    expect(checkFiveQuestionCorpus(corpus).failures).toEqual([]);
  });
});

describe("checkRolesCorpus — Guard 4 roles/load-order corpus", () => {
  const SKILLS_ROOT = join(import.meta.dir, "..", "skills");
  const ROLES_DIR = join(SKILLS_ROOT, "mstar-roles");

  /** The real shipped corpus as the guard sees it: every
 * `skills/mstar-*` SKILL.md, with the repo-relative `rel` the guard
 * filters on. */
  const realCorpus = () =>
    readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("mstar-"))
      .map((entry) => ({
        rel: `skills/${entry.name}/SKILL.md`,
        text: readFileSync(join(SKILLS_ROOT, entry.name, "SKILL.md"), "utf8"),
      }));

 /** Same heading contract as engine lintLoadOrder. */
  const LOAD_ORDER_HEADING = /^#{1,6}\s+[^\r\n]*\b(?:load[\s-]*order|first\s+action)\b[^\r\n]*$/i;

  /** Replace the first Load Order / First action section of the entry at
 * `rel` with `replacement` lines (empty array deletes the section) —
 * simulates a skill losing its load-order declaration. */
  const replaceLoadOrderSection = (
    corpus: Array<{ rel: string; text: string }>,
    rel: string,
    replacement: string[],
  ) =>
    corpus.map((entry) => {
      if (entry.rel !== rel) return entry;
      const lines = entry.text.split(/\r?\n/);
      const start = lines.findIndex((line) => LOAD_ORDER_HEADING.test(line));
      if (start === -1) return entry;
      let end = start + 1;
      while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++;
      return { ...entry, text: [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n") };
    });

  test("real corpus passes load-order lint and role mapping (count derived from readdir)", () => {
    const { skillsChecked, loadOrderViolations, mappingViolations, failures } = checkRolesCorpus(
      realCorpus(),
      ROLES_DIR,
    );
 // Count derived from readdir: mstar-* skill dirs minus mstar-harness-core
 // (exempt inside the engine's lintLoadOrder) — a new mstar-* skill must
 // declare its load order or fail the guard loudly (no multi-site pin to
 // sync when a properly-declared skill is added).
    const mstarSkillCount = readdirSync(SKILLS_ROOT, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && entry.name.startsWith("mstar-"),
    ).length;
    expect(skillsChecked).toBe(mstarSkillCount - 1);
    expect(loadOrderViolations).toBe(0);
    expect(mappingViolations).toBe(0);
    expect(failures).toEqual([]);
  });

  test("deleting a Load Order section (mstar-roles) fails the guard (roles.loadorder.section.missing)", () => {
    const corpus = realCorpus();
    const roles = corpus.find((entry) => entry.rel === "skills/mstar-roles/SKILL.md");
    expect(roles).toBeDefined();
    expect(roles!.text).toContain("## Load Order");
    const gapped = replaceLoadOrderSection(corpus, "skills/mstar-roles/SKILL.md", []);
    const { failures } = checkRolesCorpus(gapped, ROLES_DIR);
    expect(failures.length).toBeGreaterThan(0);
    expect(
      failures.some(
        (row) => row.includes("roles: load-order roles.loadorder.section.missing") && row.includes("mstar-roles"),
      ),
    ).toBe(true);
  });

  test("Load Order section without the core mention fails (roles.loadorder.core.missing)", () => {
    const corpus = realCorpus();
    const roles = corpus.find((entry) => entry.rel === "skills/mstar-roles/SKILL.md");
    expect(roles).toBeDefined();
    const gapped = replaceLoadOrderSection(corpus, "skills/mstar-roles/SKILL.md", [
      "## Load Order (Required)",
      "Read the role reference directly.",
    ]);
    const { failures } = checkRolesCorpus(gapped, ROLES_DIR);
    expect(failures.length).toBeGreaterThan(0);
    expect(
      failures.some(
        (row) => row.includes("roles: load-order roles.loadorder.core.missing") && row.includes("mstar-roles"),
      ),
    ).toBe(true);
  });

  test("mapped reference file missing from the roles dir fails (roles.mapping.reference.missing)", () => {
    const dir = mkdtempSync(join(tmpdir(), "drift-roles-"));
    try {
      const { mappingViolations, failures } = checkRolesCorpus(realCorpus(), dir);
      expect(mappingViolations).toBeGreaterThan(0);
      expect(
        failures.some((row) => row.includes("roles: mapping roles.mapping.reference.missing")),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("non-corpus files are ignored (references/, non-mstar)", () => {
    const { skillsChecked, failures } = checkRolesCorpus(
      [
        { rel: "skills/mstar-roles/references/fullstack-dev-shared.md", text: "# not a SKILL.md" },
        { rel: "skills/grill-me/SKILL.md", text: "# no load order" },
      ],
      ROLES_DIR,
    );
    expect(skillsChecked).toBe(0);
    expect(failures).toEqual([]);
  });

  test("unreadable SKILL.md becomes an explicit roles: read row, not a crash (guard-or-clear-error)", () => {
    const dir = mkdtempSync(join(tmpdir(), "drift-roles-read-"));
    try {
 // A directory named SKILL.md makes readFileSync throw EISDIR
 // deterministically (same trick as the CLI best-effort test) — the
 // guard must surface a clear row and keep scanning, never raw-stack.
      mkdirSync(join(dir, "mstar-foo", "SKILL.md"), { recursive: true });
      const { entries, readFailures } = readRolesCorpus([join(dir, "mstar-foo", "SKILL.md")], dir);
      expect(entries).toEqual([]);
      expect(readFailures.length).toBe(1);
      expect(readFailures[0]).toContain("roles: read mstar-foo/SKILL.md");
      expect(readFailures[0]).toContain("EISDIR");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkProvenanceScan — Guard 7 repo text-face provenance scan", () => {
  /** Synthetic dated-slug token mirroring the real leak shape (a dated
   * plan id cited in a comment / doc prose). Synthetic on purpose —
   * fixtures must never carry real provenance. */
  const SAMPLE_ID = "20991216-provenance-guard-sample";
  /** Root ignores directory permission bits, so a chmod-0o000 probe cannot
   * make readdir fail there — skip instead of flaking on such systems. */
  const CHMOD_PROBE_UNRELIABLE = typeof process.getuid === "function" && process.getuid() === 0;

  test("red probe: real-shaped leak on a temp tree fails the guard (ts comment + md prose)", () => {
    const dir = mkdtempSync(join(tmpdir(), "drift-prov-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(
        join(dir, "src", "sample.ts"),
        ["export const ok = 1;", `// ported from plan ${SAMPLE_ID} Task 2`].join("\n"),
      );
      writeFileSync(join(dir, "docs", "note.md"), `see plan ${SAMPLE_ID} for details\n`);
      writeFileSync(join(dir, "docs", "clean.md"), "no tokens here\n");
      const { entries, readFailures } = collectProvenanceScanFiles(
        dir,
        new Set(["src/sample.ts", "docs/note.md", "docs/clean.md"]),
      );
      expect(readFailures).toEqual([]);
      const result = checkProvenanceScan(entries);
      expect(result.filesScanned).toBe(3);
      expect(result.citationsFound).toBe(2);
      expect(result.failures.some((r) => r.startsWith("src/sample.ts:2 ") && r.includes("(plan-id)"))).toBe(true);
      expect(result.failures.some((r) => r.startsWith("docs/note.md:1 ") && r.includes("(plan-id)"))).toBe(true);
      expect(result.failures.every((r) => !r.includes("docs/clean.md"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(CHMOD_PROBE_UNRELIABLE)(
    "unlistable directory becomes an explicit provenance: read row, not a crash (guard-or-clear-error)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "drift-prov-dir-"));
      const locked = join(dir, "locked");
      try {
        mkdirSync(locked, { recursive: true });
        writeFileSync(join(dir, "clean.md"), "no tokens here\n");
        chmodSync(locked, 0o000);
        const { entries, readFailures } = collectProvenanceScanFiles(dir, new Set(["clean.md"]));
        expect(readFailures.length).toBe(1);
        expect(readFailures[0]).toContain("provenance: read locked");
        // The readable face is still collected; the CLI guard run turns the
        // surfaced row into a named failure + exit 1 through the normal path.
        expect(entries.map((e) => e.rel)).toEqual(["clean.md"]);
      } finally {
        chmodSync(locked, 0o700);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("ts scan face is comment lines only: the same token in code position is not scanned", () => {
    const text = [
      `const citedFrom = "${SAMPLE_ID}";`,
      `// cited from ${SAMPLE_ID}`,
    ].join("\n");
    const result = checkProvenanceScan([{ rel: "src/sample.ts", text }]);
    expect(result.filesScanned).toBe(1);
    expect(result.citationsFound).toBe(1);
    expect(result.failures[0]).toContain("src/sample.ts:2");
  });

  test("exemption surfaces are skipped: assembled CHANGELOG files, archived change fragments, ignored dirs", () => {
    const leak = `plan ${SAMPLE_ID}`;
    const result = checkProvenanceScan([
      { rel: "CHANGELOG.md", text: leak },
      { rel: "README_CN.md", text: "clean\n" },
      { rel: "packages/cli/CHANGELOG.md", text: leak },
      { rel: "packages/cli/CHANGELOG_CN.md", text: leak },
      { rel: ".changes/archive/2026-09/bump.md", text: leak },
      { rel: "node_modules/pkg/index.d.ts", text: `// ${SAMPLE_ID}` },
      { rel: "dist/bundle.js", text: leak },
      { rel: ".tmp/probe.ts", text: `// ${SAMPLE_ID}` },
    ]);
    expect(result.citationsFound).toBe(0);
    expect(result.filesScanned).toBe(1);
    expect(result.failures).toEqual([]);
  });

  test("synthetic example forms pass (finder discrimination preserved through the seam)", () => {
    const result = checkProvenanceScan([
      { rel: "docs/note.md", text: "layout template: 20991231-example-plan\n" },
      { rel: "src/a.ts", text: "// layout template: 20991231-example-plan\n" },
    ]);
    expect(result.citationsFound).toBe(0);
    expect(result.failures).toEqual([]);
  });

  test("harness-path citations are caught with their kind (synthetic dated deeplink)", () => {
    const result = checkProvenanceScan([
      { rel: "docs/note.md", text: `recorded under .mstar/plans/${SAMPLE_ID}.md\n` },
    ]);
    expect(result.citationsFound).toBe(1);
    expect(result.failures[0]).toContain("(harness-path)");
  });

  test("real repo face is collectable and scannable; failure rows stay 1:1 with citations (cleanliness is enforced by the CLI guard run, not pinned here — the existing-leak cleanup is tracked as its own change)", () => {
    const REPO_ROOT = join(import.meta.dir, "..");
    const { tracked, failures: trackedFailures } = readTrackedFiles(REPO_ROOT);
    expect(trackedFailures).toEqual([]);
    const { entries, readFailures } = collectProvenanceScanFiles(REPO_ROOT, tracked);
    expect(readFailures).toEqual([]);
    expect(entries.length).toBeGreaterThan(0);
    const result = checkProvenanceScan(entries);
    // The scan skips exactly the assembled-changelog entries the collector
    // hands it: file-level exemption lives at scan level, the walk prunes
    // only exemption dirs.
    const assembled = entries.filter((e) => {
      const base = e.rel.split("/").pop();
      return base === "CHANGELOG.md" || base === "CHANGELOG_CN.md";
    }).length;
    expect(result.filesScanned).toBe(entries.length - assembled);
    expect(result.failures.length).toBe(result.citationsFound);
  });

  test("ts trailing comments are scanned: the fragment from the first qualifying // fails at its real line (F-B)", () => {
    const text = [
      "export const ok = 1;",
      `const x = 1; // ported from plan ${SAMPLE_ID}`,
    ].join("\n");
    const result = checkProvenanceScan([{ rel: "src/a.ts", text }]);
    expect(result.filesScanned).toBe(1);
    expect(result.citationsFound).toBe(1);
    expect(result.failures[0]).toContain("src/a.ts:2");
    expect(result.failures[0]).toContain("(plan-id)");
  });

  test("ts trailing-comment rule excludes :// URL sequences (F-B)", () => {
    const text = [
      `const u = "https://example.com/${SAMPLE_ID}";`,
      `const v = "https://example.com/x"; // clean trailing comment`,
    ].join("\n");
    const result = checkProvenanceScan([{ rel: "src/a.ts", text }]);
    expect(result.citationsFound).toBe(0);
    expect(result.failures).toEqual([]);
  });

  test("ts trailing-comment rule catches a no-whitespace `statement;// comment` line (F-E)", () => {
    const text = [`const x = 1;// ported from plan ${SAMPLE_ID}`].join("\n");
    const result = checkProvenanceScan([{ rel: "src/a.ts", text }]);
    expect(result.citationsFound).toBe(1);
    expect(result.failures[0]).toContain("src/a.ts:1");
    expect(result.failures[0]).toContain("(plan-id)");
  });

  test("ts trailing-comment rule masks string literals: a `//` inside a quoted span is not a comment introducer (F-E)", () => {
    const text = [
      `const s = "label // plan ${SAMPLE_ID}";`,
      `const t = 'single // plan ${SAMPLE_ID}';`,
    ].join("\n");
    const result = checkProvenanceScan([{ rel: "src/a.ts", text }]);
    expect(result.citationsFound).toBe(0);
    expect(result.failures).toEqual([]);
  });

  test("ts trailing-comment rule masks template literals: a `//` inside a backtick span is not a comment introducer (F-F)", () => {
    const text = [
      "const a = `see // plan " + SAMPLE_ID + "`;",
      "const b = `https://example.com/" + SAMPLE_ID + "/x`;",
    ].join("\n");
    const result = checkProvenanceScan([{ rel: "src/a.ts", text }]);
    expect(result.filesScanned).toBe(1);
    expect(result.citationsFound).toBe(0);
    expect(result.failures).toEqual([]);
  });

  test("ts introducer face is template-literal aware: a line-start `//` inside a multi-line backtick span is not scanned (F-F)", () => {
    const text = [
      "const s = [",
      "  `",
      `// plan ${SAMPLE_ID}`,
      "  `,",
      "];",
    ].join("\n");
    const result = checkProvenanceScan([{ rel: "src/a.ts", text }]);
    expect(result.filesScanned).toBe(1);
    expect(result.citationsFound).toBe(0);
    expect(result.failures).toEqual([]);
  });

  test("ts first-token comment face unchanged (F-B): block comment and continuation lines still scanned, code without a trailing comment stays blanked", () => {
    const text = [
      `/* header cites ${SAMPLE_ID} */`,
      ` * continued ${SAMPLE_ID}`,
      `const cited = "${SAMPLE_ID}";`,
    ].join("\n");
    const result = checkProvenanceScan([{ rel: "src/a.ts", text }]);
    expect(result.citationsFound).toBe(2);
    expect(result.failures.some((r) => r.startsWith("src/a.ts:1 "))).toBe(true);
    expect(result.failures.some((r) => r.startsWith("src/a.ts:2 "))).toBe(true);
    expect(result.failures.every((r) => !r.startsWith("src/a.ts:3"))).toBe(true);
  });

  test("tracked-set seam: untracked files are not collected, tracked files stay on the face (F-C)", () => {
    const dir = mkdtempSync(join(tmpdir(), "drift-prov-tracked-"));
    try {
      writeFileSync(join(dir, "tracked.md"), `plan ${SAMPLE_ID}\n`);
      writeFileSync(join(dir, "untracked.md"), `plan ${SAMPLE_ID}\n`);
      const { entries, readFailures } = collectProvenanceScanFiles(dir, new Set(["tracked.md"]));
      expect(readFailures).toEqual([]);
      expect(entries.map((e) => e.rel)).toEqual(["tracked.md"]);
      const result = checkProvenanceScan(entries);
      expect(result.citationsFound).toBe(1);
      expect(result.failures[0]).toContain("tracked.md:1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readTrackedFiles returns the repo-root-relative tracked set; a git failure is one named row with an empty set (F-C guard-or-clear)", () => {
    const REPO_ROOT = join(import.meta.dir, "..");
    const ok = readTrackedFiles(REPO_ROOT);
    expect(ok.failures).toEqual([]);
    expect(ok.tracked.has("scripts/drift-lint.ts")).toBe(true);
    const notARepo = mkdtempSync(join(tmpdir(), "drift-prov-norepo-"));
    try {
      const bad = readTrackedFiles(notARepo);
      expect(bad.tracked.size).toBe(0);
      expect(bad.failures.length).toBe(1);
      expect(bad.failures[0]).toContain("provenance: git ls-files failed");
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  test("readTrackedFiles keeps space-padded tracked filenames verbatim so the walk intersection still matches (F-D)", () => {
    const dir = mkdtempSync(join(tmpdir(), "drift-prov-space-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, " docs.md"), `plan ${SAMPLE_ID}\n`);
      execFileSync("git", ["add", " docs.md"], { cwd: dir });
      const { tracked, failures } = readTrackedFiles(dir);
      expect(failures).toEqual([]);
      expect(tracked.has(" docs.md")).toBe(true);
      // The verbatim ls-files entry matches the fs-relative walk path: the
      // legitimately-named tracked file stays on the scan face instead of
      // being skipped by a trimmed comparison.
      const { entries, readFailures } = collectProvenanceScanFiles(dir, tracked);
      expect(readFailures).toEqual([]);
      expect(entries.map((e) => e.rel)).toEqual([" docs.md"]);
      const result = checkProvenanceScan(entries);
      expect(result.citationsFound).toBe(1);
      expect(result.failures[0]).toContain(" docs.md:1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
