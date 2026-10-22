/**
 * CLI audit subcommands — thin engine-backed wrappers:
 *   mstar audit scaffold <findings-file> [--level] [--round] [--reviews-dir] [--dir],
 *   mstar audit secret-scan [path], mstar audit supply-chain [path].
 * Moved from slice4-cli.test.ts during the command-owner test split.
 *
 * Exit-code contract (slice-2/3 convention): 0 = OK, 1 = violations / file
 * errors, 2 = usage (missing/invalid args). Each case runs the real CLI as a
 * subprocess against /tmp fixtures and asserts exit code + reported codes.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, withTempDir } from "./harness";
import { cliEnvelope } from "./support/cli-assertions";

// ---------------------------------------------------------------------------
// mstar audit scaffold
// ---------------------------------------------------------------------------

describe("mstar audit scaffold — review run dir from findings JSON", () => {
  const FINDINGS = [
    { title: "Fix N+1 query", priority: "P1", effort: "M", risk: "HIGH", category: "perf", description: "Queries explode on the dashboard." },
    { title: "Add index", priority: "P2", effort: "XS", risk: "LOW", category: "tech-debt", description: "Index the audit table." },
  ];

  test("valid findings → one run report (README.md), exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      const outDir = join(dir, "audit-2026-08-08");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir, "--date", "2026-08-08"]);
      expect(result.exitCode).toBe(0);
      const envelope = cliEnvelope(result, "ok", "audit.scaffold.ok");
      expect(envelope.data).toMatchObject({ outDir, file: join(outDir, "README.md"), date: "2026-08-08", level: "standard", round: 1 });
      // The report index is the run's only artifact — no per-finding plan files.
      expect(readdirSync(outDir)).toEqual(["README.md"]);
      const report = readFileSync(join(outDir, "README.md"), "utf8");
      expect(report).toContain("Fix N+1 query");
      expect(report).toContain("Add index");
      expect(report).toContain("Queries explode on the dashboard.");
    });
  });

  test("run dir defaults to {REVIEW_DIR}/<date>-codebase-<level>-<round>", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      // cwd = the repo root of a harness → {REVIEW_DIR} = <cwd>/.mstar/reviews
      mkdirSync(join(dir, ".mstar"), { recursive: true });
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      // macOS resolves /var to /private/var: the CLI path derives from the realpath'd cwd.
      const reviewsDir = join(realpathSync(dir), ".mstar", "reviews");
      const base = ["audit", "scaffold", findingsFile, "--date", "2026-08-08", "--sha", "deadbee"];

      const first = runCli(base, { cwd: dir });
      expect(first.exitCode).toBe(0);
      expect(cliEnvelope(first, "ok", "audit.scaffold.ok").data).toMatchObject({
        outDir: join(reviewsDir, "2026-08-08-codebase-standard-1"),
        file: join(reviewsDir, "2026-08-08-codebase-standard-1", "README.md"),
        date: "2026-08-08", level: "standard", round: 1,
      });
      // Another level takes its own run dir; an explicit round reuses that exact one.
      expect(cliEnvelope(runCli([...base, "--level", "deep"], { cwd: dir }), "ok", "audit.scaffold.ok").data).toMatchObject({
        outDir: join(reviewsDir, "2026-08-08-codebase-deep-1"), level: "deep", round: 1,
      });
      expect(cliEnvelope(runCli([...base, "--round", "2"], { cwd: dir }), "ok", "audit.scaffold.ok").data).toMatchObject({
        outDir: join(reviewsDir, "2026-08-08-codebase-standard-2"), round: 2,
      });
      // --reviews-dir overrides the root; --level input stays validated.
      expect(cliEnvelope(runCli([...base, "--reviews-dir", join(dir, "elsewhere")], { cwd: dir }), "ok", "audit.scaffold.ok").data).toMatchObject({
        outDir: join(dir, "elsewhere", "2026-08-08-codebase-standard-1"),
      });
      const badLevel = runCli([...base, "--level", "thorough"], { cwd: dir });
      expect(badLevel.exitCode).toBe(2);
      expect(cliEnvelope(badLevel, "usage", "command.invalid-input").message).toContain("--level must be one of");
    });
  });

  test("the report records the repo short SHA resolved at scaffold time", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      const outDir = join(dir, "audit-2026-08-08");
      // cwd = this repo checkout → git rev-parse --short HEAD resolves
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir, "--date", "2026-08-08"]);
      expect(result.exitCode).toBe(0);
      const report = readFileSync(join(outDir, "README.md"), "utf8");
      expect(report).toMatch(/@ [0-9a-f]{7,40} \(2026-08-08\)/);
      expect(report).not.toContain("@ unknown ");
    });
  });

  test("--sha override wins over git resolution; outside a repo the fallback is 'unknown'", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      const outDir = join(dir, "audit-2026-08-08");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir, "--sha", "deadbee", "--date", "2026-08-08"]);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(outDir, "README.md"), "utf8")).toContain("@ deadbee (2026-08-08)");
    });
    withTempDir("mstar-slice4-cli-", (dir) => {
      mkdirSync(join(dir, ".mstar"), { recursive: true });
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      // cwd = a temp dir outside any git repo; --date pinned so the run dir is not a calendar flake
      const result = runCli(["audit", "scaffold", findingsFile, "--date", "2026-08-08"], { cwd: dir });
      expect(result.exitCode).toBe(0);
      const report = join(dir, ".mstar", "reviews", "2026-08-08-codebase-standard-1", "README.md");
      expect(existsSync(report)).toBe(true);
      expect(readFileSync(report, "utf8")).toContain("@ unknown (2026-08-08)");
    });
  });

  test("supplied confidence + evidence reach the report index (fidelity regression)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(
        findingsFile,
        JSON.stringify([
          {
            title: "Unparameterized sink in export path",
            priority: "P1",
            effort: "S",
            risk: "HIGH",
            category: "security",
            description: "User-controlled CSV export interpolates raw SQL.",
            confidence: "HIGH",
            evidence: ["src/export.ts:88 — f-string builds the query", "src/export.ts:120 — same sink in the retry path", "  padded entry — rendered exactly as supplied  "],
            fixSketch: "Parameterize both call sites.",
            verification: "bun test packages/api/test/export.test.ts",
          },
        ]),
      );
      // Date/SHA pinned: the run report title is calendar/SHA flake-proof.
      const outDir = join(dir, "audit-2026-08-08");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir, "--sha", "deadbee", "--date", "2026-08-08"]);
      expect(result.exitCode).toBe(0);
      const report = readFileSync(join(outDir, "README.md"), "utf8");
      // Explicit HIGH confidence is persisted, with the first evidence preview in the row.
      expect(report).toContain("| HIGH | src/export.ts:88 — f-string builds the query |");
      expect(report).toContain("| 001 | Unparameterized sink in export path | security |");
    });
  });

  test("absent confidence/evidence defaults to MED/[] and the report has no plan sections", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify([{ title: "Add index", priority: "P2", effort: "XS", risk: "LOW", category: "tech-debt", description: "Index the audit table." }]));
      const outDir = join(dir, "audit-2026-08-08");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir, "--sha", "deadbee", "--date", "2026-08-08"]);
      expect(result.exitCode).toBe(0);
      const report = readFileSync(join(outDir, "README.md"), "utf8");
      // The row's trailing "| MED |  |" (empty Evidence cell, two spaces) is
      // part of the pinned bytes — a legacy-shape regression fails here.
      expect(report).toContain("| 001 | Add index | tech-debt | Index the audit table. | XS | LOW | MED |  |");
      // Plan-only sections are gone from the review surface.
      expect(report).not.toContain("## Execution order & status");
      expect(report).not.toContain("- **Planned at**:");
    });
  });

  test("invalid confidence (null / wrong enum) and non-string evidence entries fail usage exit 2", () => {
    for (const bad of [
      { confidence: null },
      { confidence: "CERTAIN" },
      { evidence: "src/a.ts:1" },
      { evidence: [42] },
      { fixSketch: "" },
      { verification: "   " },
    ]) {
      withTempDir("mstar-slice4-cli-", (dir) => {
        const findingsFile = join(dir, "findings.json");
        writeFileSync(findingsFile, JSON.stringify([{ title: "X", priority: "P1", effort: "M", risk: "LOW", category: "perf", description: "d", ...bad }]));
        const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
        expect({ input: bad, exitCode: result.exitCode }).toEqual({ input: bad, exitCode: 2 });
        // validation errors must not echo submitted values
        expect(result.stderr).not.toContain("CERTAIN");
        expect(result.stderr).not.toContain("src/a.ts:1");
      });
    }
  });

  test("malformed JSON → usage, exit 2", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, "not json");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain("not valid JSON");
    });
  });

  test("JSON null root → usage, exit 2 (typeof null === 'object' must not reach the object branch)", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, "null");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain("must be an array or an object with a findings array");
    });
  });

  test("empty JSON object without findings → usage, exit 2", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, "{}");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain("must be an array or an object with a findings array");
    });
  });

  test("object with findings: null → usage, exit 2", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify({ findings: null }));
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain("must be an array or an object with a findings array");
    });
  });

  test("object form with needsVerification + hardeningChecked renders the security sections", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(
        findingsFile,
        JSON.stringify({
          findings: FINDINGS,
          needsVerification: [{ lead: "SSRF in webhook fetcher", how: "confirm caller supplies the URL", evidence: "src/hooks.ts:77" }],
          hardeningChecked: [
            { kind: "Hardening", text: "no CSP header - middleware escapes all output" },
            { kind: "Checked and clean", text: "orders SQL sink parameterized end to end" },
          ],
        }),
      );
      const outDir = join(dir, "audit-2026-08-08");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir]);
      expect(result.exitCode).toBe(0);
      const readme = readFileSync(join(outDir, "README.md"), "utf8");
      expect(readme).toContain("## Needs verification");
      expect(readme).toContain("- SSRF in webhook fetcher: confirm caller supplies the URL (src/hooks.ts:77)");
      expect(readme).toContain("## Hardening & checked notes");
      expect(readme).toContain("- Hardening: no CSP header - middleware escapes all output");
      expect(readme).toContain("- Checked and clean: orders SQL sink parameterized end to end");
    });
  });

  test("invalid hardeningChecked kind → usage, exit 2", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(
        findingsFile,
        JSON.stringify({
          findings: FINDINGS,
          hardeningChecked: [{ kind: "Note", text: "x" }],
        }),
      );
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain("kind must be Hardening|Checked and clean");
    });
  });

  test("invalid enum value → usage, exit 2", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify([{ title: "X", priority: "P9", effort: "M", risk: "LOW", category: "perf", description: "d" }]));
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain("priority must be one of P1|P2|P3");
    });
  });

  test("missing required fields → usage, exit 2", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify([{ title: "X", priority: "P1", effort: "M", risk: "LOW", category: "perf" }]));
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain("needs non-empty title and description");
    });
  });

  test("missing args → usage, exit 2", () => {
    const result = runCli(["audit", "scaffold"]);
    expect(result.exitCode).toBe(2);
    expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain("findings");
  });

  test("nonexistent findings file → exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["audit", "scaffold", join(dir, "nope.json"), "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused", "audit.scaffold.refused").message).toContain("findings file not found");
    });
  });

  test("enriched finding (fingerprint/trace/severity/object evidence) renders metadata; legacy row shows — cells", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(
        findingsFile,
        JSON.stringify([
          { title: "Legacy row", priority: "P2", effort: "S", risk: "LOW", category: "tests", description: "Legacy finding." },
          {
            title: "Unparameterized sink in export path",
            priority: "P1",
            effort: "S",
            risk: "HIGH",
            category: "security",
            description: "User-controlled CSV export interpolates raw SQL.",
            confidence: "MED",
            fingerprint: "sql-export-sink",
            evidence: ["src/export.ts:88 — f-string builds the query", { file: "src/export.ts", line: 120, description: "same sink in the retry path" }],
            trace: [
              { kind: "entrypoint", file: "src/routes/export.ts", line: 10, scope: "GET /export", description: "query param reaches the exporter" },
              { kind: "propagation", file: "src/export.ts", line: 64, scope: "buildQuery", description: "parameter concatenated into SQL" },
              { kind: "sink", file: "src/export.ts", line: 88, scope: "runExport", description: "query executed" },
            ],
            severity: { likelihood: "high", impact: "high", overall: "medium" },
          },
        ]),
      );
      const outDir = join(dir, "audit-2026-08-08");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir, "--sha", "deadbee", "--date", "2026-08-08"]);
      expect(result.exitCode).toBe(0);
      const report = readFileSync(join(outDir, "README.md"), "utf8");
      expect(report).toContain("Evidence | Fingerprint | Likelihood | Severity impact | Severity |");
      expect(report).toContain("| 001 | Legacy row | tests | Legacy finding. | S | LOW | MED |  | — | — | — | — |");
      expect(report).toContain("| sql-export-sink | high | high | medium |");
      // object evidence renders its file:line and description
      expect(report).toContain("src/export.ts:120 — same sink in the retry path");
    });
  });

  // Thirteen spawns, one per invalid payload: the default 5s budget is not
  // enough on a loaded CI shard, and a timeout here reads as a wrong exit code.
  test("invalid optional-field states → usage, exit 2", { timeout: 60_000 }, () => {
    for (const bad of [
      { fingerprint: null },
      { fingerprint: 42 },
      { fingerprint: "" },
      { trace: "not-an-array" },
      { trace: [] },
      { trace: [{ kind: "entrypoint", file: "src/a.ts", line: 1, description: "missing scope" }] },
      { trace: [{ kind: "middle", file: "src/a.ts", line: 1, scope: "s", description: "bad kind" }] },
      { severity: { likelihood: "high", impact: "high" } },
      { severity: { likelihood: "high", impact: "high", overall: "CERTAIN" } },
      { evidence: [{ line: 1, description: "missing file" }] },
      { evidence: [{ file: "src/a.ts", line: "88", description: "d" }] },
      { evidence: [{ file: "src/a.ts", line: 0, description: "d" }] },
      { evidence: [{ file: "src/a.ts", description: "   " }] },
    ]) {
      withTempDir("mstar-slice4-cli-", (dir) => {
        const findingsFile = join(dir, "findings.json");
        writeFileSync(findingsFile, JSON.stringify([{ title: "X", priority: "P1", effort: "M", risk: "LOW", category: "perf", description: "d", ...bad }]));
        const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
        expect({ input: bad, exitCode: result.exitCode }).toEqual({ input: bad, exitCode: 2 });
        // gate diagnostics never echo submitted values
        expect(result.stderr).not.toContain("CERTAIN");
        expect(result.stderr).not.toContain("src/a.ts");
      });
    }
  });

  test("gate rejections surface as usage exit 2 with field path only: ordering, unsafe path, secret fingerprint", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(
        findingsFile,
        JSON.stringify([
          { title: "A", priority: "P1", effort: "M", risk: "LOW", category: "perf", description: "d", fingerprint: "zeta-first" },
          { title: "B", priority: "P1", effort: "M", risk: "LOW", category: "perf", description: "d", fingerprint: "alpha-second" },
        ]),
      );
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      const envelope = cliEnvelope(result, "usage", "command.invalid-input");
      expect(envelope.message).toContain("audit.finding.fingerprint.order");
      expect(envelope.message).toContain("findings[1].fingerprint");
      expect(existsSync(join(dir, "out"))).toBe(false); // zero new files on rejection
    });
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(
        findingsFile,
        JSON.stringify([{ title: "X", priority: "P1", effort: "M", risk: "LOW", category: "perf", description: "d", evidence: [{ file: "../escape.ts", line: 1, description: "d" }] }]),
      );
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      const envelope = cliEnvelope(result, "usage", "command.invalid-input");
      expect(envelope.message).toContain("audit.finding.path.unsafe");
      expect(envelope.message).not.toContain("../escape.ts");
    });
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(
        findingsFile,
        JSON.stringify([{ title: "X", priority: "P1", effort: "M", risk: "LOW", category: "perf", description: "d", fingerprint: "leak-AKIAIOSFODNN7EXAMPLE" }]),
      );
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      // grammar-valid but credential-shaped: the secret rule fires (not grammar)
      const envelope = cliEnvelope(result, "usage", "command.invalid-input");
      expect(envelope.message).toContain("audit.finding.fingerprint.secret");
      expect(envelope.message).not.toContain("audit.finding.fingerprint.grammar");
      expect(envelope.message).not.toContain("AKIAIOSFODNN7");
    });
  });

  test("rejected batch leaves an existing README untouched", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const outDir = join(dir, "audit-2026-08-08");
      mkdirSync(outDir, { recursive: true });
      const readme = join(outDir, "README.md");
      writeFileSync(readme, "# pre-existing index\n");
      const findingsFile = join(dir, "findings.json");
      writeFileSync(
        findingsFile,
        JSON.stringify([{ title: "X", priority: "P1", effort: "M", risk: "LOW", category: "perf", description: "d", fingerprint: "-bad-grammar" }]),
      );
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir]);
      expect(result.exitCode).toBe(2);
      expect(readFileSync(readme, "utf8")).toBe("# pre-existing index\n");
      expect(readdirSync(outDir)).toEqual(["README.md"]);
    });
  });
});

// ---------------------------------------------------------------------------
// mstar audit secret-scan / supply-chain — deterministic static checks
// ---------------------------------------------------------------------------

describe("mstar audit secret-scan — tracked-file credential scan", () => {
  test("seeded secret in a tracked file → finding JSON + exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      mkdirSync(join(dir, "sub"), { recursive: true });
      // Inert filler matching the AWS whole-match shape (AKIA + 16 alnum).
      // Split literal: keep the raw source free of the full contiguous token
      // (GitHub push protection treats test values as live credentials).
      const awsKey = "AKIAIOSFODNN7" + "EXAMPLE";
      writeFileSync(join(dir, "sub", "config.ts"), `token = "${awsKey}"\n`);
      writeFileSync(join(dir, ".env.production"), "SECRET=placeholder\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      const result = runCli(["audit", "secret-scan", dir]);
      expect(result.exitCode).toBe(1);
      // 3 hits: the whole-match AWS shape + the VALUE_PATTERNS `token` row on
      // the same line, plus the never-commit `.env.production` filename.
      const findings = cliEnvelope(result, "refused", "audit.secret-scan.findings").details?.findings ?? [];
      expect(findings).toHaveLength(3);
      const aws = findings.find(({ type }) => type === "aws-access-key");
      expect(aws).toEqual({ file: join(dir, "sub", "config.ts"), line: 1, type: "aws-access-key" });
      const envHit = findings.find(({ type }) => type === "env-file");
      expect(envHit?.line).toBe(1);
      expect(findings.every(({ file, line, type }) => Boolean(file) && Number(line) > 0 && Boolean(type))).toBe(true);
      // Hard Rule 4 at the shipped boundary: the seeded raw values must be
      // absent from BOTH output streams.
      expect(result.stdout + result.stderr).not.toContain(awsKey);
      expect(result.stdout + result.stderr).not.toContain("SECRET=placeholder");
    });
  });

  test("clean repo → exit 0, no finding lines", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      writeFileSync(join(dir, "main.ts"), `const key = process.env.API_KEY;\n`);
      execFileSync("git", ["add", "-A"], { cwd: dir });
      const result = runCli(["audit", "secret-scan", dir]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "audit.secret-scan.ok").data).toMatchObject({ findings: [], unreadableFiles: 0, filesScanned: 1 });
    });
  });

  test("untracked files are not scanned; path argument must be a directory → exit 2", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const token = randomBytes(24).toString("hex");
      writeFileSync(join(dir, "leak.ts"), `token = "${token}"\n`);
      // NOT staged → not tracked → not scanned
      const result = runCli(["audit", "secret-scan", dir]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "audit.secret-scan.ok").data).toMatchObject({ findings: [], unreadableFiles: 0, filesScanned: 0 });
      execFileSync("git", ["add", "leak.ts"], { cwd: dir });
      const tracked = runCli(["audit", "secret-scan", dir]);
      expect(tracked.exitCode).toBe(1);
      expect(cliEnvelope(tracked, "refused", "audit.secret-scan.findings").details?.findings?.map(({ type }) => type)).toContain("token");
      expect(tracked.stdout + tracked.stderr).not.toContain(token);
      const bad = runCli(["audit", "secret-scan", join(dir, "no-such-dir")]);
      expect(bad.exitCode).toBe(2);
      expect(cliEnvelope(bad, "usage", "command.invalid-input").message).toContain("not a directory");
    });
  });

  test("nested path argument resolves tracked files under it", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      // Leak lives in a NESTED package dir; scan target is that dir.
      const pkg = join(dir, "packages", "engine");
      mkdirSync(pkg, { recursive: true });
      // Synthetic Stripe live-key, split so the raw source never holds the
      // full contiguous token (GitHub push-protection false positive).
      const stripeKey = "sk_live_" + "Z9y8X7W6V5U4T3S2R1Q0P9O8N7";
      writeFileSync(join(pkg, "leak.ts"), `token = "${stripeKey}"\n`);
      writeFileSync(join(dir, "readme.md"), "harmless\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      const result = runCli(["audit", "secret-scan", pkg]);
      expect(result.exitCode).toBe(1);
      const findings = cliEnvelope(result, "refused", "audit.secret-scan.findings").details?.findings ?? [];
      expect(findings.find(({ type }) => type === "stripe-live-key")).toEqual({ file: join(pkg, "leak.ts"), line: 1, type: "stripe-live-key" });
    });
  });

  test("non-git directory → exit 2, not a clean exit 0 ", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "main.ts"), `const ok = 1;\n`);
      const result = runCli(["audit", "secret-scan", dir]);
      expect(result.exitCode).toBe(2);
      expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain("not a git repository or git unavailable");
    });
  });

  test("unreadable tracked file forces non-zero even with no findings", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      const locked = join(dir, "locked.txt");
      writeFileSync(locked, "benign content\n");
      execFileSync("git", ["add", "-A"], { cwd: dir });
      chmodSync(locked, 0o000);
      try {
        const result = runCli(["audit", "secret-scan", dir]);
        expect(result.exitCode).not.toBe(0);
        const envelope = cliEnvelope(result, "refused", "audit.secret-scan.incomplete");
        expect(envelope.message).toContain("failed to read");
        expect(envelope.details?.unreadableFiles).toBe(1);
      } finally {
        chmodSync(locked, 0o644);
      }
    });
  });
});

describe("mstar audit supply-chain — lockfile + workflow checks", () => {
  test("lockfile missing at root → lockfile-missing finding + exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const result = runCli(["audit", "supply-chain", dir]);
      expect(result.exitCode).toBe(1);
      const findings = cliEnvelope(result, "refused", "audit.supply-chain.findings").details?.findings ?? [];
      expect(findings.map(({ kind }) => kind)).toContain("lockfile-missing");
    });
  });

  test("two root lockfiles → lockfile-duplicate finding + exit 1", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      for (const name of ["package-lock.json", "yarn.lock"]) writeFileSync(join(dir, name), "{}\n");
      const result = runCli(["audit", "supply-chain", dir]);
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused", "audit.supply-chain.findings").details?.findings?.map(({ kind }) => kind)).toContain("lockfile-duplicate");
    });
  });

  test("single lockfile + SHA-pinned workflow → clean, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      writeFileSync(join(dir, "bun.lock"), "{}\n");
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      const sha = "a".repeat(40);
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        ["name: ci", "on:", "  push:", "jobs:", "  build:", "    steps:", `      - uses: actions/checkout@${sha}`].join("\n") + "\n",
      );
      const result = runCli(["audit", "supply-chain", dir]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "audit.supply-chain.ok").data).toMatchObject({ ok: true, violations: [], findings: [] });
    });
  });
});

// ---------------------------------------------------------------------------
// mstar audit — retired verbs
// ---------------------------------------------------------------------------

describe("mstar audit verbs", () => {
  test("the retired promote verb is absent from CLI help and no longer resolves", () => {
    const help = runCli(["audit", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).not.toContain("promote");
    expect(help.stdout).not.toContain("--delivery-kind");
    for (const verb of ["scaffold", "secret-scan", "supply-chain"]) {
      expect(help.stdout).toContain(verb);
    }
    // Not a command any more: an unknown verb is a usage error.
    expect(runCli(["audit", "promote", "some-dir", "--delivery-kind", "development"]).exitCode).toBe(2);
  });
});

