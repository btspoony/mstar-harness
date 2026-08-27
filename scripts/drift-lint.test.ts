/**
 * scripts/drift-lint.ts — guard semantics (QC fix wave: W-1/F-001, W-2,
 * S-1/F-002). Pins the committed guard behavior that previously had zero
 * automated coverage:
 * - checkBilingualPairing (guard 2 pairing logic) — all four change sets.
 * - evaluateBilingualGuard — the CI fail-loudly contract (GITHUB_ACTIONS
 *   env injection): a null range fails in CI, skips locally; an empty range
 *   (direct-to-main push) skips by design; a non-empty range runs the check.
 * - extractCategoryRowTokens (guard 1) — the docs/cli.md `<category>` row
 *   yields exactly AUDIT_CATEGORIES; fabricated tokens are kept for the
 *   membership check; `Category` / `<category>` placeholders are filtered.
 * - citesKnowledgeConventions (W-2) — the exemption is anchored to the
 *   cited token itself (the citation path starts with `conventions/`);
 *   proximity alone no longer exempts unrelated citations.
 * - checkFiveQuestionCorpus (guard 5) — five-question runtime smoke over
 *   the shipped `mstar-*` corpus: the real corpus passes runtime-mode
 *   lint; deleting an alias-covered heading (mstar-audit `## Output
 *   format`) or a Step-3 aligned heading (mstar-sdd `## Progress ledger`)
 *   fails; non-corpus files are ignored (load-bearing per plan Step 7).
 * - checkRolesCorpus (guard 4) — roles/load-order corpus smoke: the real
 *   corpus passes load-order lint + role mapping (19 skills, 0 mapping
 *   violations); deleting a Load Order section
 *   (roles.loadorder.section.missing) or losing the core mention
 *   (roles.loadorder.core.missing) fails; a roles dir missing mapped
 *   reference files fails (roles.mapping.reference.missing); non-corpus
 *   files are ignored (load-bearing per plan Step 3).
 * - readDeclaredBins (F-S2) — Guard 1's manifest read is guard-or-clear:
 *   missing / corrupt / bin-less manifests each return one explicit
 *   failure row (never a silent skip that would flood every citation).
 * - checkEngineCallouts real-corpus pin (F-S3) — the shipped skills corpus
 *   yields exactly 45 Engine-check callouts / 43 CLI citations against the
 *   live CLI inventory + declared bins (4 lease/seats callouts consolidated
 *   to canonical pointers by plan 20260822-skill-pointer-hygiene Task 2);
 *   corpus drift goes red.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";
import { AUDIT_CATEGORIES } from "../packages/engine/src/index.ts";
import {
  buildCliCommandInventory,
  buildEngineExportNames,
  checkBilingualContentParity,
  checkBilingualPairing,
  checkCalloutDuplication,
  checkEngineCallouts,
  checkFiveQuestionCorpus,
  checkRolesCorpus,
  citesKnowledgeConventions,
  evaluateBilingualGuard,
  extractCategoryRowTokens,
  isGitHubActions,
  readDeclaredBins,
  readRolesCorpus,
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

describe("evaluateBilingualGuard — CI fail-loudly vs local skip (W-1/F-001)", () => {
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

describe("extractCategoryRowTokens — docs/cli.md `<category>` row (guard 1)", () => {
  test("real docs/cli.md <category> row yields exactly AUDIT_CATEGORIES", () => {
    const cliMd = readFileSync(join(import.meta.dir, "..", "docs", "cli.md"), "utf8");
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
   * manifest test from plan Task 1). */
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

  test("real corpus pins 44 Engine-check callouts / 42 CLI citations (F-S3, drift goes red)", () => {
    const REPO_ROOT = join(import.meta.dir, "..");
    const SKILLS_ROOT = join(REPO_ROOT, "skills");

    /** Every `.md` file under skills/ with the repo-relative `rel` Guard 1
     * sees in main — the 45/43 counts are a regression pin: adding or
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
    expect(calloutsChecked).toBe(45);
    expect(cliCitationsChecked).toBe(43);
    expect(failures).toEqual([]);
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

describe("checkCalloutDuplication — Guard 6 Engine-check callout dedup (plan 20260822-skill-pointer-hygiene Task 2)", () => {
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
