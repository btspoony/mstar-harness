/**
 * Engine audit static checks — plan 20260826-audit-static-checks Task 2.
 *
 * Completes the Task 2 test contract beyond the fix-round suites already
 * living in audit.test.ts (never-commit `.env*` glob, credential-named files,
 * Actions env-map plaintext, unpinned-action comment tolerance):
 *   1. every provider key shape from security-review.md §6 hits via
 *      `scanSecrets` on its own synthetic file;
 *   2. safe-placeholder exclusions are individually asserted — each probed
 *      line WOULD fire absent the guard (checked against the SSOT tables);
 *   3. remaining CI/IaC leak shapes each get a dedicated positive case
 *      (`actions-secret-echo`, `dockerfile-credential-env`,
 *      `terraform-hardcoded-password`) plus targeted negatives;
 *   4. never-commit filenames not yet individually pinned (`.pem`, `.key`);
 *   5. `supplyChainChecks` runs each of its four finding kinds isolated in a
 *      fresh temp repo root, plus a clean-repo `ok: true` baseline.
 * Fixtures are deterministic synthetic tokens assembled from inert fillers —
 * never real credentials.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { scanSecrets, supplyChainChecks } from "../src/audit.js";

// ---------------------------------------------------------------------------
// Fixtures — synthetic provider tokens (inert filler tails, right-shaped)
// ---------------------------------------------------------------------------

/** One synthetic file per provider shape; bare-token body keeps exactly one
 * SSOT-table reader firing per line (no assignment context beside it). */
const PROVIDER_SHAPES: readonly { name: string; body: string; type: string }[] = [
  // AWS access key id: AKIA + 16 alnum uppercase/digits.
  { name: "aws.txt", body: "AKIA" + "IOSFODNN7EXAMPLE", type: "aws-access-key" },
  // Anthropic keys have no dedicated engine row — caught by the generic
  // `sk-` row (D-2 SSOT documents the reconcile): flag type api-secret-key.
  {
    name: "anthropic.txt",
    body: "sk-ant-" + "api03-" + "AAAAAAAAAAAAAAAAAAAA",
    type: "api-secret-key",
  },
  // GitHub classic PAT: ghp_ + 36 alnum (pattern floor).
  { name: "github.txt", body: "ghp_" + "w".repeat(36), type: "github-token" },
  // GitHub fine-grained PAT: github_pat_ + 40+ [A-Za-z0-9_].
  { name: "github-pat.txt", body: "github_pat_" + "B".repeat(46), type: "github-pat" },
  // Stripe LIVE secret key: sk_live_ + 16+ alnum.
  { name: "stripe.txt", body: "sk_live_" + "C".repeat(24), type: "stripe-live-key" },
  // Generic sk- shaped secret (OpenAI-style): sk- + 20+ alnum/hyphen.
  { name: "openai-style.txt", body: "sk-" + "D".repeat(34), type: "api-secret-key" },
];

// ---------------------------------------------------------------------------
// scanSecrets — provider key shapes (security-review.md §6)
// ---------------------------------------------------------------------------

