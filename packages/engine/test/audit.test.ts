/**
 * Engine audit module — audit Status-block validation, secret redaction, and
 * audit-<date>/ plan scaffolding.
 *
 * Spec sources (cited per test): mstar-audit SKILL.md (Hard Rules read-only,
 * Status block fields, audit-<date>/ layout, monotonic numbering, index
 * format) and mstar-audit/references/finding-format.md (category codes,
 * evidence requirements, secret-value prohibition).
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  promoteAuditPlans,
  redactSecrets,
  scaffoldAuditPlan,
  validateAuditStatusBlocks,
} from "../src/audit.js";
import { readJson } from "../src/core.js";
import { validateStatus } from "../src/status.js";
import { WORKFLOW_SNAPSHOT_FILE, validateWorkflowSnapshot } from "../src/workflow.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Compliant audit plan Status block (mstar-audit SKILL § Plan files). */
const PLAN_GOOD = `# Fix N+1 query in order list

## Status
- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit \`abc1234\`, 2026-08-08

## Problem
Every order-list render issues 1+N queries.
`;

/** Every field invalid — exercises each enum check. */
const PLAN_BAD_FIELDS = `# Plan with bad fields

## Status
- **Priority**: P5
- **Effort**: XXL
- **Risk**: MAYBE
- **Depends on**: ../other/plan.md
- **Category**: nope
- **Planned at**: yesterday

## Body
Anything.
`;

/** Missing the Planned at and Depends on fields entirely. */
const PLAN_MISSING_FIELDS = `# Plan with missing fields

## Status
- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Category**: tests

## Body
Anything.
`;

/** No Status block at all. */
const PLAN_NO_BLOCK = `# Plan without status

Some body text.
`;

/** Two Status blocks — both must be checked. */
const PLAN_TWO_BLOCKS = `# Two status blocks

## Status
- **Priority**: P1
- **Effort**: XS
- **Risk**: HIGH
- **Depends on**: none
- **Category**: security
- **Planned at**: commit \`abcd1234\`, 2026-08-08

## Body

## Status
- **Priority**: P3
- **Effort**: XL
- **Risk**: LOW
- **Depends on**: plans/001-fix-n1.md
- **Category**: docs
- **Planned at**: commit \`abcd1234\`, 2026-08-08
`;

/** Secret-laden text covering each redaction pattern. */
const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const SLACK_TOKEN = "xoxb-" + "123456789012-1234567890123-abcdefghijklmnopqrstuvwx";
const JWT_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const OPENAI_KEY = "sk-proj-" + "0123456789abcdef0123456789abcdef";
const API_KEY = "0123456789abcdef" + "0123456789abcdef";

const SECRETS_FIXTURE = `const awsKey = "${AWS_KEY}";
const ghToken = "gho_123456789012345678901234567890123456";
const slackToken = "${SLACK_TOKEN}";
const jwt = "${JWT_TOKEN}";
const openAiKey = "${OPENAI_KEY}";
const password = "hunter2hunter2hunter2";
const apiKey = "${API_KEY}";
const pem = "-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEA...\\n-----END RSA PRIVATE KEY-----\\n";
`;

/** Text with secret-looking but SAFE content that must NOT be redacted. */
const SECRETS_SAFE = `const url = "https://example.com/token?q=12345";
const short = "token: ab";
const word = "passwordless auth is fine";
const cfg = { name: "service-account", role: "reader" };
const md5 = "0123456789abcdef"; // 16 hex chars, but no key= assignment
`;

const hasCode = (g: { violations: { code: string }[] }, code: string) =>
  g.violations.some((v) => v.code === code);

// ---------------------------------------------------------------------------
// validateAuditStatusBlocks — mstar-audit SKILL § Plan files (Status block)
// ---------------------------------------------------------------------------

