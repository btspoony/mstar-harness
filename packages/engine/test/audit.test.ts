/**
 * Engine audit module — audit Status-block validation, secret redaction, and
 * audit-<date>/ plan scaffolding.
 *
 * Spec sources (cited per test): mstar-audit SKILL.md (Hard Rules read-only,
 * Status block fields, audit-<date>/ layout, monotonic numbering, index
 * format) and mstar-audit/references/finding-format.md (category codes,
 * evidence requirements, secret-value prohibition).
 */
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  promoteAuditPlans,
  redactSecrets,
  scaffoldAuditPlan,
  scanSecrets,
  supplyChainChecks,
  validateAuditStatusBlocks,
} from "../src/audit.js";
import { readJson } from "../src/core.js";
import { validateStatus } from "../src/status.js";
import { WORKFLOW_SNAPSHOT_FILE, validateWorkflowSnapshot } from "../src/workflow.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Compliant audit plan Status block (mstar-audit SKILL.md § Plan output (all variants)). */
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
// validateAuditStatusBlocks — mstar-audit SKILL.md § Plan output (all variants) Status block
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
    { type: "aws-access-key", value: "AKIAIOSFODNN7" + "EXAMPLE" },
    { type: "github-token", value: "ghp_" + "A".repeat(36) },
    { type: "slack-token", value: "xoxb-abcdefghijklmnopqrstuvwxyz" },
    { type: "api-secret-key", value: "sk-abcdefghijklmnopqrstuvwxyz0123456789" },
    {
      type: "private-key",
      value: "-----BEGIN RSA PRIVATE KEY-----\n" + "MIIEow".padEnd(76, "A") + "\n" + "-----END RSA PRIVATE KEY-----",
    },
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
    const input = `${probes[0].value}\n${probes[0].value}\n`;
    const result = redactSecrets(input);
    const keys = result.findings.map((f) => `${f.line}:${f.type}`);
    expect(new Set(keys).size).toBe(keys.length);
    // Same type on two distinct lines stays two findings.
    expect(result.findings.filter((f) => f.type === "aws-access-key")).toHaveLength(2);
  });

  // qc1 W-004: every CI/IaC shape scanSecrets detects must also be
  // redactable — a finding accepted by the scanner can appear in scaffolded
  // evidence and must not survive into artifacts with its value intact.
  test("redacts each CI/IaC shape family (detector/redactor parity)", () => {
    const docker = "ENV API_TOKEN=supersecretvalue123";
    const arg = "ARG GITHUB_TOKEN=injected-at-build-time-ok"; // 25 chars value
    const terraform = `password = "S3cr3tV4lue!"`;
    for (const [text, type] of [
      [docker, "dockerfile-credential-env"],
      [arg, "dockerfile-credential-env"],
      [terraform, "terraform-hardcoded-password"],
    ] as const) {
      const result = redactSecrets(text);
      expect(result.findings.map((f) => f.type)).toContain(type);
      // The matched line region is replaced by the marker, not left as-is.
      expect(result.text).not.toBe(text);
      expect(result.text).not.toContain(type === "terraform-hardcoded-password" ? "S3cr3tV4lue!" : "supersecretvalue123");
    }
    const argResult = redactSecrets(arg);
    expect(argResult.text).not.toContain("injected-at-build-time-ok");
  });

  // qc3 W-2: the CI/IaC shapes anchor with ^/$ and must fire per LINE of a
  // multi-line evidence text — a shape `scanSecrets` detects on line 2, 3,
  // or N must never survive redaction with its value intact.
  test("redacts CI/IaC shapes mid-string on multi-line text (qc3 W-2)", () => {
    const multi = [
      "line0: ordinary",
      'env: API_TOKEN="mysecret12345678"',
      "FROM node",
      "ENV API_TOKEN=supersecretvalue123",
      'password = "S3cr3tV4lue!"',
      "line5: ordinary",
    ].join("\n");
    const result = redactSecrets(multi);
    expect(result.text).not.toContain("mysecret12345678");
    expect(result.text).not.toContain("supersecretvalue123");
    expect(result.text).not.toContain("S3cr3tV4lue!");
    expect(result.text).toContain("[REDACTED actions-plaintext-env@2]");
    expect(result.text).toContain("[REDACTED dockerfile-credential-env@4]");
    expect(result.text).toContain("[REDACTED terraform-hardcoded-password@5]");
    // Non-credential lines stay intact.
    expect(result.text).toContain("line0: ordinary");
    expect(result.text).toContain("FROM node");
    expect(result.text).toContain("line5: ordinary");
    expect(result.findings.map((f) => f.type).sort()).toEqual([
      "actions-plaintext-env",
      "dockerfile-credential-env",
      "terraform-hardcoded-password",
    ]);
  });

  // qc3 W-3: overlapping spans must be merged (longest per overlap group)
  // before the text is rebuilt — applying ORIGINAL-length replacements
  // against already-modified text produced `[REDACTED …@1]@1]"` garbage.
  // Synthetic Stripe live-key values are assembled from parts so the raw
  // source never holds the full contiguous token (GitHub push-protection
  // false positive on test data).
  const stripeTail = "1234567890123456";
  const stripeLive = "sk_live_" + stripeTail;
  test.each([
    // env line containing a stripe whole-match token
    [`env: API_TOKEN="${stripeLive}"`, "[REDACTED actions-plaintext-env@1]"],
    // dockerfile env line containing a stripe whole-match token
    [`ENV API_TOKEN=${stripeLive}\nRUN echo hi`, "[REDACTED dockerfile-credential-env@1]\nRUN echo hi"],
    ['password = "mysecret12345678"\n', "[REDACTED terraform-hardcoded-password@1]\n"],
  ])("overlapping spans merge to a single clean marker: %j", (input, expected) => {
    const result = redactSecrets(input);
    expect(result.text).toBe(expected);
    expect((result.text.match(/\[REDACTED /g) ?? []).length).toBe(1);
    expect(result.text).not.toContain("sk_live_");
    expect(result.text).not.toContain("mysecret12345678");
  });

  test("private-key redaction covers header AND body until the END marker", () => {
    const pem = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
      "-----END OPENSSH PRIVATE KEY-----",
      "",
    ].join("\n");
    const result = redactSecrets(pem);
    expect(result.findings.filter((f) => f.type === "private-key").length).toBeGreaterThanOrEqual(1);
    // Header alone is not enough: the base64 body must be gone too.
    expect(result.text).not.toContain("b3BlbnNzaC1rZXktdjEAAAAABG5vbmU");
    expect(result.text).toContain("[REDACTED private-key@");
  });

  // qc3 W-3: a PEM block whose body lines match other patterns — the
  // whole-block span absorbs them into ONE private-key marker.
  test("private-key span absorbs overlapping matches inside its body (qc3 W-3)", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEow" + "A".repeat(70),
      'password = "hunter2hunter2hunter2"',
      "xoxb-" + "abcdefghijklmnopqrstuvwxyz",
      "-----END RSA PRIVATE KEY-----",
      "",
    ].join("\n");
    const result = redactSecrets(pem);
    const markers = result.text.match(/\[REDACTED [^\]]+@\d+\]/g) ?? [];
    expect(markers).toEqual(["[REDACTED private-key@1]"]);
    expect(result.text).not.toContain("hunter2hunter2hunter2");
    expect(result.text).not.toContain("xoxb-");
    expect(result.text).not.toContain("BEGIN RSA");
    expect(result.findings.map((f) => f.type)).toEqual(["private-key"]);
  });
});

