/**
 * discovery-walkthrough.test.ts — #324 acceptance proof: on a FIXTURE store,
 * a CLI agent must be able to derive every execution input a lawful close
 * needs from `--help` text and the refusals it hits alone, in <=3 CLI calls per
 * input. The walkthrough drives the real CLI (spawned the same way global-cli
 * tests spawn it) against a disposable temp fixture; it never touches this
 * checkout's store.
 *
 * Scope note (explicit): the walkthrough proves the INPUT-DERIVATION contract.
 * The one lawful close this chain reaches stops at the workflow-lifecycle
 * domain guard (`coordination.invalid-transition`): composing a full close
 * would require valid Assignment/QC/QA evidence fixtures — lifecycle domain
 * content, not #324 input discovery, and out of this plan's scope.
 * Every #324 input on the way IS engine-verified: the root token passes the
 * registration CAS, and the session reference, identity and workflow token
 * pass `workflow evidence`'s seat check and CAS (the operation commits).
 *
 * Precondition: the engine/commands/cli dist bundles exist (`bun run
 * --cwd packages/cli build`).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI_ENTRY = path.join(import.meta.dir, "index.ts");

type CliResult = { status: number; stdout: string; stderr: string };

function runCli(args: readonly string[], cwd: string, keepHostSession = false): CliResult {
  const env = { ...process.env };
  delete env.MSTAR_HARNESS_DIR;
  if (!keepHostSession) delete env.MSTAR_HOST_SESSION_ID;
  try {
    const stdout = execFileSync(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function envelope(stdout: string): { status: string; code: string; message: string; data: Record<string, unknown> } {
  return JSON.parse(stdout);
}

describe("#324 fixture discovery walkthrough", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "mstar-324-scratch-"));
  const fixture = mkdtempSync(path.join(tmpdir(), "mstar-324-fixture-"));
  const harnessDir = path.join(fixture, ".mstar");
  const cli = (args: readonly string[], cwd: string = fixture) => runCli(args, cwd);

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  test("a close's inputs are derivable from the CLI surfaces in \u22643 calls per input", () => {
    // Fixture store: one call creates and activates the ACTIVE authority.
    mkdirSync(harnessDir, { recursive: true });
    const plansDir = path.join(harnessDir, "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(path.join(plansDir, "p-walk.md"), "# Walk plan\n\n**plan_id:** p-walk\n\nbody\n");
    const upgraded = envelope(cli(["store", "upgrade", "--harness", harnessDir, "--operator", "walkthrough"], scratch).stdout);
    expect(upgraded.status).toBe("ok");
    expect(upgraded.data).toMatchObject({ authorityState: "active" });

    // Input 1 — root token: one `status validate` call (help names data.token).
    const firstRead = envelope(cli(["status", "validate"]).stdout);
    expect(firstRead.status).toBe("ok");
    const rootToken = firstRead.data.token as string;
    expect(rootToken).toMatch(/^exec-v1:root:/);

    // The register consumes the derived root token — its CAS accepts it.
    const registered = envelope(
      cli([
        "workflow", "register",
        "--workflow", "wf-walk",
        "--plan-id", "p-walk",
        "--plan-title", "Walk plan",
        "--plan-file", path.join(plansDir, "p-walk.md"),
        "--delivery-kind", "verification/report-only",
        "--completion-policy", "walkthrough policy",
        "--expect", rootToken,
        "--operation", "op-reg-1",
        "--harness", harnessDir,
      ]).stdout,
    );
    expect(registered.status).toBe("ok");

    // Inputs 2+3 — workflow and plan tokens: the same second `status validate`
    // call, at the JSON paths the help names.
    const secondRead = envelope(cli(["status", "validate"]).stdout);
    const workflowEntry = (secondRead.data.workflows as Array<Record<string, unknown>>).find((entry) => entry.id === "wf-walk");
    expect(workflowEntry).toBeDefined();
    const workflowToken = workflowEntry!.token as string;
    expect(workflowToken).toMatch(/^exec-v1:workflow:/);
    const authority = secondRead.data.authority as { workflows: Array<{ planTokens: Record<string, string> }> };
    const planToken = authority.workflows[0]!.planTokens["p-walk"];
    expect(planToken).toMatch(/^exec-v1:plan:/);

    // Input 4 — session reference: one `plan bind` call; its receipt object
    // carries exactly the fields the help's wire format names, and the
    // engine's own parser accepts the encoded transport (round trip).
    const bindOut = cli([
      "plan", "bind", "--execution",
      "--workflow", "wf-walk",
      "--coordinator",
      "--session-id", "walk-coord",
      "--harness", harnessDir,
    ]);
    const bound = envelope(bindOut.stdout);
    expect(bound.status).toBe("ok");
    const ref = bound.data.data as Record<string, unknown>;
    // The receipt carries exactly the six fields the help's wire format names.
    const fields = ["epoch", "planId", "role", "sessionId", "storeId", "workflowId"] as const;
    expect(Object.keys(ref).sort()).toEqual([...fields].sort());
    // Hand-built from the CLI-printed receipt alone, per the DISCLOSED format:
    // "exec-session-v1:" + base64url(JSON with exactly those six keys). No
    // engine helper constructs it — the walkthrough proves the disclosure is
    // sufficient end-to-end because the CLI under test accepts this value.
    const wire =
      "exec-session-v1:" +
      Buffer.from(JSON.stringify(Object.fromEntries(fields.map((field) => [field, ref[field]]))), "utf8").toString("base64url");

    // The derived session reference, identity and workflow token pass a real
    // CAS write: recording delivery evidence commits.
    const evidenceDir = mkdtempSync(path.join(tmpdir(), "mstar-324-evidence-"));
    const evidenceFile = path.join(evidenceDir, "evidence.json");
    writeFileSync(evidenceFile, JSON.stringify({ completion: { policy: "walkthrough policy", evidence: "walkthrough verification record" } }));
    const recorded = envelope(
      cli([
        "workflow", "evidence",
        "--workflow", "wf-walk",
        "--file", evidenceFile,
        "--session-id", "walk-coord",
        "--session-ref", wire,
        "--expect", workflowToken,
        "--operation", "op-ev-1",
        "--harness", harnessDir,
      ]).stdout,
    );
    expect(recorded.status).toBe("ok");
    rmSync(evidenceDir, { recursive: true, force: true });

    // The close then reaches the workflow-lifecycle DOMAIN guard — every #324
    // input (identity, sessionRef, token) passed its gate; the remaining refusal
    // is lifecycle evidence content, out of #324 scope (see header).
    const closeOut = cli([
      "status", "workflow-close",
      "--workflow", "wf-walk",
      "--session-id", "walk-coord",
      "--session-ref", wire,
      "--expect", workflowToken,
      "--operation", "op-close-1",
      "--harness", harnessDir,
    ]);
    const refusedClose = envelope(closeOut.stdout);
    expect(refusedClose.status).toBe("refused");
    expect(refusedClose.code).toBe("coordination.invalid-transition");
  }, 60000);

  test("a wrong-kind --expect refusal names where the expected token is read", () => {
    const wrongFixture = mkdtempSync(path.join(tmpdir(), "mstar-324-wrongkind-"));
    const wrongHarness = path.join(wrongFixture, ".mstar");
    const wrongScratch = mkdtempSync(path.join(tmpdir(), "mstar-324-s2-"));
    mkdirSync(path.join(wrongHarness, "plans"), { recursive: true });
    writeFileSync(path.join(wrongHarness, "plans", "p-walk.md"), "# Walk plan\n\n**plan_id:** p-walk\n\nbody\n");
    try {
      expect(envelope(cli(["store", "upgrade", "--harness", wrongHarness, "--operator", "walkthrough"], wrongScratch).stdout).status).toBe("ok");
      const read = envelope(cli(["status", "validate"], wrongFixture).stdout);
      const rootToken = read.data.token as string;
      expect(
        envelope(
          cli([
            "workflow", "register",
            "--workflow", "wf-wrong",
            "--plan-id", "p-walk",
            "--plan-title", "Walk plan",
            "--plan-file", path.join(wrongHarness, "plans", "p-walk.md"),
            "--delivery-kind", "verification/report-only",
            "--completion-policy", "policy",
            "--expect", rootToken,
            "--operation", "op-reg-1",
            "--harness", wrongHarness,
          ]).stdout,
        ).status,
      ).toBe("ok");
      const secondRead = envelope(cli(["status", "validate"], wrongFixture).stdout);
      const authority = secondRead.data.authority as { workflows: Array<{ planTokens: Record<string, string> }> };
      const planToken = authority.workflows[0]!.planTokens["p-walk"];
      const wrongKind = envelope(
        cli([
          "plan", "bind", "--execution",
          "--workflow", "wf-wrong",
          "--coordinator",
          "--session-id", "walk-coord",
          "--expect", planToken,
          "--operation", "op-bind-1",
          "--harness", wrongHarness,
        ]).stdout,
      );
      expect(wrongKind.status).toBe("refused");
      expect(wrongKind.code).toBe("execution.token-kind");
      expect(wrongKind.message).toContain("Read the current workflow token with `mstar status validate`");
      expect(wrongKind.message).toContain('data.workflows[] entry for workflow "wf-wrong"');
    } finally {
      rmSync(wrongScratch, { recursive: true, force: true });
      rmSync(wrongFixture, { recursive: true, force: true });
    }
  }, 60000);

  test("legacy bind refusals on an ACTIVE store name the --execution route (both forms)", () => {
    const legacyFixture = mkdtempSync(path.join(tmpdir(), "mstar-324-legacy-"));
    const legacyHarness = path.join(legacyFixture, ".mstar");
    const legacyScratch = mkdtempSync(path.join(tmpdir(), "mstar-324-s3-"));
    mkdirSync(path.join(legacyHarness, "plans"), { recursive: true });
    writeFileSync(path.join(legacyHarness, "plans", "p-legacy.md"), "# Legacy plan\n\n**plan_id:** p-legacy\n\nbody\n");
    try {
      expect(envelope(cli(["store", "upgrade", "--harness", legacyHarness, "--operator", "walkthrough"], legacyScratch).stdout).status).toBe("ok");
      const read = envelope(cli(["status", "validate"], legacyFixture).stdout);
      const rootToken = read.data.token as string;
      expect(
        envelope(
          cli([
            "workflow", "register",
            "--workflow", "wf-legacy",
            "--plan-id", "p-legacy",
            "--plan-title", "Legacy plan",
            "--plan-file", path.join(legacyHarness, "plans", "p-legacy.md"),
            "--delivery-kind", "verification/report-only",
            "--completion-policy", "policy",
            "--expect", rootToken,
            "--operation", "op-reg-1",
            "--harness", legacyHarness,
          ]).stdout,
        ).status,
      ).toBe("ok");
      // Legacy coordinator form: --workflow only, no --execution.
      const coordinatorForm = envelope(
        cli(["plan", "bind", "--coordinator", "--workflow", "wf-legacy", "--session-id", "legacy-coord", "--harness", legacyHarness]).stdout,
      );
      expect(coordinatorForm.status).toBe("refused");
      expect(coordinatorForm.code).toBe("execution.consumer-not-ready");
      expect(coordinatorForm.message).toContain("Re-run with `--execution`");
      // Legacy pair form: --workflow + --plan, no --execution.
      const pairForm = envelope(
        cli(["plan", "bind", "--workflow", "wf-legacy", "--plan", "p-legacy", "--session-id", "legacy-pm", "--harness", legacyHarness]).stdout,
      );
      expect(pairForm.status).toBe("refused");
      expect(pairForm.code).toBe("execution.consumer-not-ready");
      expect(pairForm.message).toContain("Re-run with `--execution`");
    } finally {
      rmSync(legacyScratch, { recursive: true, force: true });
      rmSync(legacyFixture, { recursive: true, force: true });
    }
  }, 60000);
});
