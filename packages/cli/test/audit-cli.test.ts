/**
 * CLI audit subcommands — thin engine-backed wrappers:
 *   mstar audit scaffold <findings-file> [--dir <out-dir>],
 *   mstar audit promote <audit-dir> --plans <ids>,
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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, scaffoldAuditPlan, validateAuditStatusBlocks } from "@mstar-harness/engine";
import { runCli, withTempDir } from "./harness";
import { cliEnvelope, expectUsageDiagnostic } from "./support/cli-assertions";

// ---------------------------------------------------------------------------
// mstar audit scaffold
// ---------------------------------------------------------------------------

describe("mstar audit scaffold — plan directory from findings JSON", () => {
  const FINDINGS = [
    { title: "Fix N+1 query", priority: "P1", effort: "M", risk: "HIGH", category: "perf", dependsOn: "002", description: "Queries explode on the dashboard." },
    { title: "Add index", priority: "P2", effort: "XS", risk: "LOW", category: "tech-debt", description: "Index the audit table." },
  ];

  test("valid findings → plan files + README created, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      const outDir = join(dir, "audit-2026-08-08");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "audit.scaffold.ok").data).toMatchObject({
        outDir,
        files: ["001-fix-n-1-query.md", "002-add-index.md"],
        nextNumber: 3,
      });
      expect(existsSync(join(outDir, "001-fix-n-1-query.md"))).toBe(true);
      expect(existsSync(join(outDir, "002-add-index.md"))).toBe(true);
      expect(existsSync(join(outDir, "README.md"))).toBe(true);
      // Status block carries the mapped fields (description → Impact section).
      const plan = readFileSync(join(outDir, "001-fix-n-1-query.md"), "utf8");
      expect(plan).toContain("## Impact");
      expect(plan).toContain("Queries explode on the dashboard.");
      expect(plan).toContain("- **Priority**: P1");
      // dependsOn "002" (scaffolded numbering scheme) renders as the
      // documented plans/NNN-*.md form — no dangling Evidence heading either.
      expect(plan).toContain("- **Depends on**: plans/002-*.md");
      expect(plan).not.toContain("## Evidence");
    });
  });

  test("scaffolded plans round-trip through the engine's validateAuditStatusBlocks", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      const outDir = join(dir, "audit-2026-08-08");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir]);
      expect(result.exitCode).toBe(0);
      for (const file of ["001-fix-n-1-query.md", "002-add-index.md"]) {
        const gate = validateAuditStatusBlocks(readFileSync(join(outDir, file), "utf8"));
        expect({ file, ok: gate.ok, violations: gate.violations.map((v) => v.code) }).toEqual({ file, ok: true, violations: [] });
      }
    });
  });

  test("Planned at carries the repo short SHA resolved at scaffold time", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      const outDir = join(dir, "audit-2026-08-08");
      // cwd = this repo checkout → git rev-parse --short HEAD resolves
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir]);
      expect(result.exitCode).toBe(0);
      const plan = readFileSync(join(outDir, "001-fix-n-1-query.md"), "utf8");
      const plannedAt = /- \*\*Planned at\*\*: commit `([0-9a-f]{7,40})`, \d{4}-\d{2}-\d{2}/.exec(plan);
      expect(plannedAt).not.toBeNull();
      expect(plannedAt![1]).not.toBe("unknown");
    });
  });

  test("--sha override wins over git resolution; outside a repo the fallback is 'unknown'", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      const outDir = join(dir, "audit-2026-08-08");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir, "--sha", "deadbee"]);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(outDir, "001-fix-n-1-query.md"), "utf8")).toContain("- **Planned at**: commit `deadbee`,");
    });
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      // cwd = a temp dir outside any git repo → documented "unknown" fallback
      // (--date pinned: without it the audit-<date> dir derives from "today", a calendar flake)
      const result = runCli(["audit", "scaffold", findingsFile, "--date", "2026-08-08"], { cwd: dir });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dir, "audit-2026-08-08", "001-fix-n-1-query.md"))).toBe(true);
      const plan = readFileSync(join(dir, "audit-2026-08-08", "001-fix-n-1-query.md"), "utf8");
      expect(plan).toContain("- **Planned at**: commit `unknown`,");
      // the "unknown" fallback still round-trips through the validator
      expect(validateAuditStatusBlocks(plan).ok).toBe(true);
    });
  });

  test("--date derives the audit-<date> directory name when --dir is omitted", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify(FINDINGS));
      const result = runCli(["audit", "scaffold", findingsFile, "--date", "2026-07-01"], { cwd: dir });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dir, "audit-2026-07-01", "README.md"))).toBe(true);
      expect(existsSync(join(dir, "audit-2026-07-01", "001-fix-n-1-query.md"))).toBe(true);
    });
  });

  test("supplied confidence + evidence + fixSketch + verification reach the plan and index (fidelity regression)", () => {
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
      // Date/SHA pinned: the audit-<date> dir name and Planned-at line are calendar/SHA flake-proof.
      const outDir = join(dir, "audit-2026-08-08");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir, "--sha", "deadbee", "--date", "2026-08-08"]);
      expect(result.exitCode).toBe(0);
      const plan = readFileSync(join(outDir, "001-unparameterized-sink-in-export-path.md"), "utf8");
      // Explicit HIGH confidence is persisted in the Status block...
      expect(plan).toContain("- **Confidence**: HIGH");
      // ...all string evidence entries reach the plan (not just the first)...
      expect(plan).toContain("## Evidence");
      expect(plan).toContain("- src/export.ts:88 — f-string builds the query");
      expect(plan).toContain("- src/export.ts:120 — same sink in the retry path");
      // Leading/trailing whitespace in a supplied entry is preserved as-is —
      // trimming is only used for the non-empty validation check.
      expect(plan).toContain("-   padded entry — rendered exactly as supplied  ");
      // ...and fixSketch/verification render too.
      expect(plan).toContain("## Fix sketch");
      expect(plan).toContain("Parameterize both call sites.");
      expect(plan).toContain("## Verification");
      expect(plan).toContain("bun test packages/api/test/export.test.ts");
      // Index row: HIGH confidence + first-evidence preview (not "—"/empty).
      const readme = readFileSync(join(outDir, "README.md"), "utf8");
      expect(readme).toContain("| 001 | Unparameterized sink in export path | security |");
      expect(readme).toContain("| HIGH | src/export.ts:88 — f-string builds the query |");
      // still round-trips through the engine validator
      expect(validateAuditStatusBlocks(plan).ok).toBe(true);
    });
  });

  test("absent confidence/evidence defaults to MED/[] — legacy plan/index byte-identical with pinned date/SHA", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify([{ title: "Add index", priority: "P2", effort: "XS", risk: "LOW", category: "tech-debt", description: "Index the audit table." }]));
      const outDir = join(dir, "audit-2026-08-08");
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", outDir, "--sha", "deadbee", "--date", "2026-08-08"]);
      expect(result.exitCode).toBe(0);
      const plan = readFileSync(join(outDir, "001-add-index.md"), "utf8");
      // Focused legacy-shape assertions.
      expect(plan).not.toContain("**Confidence**");
      expect(plan).not.toContain("## Evidence");
      // Full byte-identical baseline: with date/SHA pinned, the legacy
      // (no-confidence, no-evidence) document must not drift at all.
      const expectedPlan = `# Add index

## Status
- **Priority**: P2
- **Effort**: XS
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit \`deadbee\`, 2026-08-08

## Impact
Index the audit table.
`;
      expect(plan).toBe(expectedPlan);
      const readme = readFileSync(join(outDir, "README.md"), "utf8");
      // The row's trailing "| MED |  |" (empty Evidence cell, two spaces) is
      // part of the pinned bytes — a legacy-shape regression fails here.
      expect(readme).toContain("| 001 | Add index | tech-debt | Index the audit table. | XS | LOW | MED |  |");
      const expectedReadme = `# Audit Report — repo @ deadbee (2026-08-08)

## Findings

| # | Finding | Category | Impact | Effort | Risk | Confidence | Evidence |
|---|---------|----------|--------|--------|------|------------|----------|
| 001 | Add index | tech-debt | Index the audit table. | XS | LOW | MED |  |

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001 | Add index | P2 | XS | none | TODO |

## Red-team dispositions

- <finding>: <survived / refuted / hallucination-dropped / uncovered-kept>, <one-line reason>
`;
      expect(readme).toBe(expectedReadme);
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

  test("invalid dependsOn → usage, exit 2", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const findingsFile = join(dir, "findings.json");
      writeFileSync(findingsFile, JSON.stringify([{ title: "X", priority: "P1", effort: "M", risk: "LOW", category: "perf", dependsOn: "plan-002.md", description: "d" }]));
      const result = runCli(["audit", "scaffold", findingsFile, "--dir", join(dir, "out")]);
      expect(result.exitCode).toBe(2);
      expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain("dependsOn must be");
    });
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
      const plan = readFileSync(join(outDir, "002-unparameterized-sink-in-export-path.md"), "utf8");
      expect(plan).toContain("- **Fingerprint**: sql-export-sink");
      expect(plan).toContain("- **Likelihood**: high");
      expect(plan).toContain("- **Severity impact**: high");
      expect(plan).toContain("- **Severity**: medium");
      // enriched MED confidence is persisted (§8)
      expect(plan).toContain("- **Confidence**: MED");
      expect(plan).toContain("- src/export.ts:120 — same sink in the retry path");
      expect(plan).toContain("| entrypoint | src/routes/export.ts:10 | GET /export — query param reaches the exporter |");
      expect(plan).toContain("## Impact"); // prose impact retained alongside structured severity
      expect(validateAuditStatusBlocks(plan).ok).toBe(true);
      const readme = readFileSync(join(outDir, "README.md"), "utf8");
      expect(readme).toContain("Evidence | Fingerprint | Likelihood | Severity impact | Severity |");
      expect(readme).toContain("| 001 | Legacy row | tests | Legacy finding. | S | LOW | MED |  | — | — | — | — |");
      expect(readme).toContain("| sql-export-sink | high | high | medium |");
    });
  });

  test("invalid optional-field states → usage, exit 2", () => {
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
      expect(existsSync(join(outDir, "001-x.md"))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// mstar audit promote

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

describe("mstar audit promote — v2 workflow registration for selected plans", () => {
  /** Scaffold an audit dir with two plan files under a temp root and return
   * `{ harnessDir, outDir }` (outDir under harnessDir/plans/, the documented
   * `{PLAN_DIR}/audit-<date>/` layout).
   *
   * Seeds an active issue store first: promotion registers through the catalog
   * registration journal, which publishes rows into store.db and refuses
   * fail-closed (`store.not-initialized`) on a harness dir without one. */
  function scaffoldFixture(dir: string): { harnessDir: string; outDir: string } {
    const harnessDir = join(dir, "harness");
    const outDir = join(harnessDir, "plans", "audit-2026-08-08");
    scaffoldAuditPlan(
      outDir,
      [
        {
          title: "Fix N+1 query in order list",
          category: "perf",
          impact: "Every order-list render issues 1+N queries.",
          effort: "M",
          risk: "MED",
          confidence: "HIGH",
          evidence: ["src/orders.ts:42"],
          priority: "P1",
        },
        {
          title: "Rotate leaked AWS keys",
          category: "security",
          impact: "Credentials in git history.",
          effort: "S",
          risk: "HIGH",
          confidence: "HIGH",
          evidence: ["src/config.ts:3"],
          priority: "P1",
        },
      ],
      { date: "2026-08-08" },
    );
    const init = runCli(["store", "init", "--harness", harnessDir]);
    expect(init.exitCode).toBe(0);
    return { harnessDir, outDir };
  }

  test("selected plan → snapshot with one Todo row + status.json type plan, exit 0", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const { harnessDir, outDir } = scaffoldFixture(dir);
      const result = runCli(["audit", "promote", outDir, "--plans", "001", "--harness", harnessDir,
        "--delivery-kind",
        "development",
        "--branch-source",
        "feature/audit-plans",
        "--branch-target",
        "main",
      ]);
      expect(result.exitCode).toBe(0);
      const promoted = cliEnvelope(result, "ok", "audit.promote.ok");
      expect(promoted.data?.workflowId).toBe("audit-2026-08-08");

      // snapshot has exactly the selected plan as a Todo row
      const snapshotPath = join(harnessDir, "workflows", "audit-2026-08-08", "snapshot.json");
      expect(existsSync(snapshotPath)).toBe(true);
      const snapshot = readJson(snapshotPath);
      expect(snapshot.type).toBe("plan");
      expect(snapshot.status).toBe("running");
      const plans = snapshot.plans as Array<Record<string, unknown>>;
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({
        id: "001-fix-n-1-query-in-order-list",
        title: "Fix N+1 query in order list",
        file: "audit-2026-08-08/001-fix-n-1-query-in-order-list.md",
        status: "Todo",
      });

      // root status.json registers the workflow as type: plan
      const status = readJson(join(harnessDir, "status.json"));
      expect(status.version).toBe(2);
      const entry = (status.workflows as Array<Record<string, unknown>>).find(
        (w) => w.id === "audit-2026-08-08",
      );
      expect(entry).toMatchObject({ type: "plan", dir: "workflows/audit-2026-08-08" });
      expect(entry?.started_at).toBe(snapshot.started_at);
    });
  });

  test("missing <audit-dir> or --plans → argument error", () => {
    const noDir = runCli(["audit", "promote",
        "--delivery-kind",
        "development",
        "--branch-source",
        "feature/audit-plans",
        "--branch-target",
        "main",
      ]);
    expect(noDir.exitCode).toBe(2);
    expectUsageDiagnostic(noDir, "path");

    withTempDir("mstar-slice4-cli-", (dir) => {
      const { outDir } = scaffoldFixture(dir);
      const noPlans = runCli([
        "audit",
        "promote",
        outDir,
        "--delivery-kind",
        "development",
        "--branch-source",
        "feature/audit-plans",
        "--branch-target",
        "main",
      ]);
      expect(noPlans.exitCode).toBe(2);
      expectUsageDiagnostic(noPlans, "--plans");
    });
  });

  test("missing harness → exit 1 with the --harness / MSTAR_HARNESS_DIR message", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const { outDir } = scaffoldFixture(dir);
      const result = runCli(["audit", "promote", outDir, "--plans", "001",
        "--delivery-kind",
        "development",
        "--branch-source",
        "feature/audit-plans",
        "--branch-target",
        "main",
      ], { cwd: dir });
      expect(result.exitCode).toBe(1);
      expect(cliEnvelope(result, "refused").message).toContain("harness");
    });
  });

  test("--workflow override sets the workflow id", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const { harnessDir, outDir } = scaffoldFixture(dir);
      const result = runCli([
        "audit",
        "promote",
        outDir,
        "--plans",
        "001",
        "--workflow",
        "audit-2026-08-08-custom",
        "--harness",
        harnessDir,
        "--delivery-kind",
        "development",
        "--branch-source",
        "feature/audit-plans",
        "--branch-target",
        "main",
      ]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result, "ok", "audit.promote.ok").data?.workflowId).toBe("audit-2026-08-08-custom");
      expect(
        existsSync(join(harnessDir, "workflows", "audit-2026-08-08-custom", "snapshot.json")),
      ).toBe(true);
    });
  });

  test("re-promote of a registered workflow id refuses without replacing its snapshot", () => {
    withTempDir("mstar-slice4-cli-", (dir) => {
      const { harnessDir, outDir } = scaffoldFixture(dir);
      const first = runCli(["audit", "promote", outDir, "--plans", "001", "--harness", harnessDir,
        "--delivery-kind",
        "development",
        "--branch-source",
        "feature/audit-plans",
        "--branch-target",
        "main",
      ]);
      expect(first.exitCode).toBe(0);

      const snapshotPath = join(harnessDir, "workflows", "audit-2026-08-08", "snapshot.json");
      const before = readJson(snapshotPath);

      // A new operation cannot create the same workflow id again; the
      // registration conflict is the behavioral contract, not path wording.
      const second = runCli(["audit", "promote", outDir, "--plans", "002", "--harness", harnessDir,
        "--delivery-kind",
        "development",
        "--branch-source",
        "feature/audit-plans",
        "--branch-target",
        "main",
      ]);
      expect(second.exitCode).toBe(1);
      cliEnvelope(second, "refused", "catalog.registration-conflict");

      // First rows intact.
      const after = readJson(snapshotPath);
      expect(after.started_at).toBe(before.started_at);
      const plans = after.plans as Array<Record<string, unknown>>;
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({ id: "001-fix-n-1-query-in-order-list", status: "Todo" });
    });
  });
});
