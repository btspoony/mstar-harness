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
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createJwt, createOpenSshPrivateKey, createRsaPrivateKey } from "./fixtures/credentials.js";
import {
  promoteAuditPlans,
  redactSecrets,
  scaffoldAuditPlan,
  scanSecrets,
  supplyChainChecks,
  validateAuditFindingGates,
  validateAuditStatusBlocks,
} from "../src/audit.js";
import type { AuditFinding } from "../src/audit.js";
import { createFsStore, setArtifactStore } from "../src/store.js";
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
// Disposable values are generated locally, never issued by a remote service.
const AWS_KEY = `AKIA${randomBytes(8).toString("hex").toUpperCase()}`;
const GH_TOKEN = `ghp_${randomBytes(18).toString("hex")}`;
const SLACK_TOKEN = `xoxb-${randomBytes(24).toString("hex")}`;
const JWT_TOKEN = createJwt();
const OPENAI_KEY = `sk-proj-${randomBytes(16).toString("hex")}`;
const API_KEY = randomBytes(16).toString("hex");
const PASSWORD = randomBytes(24).toString("hex");
const RSA_PRIVATE_KEY = createRsaPrivateKey();
const OPENSSH_PRIVATE_KEY = createOpenSshPrivateKey();

const SECRETS_FIXTURE = `const awsKey = "${AWS_KEY}";
const ghToken = "${GH_TOKEN}";
const slackToken = "${SLACK_TOKEN}";
const jwt = "${JWT_TOKEN}";
const openAiKey = "${OPENAI_KEY}";
const password = "${PASSWORD}";
const apiKey = "${API_KEY}";
const pem = ${JSON.stringify(RSA_PRIVATE_KEY)};
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
    for (const secret of [AWS_KEY, GH_TOKEN, SLACK_TOKEN, JWT_TOKEN, OPENAI_KEY, API_KEY, PASSWORD]) {
      expect(result.text).not.toContain(secret);
    }
    expect(result.text).not.toContain(RSA_PRIVATE_KEY.split("\n")[0]);
  });

  test("replacement carries the file:line + type summary", () => {
    const result = redactSecrets(`const password = "${PASSWORD}";`, "src/config.ts");
    expect(result.text).toContain("[REDACTED password@1 in src/config.ts]");
  });

  test("omits the file name when not provided", () => {
    const result = redactSecrets(`const password = "${PASSWORD}";`);
    expect(result.text).toContain("[REDACTED password@1]");
  });

  test("keeps the key= prefix and only replaces the value", () => {
    const result = redactSecrets(`const password = "${PASSWORD}";`);
    expect(result.text).toContain('const password = [REDACTED password@1]');
  });

  test("leaves safe text untouched", () => {
    const result = redactSecrets(SECRETS_SAFE);
    expect(result.text).toBe(SECRETS_SAFE);
    expect(result.findings).toEqual([]);
  });

  test("redacts quoted JSON keys and preserves the quotes", () => {
    const json = `{"password": "${PASSWORD}", "token": "${API_KEY}"}`;
    const result = redactSecrets(json, "config.json");
    expect(result.text).toContain('{"password": [REDACTED password@1 in config.json]');
    expect(result.text).toContain('"token": [REDACTED token@1 in config.json]');
    expect(result.text).not.toContain(PASSWORD);
    expect(result.text).not.toContain(API_KEY);
  });

  test("redacts single-quoted keys and YAML unquoted keys", () => {
    const yaml = `password: '${PASSWORD}'\n'token': ${API_KEY}`;
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
    { type: "aws-access-key", value: AWS_KEY },
    { type: "github-token", value: GH_TOKEN },
    { type: "slack-token", value: SLACK_TOKEN },
    { type: "api-secret-key", value: OPENAI_KEY },
    { type: "private-key", value: RSA_PRIVATE_KEY },
    { type: "jwt", value: JWT_TOKEN },
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

  // every CI/IaC shape scanSecrets detects must also be
 // redactable — a finding accepted by the scanner can appear in scaffolded
 // evidence and must not survive into artifacts with its value intact.
  test("redacts each CI/IaC shape family (detector/redactor parity)", () => {
    const docker = `ENV API_TOKEN=${PASSWORD}`;
    const arg = `ARG GITHUB_TOKEN=${PASSWORD}`;
    const terraform = `password = "${PASSWORD}"`;
    for (const [text, type] of [
      [docker, "dockerfile-credential-env"],
      [arg, "dockerfile-credential-env"],
      [terraform, "terraform-hardcoded-password"],
    ] as const) {
      const result = redactSecrets(text);
      expect(result.findings.map((f) => f.type)).toContain(type);
 // The matched line region is replaced by the marker, not left as-is.
      expect(result.text).not.toBe(text);
      expect(result.text).not.toContain(PASSWORD);
    }
    const argResult = redactSecrets(arg);
    expect(argResult.text).not.toContain(PASSWORD);
  });

  // the CI/IaC shapes anchor with ^/$ and must fire per LINE of a
 // multi-line evidence text — a shape `scanSecrets` detects on line 2, 3,
 // or N must never survive redaction with its value intact.
  test("redacts CI/IaC shapes mid-string on multi-line text ", () => {
    const multi = [
      "line0: ordinary",
      `env: API_TOKEN="${PASSWORD}"`,
      "FROM node",
      `ENV API_TOKEN=${PASSWORD}`,
      `password = "${PASSWORD}"`,
      "line5: ordinary",
    ].join("\n");
    const result = redactSecrets(multi);
    expect(result.text).not.toContain(PASSWORD);
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

  // overlapping spans must be merged (longest per overlap group)
 // before the text is rebuilt — applying ORIGINAL-length replacements
 // against already-modified text produced `[REDACTED …@1]@1]"` garbage.
 // A fresh provider-shaped value exercises whole-match and line-match overlap.
  const stripeLive = `sk_live_${randomBytes(12).toString("hex")}`;
  test.each([
 // env line containing a stripe whole-match token
    [`env: API_TOKEN="${stripeLive}"`, "[REDACTED actions-plaintext-env@1]"],
 // dockerfile env line containing a stripe whole-match token
    [`ENV API_TOKEN=${stripeLive}\nRUN echo hi`, "[REDACTED dockerfile-credential-env@1]\nRUN echo hi"],
    [`password = "${PASSWORD}"\n`, "[REDACTED terraform-hardcoded-password@1]\n"],
  ])("overlapping spans merge to a single clean marker: %j", (input, expected) => {
    const result = redactSecrets(input);
    expect(result.text).toBe(expected);
    expect((result.text.match(/\[REDACTED /g) ?? []).length).toBe(1);
    expect(result.text).not.toContain("sk_live_");
    expect(result.text).not.toContain(PASSWORD);
  });

  test("private-key redaction covers header AND body until the END marker", () => {
    const pem = OPENSSH_PRIVATE_KEY;
    const result = redactSecrets(pem);
    expect(result.findings.filter((f) => f.type === "private-key").length).toBeGreaterThanOrEqual(1);
 // Header alone is not enough: the base64 body must be gone too.
    expect(result.text).not.toContain(pem.split("\n")[1]);
    expect(result.text).toContain("[REDACTED private-key@");
  });

  // a PEM block whose body lines match other patterns — the
 // whole-block span absorbs them into ONE private-key marker.
  test("private-key span absorbs overlapping matches inside its body ", () => {
    const pem = RSA_PRIVATE_KEY.replace("\n", `\npassword = "${PASSWORD}"\n${SLACK_TOKEN}\n`);
    const result = redactSecrets(pem);
    const markers = result.text.match(/\[REDACTED [^\]]+@\d+\]/g) ?? [];
    expect(markers).toEqual(["[REDACTED private-key@1]"]);
    expect(result.text).not.toContain(PASSWORD);
    expect(result.text).not.toContain(SLACK_TOKEN);
    expect(result.text).not.toContain(RSA_PRIVATE_KEY.split("\n")[0]);
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

  test("non-default confidence persists in a Status line and survives a no-new-findings rebuild", () => {
    const out = join(tmp, "audit-2026-08-28");
    scaffoldAuditPlan(
      out,
      [
        {
          title: "Unparameterized sink",
          category: "security" as const,
          impact: "Raw SQL in the export path.",
          effort: "S" as const,
          risk: "HIGH" as const,
          confidence: "HIGH" as const,
          evidence: ["src/export.ts:88 — f-string builds the query", "src/export.ts:120 — retry path"],
          priority: "P1" as const,
        },
      ],
      { date: "2026-08-28" },
    );
    const plan = readFileSync(join(out, "001-unparameterized-sink.md"), "utf8");
    expect(plan).toContain("- **Confidence**: HIGH");
    expect(validateAuditStatusBlocks(plan).ok).toBe(true);
    expect(readFileSync(join(out, "README.md"), "utf8")).toContain("| HIGH | src/export.ts:88 — f-string builds the query |");
    // Default output unchanged: MED findings render NO Confidence Status line.
    scaffoldAuditPlan(
      out,
      [{ title: "Default confidence", category: "docs" as const, impact: "d", effort: "XS" as const, risk: "LOW" as const, confidence: "MED" as const, evidence: [], priority: "P3" as const }],
      { date: "2026-08-29" },
    );
    expect(readFileSync(join(out, "002-default-confidence.md"), "utf8")).not.toContain("**Confidence**");
    // Rebuild with NO new findings: the index row recovers HIGH from the
    // persisted Status line instead of degrading to "—".
    scaffoldAuditPlan(out, [], { date: "2026-08-30" });
    const readme = readFileSync(join(out, "README.md"), "utf8");
    expect(readme).toContain("| 001 | Unparameterized sink | security |");
    expect(readme).toContain("| HIGH | src/export.ts:88 — f-string builds the query |");
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

  test("D-1: rejected findings + needsVerification/hardeningChecked are redacted in the README ", () => {
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

// ---------------------------------------------------------------------------
// Finding gates + additive metadata (audit-finding-contract.md §§3–8)
// ---------------------------------------------------------------------------

/** Legacy-shape finding (string evidence, no metadata) — the baseline. */
function legacyFinding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    title: "Fix N+1 query",
    category: "perf",
    impact: "Queries explode on the dashboard.",
    effort: "S",
    risk: "LOW",
    confidence: "MED",
    evidence: ["src/orders.ts:42 — raw loop"],
    priority: "P1",
    ...overrides,
  };
}

/** Fully enriched finding exercising every optional field. */
function enrichedFinding(overrides: Partial<AuditFinding> = {}): AuditFinding {
  return {
    title: "Unparameterized sink in export path",
    category: "security",
    impact: "User-controlled CSV export interpolates raw SQL.",
    effort: "S",
    risk: "HIGH",
    confidence: "HIGH",
    evidence: [
      "src/export.ts:88 — f-string builds the query",
      { file: "src/export.ts", line: 120, description: "same sink in the retry path" },
    ],
    priority: "P1",
    fingerprint: "sql-export-sink",
    trace: [
      { kind: "entrypoint", file: "src/routes/export.ts", line: 10, scope: "GET /export", description: "query param reaches the exporter" },
      { kind: "propagation", file: "src/export.ts", line: 64, scope: "buildQuery", description: "parameter concatenated into SQL" },
      { kind: "sink", file: "src/export.ts", line: 88, scope: "runExport", description: "query executed" },
    ],
    severity: { likelihood: "high", impact: "high", overall: "high" },
    ...overrides,
  };
}

describe("validateAuditFindingGates", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-audit-gates-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test("legacy and enriched batches pass; the gate does not mutate its input", () => {
    const findings = [legacyFinding(), enrichedFinding()];
    const snapshot = JSON.stringify(findings);
    const gate = validateAuditFindingGates(findings);
    expect({ ok: gate.ok, violations: gate.violations.map((v) => v.code) }).toEqual({ ok: true, violations: [] });
    expect(JSON.stringify(findings)).toBe(snapshot);
  });

  test("duplicate fingerprint → audit.finding.fingerprint.duplicate with field path only", () => {
    const gate = validateAuditFindingGates([
      enrichedFinding(),
      legacyFinding({ title: "Second instance", fingerprint: "sql-export-sink" }),
    ]);
    expect(gate.ok).toBe(false);
    expect(gate.violations.map((v) => v.code)).toContain("audit.finding.fingerprint.duplicate");
    expect(gate.violations.some((v) => v.message.includes("findings[1].fingerprint"))).toBe(true);
    expect(gate.violations.some((v) => v.message.includes("sql-export-sink"))).toBe(false);
  });

  test("out-of-order supplied fingerprints → audit.finding.fingerprint.order (reject, never sort)", () => {
    const gate = validateAuditFindingGates([
      enrichedFinding({ fingerprint: "zeta-auth-bypass" }),
      legacyFinding({ title: "Earlier identity", fingerprint: "alpha-open-redirect" }),
    ]);
    expect(gate.ok).toBe(false);
    expect(gate.violations.map((v) => v.code)).toContain("audit.finding.fingerprint.order");
  });

  test("mixed legacy/enriched batch with only one fingerprint passes ordering", () => {
    const gate = validateAuditFindingGates([legacyFinding(), enrichedFinding()]);
    expect(gate.ok).toBe(true);
  });

  test("fingerprint grammar violation → audit.finding.fingerprint.grammar", () => {
    const gate = validateAuditFindingGates([enrichedFinding({ fingerprint: "-starts-with-dash" })]);
    expect(gate.ok).toBe(false);
    expect(gate.violations.map((v) => v.code)).toContain("audit.finding.fingerprint.grammar");
  });

  test("supplied fingerprint: null is a usage error, not silent omission", () => {
    const gate = validateAuditFindingGates([{ ...enrichedFinding(), fingerprint: null } as unknown as AuditFinding]);
    expect(gate.ok).toBe(false);
    expect(gate.violations.map((v) => v.code)).toContain("audit.finding.fingerprint.grammar");
    expect(gate.violations.some((v) => v.message.includes("findings[0].fingerprint"))).toBe(true);
  });

  test("supplied severity: null → audit.finding.severity.shape; supplied trace: null → audit.finding.trace.shape", () => {
    const severityGate = validateAuditFindingGates([{ ...enrichedFinding(), severity: null } as unknown as AuditFinding]);
    expect(severityGate.violations.map((v) => v.code)).toContain("audit.finding.severity.shape");
    const traceGate = validateAuditFindingGates([{ ...enrichedFinding(), trace: null } as unknown as AuditFinding]);
    expect(traceGate.violations.map((v) => v.code)).toContain("audit.finding.trace.shape");
  });

  test("omitted fingerprint / severity / trace remain benign (pass gates)", () => {
    const { fingerprint: _f, severity: _s, trace: _t, ...omitted } = enrichedFinding();
    expect(validateAuditFindingGates([omitted]).ok).toBe(true);
  });

  test("fingerprint with any trailing line terminator fails the grammar (true end-of-input anchor)", () => {
    for (const fp of ["valid-id\n", "valid-id\r", "valid-id\r\n", "valid-id\u2028", "valid-id\u2029", "valid-id "]) {
      const gate = validateAuditFindingGates([enrichedFinding({ fingerprint: fp })]);
      expect(gate.violations.map((v) => v.code)).toContain("audit.finding.fingerprint.grammar");
    }
    // positive control: a clean id still passes
    expect(validateAuditFindingGates([enrichedFinding({ fingerprint: "valid-id" })]).ok).toBe(true);
  });

  test("credential-bearing fingerprint is REJECTED, not redacted into another identity", () => {
    const gate = validateAuditFindingGates([enrichedFinding({ fingerprint: "leak-AKIAIOSFODNN7EXAMPLE" })]);
    expect(gate.ok).toBe(false);
    expect(gate.violations.map((v) => v.code)).toContain("audit.finding.fingerprint.secret");
    // the violation names the field path, never the value
    expect(gate.violations.some((v) => v.message.includes("AKIAIOSFODNN7"))).toBe(false);
  });

  test("severity.overall > severity.impact → audit.finding.severity.overall-exceeds-impact", () => {
    const gate = validateAuditFindingGates([
      enrichedFinding({ severity: { likelihood: "low", impact: "medium", overall: "high" } }),
    ]);
    expect(gate.ok).toBe(false);
    expect(gate.violations.map((v) => v.code)).toContain("audit.finding.severity.overall-exceeds-impact");
  });

  test("severity.overall ≤ impact passes; no overall-vs-likelihood gate exists", () => {
    const gate = validateAuditFindingGates([
      enrichedFinding({ severity: { likelihood: "critical", impact: "low", overall: "low" } }),
    ]);
    expect(gate.ok).toBe(true);
  });

  test("empty trace → audit.finding.trace.empty (missing vs empty distinction)", () => {
    const gate = validateAuditFindingGates([enrichedFinding({ trace: [] })]);
    expect(gate.ok).toBe(false);
    expect(gate.violations.map((v) => v.code)).toContain("audit.finding.trace.empty");
  });

  test("singleton trace accepts entrypoint or sink but not propagation", () => {
    expect(validateAuditFindingGates([enrichedFinding({ trace: [{ kind: "sink", file: "src/a.ts", line: 1, scope: "s", description: "d" }] })]).ok).toBe(true);
    const gate = validateAuditFindingGates([
      enrichedFinding({ trace: [{ kind: "propagation", file: "src/a.ts", line: 1, scope: "s", description: "d" }] }),
    ]);
    expect(gate.violations.map((v) => v.code)).toContain("audit.finding.trace.topology");
  });

  test("multi-step trace topology: entrypoint first, sink last, propagation between", () => {
    expect(validateAuditFindingGates([enrichedFinding()]).ok).toBe(true);
    const gate = validateAuditFindingGates([
      enrichedFinding({
        trace: [
          { kind: "propagation", file: "src/a.ts", line: 1, scope: "s", description: "d" },
          { kind: "propagation", file: "src/b.ts", line: 2, scope: "s", description: "d" },
          { kind: "sink", file: "src/c.ts", line: 3, scope: "s", description: "d" },
        ],
      }),
    ]);
    expect(gate.violations.map((v) => v.code)).toContain("audit.finding.trace.topology");
  });

  test("non-positive or non-safe trace lines → audit.finding.trace.line", () => {
    for (const line of [0, -1, 1.5]) {
      const gate = validateAuditFindingGates([
        enrichedFinding({ trace: [{ kind: "sink", file: "src/a.ts", line, scope: "s", description: "d" }] }),
      ]);
      expect(gate.violations.map((v) => v.code)).toContain("audit.finding.trace.line");
    }
  });

  test("non-positive, fractional or unsafe evidence lines → audit.finding.evidence.line; scaffoldAuditPlan rejects via direct engine call", () => {
    for (const line of [0, -3, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const gate = validateAuditFindingGates([
        enrichedFinding({ evidence: [{ file: "src/a.ts", line, description: "d" }] }),
      ]);
      expect(gate.violations.map((v) => v.code)).toContain("audit.finding.evidence.line");
    }
    // omitted line stays legal; the CLI parser already validates, so the
    // direct-engine path (which skips it) must carry the gate itself
    expect(validateAuditFindingGates([enrichedFinding()]).ok).toBe(true);
    const out = join(tmp, "audit-evidence-line");
    for (const line of [0, -3, 1.5]) {
      expect(() =>
        scaffoldAuditPlan(out, [enrichedFinding({ evidence: [{ file: "src/a.ts", line, description: "d" }] })], { date: "2026-09-05" }),
      ).toThrow(/audit\.finding\.evidence\.line/);
    }
  });

  test("unsafe typed paths → audit.finding.path.unsafe (typed file fields only, never prose)", () => {
    for (const file of ["../evil.ts", "/abs/x.ts", "C:\\x\\y.ts", "a//b.ts", "a/./b.ts", "a/../b.ts", "a/trailing./b.ts", "a/trailing /b.ts", "", "src/\ud800a.ts"]) {
      const gate = validateAuditFindingGates([
        enrichedFinding({ evidence: [{ file, line: 1, description: "d" }] }),
      ]);
      expect(gate.violations.some((v) => v.code === "audit.finding.path.unsafe")).toBe(true);
    }
    // a lone surrogate in a trace file is rejected with a field-path diagnostic too
    const surrogateTrace = validateAuditFindingGates([
      enrichedFinding({ trace: [{ kind: "sink", file: "src/\ud800a.ts", line: 1, scope: "s", description: "d" }] }),
    ]);
    expect(surrogateTrace.violations.map((v) => v.code)).toContain("audit.finding.path.unsafe");
    expect(surrogateTrace.violations.some((v) => v.message.includes("trace[0].file"))).toBe(true);
    // legacy string evidence with path-looking prose is NOT path-checked
    expect(validateAuditFindingGates([legacyFinding({ evidence: ["see C:\\secrets\\.env line 3"] })]).ok).toBe(true);
  });

  test("credential-bearing typed location is rejected, not redacted", () => {
    const gate = validateAuditFindingGates([
      enrichedFinding({ trace: [{ kind: "sink", file: "src/AKIAIOSFODNN7EXAMPLE.ts", line: 1, scope: "s", description: "d" }] }),
    ]);
    expect(gate.violations.map((v) => v.code)).toContain("audit.finding.path.secret");
    expect(gate.violations.some((v) => v.message.includes("AKIAIOSFODNN7"))).toBe(false);
  });

  test("invisible-only text → audit.finding.text.invisible; lone surrogate → text.surrogate", () => {
    const zwsp = "\u200B\u00AD\uFEFF";
    for (const [field, value] of [
      ["title", zwsp],
      ["impact", zwsp],
    ] as const) {
      const gate = validateAuditFindingGates([legacyFinding({ [field]: value } as Partial<AuditFinding>)]);
      expect(gate.violations.some((v) => v.code === "audit.finding.text.invisible")).toBe(true);
    }
    // trailing whitespace around visible content is fine
    expect(validateAuditFindingGates([legacyFinding({ title: "  visible  " })]).ok).toBe(true);
    // invisible-only string evidence and trace scope are caught too
    const gate = validateAuditFindingGates([
      enrichedFinding({ trace: [{ kind: "sink", file: "src/a.ts", line: 1, scope: zwsp, description: "d" }] }),
    ]);
    expect(gate.violations.some((v) => v.code === "audit.finding.text.invisible")).toBe(true);
    const surrogate = validateAuditFindingGates([legacyFinding({ impact: "ok \uD800 here" })]);
    expect(surrogate.violations.map((v) => v.code)).toContain("audit.finding.text.surrogate");
  });

  test("variation-selector-only text is invisible-only → audit.finding.text.invisible", () => {
    for (const vs of ["\uFE0F", "\u{E0100}\u{E01EF}", "\uFE00"]) {
      const gate = validateAuditFindingGates([legacyFinding({ title: vs })]);
      expect(gate.violations.some((v) => v.code === "audit.finding.text.invisible")).toBe(true);
    }
  });

  test("full Default_Ignorable_Code_Point set: newly added ranges are invisible-only", () => {
    // representative code point from each range the previous table missed
    for (const cp of ["\u180F", "\u2065", "\u2069", "\u{1BCA0}", "\u{1D173}", "\u{E0080}", "\u{E0FFF}", "\u{E01EF}"]) {
      const gate = validateAuditFindingGates([legacyFinding({ title: cp })]);
      expect(gate.violations.some((v) => v.code === "audit.finding.text.invisible")).toBe(true);
    }
    // invisible-only rejections for previously covered ranges still hold
    for (const cp of ["\u00AD", "\u061C", "\u115F", "\u17B4", "\u200B", "\u202E", "\u3164", "\uFEFF", "\uFFA0", "\uFFF8"]) {
      const gate = validateAuditFindingGates([legacyFinding({ title: cp })]);
      expect(gate.violations.some((v) => v.code === "audit.finding.text.invisible")).toBe(true);
    }
  });

  test("C1 control characters in typed paths → audit.finding.path.unsafe", () => {
    for (const file of ["src/\u0085file.ts", "src/\u009Ffile.ts", "\u0080x.ts"]) {
      const gate = validateAuditFindingGates([
        enrichedFinding({ evidence: [{ file, line: 1, description: "d" }] }),
      ]);
      expect(gate.violations.some((v) => v.code === "audit.finding.path.unsafe")).toBe(true);
    }
  });

  test("valid multilingual visible text is not stripped or rejected", () => {
    const gate = validateAuditFindingGates([
      legacyFinding({ title: "注文クエリの N+1 問題", impact: "整序リストで注文ごとにクエリが発行されます。" }),
    ]);
    expect(gate.ok).toBe(true);
  });

  // Runtime shape guards (§3): JavaScript callers bypass type-checking, so a
  // runtime-malformed carrier must yield a stable `audit.finding.*` violation
  // with a field path — never a native TypeError. Malformed carriers are
  // built via casts exactly as a JS caller would deliver them.
  const malformed = (overrides: Record<string, unknown>): AuditFinding =>
    ({ ...legacyFinding(), ...overrides }) as unknown as AuditFinding;
  const codesOf = (findings: readonly AuditFinding[]): string[] =>
    validateAuditFindingGates(findings).violations.map((v) => v.code);

  test("non-array findings → audit.finding.shape; scaffoldAuditPlan rejects via direct engine call", () => {
    const out = join(tmp, "audit-shape-findings");
    expect(() => scaffoldAuditPlan(out, "nope" as unknown as AuditFinding[], { date: "2026-09-15" })).toThrow(
      /invalid audit findings — audit\.finding\.shape: findings — audit\.finding\.shape/,
    );
  });

  test("non-object finding → audit.finding.shape at findings[index], no dereference", () => {
    for (const finding of [null, 7, "x"]) {
      const gate = validateAuditFindingGates([finding as unknown as AuditFinding]);
      expect(gate.ok).toBe(false);
      expect(gate.violations.map((v) => v.code)).toEqual(["audit.finding.shape"]);
      expect(gate.violations[0].message.startsWith("findings[0] — ")).toBe(true);
    }
  });

  test("evidence: null / primitive / non-array carriers → stable codes, never TypeError", () => {
    expect(codesOf([malformed({ evidence: [null] })])).toContain("audit.finding.evidence.shape");
    expect(codesOf([malformed({ evidence: [42] })])).toContain("audit.finding.evidence.shape");
    expect(codesOf([malformed({ evidence: "see src/a.ts" })])).toContain("audit.finding.evidence.shape");
    expect(codesOf([malformed({ evidence: undefined })])).toContain("audit.finding.evidence.shape");
    // positive control: string evidence stays legal
    expect(validateAuditFindingGates([legacyFinding()]).ok).toBe(true);
    const out = join(tmp, "audit-shape-evidence");
    expect(() => scaffoldAuditPlan(out, [malformed({ evidence: [null] })], { date: "2026-09-15" })).toThrow(
      /audit\.finding\.evidence\.shape: findings\[0\]\.evidence\[0\]/,
    );
  });

  test("evidence object with absent or non-string file/description → path.unsafe / text.type", () => {
    expect(codesOf([malformed({ evidence: [{ line: 1, description: "d" }] })])).toContain("audit.finding.path.unsafe");
    expect(codesOf([malformed({ evidence: [{ file: 7, description: "d" }] })])).toContain("audit.finding.path.unsafe");
    const descGate = validateAuditFindingGates([malformed({ evidence: [{ file: "src/a.ts", description: 42 }] })]);
    expect(descGate.violations.map((v) => v.code)).toContain("audit.finding.text.type");
    expect(descGate.violations.some((v) => v.message.includes("evidence[0].description"))).toBe(true);
  });

  test("trace: non-array carrier and non-object steps → audit.finding.trace.shape", () => {
    expect(codesOf([malformed({ trace: "src/a.ts" })])).toContain("audit.finding.trace.shape");
    expect(codesOf([malformed({ trace: [null] })])).toContain("audit.finding.trace.shape");
    expect(codesOf([malformed({ trace: [42] })])).toContain("audit.finding.trace.shape");
    const stepGate = validateAuditFindingGates([malformed({ trace: [null] })]);
    expect(stepGate.violations.some((v) => v.message.includes("trace[0]"))).toBe(true);
    const out = join(tmp, "audit-shape-trace");
    // scaffoldAuditPlan reports the gate's first violation (topology sorts
    // before the per-step pass) — still a stable code, never a TypeError.
    expect(() => scaffoldAuditPlan(out, [malformed({ trace: [42] })], { date: "2026-09-15" })).toThrow(
      /invalid audit findings — audit\.finding\.trace\.\w+/,
    );
  });

  test("trace step with missing or non-string required text members → trace.shape / text.type", () => {
    expect(codesOf([malformed({ trace: [{ kind: "sink", file: "src/a.ts", line: 1 }] })])).toContain(
      "audit.finding.trace.shape",
    );
    const nonString = validateAuditFindingGates([
      malformed({ trace: [{ kind: "sink", file: "src/a.ts", line: 1, scope: 9, description: "d" }] }),
    ]);
    expect(nonString.violations.map((v) => v.code)).toContain("audit.finding.text.type");
    expect(nonString.violations.some((v) => v.message.includes("trace[0].scope"))).toBe(true);
  });

  test("severity: non-object carrier → audit.finding.severity.shape; non-enum ranks keep audit.finding.severity.rank", () => {
    for (const severity of [null, "high", 3]) {
      const gate = validateAuditFindingGates([malformed({ severity })]);
      expect(gate.ok).toBe(false);
      expect(gate.violations.map((v) => v.code)).toContain("audit.finding.severity.shape");
      expect(gate.violations.some((v) => v.message.includes("findings[0].severity"))).toBe(true);
    }
    expect(codesOf([malformed({ severity: { likelihood: "catastrophic", impact: "high", overall: "low" } })])).toContain(
      "audit.finding.severity.rank",
    );
    // positive control: a well-formed severity still passes
    expect(validateAuditFindingGates([enrichedFinding()]).ok).toBe(true);
  });

  test("shape diagnostics never carry submitted values", () => {
    const gate = validateAuditFindingGates([malformed({ evidence: [null], trace: [42], severity: "secret-value" })]);
    expect(gate.ok).toBe(false);
    for (const v of gate.violations) {
      expect(v.message).not.toContain("secret-value");
      expect(v.message).toMatch(/^findings\[\d+\]/);
    }
  });
});

describe("scaffoldAuditPlan — gate integration + additive rendering", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-audit-scaffold-gates-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test("gate failure throws TypeError with code + field path BEFORE any write; existing README untouched", () => {
    const out = join(tmp, "audit-gate-fail");
    mkdirSync(out, { recursive: true });
    const readme = join(out, "README.md");
    writeFileSync(readme, "# pre-existing index\n");
    let thrown: unknown;
    try {
      scaffoldAuditPlan(out, [enrichedFinding(), legacyFinding({ fingerprint: "aa-late" })], { date: "2026-09-01" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as TypeError).message).toContain("audit.finding.fingerprint.order");
    expect((thrown as TypeError).message).toContain("findings[1].fingerprint");
    expect(readdirSync(out).sort()).toEqual(["README.md"]);
    expect(readFileSync(readme, "utf8")).toBe("# pre-existing index\n");
  });

  test("supplied fingerprint: null → gate violation TypeError before any write (never silent omission)", () => {
    const out = join(tmp, "audit-fingerprint-null");
    mkdirSync(out, { recursive: true });
    let thrown: unknown;
    try {
      scaffoldAuditPlan(out, [{ ...enrichedFinding(), fingerprint: null } as unknown as AuditFinding], { date: "2026-09-18" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as TypeError).message).toContain("audit.finding.fingerprint.grammar");
    expect((thrown as TypeError).message).toContain("findings[0].fingerprint");
    expect(readdirSync(out)).toEqual([]);
  });

  test("enriched finding renders Fingerprint/Likelihood/Severity Status lines, Trace table, structured evidence bullets; prose Impact retained", () => {
    const out = join(tmp, "audit-2026-09-02");
    scaffoldAuditPlan(out, [enrichedFinding()], { date: "2026-09-02", repoShortSha: "deadbee" });
    const plan = readFileSync(join(out, "001-unparameterized-sink-in-export-path.md"), "utf8");
    expect(plan).toContain("- **Fingerprint**: sql-export-sink");
    expect(plan).toContain("- **Confidence**: HIGH");
    expect(plan).toContain("- **Likelihood**: high");
    expect(plan).toContain("- **Severity impact**: high");
    expect(plan).toContain("- **Severity**: high");
    expect(plan).toContain("## Impact");
    expect(plan).toContain("User-controlled CSV export interpolates raw SQL.");
    // string evidence bullets byte-for-byte; object evidence renders file:line — description
    expect(plan).toContain("- src/export.ts:88 — f-string builds the query");
    expect(plan).toContain("- src/export.ts:120 — same sink in the retry path");
    // Trace table with Kind | Location | Scope / Description
    expect(plan).toContain("## Trace");
    expect(plan).toContain("| entrypoint | src/routes/export.ts:10 | GET /export — query param reaches the exporter |");
    expect(plan).toContain("| sink | src/export.ts:88 | runExport — query executed |");
    // still round-trips through the Status validator
    expect(validateAuditStatusBlocks(plan).ok).toBe(true);
  });

  test("trace table cells escape pipes and encode embedded line breaks (\\n and lone \\r) without extra rows", () => {
    const out = join(tmp, "audit-2026-09-03");
    scaffoldAuditPlan(
      out,
      [
        enrichedFinding({
          trace: [
            { kind: "sink", file: "src/a.ts", line: 1, scope: "with | pipe", description: "line one\nline two\rcol three" },
          ],
        }),
      ],
      { date: "2026-09-03" },
    );
    const plan = readFileSync(join(out, "001-unparameterized-sink-in-export-path.md"), "utf8");
    expect(plan).toContain("| sink | src/a.ts:1 | with \\| pipe — line one\\nline two\\ncol three |");
    expect(plan).toContain("## Impact"); // exactly one row: the encoded break never starts a new table line
    expect(plan).not.toContain("\r"); // a lone CR never survives into a written cell
  });

  test("MED confidence with no metadata writes no Confidence line; enriched MED finding does", () => {
    const out = join(tmp, "audit-2026-09-04");
    scaffoldAuditPlan(
      out,
      [
        legacyFinding({ title: "Legacy shape" }),
        enrichedFinding({ confidence: "MED", title: "Enriched default confidence" }),
      ],
      { date: "2026-09-04" },
    );
    const legacy = readFileSync(join(out, "001-legacy-shape.md"), "utf8");
    expect(legacy).not.toContain("**Confidence**");
    expect(legacy).not.toContain("## Trace");
    expect(legacy).not.toContain("**Fingerprint**");
    const enriched = readFileSync(join(out, "002-enriched-default-confidence.md"), "utf8");
    expect(enriched).toContain("- **Confidence**: MED");
  });

  test("index gains Fingerprint / Likelihood / Severity impact / Severity columns only when a row has them; unrated rows show —", () => {
    const out = join(tmp, "audit-2026-09-05");
    scaffoldAuditPlan(out, [legacyFinding({ title: "Legacy row" }), enrichedFinding()], {
      date: "2026-09-05",
      repoShortSha: "deadbee",
    });
    const readme = readFileSync(join(out, "README.md"), "utf8");
    expect(readme).toContain("| # | Finding | Category | Impact | Effort | Risk | Confidence | Evidence | Fingerprint | Likelihood | Severity impact | Severity |");
    // prose Impact column retained; legacy row shows — in the new cells
    expect(readme).toContain("| 001 | Legacy row | perf | Queries explode on the dashboard. | S | LOW | MED | src/orders.ts:42 — raw loop | — | — | — | — |");
    expect(readme).toContain("| 002 | Unparameterized sink in export path | security | User-controlled CSV export interpolates raw SQL. | S | HIGH | HIGH | src/export.ts:88 — f-string builds the query | sql-export-sink | high | high | high |");
  });

  test("legacy-only batch keeps the old index header (no empty new columns)", () => {
    const out = join(tmp, "audit-2026-09-06");
    scaffoldAuditPlan(out, [legacyFinding()], { date: "2026-09-06", repoShortSha: "deadbee" });
    const readme = readFileSync(join(out, "README.md"), "utf8");
    expect(readme).toContain("| # | Finding | Category | Impact | Effort | Risk | Confidence | Evidence |\n");
    expect(readme).not.toContain("Fingerprint");
  });

  test("rerun with no new findings retains stored fingerprint/severity/confidence; legacy row fallbacks unchanged", () => {
    const out = join(tmp, "audit-2026-09-07");
    scaffoldAuditPlan(out, [legacyFinding({ title: "Legacy row" }), enrichedFinding()], {
      date: "2026-09-07",
      repoShortSha: "deadbee",
    });
    const before = readFileSync(join(out, "README.md"), "utf8");
    // rerun: no new findings, no plan file rewritten; the README is rebuilt
    // from the stored Status lines — fingerprint/severity/confidence of
    // enriched rows survive, legacy rows keep their fallbacks ("see plan
    // file" impact, "—" confidence — pre-existing rebuild behavior).
    const result = scaffoldAuditPlan(out, [], { date: "2026-09-07", repoShortSha: "deadbee" });
    expect(result.files).toEqual([]);
    expect(result.nextNumber).toBe(3);
    const rebuilt = readFileSync(join(out, "README.md"), "utf8");
    expect(rebuilt).not.toBe(before); // finding-authoritative overrides no longer apply; parsed storage drives the rows
    expect(rebuilt).toContain("| 002 | Unparameterized sink in export path | security | see plan file | S | HIGH | HIGH | src/export.ts:88 — f-string builds the query | sql-export-sink | high | high | high |");
    expect(rebuilt).toContain("| 001 | Legacy row | perf | see plan file | S | LOW | — | src/orders.ts:42 — raw loop | — | — | — | — |");
    // a second empty rerun is byte-stable — rebuild-from-storage converged
    scaffoldAuditPlan(out, [], { date: "2026-09-07", repoShortSha: "deadbee" });
    expect(readFileSync(join(out, "README.md"), "utf8")).toBe(rebuilt);
  });

  test("secret-bearing structured description is redacted normally; opaque files/fingerprints never altered", () => {
    const out = join(tmp, "audit-2026-09-08b");
    scaffoldAuditPlan(
      out,
      [
        enrichedFinding({
          evidence: [{ file: "src/config.ts", line: 3, description: "AWS key AKIAIOSFODNN7EXAMPLE committed" }],
        }),
      ],
      { date: "2026-09-08" },
    );
    const plan = readFileSync(join(out, "001-unparameterized-sink-in-export-path.md"), "utf8");
    expect(plan).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(plan).toContain("- src/config.ts:3 —");
  });
});

describe("promoteAuditPlans", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-audit-promote-"));
  afterAll(() => {
    setArtifactStore(undefined);
    rmSync(tmp, { recursive: true, force: true });
  });
  /** Per-test harness root with the active ArtifactStore pointed at it (Task
 * 2: the promote path's root upsert persists via `registerWorkflowEntryLocked`
 * → `getArtifactStore().put`; the store must resolve to this harness). */
  function promoteHarnessDir(name: string): string {
    const harnessDir = join(tmp, name);
    setArtifactStore(createFsStore(harnessDir));
    return harnessDir;
  }

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

  test("the delivery declaration is required and coherent (kind never inferred/defaulted, §1/§4a)", async () => {
    const harnessDir = promoteHarnessDir("harness-declaration");
    const outDir = join(harnessDir, "plans", "audit-2026-09-16");
    mkPlanAudit(outDir, "2026-09-16");

    // Missing kind: refused before any write (no snapshot, no root entry).
    await expect(promoteAuditPlans(outDir, ["001"], { harnessDir } as never)).rejects.toThrow(/deliveryKind must be one of/);
    // Development without its anchors: the shared per-kind coherence rule.
    await expect(
      promoteAuditPlans(outDir, ["001"], { harnessDir, deliveryKind: "development", branchSource: "feature/a" }),
    ).rejects.toThrow(/delivery source and target branches/);
    // Verification/report-only without its completion policy.
    await expect(
      promoteAuditPlans(outDir, ["001"], { harnessDir, deliveryKind: "verification/report-only" }),
    ).rejects.toThrow(/completion policy/);
    expect(existsSync(join(harnessDir, "workflows"))).toBe(false);
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);

    // A coherent verification/report-only declaration records kind + policy.
    const promoted = await promoteAuditPlans(outDir, ["001"], {
      harnessDir,
      deliveryKind: "verification/report-only",
      completionPolicy: "acceptance artifacts under the audit dir",
    });
    const snapshot = readJson(join(harnessDir, "workflows", promoted.workflowId, WORKFLOW_SNAPSHOT_FILE));
    expect(snapshot.delivery_kind).toBe("verification/report-only");
    expect(snapshot.completion_policy).toBe("acceptance artifacts under the audit dir");
    expect(snapshot.branch).toBeUndefined();
    expect(validateWorkflowSnapshot(snapshot).ok).toBe(true);
  });

  test("writes a plan workflow snapshot + registers it (type plan, matching started_at)", async () => {
    const harnessDir = promoteHarnessDir("harness");
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

    const result = await promoteAuditPlans(outDir, ["001"], { harnessDir, deliveryKind: "development", branchSource: "feature/audit-plans", branchTarget: "main" });
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
    // Contract §1/§4a: the promoted lifecycle declares its delivery kind (and
    // its per-kind evidence) at registration — never inferred, never defaulted.
    expect(snapshot.delivery_kind).toBe("development");
    expect(snapshot.branch).toEqual({ source: "feature/audit-plans", target: "main" });
    expect(validateWorkflowSnapshot(snapshot).ok).toBe(true);
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
    const harnessDir = promoteHarnessDir("harness-clobber");
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

    const first = await promoteAuditPlans(outDir, ["001"], { harnessDir, deliveryKind: "development", branchSource: "feature/audit-plans", branchTarget: "main" });
    const workflowId = first.workflowId;
    const snapshotPath = join(harnessDir, "workflows", workflowId, WORKFLOW_SNAPSHOT_FILE);
    const before = readJson(snapshotPath);

 // A second promote of the same audit dir (different subset) must refuse,
 // naming the existing snapshot path — not silently whole-rewrite and drop
 // the previously promoted 001 Todo row.
    await expect(promoteAuditPlans(outDir, ["002"], { harnessDir, deliveryKind: "development", branchSource: "feature/audit-plans", branchTarget: "main" })).rejects.toThrow(snapshotPath);

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
    const harnessDir = promoteHarnessDir("harness-concurrent");
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

    const promoteA = promoteAuditPlans(outDir, ["001"], { harnessDir, deliveryKind: "development", branchSource: "feature/audit-plans", branchTarget: "main" });
    const promoteB = promoteAuditPlans(outDir, ["002"], { harnessDir, deliveryKind: "development", branchSource: "feature/audit-plans", branchTarget: "main" });
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
    const harnessDir = promoteHarnessDir("harness-register-failure");
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

    await expect(promoteAuditPlans(outDir, ["001"], { harnessDir, deliveryKind: "development", branchSource: "feature/audit-plans", branchTarget: "main" })).rejects.toThrow(/invalid status\.json/);

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
    const retry = await promoteAuditPlans(outDir, ["001"], { harnessDir, deliveryKind: "development", branchSource: "feature/audit-plans", branchTarget: "main" });
    expect(existsSync(join(harnessDir, "workflows", retry.workflowId, WORKFLOW_SNAPSHOT_FILE))).toBe(true);
    expect(validateStatus(join(harnessDir, "status.json")).ok).toBe(true);
  });

  test("promotes a selected subset only (multi-id, out-of-selection rows absent)", async () => {
    const harnessDir = promoteHarnessDir("harness-subset");
    const outDir = join(harnessDir, "plans", "audit-2026-08-11");
    mkPlanAudit(outDir, "2026-08-11");

    const result = await promoteAuditPlans(outDir, ["002", "001"], { harnessDir, deliveryKind: "development", branchSource: "feature/audit-plans", branchTarget: "main" });
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
    const harnessDir = promoteHarnessDir("harness-dup-prefix");
    const outDir = join(harnessDir, "plans", "audit-2026-08-22");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "001-a.md"), "# Plan A\n");
    writeFileSync(join(outDir, "001-b.md"), "# Plan B\n");

    const result = await promoteAuditPlans(outDir, ["001"], { harnessDir, deliveryKind: "development", branchSource: "feature/audit-plans", branchTarget: "main" });
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
    const harnessDir = promoteHarnessDir("harness-errors");
    const outDir = join(harnessDir, "plans", "audit-2026-08-11");
    mkPlanAudit(outDir, "2026-08-11");

 // Empty selection is a usage error before any write.
    await expect(promoteAuditPlans(outDir, [], { harnessDir, deliveryKind: "development", branchSource: "feature/audit-plans", branchTarget: "main" })).rejects.toThrow(/at least one plan id/);
 // Missing harnessDir is rejected before any write (no harness, no workflow dir).
    await expect(promoteAuditPlans(outDir, ["001"], { harnessDir: "" })).rejects.toThrow(/harnessDir is required/);
 // Unknown plan id names the offending id and does not promote a subset.
    await expect(promoteAuditPlans(outDir, ["999"], { harnessDir, deliveryKind: "development", branchSource: "feature/audit-plans", branchTarget: "main" })).rejects.toThrow(/999/);
 // Hostile workflow id (path traversal) is refused by the path-component
 // guard, never resolved into a workflow path.
    await expect(promoteAuditPlans(outDir, ["001"], { harnessDir, deliveryKind: "development", branchSource: "feature/audit-plans", branchTarget: "main", workflowId: "../x" })).rejects.toThrow(
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
// (`.envrc`, `credentials.json`, `service-account.json`, git-credentials)
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
      writeFileSync(p, `      - run: make\n        env: API_TOKEN="${PASSWORD}"\n`);
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

// ---------------------------------------------------------------------------
// coordinated-writer — promoteAuditPlans writes create-only (spec C4)
// ---------------------------------------------------------------------------

describe("coordinated-writer — promoteAuditPlans create-only snapshot", () => {
  test("refuses to replace an existing snapshot and leaves its bytes unchanged", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "coordinated-writer-promote-"));
    try {
      const harnessDir = join(tmp, "harness");
      setArtifactStore(createFsStore(harnessDir));
      const outDir = join(harnessDir, "plans", "audit-2026-09-15");
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
        ],
        { date: "2026-09-15" },
      );
      const snapshotPath = join(harnessDir, "workflows", "audit-2026-09-15", WORKFLOW_SNAPSHOT_FILE);
      mkdirSync(dirname(snapshotPath), { recursive: true });
      const foreign = '{\n  "schema_version": 1,\n  "id": "audit-2026-09-15",\n  "type": "plan",\n  "status": "running",\n  "started_at": "2026-09-15T00:00:00Z",\n  "updated_at": "2026-09-15",\n  "plans": []\n}\n';
      writeFileSync(snapshotPath, foreign, "utf8");

      await expect(promoteAuditPlans(outDir, ["001"], { harnessDir, deliveryKind: "development", branchSource: "feature/audit-plans", branchTarget: "main" })).rejects.toThrow(/already exists/);
      expect(readFileSync(snapshotPath, "utf8")).toBe(foreign);
    } finally {
      setArtifactStore(undefined);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
