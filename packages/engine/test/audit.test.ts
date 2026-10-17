/**
 * Engine audit module — the codebase-audit review report renderer, secret
 * redaction + credential scanning, supply-chain checks and the
 * deterministic finding gates.
 *
 * Spec sources (cited per test): mstar-audit SKILL.md (Hard Rules
 * read-only, § Output format — the `{REVIEW_DIR}` run dir and the README
 * report index) and mstar-audit/references/finding-format.md (category
 * codes, evidence requirements, secret-value prohibition).
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createJwt, createOpenSshPrivateKey, createRsaPrivateKey } from "./fixtures/credentials.js";
import {
  redactSecrets,
  scaffoldAuditReport,
  scanSecrets,
  supplyChainChecks,
  validateAuditFindingGates,
} from "../src/audit.js";
import type { AuditFinding } from "../src/audit.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
// scaffoldAuditReport — mstar-audit SKILL.md § Output format
// ({REVIEW_DIR}/<date>-codebase-<level>-<round>/README.md; no plan files)
// ---------------------------------------------------------------------------

describe("scaffoldAuditReport", () => {
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

  /** The run dir one codebase run resolves to under `reviewsDir`. */
  const runDir = (reviewsDir: string, date: string, level = "standard", round = 1): string =>
    join(reviewsDir, `${date}-codebase-${level}-${round}`);

  /** The rendered report of one run. */
  const readReport = (reviewsDir: string, date: string, level = "standard", round = 1): string =>
    readFileSync(join(runDir(reviewsDir, date, level, round), "README.md"), "utf8");

  test("writes ONE report index into the run dir — no plan files, no Status block", () => {
    const reviews = join(tmp, "reviews-main");
    mkdirSync(reviews, { recursive: true });
    const result = scaffoldAuditReport(findings, { reviewsDir: reviews, date: "2026-08-08", repoName: "acme", repoShortSha: "abc1234" });

    expect(result).toEqual({
      outDir: runDir(reviews, "2026-08-08"),
      file: join(runDir(reviews, "2026-08-08"), "README.md"),
      date: "2026-08-08",
      level: "standard",
      round: 1,
    });
 // The run dir holds the report and nothing else — there are no
 // `NNN-*.md` plan documents any more.
    expect(readdirSync(result.outDir)).toEqual(["README.md"]);

    const readme = readFileSync(result.file, "utf8");
    expect(readme).toContain("# Audit Report \u2014 acme @ abc1234 (2026-08-08)");
    expect(readme).toContain("| 001 | Fix N+1 query in order list | perf |");
    expect(readme).toContain("| 002 | Rotate leaked AWS keys | security |");
    expect(readme).toContain("src/orders.ts:42 — list() queries per order");
    expect(readme).not.toContain("## Status");
    expect(readme).not.toContain("**Depends on**");
  });

  test("the detail section carries each finding in full: priority, verbatim multi-line text, every evidence entry", () => {
    const reviews = join(tmp, "reviews-detail-fidelity");
    mkdirSync(reviews, { recursive: true });
    const verification = "```sh\nbun test a\nbun test b\n```";
    scaffoldAuditReport(
      [
        {
          title: "Multi-line finding",
          category: "bug" as const,
          impact: "Line one.\nLine two.",
          effort: "S" as const,
          risk: "LOW" as const,
          confidence: "HIGH" as const,
          evidence: ["src/a.ts:1 — first", "src/a.ts:2 — second"],
          priority: "P3" as const,
          fixSketch: "Do X.\nThen Y.",
          verification,
        },
      ],
      { reviewsDir: reviews, date: "2026-08-18" },
    );
    const readme = readReport(reviews, "2026-08-18");
    expect(readme).toContain("## Finding detail");
    expect(readme).toContain("- **Priority**: P3");
    // Prose and command blocks keep their newlines — the report is the only artifact.
    expect(readme).toContain("Line one.\nLine two.");
    expect(readme).toContain("Do X.\nThen Y.");
    expect(readme).toContain(verification);
    expect(readme).toContain("- src/a.ts:2 — second");
  });

  test("drops the Execution order & status section (plan-only) and keeps the documented order", () => {
    const reviews = join(tmp, "reviews-sections");
    mkdirSync(reviews, { recursive: true });
    scaffoldAuditReport(findings, { reviewsDir: reviews, date: "2026-08-08" });
    const readme = readReport(reviews, "2026-08-08");
    expect(readme).not.toContain("## Execution order & status");
    expect(readme).not.toContain("| Plan | Title |");
    const order = ["## Findings", "## Red-team dispositions"].map((heading) => readme.indexOf(heading));
    expect(order[0]).toBeGreaterThanOrEqual(0);
    expect(order[1]).toBeGreaterThan(order[0]!);
  });

  test("level + round shape the run dir: a fresh run allocates the next round, an explicit round reuses it", () => {
    const reviews = join(tmp, "reviews-rounds");
    mkdirSync(reviews, { recursive: true });
    const deep = scaffoldAuditReport(findings, { reviewsDir: reviews, date: "2026-08-09", level: "deep" });
    expect(deep.outDir).toBe(runDir(reviews, "2026-08-09", "deep", 1));
    expect(deep.level).toBe("deep");
    expect(deep.round).toBe(1);
 // A second run on the same date + level is a NEW round...
    expect(scaffoldAuditReport(findings, { reviewsDir: reviews, date: "2026-08-09", level: "deep" }).outDir).toBe(
      runDir(reviews, "2026-08-09", "deep", 2),
    );
 // ...while an explicit round is that exact directory (a session's own run).
    expect(scaffoldAuditReport(findings, { reviewsDir: reviews, date: "2026-08-09", level: "deep", round: 1 }).outDir).toBe(
      runDir(reviews, "2026-08-09", "deep", 1),
    );
 // Levels allocate independently of one another.
    expect(scaffoldAuditReport(findings, { reviewsDir: reviews, date: "2026-08-09", level: "quick" }).outDir).toBe(
      runDir(reviews, "2026-08-09", "quick", 1),
    );
  });

  test("a fresh run leaves the previous round's report untouched", () => {
    const reviews = join(tmp, "reviews-preserve");
    mkdirSync(reviews, { recursive: true });
    scaffoldAuditReport([findings[0]!], { reviewsDir: reviews, date: "2026-08-10" });
    const firstReport = join(runDir(reviews, "2026-08-10"), "README.md");
    const before = readFileSync(firstReport, "utf8");
    scaffoldAuditReport([findings[1]!], { reviewsDir: reviews, date: "2026-08-10" });
    expect(readFileSync(firstReport, "utf8")).toBe(before);
    expect(readReport(reviews, "2026-08-10", "standard", 2)).toContain("Rotate leaked AWS keys");
    expect(readReport(reviews, "2026-08-10")).not.toContain("Rotate leaked AWS keys");
  });

  test("concurrent auto-allocated runs each get their own round — no report is overwritten", async () => {
    const reviews = join(tmp, "reviews-alloc");
    mkdirSync(reviews, { recursive: true });
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => scaffoldAuditReport(findings, { reviewsDir: reviews, date: "2026-08-19" })),
      Promise.resolve().then(() => scaffoldAuditReport(findings, { reviewsDir: reviews, date: "2026-08-19" })),
    ]);
    expect([first.round, second.round].sort()).toEqual([1, 2]);
    expect(first.outDir).not.toBe(second.outDir);
    // Both reports survive: neither run destroyed the other's.
    expect(readdirSync(reviews).sort()).toEqual([
      "2026-08-19-codebase-standard-1",
      "2026-08-19-codebase-standard-2",
    ]);
  });

  test("dir overrides the whole run dir (the CLI --dir path)", () => {
    const reviews = join(tmp, "reviews-dir-override");
    mkdirSync(reviews, { recursive: true });
    const custom = join(tmp, "custom-run-dir");
    const result = scaffoldAuditReport(findings, { reviewsDir: reviews, dir: custom, date: "2026-08-11" });
    expect(result).toEqual({
      outDir: custom,
      file: join(custom, "README.md"),
      date: "2026-08-11",
      level: "standard",
      round: 1,
    });
    expect(readdirSync(custom)).toEqual(["README.md"]);
 // Nothing is derived from the name, so the reviews root stays untouched.
    expect(readdirSync(reviews)).toEqual([]);
  });

  test("date defaults to the local calendar date", () => {
    const reviews = join(tmp, "reviews-today");
    mkdirSync(reviews, { recursive: true });
    const today = new Date();
    const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const result = scaffoldAuditReport([], { reviewsDir: reviews });
    expect(result.date).toBe(local);
    expect(result.outDir).toBe(runDir(reviews, local));
  });

  test("renders the Direction section when direction findings exist", () => {
    const reviews = join(tmp, "reviews-direction");
    mkdirSync(reviews, { recursive: true });
    scaffoldAuditReport(
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
      { reviewsDir: reviews, date: "2026-08-12" },
    );
    const readme = readReport(reviews, "2026-08-12");
    expect(readme).toContain("## Direction");
    expect(readme).toContain("- Ship a status dashboard \u2014 Product value for operators.");
  });

  test("renders the rejected-findings section when provided", () => {
    const reviews = join(tmp, "reviews-rejected");
    mkdirSync(reviews, { recursive: true });
    scaffoldAuditReport(findings, {
      reviewsDir: reviews,
      date: "2026-08-13",
      rejected: [{ title: "Add dark mode", reason: "not worth doing for a CLI" }],
    });
    const readme = readReport(reviews, "2026-08-13");
    expect(readme).toContain("## Findings considered and rejected");
    expect(readme).toContain("- Add dark mode: not worth doing for a CLI");
  });

  test("duplicate titles keep their own numbered row (no slug loss on the report surface)", () => {
    const reviews = join(tmp, "reviews-dup");
    mkdirSync(reviews, { recursive: true });
    scaffoldAuditReport(
      [
        { title: "Fix N+1 query", category: "perf" as const, impact: "a", effort: "S" as const, risk: "LOW" as const, confidence: "HIGH" as const, evidence: ["x"], priority: "P1" as const },
        { title: "Fix N+1 query!", category: "perf" as const, impact: "b", effort: "S" as const, risk: "LOW" as const, confidence: "HIGH" as const, evidence: ["y"], priority: "P2" as const },
        { title: "Fix N+1 query??", category: "perf" as const, impact: "c", effort: "S" as const, risk: "LOW" as const, confidence: "HIGH" as const, evidence: ["z"], priority: "P3" as const },
      ],
      { reviewsDir: reviews, date: "2026-08-14" },
    );
    const readme = readReport(reviews, "2026-08-14");
    expect(readme).toContain("| 001 | Fix N+1 query |");
    expect(readme).toContain("| 002 | Fix N+1 query! |");
    expect(readme).toContain("| 003 | Fix N+1 query?? |");
  });

  test("renders the Red-team dispositions section with the four-state placeholder", () => {
    const reviews = join(tmp, "reviews-redteam");
    mkdirSync(reviews, { recursive: true });
    scaffoldAuditReport(findings, { reviewsDir: reviews, date: "2026-08-15" });
    const readme = readReport(reviews, "2026-08-15");
    expect(readme).toContain("## Red-team dispositions");
    expect(readme).toContain("- <finding>: <survived / refuted / hallucination-dropped / uncovered-kept>, <one-line reason>");
  });

  test("renders Needs verification and Hardening & checked notes from options", () => {
    const reviews = join(tmp, "reviews-dispositions");
    mkdirSync(reviews, { recursive: true });
    scaffoldAuditReport(findings, {
      reviewsDir: reviews,
      date: "2026-08-16",
      needsVerification: [{ lead: "SSRF in webhook fetcher", how: "confirm caller supplies the URL", evidence: "src/hooks.ts:77" }],
      hardeningChecked: [
        { kind: "Hardening", text: "no CSP header - framework middleware already escapes all output" },
        { kind: "Checked and clean", text: "orders SQL sink parameterized end to end" },
      ],
    });
    const readme = readReport(reviews, "2026-08-16");
    expect(readme).toContain("## Needs verification");
    expect(readme).toContain("- SSRF in webhook fetcher: confirm caller supplies the URL (src/hooks.ts:77)");
    expect(readme).toContain("## Hardening & checked notes");
    expect(readme).toContain("- Hardening: no CSP header - framework middleware already escapes all output");
    expect(readme).toContain("- Checked and clean: orders SQL sink parameterized end to end");
 // section order matches the documented template
    // No direction finding is supplied, so the Direction section is absent.
    const order = ["## Needs verification", "## Hardening & checked notes", "## Red-team dispositions"].map(
      (heading) => readme.indexOf(heading),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("a re-run of the same round without disposition options carries over ALL previous entries", () => {
    const reviews = join(tmp, "reviews-carry");
    mkdirSync(reviews, { recursive: true });
    scaffoldAuditReport(findings, {
      reviewsDir: reviews,
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
 // Same run dir (explicit round), no disposition options — every entry must
 // survive the rebuild (regression: the carry-over regex used to stop after
 // the first entry of each section). A fresh run would allocate the next
 // round instead, leaving this report alone.
    scaffoldAuditReport(
      [{ title: "Second batch finding", category: "tests" as const, impact: "b", effort: "S" as const, risk: "LOW" as const, confidence: "HIGH" as const, evidence: [], priority: "P2" as const }],
      { reviewsDir: reviews, date: "2026-08-17", round: 1 },
    );
    const readme = readReport(reviews, "2026-08-17");
    expect(readme).toContain("- lead one: check x");
    expect(readme).toContain("- lead two: check y (src/a.ts:9)");
    expect(readme).toContain("- Hardening: gap one");
    expect(readme).toContain("- Checked and clean: sink y cleared");
    expect(readme).toContain("- Checked and clean: sink z cleared");
 // section entry counts preserved exactly
    const nvBlock = /## Needs verification\n\n([\s\S]*?)\n\n## Hardening/.exec(readme)?.[1] ?? "";
    expect(nvBlock.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(2);
    const hcBlock = /## Hardening & checked notes\n\n([\s\S]*?)\n\n## Red-team dispositions/.exec(readme)?.[1] ?? "";
    expect(hcBlock.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(3);
 // The new batch replaced the findings table of that same report.
    expect(readme).toContain("| 001 | Second batch finding |");
    expect(readme).not.toContain("Fix N+1 query in order list");
  });

  test("a SUPPLIED disposition array is the authoritative set — it replaces prior entries", () => {
    const reviews = join(tmp, "reviews-supplied");
    mkdirSync(reviews, { recursive: true });
    scaffoldAuditReport(findings, {
      reviewsDir: reviews,
      date: "2026-08-19",
      needsVerification: [
        { lead: "stale lead", how: "check old" },
        { lead: "kept lead", how: "check keep" },
      ],
    });
 // same run dir, current truth supplied: stale lead resolved, kept kept,
 // fresh added — omission would have carried all three, supplying replaces
 // with exactly this set (resolved entries CAN be removed)
    scaffoldAuditReport([], {
      reviewsDir: reviews,
      date: "2026-08-19",
      round: 1,
      needsVerification: [
        { lead: "kept lead", how: "check keep" },
        { lead: "fresh lead", how: "check new" },
      ],
    });
    const readme = readReport(reviews, "2026-08-19");
    expect(readme).not.toContain("- stale lead: check old");
    expect(readme).toContain("- kept lead: check keep");
    expect(readme).toContain("- fresh lead: check new");
  });

  test("carry-over tolerates hand-edited headings: case, CRLF, spacing, blank lines", () => {
    const reviews = join(tmp, "reviews-handedited");
    mkdirSync(reviews, { recursive: true });
    scaffoldAuditReport(findings, { reviewsDir: reviews, date: "2026-08-21" });
    const report = join(runDir(reviews, "2026-08-21"), "README.md");
 // simulate a hand-edited report: CRLF endings, different heading case,
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
      "## Red-team dispositions",
      "",
    ].join("\r\n");
    writeFileSync(report, handEdited);
    scaffoldAuditReport(
      [{ title: "Rebuild batch", category: "tests" as const, impact: "b", effort: "S" as const, risk: "LOW" as const, confidence: "HIGH" as const, evidence: [], priority: "P2" as const }],
      { reviewsDir: reviews, date: "2026-08-21", round: 1 },
    );
    const readme = readFileSync(report, "utf8");
    expect(readme).toContain("- hand typed lead: check it (src/x.ts:1)");
    expect(readme).toContain("- Checked and clean: hand cleared sink");
  });

  test("D-1: the report redacts credentials in every channel (Hard Rule 4)", () => {
    const reviews = join(tmp, "reviews-redaction");
    mkdirSync(reviews, { recursive: true });
    const leak = "sk_live_" + "A1b2C3d4E5f6G7h8I9j0K1l2";
    const otherLeak = "sk_live_" + "B7c8D9e0F1a2B3c4D5e6F7g8";
    const result = scaffoldAuditReport(
      [
        {
          title: "Rotate the leaked Stripe live key",
          category: "security" as const,
          impact: "Anyone with repo read access can charge cards.",
          effort: "S" as const,
          risk: "HIGH" as const,
          confidence: "HIGH" as const,
          evidence: [`src/config.ts:12 — ${leak} committed`, `src/config.ts:20 — ${leak} again`],
          priority: "P1" as const,
        },
      ],
      {
        reviewsDir: reviews,
        date: "2026-08-22",
        rejected: [{ title: `Rejected token: ${otherLeak}`, reason: "value was already rotated" }],
        needsVerification: [{ lead: "AWS key in logs", how: `search ${otherLeak} in CloudWatch` }],
        hardeningChecked: [{ kind: "Hardening", text: `legacy key ${otherLeak} revoked` }],
      },
    );
    const readme = readFileSync(result.file, "utf8");
 // No raw credential value reaches the report through ANY channel...
    expect(readme).not.toContain(leak);
    expect(readme).not.toContain(otherLeak);
 // ...while the redaction marker and the non-secret context survive.
    expect(readme).toContain("[REDACTED stripe-live-key@");
    expect(readme).toContain("src/config.ts:12");
  });
});



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
    const gate = validateAuditFindingGates(findings);
    expect({ ok: gate.ok, violations: gate.violations.map((v) => v.code) }).toEqual({ ok: true, violations: [] });
    expect(findings.map(({ title, fingerprint }) => [title, fingerprint])).toEqual([
      ["Fix N+1 query", undefined],
      ["Unparameterized sink in export path", "sql-export-sink"],
    ]);
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

  test("non-positive, fractional or unsafe evidence lines → audit.finding.evidence.line; scaffoldAuditReport rejects via direct engine call", () => {
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
        scaffoldAuditReport([enrichedFinding({ evidence: [{ file: "src/a.ts", line, description: "d" }] })], { reviewsDir: out, date: "2026-09-05" }),
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

  test("non-array findings → audit.finding.shape; scaffoldAuditReport rejects via direct engine call", () => {
    const out = join(tmp, "audit-shape-findings");
    expect(() => scaffoldAuditReport("nope" as unknown as AuditFinding[], { reviewsDir: out, date: "2026-09-15" })).toThrow(
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
    expect(() => scaffoldAuditReport([malformed({ evidence: [null] })], { reviewsDir: out, date: "2026-09-15" })).toThrow(
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
    // scaffoldAuditReport reports the gate's first violation (topology sorts
    // before the per-step pass) — still a stable code, never a TypeError.
    expect(() => scaffoldAuditReport([malformed({ trace: [42] })], { reviewsDir: out, date: "2026-09-15" })).toThrow(
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

describe("scaffoldAuditReport — gate integration + report columns", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-audit-scaffold-gates-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /** The run dir a default (standard / round 1) report lands in. */
  const runDir = (reviewsDir: string, date: string): string => join(reviewsDir, `${date}-codebase-standard-1`);

  test("gate failure throws TypeError with code + field path BEFORE any write; no run dir is created", () => {
    const reviews = join(tmp, "reviews-gate-fail");
    mkdirSync(reviews, { recursive: true });
    let thrown: unknown;
    try {
      scaffoldAuditReport([enrichedFinding(), legacyFinding({ fingerprint: "aa-late" })], { reviewsDir: reviews, date: "2026-09-01" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as TypeError).message).toContain("audit.finding.fingerprint.order");
    expect((thrown as TypeError).message).toContain("findings[1].fingerprint");
 // The gate runs before the first mkdirSync: no run dir appears.
    expect(readdirSync(reviews)).toEqual([]);
  });

  test("gate failure leaves an existing report of the same run dir untouched", () => {
    const reviews = join(tmp, "reviews-gate-preserve");
    mkdirSync(reviews, { recursive: true });
    scaffoldAuditReport([legacyFinding()], { reviewsDir: reviews, date: "2026-09-01" });
    const report = join(runDir(reviews, "2026-09-01"), "README.md");
    const before = readFileSync(report, "utf8");
    expect(() =>
      scaffoldAuditReport([enrichedFinding(), legacyFinding({ fingerprint: "aa-late" })], {
        reviewsDir: reviews,
        date: "2026-09-01",
        round: 1,
      }),
    ).toThrow(TypeError);
    expect(readFileSync(report, "utf8")).toBe(before);
  });

  test("supplied fingerprint: null → gate violation TypeError before any write (never silent omission)", () => {
    const reviews = join(tmp, "reviews-fingerprint-null");
    mkdirSync(reviews, { recursive: true });
    let thrown: unknown;
    try {
      scaffoldAuditReport([{ ...enrichedFinding(), fingerprint: null } as unknown as AuditFinding], { reviewsDir: reviews, date: "2026-09-18" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as TypeError).message).toContain("audit.finding.fingerprint.grammar");
    expect((thrown as TypeError).message).toContain("findings[0].fingerprint");
    expect(readdirSync(reviews)).toEqual([]);
  });

  test("enriched findings render Fingerprint + severity columns; structured evidence renders file:line — description", () => {
    const reviews = join(tmp, "reviews-enriched");
    mkdirSync(reviews, { recursive: true });
    scaffoldAuditReport([enrichedFinding()], { reviewsDir: reviews, date: "2026-09-02", repoShortSha: "deadbee" });
    const readme = readFileSync(join(runDir(reviews, "2026-09-02"), "README.md"), "utf8");
    expect(readme).toContain(
      "| # | Finding | Category | Impact | Effort | Risk | Confidence | Evidence | Fingerprint | Likelihood | Severity impact | Severity |",
    );
 // prose Impact retained; structured evidence renders the typed location
    expect(readme).toContain(
      "| 001 | Unparameterized sink in export path | security | User-controlled CSV export interpolates raw SQL. | S | HIGH | HIGH | src/export.ts:88 — f-string builds the query | sql-export-sink | high | high | high |",
    );
  });

  test("index gains the Fingerprint / Likelihood / Severity columns only when a row has them; unrated rows show —", () => {
    const reviews = join(tmp, "reviews-columns");
    mkdirSync(reviews, { recursive: true });
    scaffoldAuditReport([legacyFinding({ title: "Legacy row" }), enrichedFinding()], {
      reviewsDir: reviews,
      date: "2026-09-05",
      repoShortSha: "deadbee",
    });
    const readme = readFileSync(join(runDir(reviews, "2026-09-05"), "README.md"), "utf8");
    expect(readme).toContain(
      "| # | Finding | Category | Impact | Effort | Risk | Confidence | Evidence | Fingerprint | Likelihood | Severity impact | Severity |",
    );
    expect(readme).toContain("| 001 | Legacy row | perf | Queries explode on the dashboard. | S | LOW | MED | src/orders.ts:42 — raw loop | — | — | — | — |");
    expect(readme).toContain(
      "| 002 | Unparameterized sink in export path | security | User-controlled CSV export interpolates raw SQL. | S | HIGH | HIGH | src/export.ts:88 — f-string builds the query | sql-export-sink | high | high | high |",
    );
  });

  test("legacy-only batch keeps the old index header (no empty new columns)", () => {
    const reviews = join(tmp, "reviews-legacy-header");
    mkdirSync(reviews, { recursive: true });
    scaffoldAuditReport([legacyFinding()], { reviewsDir: reviews, date: "2026-09-06", repoShortSha: "deadbee" });
    const readme = readFileSync(join(runDir(reviews, "2026-09-06"), "README.md"), "utf8");
    expect(readme).toContain("| # | Finding | Category | Impact | Effort | Risk | Confidence | Evidence |\n");
    expect(readme).not.toContain("Fingerprint");
  });

  test("secret-bearing structured description is redacted; the typed file path is never altered", () => {
    const reviews = join(tmp, "reviews-typed-redaction");
    mkdirSync(reviews, { recursive: true });
    scaffoldAuditReport(
      [
        enrichedFinding({
          evidence: [{ file: "src/config.ts", line: 3, description: "AWS key AKIAIOSFODNN7EXAMPLE committed" }],
        }),
      ],
      { reviewsDir: reviews, date: "2026-09-08" },
    );
    const readme = readFileSync(join(runDir(reviews, "2026-09-08"), "README.md"), "utf8");
    expect(readme).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(readme).toContain("src/config.ts:3 —");
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