describe("scanSecrets provider key shapes", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-audit-static-providers-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /** Write content into tmp and return the path. */
  function fixture(name: string, body: string): string {
    const p = join(tmp, name);
    writeFileSync(p, `${body}\n`);
    return p;
  }

  for (const { name, body, type } of PROVIDER_SHAPES) {
    test(`${type} fires on ${name}`, () => {
      const { findings } = scanSecrets([fixture(name, body)]);
      expect(findings.map((f) => f.type)).toEqual([type]);
      expect(findings[0]?.line).toBe(1);
    });
  }

  test("slack-token fires for each xox[baprs]- prefix", () => {
    const tail = "123456789012-1234567890123-abcdefghijklmnopqrstuvwx";
    for (const prefix of ["xoxb", "xoxp", "xoxa", "xoxr", "xoxs"]) {
      const p = fixture(`slack-${prefix}.txt`, `${prefix}-${tail}`);
      expect(scanSecrets([p]).findings.map((f) => f.type)).toEqual(["slack-token"]);
    }
  });

  test("jwt fires on a three-segment bearer token", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
      "." +
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0" +
      "." +
      "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const { findings } = scanSecrets([fixture("jwt.txt", jwt)]);
    expect(findings.map((f) => f.type)).toEqual(["jwt"]);
  });

  test("private-key block header fires", () => {
    const pem = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
      "-----END OPENSSH PRIVATE KEY-----",
      "",
    ].join("\n");
    const { findings } = scanSecrets([fixture("id_server", pem)]);
    expect(findings.map((f) => f.type)).toEqual(["private-key"]);
    expect(findings[0]?.line).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// scanSecrets — safe-placeholder exclusions (§6 "do NOT flag"), each probed
// line chosen so the SSOT tables WOULD fire without the guard:
//  - `secret: "${ENV_VAR}"` → quoted 8+ literal hits VALUE_PATTERNS
//  - `token = process.env.…` → unquoted 16+ dotted run hits VALUE_PATTERNS
//  - `apiKey = "your-api-key-here"` / `"<YOUR_API_KEY>"` → quoted literals
// Each file therefore asserts an EMPTY result, proving the guard fired.
// ---------------------------------------------------------------------------

describe("scanSecrets safe-placeholder exclusions", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-audit-static-placeholders-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /** Write one probe line into its own file; expect zero findings. */
  function expectSafe(name: string, line: string): void {
    const p = join(tmp, name);
    writeFileSync(p, `${line}\n`);
    expect(scanSecrets([p]).findings).toEqual([]);
  }

  test("${ENV_VAR} indirection is not reported", () => {
    expectSafe("env-var.txt", `secret: "\${ENV_VAR}"`);
  });

  test("process.env.X read is not reported", () => {
    expectSafe("process-env.txt", `token = process.env.GITHUB_ACCESS_TOKEN_SIGNING_KEY`);
  });

  test('"your-api-key-here" placeholder is not reported', () => {
    expectSafe("placeholder-doc.txt", `apiKey = "your-api-key-here"`);
  });

  test("<YOUR_API_KEY> placeholder is not reported", () => {
    expectSafe("placeholder-angle.txt", `API_KEY = "<YOUR_API_KEY>"`);
  });
  /** Write content into the mixed-line tmp dir and return the path. */
  function fixture(name: string, body: string): string {
    const p = join(tmp, name);
    writeFileSync(p, `${body}\n`);
    return p;
  }


  // Mixed lines (qc2 F-001): the safe-placeholder vocab must exempt only the
  // value region it appears in — a literal key sharing the line MUST still be
  // flagged.
  const LEAK = "sk_live_" + "Z9y8X7W6V5U4T3S2R1Q0P9O8N7";

  test("process.env reference beside a literal stripe key still flags the key", () => {
    const p = fixture("mixed-node.txt", `const key = process.env.STRIPE_KEY ?? "${LEAK}"\n`);
    const hits = scanSecrets([p]).findings.filter((f) => f.type === "stripe-live-key");
    expect(hits.map((h) => h.line)).toEqual([1]);
  });

  test("os.environ reference beside a literal stripe key still flags the key", () => {
    const p = fixture("mixed-py.txt", `key = os.environ.get("STRIPE_KEY") or "${LEAK}"\n`);
    const hits = scanSecrets([p]).findings.filter((f) => f.type === "stripe-live-key");
    expect(hits.map((h) => h.line)).toEqual([1]);
  });

  test("${ENV_VAR} reference in a comment still flags the trailing literal key", () => {
    const p = fixture("mixed-shell.txt", `KEY = "\${API_KEY}" # fallback: ${LEAK}\n`);
    const hits = scanSecrets([p]).findings.filter((f) => f.type === "stripe-live-key");
    expect(hits.map((h) => h.line)).toEqual([1]);
  });

  test("unwritten safe-placeholder file yields empty findings list input too", () => {
    expect(scanSecrets([])).toEqual({ findings: [], unreadableFiles: 0 });
  });
});