describe("validateAuditStatusBlocks", () => {
  test("passes a fully compliant Status block", () => {
    const result = validateAuditStatusBlocks(PLAN_GOOD);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("accepts 'plans/NNN-*.md' as Depends on", () => {
    const result = validateAuditStatusBlocks(PLAN_TWO_BLOCKS);
    expect(result.ok).toBe(true);
  });

  test("flags every invalid enum value", () => {
    const result = validateAuditStatusBlocks(PLAN_BAD_FIELDS);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "audit.status.invalid-priority")).toBe(true);
    expect(hasCode(result, "audit.status.invalid-effort")).toBe(true);
    expect(hasCode(result, "audit.status.invalid-risk")).toBe(true);
    expect(hasCode(result, "audit.status.invalid-depends-on")).toBe(true);
    expect(hasCode(result, "audit.status.invalid-category")).toBe(true);
    expect(hasCode(result, "audit.status.invalid-planned-at")).toBe(true);
  });

  test("flags missing required fields", () => {
    const result = validateAuditStatusBlocks(PLAN_MISSING_FIELDS);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "audit.status.missing-field")).toBe(true);
    const missing = result.violations
      .filter((v) => v.code === "audit.status.missing-field")
      .map((v) => v.message);
    expect(missing.some((m) => m.includes("Depends on"))).toBe(true);
    expect(missing.some((m) => m.includes("Planned at"))).toBe(true);
  });

  test("reports a missing Status block", () => {
    const result = validateAuditStatusBlocks(PLAN_NO_BLOCK);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "audit.status.missing-block")).toBe(true);
  });

  test("accepts the documented depends-on wildcard and unknown-commit fallback", () => {
    const plan = `# Plan with scaffold defaults
## Status
- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/002-*.md
- **Category**: tests
- **Planned at**: commit \`unknown\`, 2026-08-08
`;
    const result = validateAuditStatusBlocks(plan);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// redactSecrets — mstar-audit Hard Rule 4 (never reproduce secret values)
// ---------------------------------------------------------------------------

describe("redactSecrets", () => {
  test("redacts every credential pattern with file:line + type", () => {
    const result = redactSecrets(SECRETS_FIXTURE, "src/config.ts");
    expect(result.findings.length).toBeGreaterThanOrEqual(8);
    const types = new Set(result.findings.map((f) => f.type));
    expect(types.has("aws-access-key")).toBe(true);
    expect(types.has("github-token")).toBe(true);
    expect(types.has("slack-token")).toBe(true);
    expect(types.has("jwt")).toBe(true);
    expect(types.has("api-secret-key")).toBe(true);
    expect(types.has("password")).toBe(true);
    expect(types.has("api-key")).toBe(true);
    expect(types.has("private-key")).toBe(true);
    // Every finding carries a 1-based line number.
    expect(result.findings.every((f) => f.line >= 1)).toBe(true);
    // The redacted text never contains the raw secrets.
    expect(result.text).not.toContain(AWS_KEY);
    expect(result.text).not.toContain("gho_123456789012345678901234567890123456");
    expect(result.text).not.toContain("hunter2hunter2hunter2");
    expect(result.text).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  test("replacement carries the file:line + type summary", () => {
    const result = redactSecrets('const password = "hunter2hunter2hunter2";', "src/config.ts");
    expect(result.text).toContain("[REDACTED password@1 in src/config.ts]");
  });

  test("omits the file name when not provided", () => {
    const result = redactSecrets('const password = "hunter2hunter2hunter2";');
    expect(result.text).toContain("[REDACTED password@1]");
  });

  test("keeps the key= prefix and only replaces the value", () => {
    const result = redactSecrets('const password = "hunter2hunter2hunter2";');
    expect(result.text).toContain('const password = [REDACTED password@1]');
  });

  test("leaves safe text untouched", () => {
    const result = redactSecrets(SECRETS_SAFE);
    expect(result.text).toBe(SECRETS_SAFE);
    expect(result.findings).toEqual([]);
  });

  test("redacts quoted JSON keys and preserves the quotes", () => {
    const json = '{"password": "hunter2hunter2hunter2", "token": "abcdefghijklmnopqrstuvwxyz0123456789"}';
    const result = redactSecrets(json, "config.json");
    expect(result.text).toContain('{"password": [REDACTED password@1 in config.json]');
    expect(result.text).toContain('"token": [REDACTED token@1 in config.json]');
    expect(result.text).not.toContain("hunter2hunter2hunter2");
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  test("redacts single-quoted keys and YAML unquoted keys", () => {
    const yaml = "password: 'hunter2hunter2hunter2'\n'token': hunter2hunter2hunter2abcdefgh";
    const result = redactSecrets(yaml);
    expect(result.text).toContain("password: [REDACTED password@1]");
    expect(result.text).toContain("'token': [REDACTED token@2]");
  });

  test("findings are sorted by line", () => {
    const result = redactSecrets(SECRETS_FIXTURE);
    const lines = result.findings.map((f) => f.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });
});

// ---------------------------------------------------------------------------
// redactSecrets non-leakage invariants — Hard Rule 4 over the WHOLE_MATCH
// table (specs/sp3-redact-secrets.md). Probes sit on their own bare line so
// only WHOLE_MATCH fires — a key= prefix would also match VALUE_PATTERNS and
// double-report.
// ---------------------------------------------------------------------------

describe("redactSecrets non-leakage invariants", () => {
  const probes: { type: string; value: string }[] = [
    { type: "aws-access-key", value: "AKIAIOSFODNN7EXAMPLE" },
    { type: "github-token", value: "ghp_" + "A".repeat(36) },
    { type: "slack-token", value: "xoxb-abcdefghijklmnopqrstuvwxyz" },
    { type: "api-secret-key", value: "sk-abcdefghijklmnopqrstuvwxyz0123456789" },
    { type: "private-key", value: "-----BEGIN RSA PRIVATE KEY-----" },
    {
      type: "jwt",
      value:
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz0123456789",
    },
  ];

  test("never leaks a locked WHOLE_MATCH probe", () => {
    for (const { type, value } of probes) {
      const input = `line one\n${value}\nline three\n`;
      const result = redactSecrets(input);
      expect(result.text).not.toContain(value);
      // The probe must actually have been redacted — not a no-op pass.
      expect(result.findings.some((f) => f.type === type)).toBe(true);
    }
  });

  test("exercises every WHOLE_MATCH type on one corpus", () => {
    const corpus = probes.map((p) => p.value).join("\n") + "\n";
    const result = redactSecrets(corpus);
    const types = new Set(result.findings.map((f) => f.type));
    for (const { type } of probes) {
      expect(types.has(type)).toBe(true);
    }
  });

  test("preserves the newline count when redaction happens", () => {
    const input = `before\n${probes[0].value}\nafter\n`;
    const result = redactSecrets(input);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.text.split(/\n/).length).toBe(input.split(/\n/).length);
  });

  test("deduplicates findings by (line, type)", () => {
    const input = "AKIAIOSFODNN7EXAMPLE\nAKIAIOSFODNN7EXAMPLE\n";
    const result = redactSecrets(input);
    const keys = result.findings.map((f) => `${f.line}:${f.type}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Same type on two distinct lines stays two findings.
    expect(result.findings.filter((f) => f.type === "aws-access-key")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// scaffoldAuditPlan — mstar-audit SKILL § Phase 4 (audit-<date>/ layout,
// monotonic numbering, README index)
// ---------------------------------------------------------------------------

describe("scaffoldAuditPlan", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-audit-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const findings = [
    {
      title: "Fix N+1 query in order list",
      category: "perf" as const,
      impact: "Every order-list render issues 1+N queries.",
      effort: "M" as const,
      risk: "MED" as const,
      confidence: "HIGH" as const,
      evidence: ["src/orders.ts:42 — list() queries per order"],
      priority: "P1" as const,
      fixSketch: "Batch the order items into one query.",
      verification: "bun test test/orders.test.ts",
    },
    {
      title: "Rotate leaked AWS keys",
      category: "security" as const,
      impact: "Credentials in git history.",
      effort: "S" as const,
      risk: "HIGH" as const,
      confidence: "HIGH" as const,
      evidence: ["src/config.ts:3 — AKIA key literal"],
      priority: "P1" as const,
      fixSketch: "Rotate, then scrub history.",
    },
  ];

  test("scaffolds numbered plan files + README index", () => {
    const out = join(tmp, "audit-2026-08-08");
    const result = scaffoldAuditPlan(out, findings, {
      repoName: "acme",
      repoShortSha: "abc1234",
      date: "2026-08-08",
    });
    expect(result.files).toEqual(["001-fix-n-1-query-in-order-list.md", "002-rotate-leaked-aws-keys.md"]);
    expect(result.nextNumber).toBe(3);

    const plan1 = readFileSync(join(out, "001-fix-n-1-query-in-order-list.md"), "utf8");
    expect(plan1).toContain("# Fix N+1 query in order list");
    expect(plan1).toContain("- **Priority**: P1");
    expect(plan1).toContain("- **Effort**: M");
    expect(plan1).toContain("- **Risk**: MED");
    expect(plan1).toContain("- **Depends on**: none");
    expect(plan1).toContain("- **Category**: perf");
    expect(plan1).toContain("- **Planned at**: commit `abc1234`, 2026-08-08");
    expect(plan1).toContain("src/orders.ts:42");
    expect(plan1).toContain("Batch the order items into one query.");
    expect(plan1).toContain("bun test test/orders.test.ts");
    // no placeholder tokens in plan files (plan-quality-bar)
    expect(/\b(TODO|TBD|TBA)\b/i.test(plan1)).toBe(false);

    const readme = readFileSync(join(out, "README.md"), "utf8");
    expect(readme).toContain("# Audit Report — acme @ abc1234 (2026-08-08)");
    expect(readme).toContain("| 001 | Fix N+1 query in order list | perf |");
    expect(readme).toContain("| 002 | Rotate leaked AWS keys | security |");
    expect(readme).toContain("| 001 | Fix N+1 query in order list | P1 | M | none | TODO |");
  });

  test("continues numbering monotonically when the directory already has plans", () => {
    const out = join(tmp, "audit-2026-08-09");
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, "001-earlier-plan.md"),
      `# Earlier plan\n\n## Status\n- **Priority**: P2\n- **Effort**: S\n- **Risk**: LOW\n- **Depends on**: none\n- **Category**: tests\n- **Planned at**: commit \`deadbee\`, 2026-08-01\n`,
    );
    const result = scaffoldAuditPlan(out, findings, { date: "2026-08-09" });
    // prior 001 stays; new batch starts at 002/003
    expect(result.files).toEqual(["002-fix-n-1-query-in-order-list.md", "003-rotate-leaked-aws-keys.md"]);
    expect(result.nextNumber).toBe(4);
    expect(readFileSync(join(out, "001-earlier-plan.md"), "utf8")).toContain("# Earlier plan");
    // rebuilt index includes the pre-existing plan row
    const readme = readFileSync(join(out, "README.md"), "utf8");
    expect(readme).toContain("| 001 | Earlier plan |");
    expect(readme).toContain("| 002 | Fix N+1 query in order list |");
  });

  test("renders the Direction section when direction findings exist", () => {
    const out = join(tmp, "audit-2026-08-10");
    const result = scaffoldAuditPlan(
      out,
      [
        {
          title: "Ship a status dashboard",
          category: "direction" as const,
          impact: "Product value for operators.",
          effort: "L" as const,
          risk: "MED" as const,
          confidence: "MED" as const,
          evidence: ["README.md:12 — roadmap mentions dashboard"],
          priority: "P3" as const,
        },
      ],
      { date: "2026-08-10" },
    );
    expect(result.files).toEqual(["001-ship-a-status-dashboard.md"]);
    const readme = readFileSync(join(out, "README.md"), "utf8");
    expect(readme).toContain("## Direction");
    expect(readme).toContain("Ship a status dashboard");
  });

  test("renders the rejected-findings section when provided", () => {
    const out = join(tmp, "audit-2026-08-11");
    scaffoldAuditPlan(out, findings, {
      date: "2026-08-11",
      rejected: [{ title: "Add dark mode", reason: "not worth doing for a CLI" }],
    });
    const readme = readFileSync(join(out, "README.md"), "utf8");
    expect(readme).toContain("## Findings considered and rejected");
    expect(readme).toContain("- Add dark mode: not worth doing for a CLI");
  });

  test("same-slug findings get -2/-3 suffixes instead of overwriting", () => {
    const out = join(tmp, "audit-2026-08-13");
    const result = scaffoldAuditPlan(
      out,
      [
        { title: "Fix N+1 query", category: "perf" as const, impact: "a", effort: "S" as const, risk: "LOW" as const, confidence: "HIGH" as const, evidence: ["x"], priority: "P1" as const },
        { title: "Fix N+1 query!", category: "perf" as const, impact: "b", effort: "S" as const, risk: "LOW" as const, confidence: "HIGH" as const, evidence: ["y"], priority: "P2" as const },
        { title: "Fix N+1 query??", category: "perf" as const, impact: "c", effort: "S" as const, risk: "LOW" as const, confidence: "HIGH" as const, evidence: ["z"], priority: "P3" as const },
      ],
      { date: "2026-08-13" },
    );
    expect(result.files).toEqual(["001-fix-n-1-query.md", "002-fix-n-1-query-2.md", "003-fix-n-1-query-3.md"]);
    // every finding's plan file exists and keeps its own content
    expect(readFileSync(join(out, "002-fix-n-1-query-2.md"), "utf8")).toContain("# Fix N+1 query!");
    expect(readFileSync(join(out, "003-fix-n-1-query-3.md"), "utf8")).toContain("# Fix N+1 query??");
    // index rows are unique per file (no silent loss)
    const readme = readFileSync(join(out, "README.md"), "utf8");
    expect(readme).toContain("| 001 | Fix N+1 query |");
    expect(readme).toContain("| 002 | Fix N+1 query! |");
    expect(readme).toContain("| 003 | Fix N+1 query?? |");
  });

  test("scaffold output round-trips through validateAuditStatusBlocks (defaults included)", () => {
    const out = join(tmp, "audit-2026-08-12");
    const result = scaffoldAuditPlan(
      out,
      [
        { title: "Fix N+1 query in order list", category: "perf" as const, impact: "Queries explode.", effort: "M" as const, risk: "MED" as const, confidence: "HIGH" as const, evidence: ["src/orders.ts:42"], priority: "P1" as const, dependsOn: "plans/002-*.md" },
        { title: "Rotate leaked AWS keys", category: "security" as const, impact: "Credentials in git history.", effort: "S" as const, risk: "HIGH" as const, confidence: "HIGH" as const, evidence: [], priority: "P1" as const },
      ],
      // no plannedAt / repoShortSha — commit falls back to "unknown", the
      // documented non-git-repo default that the validator accepts
      { date: "2026-08-12" },
    );
    expect(result.files).toHaveLength(2);
    for (const file of result.files) {
      const plan = readFileSync(join(out, file), "utf8");
      const gate = validateAuditStatusBlocks(plan);
      expect({ file, ok: gate.ok, violations: gate.violations.map((v) => v.code) }).toEqual({ file, ok: true, violations: [] });
    }
  });

  test("omits the Evidence section when a finding carries no evidence", () => {
    const out = join(tmp, "audit-2026-08-14");
    scaffoldAuditPlan(
      out,
      [{ title: "Document the fixture layout", category: "docs" as const, impact: "Nobody knows the layout.", effort: "XS" as const, risk: "LOW" as const, confidence: "MED" as const, evidence: [], priority: "P3" as const }],
      { date: "2026-08-14" },
    );
    const plan = readFileSync(join(out, "001-document-the-fixture-layout.md"), "utf8");
    expect(plan).not.toContain("## Evidence");
  });

  test("renders the Red-team dispositions section with the four-state placeholder", () => {
    const out = join(tmp, "audit-2026-08-15");
    scaffoldAuditPlan(out, findings, { date: "2026-08-15" });
    const readme = readFileSync(join(out, "README.md"), "utf8");
    expect(readme).toContain("## Red-team dispositions");
    expect(readme).toContain("- <finding>: <survived / refuted / hallucination-dropped / uncovered-kept>, <one-line reason>");
  });
});

// ---------------------------------------------------------------------------
// promoteAuditPlans — v2 workflow promotion of selected audit plans
// (snapshot written BEFORE registerWorkflow; validateStatus + snapshot
// validators pass on the promoted artifacts)
// ---------------------------------------------------------------------------

describe("promoteAuditPlans", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-audit-promote-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test("writes a plan workflow snapshot + registers it (type plan, matching started_at)", async () => {
    const harnessDir = join(tmp, "harness");
    const outDir = join(harnessDir, "plans", "audit-2026-08-08");
    scaffoldAuditPlan(
      outDir,
      [
        {
          title: "Fix N+1 query in order list",
          category: "perf" as const,
          impact: "Every order-list render issues 1+N queries.",
          effort: "M" as const,
          risk: "MED" as const,
          confidence: "HIGH" as const,
          evidence: ["src/orders.ts:42"],
          priority: "P1" as const,
        },
        {
          title: "Rotate leaked AWS keys",
          category: "security" as const,
          impact: "Credentials in git history.",
          effort: "S" as const,
          risk: "HIGH" as const,
          confidence: "HIGH" as const,
          evidence: ["src/config.ts:3"],
          priority: "P1" as const,
        },
      ],
      { date: "2026-08-08" },
    );

    const result = await promoteAuditPlans(outDir, ["001"], { harnessDir });
    const workflowId = result.workflowId;
    expect(workflowId).toBe("audit-2026-08-08");
    expect(result.snapshotPath).toBe(join(harnessDir, "workflows", workflowId, WORKFLOW_SNAPSHOT_FILE));

    // (a) snapshot exists with exactly the selected plan row (Todo)
    const snapshotPath = join(harnessDir, "workflows", workflowId, WORKFLOW_SNAPSHOT_FILE);
    expect(existsSync(snapshotPath)).toBe(true);
    const snapshot = readJson(snapshotPath);
    expect(snapshot.schema_version).toBe(1);
    expect(snapshot.id).toBe(workflowId);
    expect(snapshot.type).toBe("plan");
    expect(snapshot.status).toBe("running");
    expect(snapshot.started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(snapshot.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const plans = snapshot.plans as Array<Record<string, unknown>>;
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      id: "001-fix-n-1-query-in-order-list",
      title: "Fix N+1 query in order list",
      file: "audit-2026-08-08/001-fix-n-1-query-in-order-list.md",
      status: "Todo",
    });

    // (b) root status.json has the workflow entry, type plan, matching started_at
    const statusPath = join(harnessDir, "status.json");
    const status = readJson(statusPath);
    expect(status.version).toBe(2);
    const entry = (status.workflows as Array<Record<string, unknown>>).find((w) => w.id === workflowId);
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      id: workflowId,
      type: "plan",
      dir: `workflows/${workflowId}`,
    });
    expect(entry?.started_at).toBe(snapshot.started_at);

    // (c) validateStatus passes on the status path
    expect(validateStatus(statusPath).ok).toBe(true);

    // (d) validateWorkflowSnapshot passes on the snapshot
    expect(validateWorkflowSnapshot(readJson(snapshotPath)).ok).toBe(true);
  });
});