// ---------------------------------------------------------------------------
// scaffoldAuditPlan — mstar-audit SKILL.md § Plan output (all variants) (audit-<date>/ layout,
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

  test("re-scaffold with a changed priority refreshes the index row", () => {
    const out = join(tmp, "audit-2026-08-27");
    const finding = {
      title: "Fix N+1 query",
      category: "perf" as const,
      impact: "a",
      effort: "S" as const,
      risk: "LOW" as const,
      confidence: "HIGH" as const,
      evidence: ["x"],
      priority: "P1" as const,
    };
    scaffoldAuditPlan(out, [finding], { date: "2026-08-27" });
    expect(readFileSync(join(out, "README.md"), "utf8")).toContain("| 001 | Fix N+1 query | P1 | S | none | TODO |");
    // Same title re-scaffolded with a re-triaged priority: numbering is
    // monotonic (001 is never rewritten), so the NEW batch's row must
    // carry the NEW value — finding-authoritative from the redacted
    // finding, not a parse artifact of a previous Status block — while
    // the preserved 001 row keeps its own priority.
    scaffoldAuditPlan(out, [{ ...finding, priority: "P2" as const }], { date: "2026-08-27" });
    const readme = readFileSync(join(out, "README.md"), "utf8");
    expect(readme).toContain("| 002 | Fix N+1 query | P2 | S | none | TODO |");
    expect(readme).toContain("| 001 | Fix N+1 query | P1 | S | none | TODO |");
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

  test("renders Needs verification and Hardening & checked notes from options", () => {
    const out = join(tmp, "audit-2026-08-16");
    scaffoldAuditPlan(out, findings, {
      date: "2026-08-16",
      needsVerification: [{ lead: "SSRF in webhook fetcher", how: "confirm caller supplies the URL", evidence: "src/hooks.ts:77" }],
      hardeningChecked: [
        { kind: "Hardening", text: "no CSP header - framework middleware already escapes all output" },
        { kind: "Checked and clean", text: "orders SQL sink parameterized end to end", },
      ],
    });
    const readme = readFileSync(join(out, "README.md"), "utf8");
    expect(readme).toContain("## Needs verification");
    expect(readme).toContain("- SSRF in webhook fetcher: confirm caller supplies the URL (src/hooks.ts:77)");
    expect(readme).toContain("## Hardening & checked notes");
    expect(readme).toContain("- Hardening: no CSP header - framework middleware already escapes all output");
    expect(readme).toContain("- Checked and clean: orders SQL sink parameterized end to end");
    // section order matches the documented template
    const nv = readme.indexOf("## Needs verification");
    const hc = readme.indexOf("## Hardening & checked notes");
    const dir = readme.indexOf("## Direction");
    expect(nv).toBeGreaterThan(dir);
    expect(hc).toBeGreaterThan(nv);
  });

  test("re-run without disposition options carries over ALL previously rendered entries", () => {
    const out = join(tmp, "audit-2026-08-17");
    scaffoldAuditPlan(out, findings, {
      date: "2026-08-17",
      needsVerification: [
        { lead: "lead one", how: "check x" },
        { lead: "lead two", how: "check y", evidence: "src/a.ts:9" },
      ],
      hardeningChecked: [
        { kind: "Hardening", text: "gap one" },
        { kind: "Checked and clean", text: "sink y cleared" },
        { kind: "Checked and clean", text: "sink z cleared" },
      ],
    });
    // re-run with no disposition options — every entry must survive the
    // rebuild (regression: the carry-over regex used to stop after the
    // first entry of each section)
    scaffoldAuditPlan(out, [{ title: "Second batch plan", category: "tests" as const, impact: "b", effort: "S" as const, risk: "LOW" as const, confidence: "HIGH" as const, evidence: [], priority: "P2" as const }], { date: "2026-08-18" });
    const readme = readFileSync(join(out, "README.md"), "utf8");
    expect(readme).toContain("- lead one: check x");
    expect(readme).toContain("- lead two: check y (src/a.ts:9)");
    expect(readme).toContain("- Hardening: gap one");
    expect(readme).toContain("- Checked and clean: sink y cleared");
    expect(readme).toContain("- Checked and clean: sink z cleared");
    // section entry counts preserved exactly
    const nvBlock = /## Needs verification\n\n([\s\S]*?)\n\n## Hardening/.exec(readme)?.[1] ?? "";
    expect(nvBlock.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2);
    const hcBlock = /## Hardening & checked notes\n\n([\s\S]*?)\n\n## Execution order/.exec(readme)?.[1] ?? "";
    expect(hcBlock.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
    expect(readdirSync(out).filter((f) => f.startsWith("003-"))).toEqual(["003-second-batch-plan.md"]);
  });

  test("a SUPPLIED disposition array is the authoritative set — it replaces prior entries", () => {
    const out = join(tmp, "audit-2026-08-19");
    scaffoldAuditPlan(out, findings, {
      date: "2026-08-19",
      needsVerification: [
        { lead: "stale lead", how: "check old" },
        { lead: "kept lead", how: "check keep" },
      ],
    });
    // rerun supplies the current truth: stale lead resolved, kept kept,
    // fresh added — omission would have carried all three, supplying
    // replaces with exactly this set (resolved entries CAN be removed)
    scaffoldAuditPlan(out, [], {
      date: "2026-08-20",
      needsVerification: [
        { lead: "kept lead", how: "check keep" },
        { lead: "fresh lead", how: "check new" },
      ],
    });
    const readme = readFileSync(join(out, "README.md"), "utf8");
    expect(readme).not.toContain("- stale lead: check old");
    expect(readme).toContain("- kept lead: check keep");
    expect(readme).toContain("- fresh lead: check new");
  });

  test("carry-over tolerates hand-edited headings: case, CRLF, spacing, blank lines", () => {
    const out = join(tmp, "audit-2026-08-21");
    scaffoldAuditPlan(out, findings, { date: "2026-08-21" });
    // simulate a hand-edited index: CRLF endings, different heading case,
    // trailing spaces in the heading, no blank line before the body
    const handEdited = [
      "# Audit Report \u2014 repo @ abc1234 (2026-08-21)",
      "",
      "## Findings",
      "",
      "| # | Finding | Category | Impact | Effort | Risk | Confidence | Evidence |",
      "|---|---------|----------|--------|--------|------|------------|----------|",
      "",
      "## needs verification  ",
      "- hand typed lead: check it (src/x.ts:1)",
      "",
      "## HARDENING & CHECKED NOTES",
      "- Checked and clean: hand cleared sink",
      "",
      "## Execution order & status",
      "",
    ].join("\r\n");
    writeFileSync(join(out, "README.md"), handEdited);
    scaffoldAuditPlan(out, [{ title: "Rebuild batch", category: "tests" as const, impact: "b", effort: "S" as const, risk: "LOW" as const, confidence: "HIGH" as const, evidence: [], priority: "P2" as const }], { date: "2026-08-22" });
    const readme = readFileSync(join(out, "README.md"), "utf8");
    expect(readme).toContain("- hand typed lead: check it (src/x.ts:1)");
    expect(readme).toContain("- Checked and clean: hand cleared sink");
  });

  test("D-1: scaffold redacts credentials from finding evidence/fix sketch (Hard Rule 4)", () => {
    const out = join(tmp, "audit-2026-08-25");
    const result = scaffoldAuditPlan(
      out,
      [
        {
          title: "Rotate the leaked Stripe live key",
          category: "security" as const,
          impact: "Anyone with repo read access can charge cards.",
          effort: "S" as const,
          risk: "HIGH" as const,
          confidence: "HIGH" as const,
          evidence: ["src/config.ts:12 — sk_live_" + "A1b2C3d4E5f6G7h8I9j0K1l2 committed"],
          priority: "P1" as const,
          fixSketch: "Rotate the key (sk_live_" + "A1b2C3d4E5f6G7h8I9j0K1l2), then scrub history.",
        },
      ],
      { date: "2026-08-11" },
    );
    expect(result.files).toEqual(["001-rotate-the-leaked-stripe-live-key.md"]);
    for (const file of [...result.files, "README.md"]) {
      const text = readFileSync(join(out, file), "utf8");
      // No raw credential value anywhere in the scaffolded artifact...
      expect(text).not.toContain("sk_live_" + "A1b2C3d4E5f6G7h8I9j0K1l2");
      // ...but the redaction marker and the non-secret context survive.
      expect(text).toContain("[REDACTED stripe-live-key@");
      expect(text).toContain("src/config.ts:12");
    }
    const planFile = readFileSync(join(out, result.files[0]!), "utf8");
    // Fix sketch survives redaction too (plan file only — the README
    // index does not render fix sketches).
    expect(planFile).toContain("Rotate the key ([REDACTED stripe-live-key@1]), then scrub history.");
  });

  test("D-1: rejected findings + needsVerification/hardeningChecked are redacted in the README (qc1 W-003)", () => {
    const out = join(tmp, "audit-2026-08-26");
    const leak = "sk_live_" + "B7c8D9e0F1a2B3c4D5e6F7g8";
    scaffoldAuditPlan(
      out,
      [{ title: "Benign finding", category: "tests" as const, impact: "i", effort: "S" as const, risk: "LOW" as const, confidence: "HIGH" as const, evidence: [], priority: "P2" as const }],
      {
        date: "2026-08-26",
        rejected: [{ title: `Rejected token: ${leak}`, reason: "value was already rotated" }],
        needsVerification: [{ lead: "AWS key in logs", how: `search ${leak} in CloudWatch` }],
        hardeningChecked: [{ kind: "Hardening", text: `legacy key ${leak} revoked` }],
      },
    );
    const readme = readFileSync(join(out, "README.md"), "utf8");
    // No raw value may reach the index through ANY channel.
    expect(readme).not.toContain(leak);
    expect(readme).toContain("[REDACTED stripe-live-key@");
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

  /** Scaffold the standard 2-plan audit dir used by the error-path tests. */
  function mkPlanAudit(outDir: string, date: string): void {
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
      { date },
    );
  }

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

  test("re-promote with the same workflow id refuses and leaves the first rows intact", async () => {
    const harnessDir = join(tmp, "harness-clobber");
    const outDir = join(harnessDir, "plans", "audit-2026-08-09");
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
      { date: "2026-08-09" },
    );

    const first = await promoteAuditPlans(outDir, ["001"], { harnessDir });
    const workflowId = first.workflowId;
    const snapshotPath = join(harnessDir, "workflows", workflowId, WORKFLOW_SNAPSHOT_FILE);
    const before = readJson(snapshotPath);

    // A second promote of the same audit dir (different subset) must refuse,
    // naming the existing snapshot path — not silently whole-rewrite and drop
    // the previously promoted 001 Todo row.
    await expect(promoteAuditPlans(outDir, ["002"], { harnessDir })).rejects.toThrow(snapshotPath);

    // First rows intact: same started_at, still exactly the 001 Todo row.
    const after = readJson(snapshotPath);
    expect(after.started_at).toBe(before.started_at);
    expect((after.plans as Array<Record<string, unknown>>)).toHaveLength(1);
    expect((after.plans as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: "001-fix-n-1-query-in-order-list",
      title: "Fix N+1 query in order list",
      status: "Todo",
    });

    // Root registration unchanged.
    const status = readJson(join(harnessDir, "status.json"));
    const entry = (status.workflows as Array<Record<string, unknown>>).find((w) => w.id === workflowId);
    expect(entry?.started_at).toBe(before.started_at);
    expect(validateStatus(join(harnessDir, "status.json")).ok).toBe(true);
  });

  test("two concurrent promotes of the same audit dir: exactly one wins, the other refuses (TOCTOU)", async () => {
    const harnessDir = join(tmp, "harness-concurrent");
    const outDir = join(harnessDir, "plans", "audit-2026-08-12");
    mkPlanAudit(outDir, "2026-08-12");

    // Reproduce the cross-process TOCTOU window in-process: hold the
    // SNAPSHOT-dir write lock (`.status-write.lockdir` inside
    // `workflows/<id>/` — the serialization point of the pre-fix
    // writeWorkflowSnapshot) BEFORE either promote runs. Both promotes then
    // pass the re-promote guard (no snapshot exists yet) and queue at the
    // snapshot lock. Releasing it lets the pre-fix code run BOTH promotes to
    // completion — the later writer whole-rewrites the snapshot and upserts
    // the root, silently dropping the earlier rows. The fixed code
    // serializes guard + snapshot write + root registration on the ROOT
    // status.json lock instead, so only the first promote may complete and
    // the second re-checks under the lock and refuses. (Both promotes settle
    // synchronously up to their first await, so no wall-clock delay is
    // needed to know they have reached their blocking point.)
    const workflowId = "audit-2026-08-12";
    const snapshotLockDir = join(harnessDir, "workflows", workflowId, ".status-write.lockdir");
    mkdirSync(snapshotLockDir, { recursive: true });

    const promoteA = promoteAuditPlans(outDir, ["001"], { harnessDir });
    const promoteB = promoteAuditPlans(outDir, ["002"], { harnessDir });
    // Attach settlement handlers in the SAME tick the promises are created —
    // a rejected promote must never surface as an unhandled rejection while
    // the interleaving below runs.
    const settled = Promise.allSettled([promoteA, promoteB]);
    // Genuine delay required (integration test): the engine's cross-process
    // lockdir polling cannot be driven with deterministic timers, and both
    // promotes must reach their blocking point on the snapshot lockdir the
    // test holds before it is released — reproducing the cross-process
    // interleaving where two writers are past the re-promote guard, queued
    // on the snapshot lock (same rationale as the suite's migrate/lease
    // concurrency tests).
    await Bun.sleep(150);
    // Release the snapshot lock the test held (the fixed code never takes
    // it; the pre-fix code removes it on release — force/recursive is safe).
    rmSync(snapshotLockDir, { recursive: true, force: true });
    const [a, b] = await settled;
    rmSync(snapshotLockDir, { recursive: true, force: true });

    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    const rejected = [a, b].filter((r) => r.status === "rejected");
    // The root lock serializes guard+write+register — exactly one promote
    // may win; the other must refuse. (Pre-fix, BOTH fulfill: the TOCTOU
    // loser's whole-rewrite silently replaces the winner's rows.)
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    const refuseError = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(refuseError.message).toContain("refusing to promote");
    expect(refuseError.message).toContain(join(harnessDir, "workflows", workflowId, WORKFLOW_SNAPSHOT_FILE));

    // First rows intact: the winner's snapshot is exactly its single Todo
    // row, never clobbered by the loser's selection (001 vs 002 — a TOCTOU
    // loser would have whole-rewritten it with its own selection).
    const snapshotPath = join(harnessDir, "workflows", workflowId, WORKFLOW_SNAPSHOT_FILE);
    const snapshot = readJson(snapshotPath);
    const plans = snapshot.plans as Array<Record<string, unknown>>;
    expect(plans).toHaveLength(1);
    expect(plans[0]?.id).toBe("001-fix-n-1-query-in-order-list");
    expect(plans[0]).toMatchObject({ status: "Todo" });

    // Root registration intact and valid; the entry mirrors the snapshot.
    const statusPath = join(harnessDir, "status.json");
    expect(validateStatus(statusPath).ok).toBe(true);
    const status = readJson(statusPath);
    const entry = (status.workflows as Array<Record<string, unknown>>).find((w) => w.id === workflowId);
    expect(entry).toBeDefined();
    expect(entry?.started_at).toBe(snapshot.started_at);
    expect((status.workflows as Array<Record<string, unknown>>)).toHaveLength(1);
  });

  test("register failure rolls back the snapshot so a retry converges (W-001)", async () => {
    const harnessDir = join(tmp, "harness-register-failure");
    const outDir = join(harnessDir, "plans", "audit-2026-08-10");
    mkPlanAudit(outDir, "2026-08-10");

    // Conflicting root state: a second workflow row whose snapshot is missing
    // makes validateStatusV2 fail for the WHOLE document, so registerWorkflow
    // throws only AFTER promoteAuditPlans has already written this workflow's
    // snapshot. Simulates a concurrent root writer / validation failure that
    // the promote path cannot predict before its snapshot write.
    const statusPath = join(harnessDir, "status.json");
    const staleRoot = {
      version: 2,
      updated_at: "2026-08-09",
      workflows: [
        { id: "other-wf", type: "plan", started_at: "2026-08-09T00:00:00.000Z", dir: "workflows/other-wf" },
      ],
    };
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(statusPath, JSON.stringify(staleRoot, null, 2));

    await expect(promoteAuditPlans(outDir, ["001"], { harnessDir })).rejects.toThrow(/invalid status\.json/);

    // Rollback: the snapshot written before the failed register is removed,
    // so the fix-1 re-promote guard no longer blocks a retry.
    const workflowDir = join(harnessDir, "workflows", "audit-2026-08-10");
    expect(existsSync(join(workflowDir, WORKFLOW_SNAPSHOT_FILE))).toBe(false);
    expect(existsSync(workflowDir)).toBe(false);

    // Root untouched: the conflicting root bytes survive the failed promote.
    const after = readFileSync(statusPath, "utf8");
    expect(after).toBe(JSON.stringify(staleRoot, null, 2));

    // Retry after the root conflict is resolved converges end-to-end.
    writeFileSync(statusPath, JSON.stringify({ version: 2, updated_at: "2026-08-09", workflows: [] }, null, 2));
    const retry = await promoteAuditPlans(outDir, ["001"], { harnessDir });
    expect(existsSync(join(harnessDir, "workflows", retry.workflowId, WORKFLOW_SNAPSHOT_FILE))).toBe(true);
    expect(validateStatus(join(harnessDir, "status.json")).ok).toBe(true);
  });

  test("promotes a selected subset only (multi-id, out-of-selection rows absent)", async () => {
    const harnessDir = join(tmp, "harness-subset");
    const outDir = join(harnessDir, "plans", "audit-2026-08-11");
    mkPlanAudit(outDir, "2026-08-11");

    const result = await promoteAuditPlans(outDir, ["002", "001"], { harnessDir });
    const snapshot = readJson(join(harnessDir, "workflows", result.workflowId, WORKFLOW_SNAPSHOT_FILE));
    const plans = snapshot.plans as Array<Record<string, unknown>>;
    expect(plans).toHaveLength(2);
    // Row order follows the selection order, not the directory order.
    expect(plans[0].id).toBe("002-rotate-leaked-aws-keys");
    expect(plans[1].id).toBe("001-fix-n-1-query-in-order-list");
    expect(validateStatus(join(harnessDir, "status.json")).ok).toBe(true);
    expect(validateWorkflowSnapshot(snapshot).ok).toBe(true);
  });

  test("duplicate numeric prefix resolves to the FIRST (lowest) filename (S-03)", async () => {
    // Manual duplicate `001-*.md` files: selecting bare `001` must promote
    // the lowest filename (`001-a.md`), never the highest — the pre-fix
    // `byNum.set` loop let later entries overwrite earlier ones.
    const harnessDir = join(tmp, "harness-dup-prefix");
    const outDir = join(harnessDir, "plans", "audit-2026-08-22");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "001-a.md"), "# Plan A\n");
    writeFileSync(join(outDir, "001-b.md"), "# Plan B\n");

    const result = await promoteAuditPlans(outDir, ["001"], { harnessDir });
    const snapshot = readJson(join(harnessDir, "workflows", result.workflowId, WORKFLOW_SNAPSHOT_FILE));
    const plans = snapshot.plans as Array<Record<string, unknown>>;
    expect(plans).toHaveLength(1);
    // S-03: lowest filename wins for the shared numeric prefix.
    expect(plans[0]).toMatchObject({
      id: "001-a",
      title: "Plan A",
      file: "audit-2026-08-22/001-a.md",
      status: "Todo",
    });
    expect(validateStatus(join(harnessDir, "status.json")).ok).toBe(true);
    expect(validateWorkflowSnapshot(snapshot).ok).toBe(true);
  });

  test("error paths: empty selected / missing harnessDir / unknown plan id / hostile workflow id", async () => {
    const harnessDir = join(tmp, "harness-errors");
    const outDir = join(harnessDir, "plans", "audit-2026-08-11");
    mkPlanAudit(outDir, "2026-08-11");

    // Empty selection is a usage error before any write.
    await expect(promoteAuditPlans(outDir, [], { harnessDir })).rejects.toThrow(/at least one plan id/);
    // Missing harnessDir is rejected before any write (no harness, no workflow dir).
    await expect(promoteAuditPlans(outDir, ["001"], { harnessDir: "" })).rejects.toThrow(/harnessDir is required/);
    // Unknown plan id names the offending id and does not promote a subset.
    await expect(promoteAuditPlans(outDir, ["999"], { harnessDir })).rejects.toThrow(/999/);
    // Hostile workflow id (path traversal) is refused by the path-component
    // guard, never resolved into a workflow path.
    await expect(promoteAuditPlans(outDir, ["001"], { harnessDir, workflowId: "../x" })).rejects.toThrow(
      /safe path component/,
    );
    // All failures left the harness untouched (no snapshot, no status.json).
    expect(existsSync(join(harnessDir, "workflows"))).toBe(false);
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// f11: redactSecrets must NOT be re-exported from the engine barrel —
// the deterministic validator surface stays public; the redaction utility
// stays module-private (import from the audit module directly).
// ---------------------------------------------------------------------------

describe("engine barrel hides redactSecrets (f11)", () => {
  test("importing redactSecrets from the barrel resolves to undefined", async () => {
    // Dynamic import: this test intentionally exercises the module loading
    // boundary — the assertion is that the barrel's runtime namespace lacks
    // the removed export, which a static named import could not express.
    const barrel = await import("../src/index.js");
    expect((barrel as Record<string, unknown>).redactSecrets).toBeUndefined();
  });

  test("the audit module still exports redactSecrets directly", () => {
    expect(typeof redactSecrets).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Fix round — review findings on the Task 1 static checks:
// 1. NEVER_COMMIT_FILENAMES implements `.env*` prefix glob + missing names
//    (`.envrc`, `credentials.json`, `service-account.json`, git-credentials)
// 2. CI_IAC_LEAK_SHAPES `actions-plaintext-env` hits canonical YAML `env:` maps
// 3. `action-unpinned` tolerates trailing comments (`uses: a/b@main # c`)
// ---------------------------------------------------------------------------

describe("scanSecrets never-commit filenames (fix round)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-audit-fix-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /** Write an empty file and return its path for scanning. */
  function touch(name: string): string {
    const p = join(tmp, name);
    writeFileSync(p, "");
    return p;
  }

  // `.env*` prefix glob: basename STARTS with `.env`.
  test("flags .env prefix variants", () => {
    for (const name of [".env", ".env.production", ".env.local.j2", ".envrc"]) {
      const findings = scanSecrets([touch(name)]).findings.filter((f) => f.type === "env-file");
      expect(findings.length).toBe(1);
    }
  });

  test("does not flag env-like suffixes that are not .env-prefixed", () => {
    for (const name of ["foo.env", "config.env", "env.example", "dotenv"]) {
      const findings = scanSecrets([touch(name)]).findings.filter((f) => f.type === "env-file");
      expect(findings.length).toBe(0);
    }
  });

  test("matches on the basename, not the full path (deep dirs)", () => {
    const deep = join(tmp, "nested");
    mkdirSync(deep, { recursive: true });
    const p = join(deep, ".env.staging");
    writeFileSync(p, "");
    expect(scanSecrets([p]).findings.some((f) => f.type === "env-file")).toBe(true);
  });

  test("flags named credential files from security-review §6", () => {
    for (const [name, type] of [
      ["credentials.json", "credentials-json"],
      ["service-account.json", "service-account-json"],
      [".git-credentials", "git-credentials"],
      ["git-credentials", "git-credentials"],
      ["id_rsa", "ssh-private-key-file"],
      ["id_ed25519", "ssh-private-key-file"],
    ] as const) {
      const findings = scanSecrets([touch(name)]).findings.filter((f) => f.type === type);
      expect(findings.length).toBe(1);
    }
  });
});

describe("scanSecrets actions-plaintext-env YAML env: map (fix round)", () => {
  test("flags secret-looking literal children of an env: block mapping", () => {
    const workflow = [
      "on:",
      "  push:",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: make",
      "        env:",
      "          API_TOKEN: \"literalvalue123\"",
      "          DEPLOY_SECRET: mysecretvalue",
      "          PLAIN_VAR: hello",
      "      - run: echo done",
      "        env:",
      "          SAFE_TOKEN: ${{ secrets.SAFE_TOKEN }}",
      "          OTHER_KEY: abcdefgh",
      "",
    ].join("\n");
    const tmp = mkdtempSync(join(tmpdir(), "engine-audit-envmap-"));
    try {
      const wfPath = join(tmp, "wf.yml");
      writeFileSync(wfPath, workflow);
      const hits = scanSecrets([wfPath]).findings.filter((f) => f.type === "actions-plaintext-env");
      // Lines 9-10 are plaintext literals inside the first env: map;
      // line 14 is `${{ }}`-indirect and stays safe; line 15 (OTHER_KEY,
      // 8-char literal) is credential-shaped and MUST be flagged.
      expect(hits.map((h) => h.line)).toEqual([9, 10, 15]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("keeps the same-line shortcut working", () => {
    const tmp = mkdtempSync(join(tmpdir(), "engine-audit-inl-"));
    try {
      const p = join(tmp, "wf.yml");
      writeFileSync(p, '      - run: make\n        env: API_TOKEN="literalvalue123"\n');
      const hits = scanSecrets([p]).findings.filter((f) => f.type === "actions-plaintext-env");
      expect(hits.map((h) => h.line)).toEqual([2]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("supplyChainChecks action-unpinned trailing comment (fix round)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-audit-pin-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /** Write one workflow under a temp repo root and run the gate. */
  function check(workflow: string): { kinds: { kind: string; line?: number }[] } {
    mkdirSync(join(tmp, ".github", "workflows"), { recursive: true });
    writeFileSync(join(tmp, ".github", "workflows", "ci.yml"), workflow);
    return { kinds: supplyChainChecks(tmp).findings };
  }

  test("unpinned with trailing comment is still flagged", () => {
    const r = check("jobs:\n  b:\n    steps:\n      - uses: some/action@main # pin me\n");
    expect(r.kinds.some((f) => f.kind === "action-unpinned" && f.line === 4)).toBe(true);
  });

  test("pinned SHA with trailing comment is NOT flagged", () => {
    const r = check(
      "jobs:\n  b:\n    steps:\n      - uses: some/action@8f4b7f84864484a7bf31766abe9204da3cbe65b3 # v4\n",
    );
    expect(r.kinds.some((f) => f.kind === "action-unpinned")).toBe(false);
  });

  test("plain unpinned without comment still flagged; version pin tolerated", () => {
    const r = check(
      "jobs:\n  b:\n    steps:\n      - uses: some/action@main\n      - uses: some/other@v4\n",
    );
    expect(r.kinds.filter((f) => f.kind === "action-unpinned").length).toBe(1);
  });
});