// ---------------------------------------------------------------------------
// scanSecrets — CI/IaC leak shapes not yet covered by audit.test.ts fix
// rounds (Actions env-map plaintext already has dedicated suites there):
// actions-secret-echo, dockerfile-credential-env, terraform-hardcoded-password
// ---------------------------------------------------------------------------

describe("scanSecrets CI/IaC leak shapes", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-audit-static-ciiac-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  function fixture(name: string, body: string): string {
    const p = join(tmp, name);
    writeFileSync(p, body);
    return p;
  }

  test("actions-secret-echo: echo ${{ secrets.X }} flagged", () => {
    const p = fixture(
      "echo-leak.yml",
      ["jobs:", "  deploy:", "    steps:", "      - run: echo ${{ secrets.DEPLOY_TOKEN }}", ""].join("\n"),
    );
    const hits = scanSecrets([p]).findings;
    expect(hits.map((f) => f.type)).toEqual(["actions-secret-echo"]);
    expect(hits[0]?.line).toBe(4);
  });

  test("non-secrets context echo stays clean", () => {
    const p = fixture(
      "echo-safe.yml",
      ["jobs:", "  build:", "    steps:", "      - run: echo ${{ vars.ENV_NAME }}", ""].join("\n"),
    );
    expect(scanSecrets([p]).findings).toEqual([]);
  });

  test("dockerfile-credential-env: ENV with credential-looking name flagged", () => {
    const p = fixture(
      "Dockerfile.env",
      ["FROM alpine:3", "ENV API_TOKEN=supersecretvalue123", "CMD [\"sh\"]", ""].join("\n"),
    );
    const hits = scanSecrets([p]).findings;
    expect(hits.map((f) => f.type)).toEqual(["dockerfile-credential-env"]);
    expect(hits[0]?.line).toBe(2);
  });

  test("dockerfile-credential-env: ARG with credential-looking name flagged", () => {
    const p = fixture(
      "Dockerfile.arg",
      ["FROM node:22", "ARG NPM_AUTH_TOKEN=injected-at-build-time", "RUN npm ci", ""].join("\n"),
    );
    expect(scanSecrets([p]).findings.map((f) => f.type)).toEqual(["dockerfile-credential-env"]);
  });

  test("Dockerfile without credential-looking ENV/ARG stays clean", () => {
    const p = fixture(
      "Dockerfile.safe",
      ["FROM alpine:3", "ENV APP_MODE=production NODE_ENV=production", ""].join("\n"),
    );
    expect(scanSecrets([p]).findings).toEqual([]);
  });

  test("terraform-hardcoded-password flagged alongside the generic kv hit", () => {
    // Table composition is additive: `password = "literal"` fires BOTH the
    // dedicated Terraform shape and the generic VALUE_PATTERNS row (same
    // line, two documented sources). Asserting both makes the D-2 SSOT
    // layering visible instead of hiding it behind one type.
    const p = fixture("main.tf", [`resource "random_password" "db" {`, `  password = "S3cr3tV4lue!"`, `}`, ""].join("\n"));
    const types = scanSecrets([p])
      .findings.map((f) => f.type)
      .sort();
    expect(types).toEqual(["password", "terraform-hardcoded-password"]);
  });

  test("terraform var reference is not a hardcoded-password shape", () => {
    const p = fixture("refs.tf", [`resource "db" "main" {`, `  password = var.db_password`, `}`, ""].join("\n"));
    expect(scanSecrets([p]).findings.some((f) => f.type === "terraform-hardcoded-password")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanSecrets — never-commit filenames still unpinned individually:
// `.pem` and `.key` (the rest of §6 lives in audit.test.ts fix round)
// ---------------------------------------------------------------------------

describe("scanSecrets never-commit filenames (.pem/.key)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "engine-audit-static-filenames-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  test.each([
    ["server.pem", "private-key-file"],
    ["localhost.key", "private-key-file"],
    ["CA.CHAIN.PEM", "private-key-file"], // suffix match is case-insensitive
  ])("%s flagged as %s", (name, type) => {
    const p = join(tmp, name);
    writeFileSync(p, "");
    const findings = scanSecrets([p]).findings.filter((f) => f.type === type);
    expect(findings.length).toBe(1);
    expect(findings[0]?.line).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// scanSecrets — zero-secret file
// ---------------------------------------------------------------------------

describe("supplyChainChecks — tracked-state lockfile + verbose prt (fix wave)", () => {
  test("benign source file produces no findings", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "engine-audit-static-clean-"));
    try {
      const p = join(tmp, "app.ts");
      writeFileSync(
        p,
        [
          'import { serve } from "./serve.js";',
          "",
          "export const retryLimit = 5;",
          'export const greeting = "hello world";',
          "",
        ].join("\n"),
      );
      expect(scanSecrets([p]).findings).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("gitignored root lockfile still reports lockfile-missing (qc1 W-005)", () => {
    const root = mkdtempSync(join(tmpdir(), "engine-supply-ignored-lock-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root });
      writeFileSync(join(root, "bun.lock"), "{}\n");
      writeFileSync(join(root, ".gitignore"), "bun.lock\n");
      execFileSync("git", ["add", "-A"], { cwd: root });
      // bun.lock is present on disk but NOT tracked — the authoritative
      // install input is missing.
      const r = supplyChainChecks(root);
      expect(r.findings).toEqual([{ kind: "lockfile-missing", file: root }]);
      expect(r.violations.map((v) => v.code)).toEqual(["audit.supply.lockfile-missing"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tracked root lockfile in a non-git dir falls back to filesystem presence (qc1 W-005)", () => {
    const root = mkdtempSync(join(tmpdir(), "engine-supply-nogit-lock-"));
    try {
      writeFileSync(join(root, "package-lock.json"), "{}");
      const r = supplyChainChecks(root);
      expect(r.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("verbose pull_request_target with-map checkout still flagged beyond 6 lines (qc2 F-002)", () => {
    const root = mkdtempSync(join(tmpdir(), "engine-supply-prt-verbose-"));
    try {
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(join(root, "package-lock.json"), "{}");
      writeFileSync(
        join(root, ".github", "workflows", "verbose.yml"),
        [
          "on:",
          "  pull_request_target:",
          "jobs:",
          "  risky:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - name: Checkout head",
          "        uses: actions/checkout@v4",
          "        with:",
          "          repository: ${{ github.event.pull_request.head.repo.full_name }}",
          "          token: ${{ secrets.GITHUB_TOKEN }}",
          "          persist-credentials: true",
          "          fetch-depth: 0",
          "          submodules: recursive",
          "          clean: false",
          "          ref: ${{ github.event.pull_request.head.sha }}",
          "",
        ].join("\n"),
      );
      const r = supplyChainChecks(root);
      expect(r.ok).toBe(false);
      expect(r.findings).toContainEqual({
        kind: "pull_request_target-head",
        file: ".github/workflows/verbose.yml",
        line: 8, // the `uses:` line (1-based) of the verbose with: map
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// supplyChainChecks — each finding kind isolated in a fresh temp repo root,
// plus the clean-repo baseline. Root lockfiles drive the lockfile kinds;
// workflow scans drive the two Actions kinds.
// ---------------------------------------------------------------------------

describe("supplyChainChecks — isolated kinds", () => {
  test("empty repo root reports lockfile-missing only", () => {
    const root = mkdtempSync(join(tmpdir(), "engine-supply-empty-"));
    try {
      const r = supplyChainChecks(root);
      expect(r.ok).toBe(false);
      expect(r.findings).toEqual([{ kind: "lockfile-missing", file: root }]);
      expect(r.violations.map((v) => v.code)).toEqual(["audit.supply.lockfile-missing"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two root lockfiles report lockfile-duplicate", () => {
    const root = mkdtempSync(join(tmpdir(), "engine-supply-dup-"));
    try {
      writeFileSync(join(root, "package-lock.json"), "{}");
      writeFileSync(join(root, "yarn.lock"), "# yarn lockfile v1");
      const r = supplyChainChecks(root);
      expect(r.ok).toBe(false);
      // File list follows readdirSync order (unspecified) — assert on set
      // membership, not exact concatenation.
      expect(r.findings.length).toBe(1);
      expect(r.findings[0]?.kind).toBe("lockfile-duplicate");
      const listed = (r.findings[0]?.file ?? "").split(", ");
      expect(listed.sort()).toEqual(["package-lock.json", "yarn.lock"]);
      expect(r.violations[0]?.code).toBe("audit.supply.lockfile-duplicate");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("@latest action ref reports action-unpinned", () => {
    const root = mkdtempSync(join(tmpdir(), "engine-supply-latest-"));
    try {
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(join(root, "package-lock.json"), "{}");
      writeFileSync(
        join(root, ".github", "workflows", "ci.yml"),
        ["jobs:", "  b:", "    steps:", "      - uses: some/action@latest", ""].join("\n"),
      );
      const r = supplyChainChecks(root);
      expect(r.ok).toBe(false);
      expect(r.findings).toEqual([
        { kind: "action-unpinned", file: ".github/workflows/ci.yml", line: 4 },
      ]);
      expect(r.violations[0]?.code).toBe("audit.supply.action-unpinned");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pull_request_target + PR-head checkout reports pull_request_target-head", () => {
    const root = mkdtempSync(join(tmpdir(), "engine-supply-prt-"));
    try {
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(join(root, "package-lock.json"), "{}");
      // Checkout pins @v4 (version pin → not unpinned); the PR-head ref two
      // lines below is what trips the dangerous-combination check.
      writeFileSync(
        join(root, ".github", "workflows", "risk.yml"),
        [
          "on:",
          "  pull_request_target:",
          "jobs:",
          "  risky:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "        with:",
          "          ref: ${{ github.event.pull_request.head.sha }}",
          "",
        ].join("\n"),
      );
      const r = supplyChainChecks(root);
      expect(r.ok).toBe(false);
      expect(r.findings).toEqual([
        { kind: "pull_request_target-head", file: ".github/workflows/risk.yml", line: 7 },
      ]);
      expect(r.violations[0]?.code).toBe("audit.supply.pull_request_target-head");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("pull_request_target with plain (base-ref) checkout is NOT flagged", () => {
    const root = mkdtempSync(join(tmpdir(), "engine-supply-prt-base-"));
    try {
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(join(root, "package-lock.json"), "{}");
      writeFileSync(
        join(root, ".github", "workflows", "safe-prt.yml"),
        [
          "on:",
          "  pull_request_target:",
          "jobs:",
          "  safe:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - uses: actions/checkout@v4",
          "",
        ].join("\n"),
      );
      const r = supplyChainChecks(root);
      expect(r.findings).toEqual([]);
      expect(r.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clean repo (lockfile + SHA-pinned workflow) passes with ok:true", () => {
    const root = mkdtempSync(join(tmpdir(), "engine-supply-clean-"));
    try {
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      writeFileSync(
        join(root, ".github", "workflows", "ci.yml"),
        [
          "jobs:",
          "  b:",
          "    steps:",
          "      - uses: some/action@8f4b7f84864484a7bf31766abe9204da3cbe65b3 # v4",
          "",
        ].join("\n"),
      );
      const r = supplyChainChecks(root);
      expect(r.ok).toBe(true);
      expect(r.violations).toEqual([]);
      expect(r.findings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
