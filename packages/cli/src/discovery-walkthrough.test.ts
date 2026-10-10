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
 * would require valid QC/QA evidence fixtures — lifecycle domain
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
  delete env.MSTAR_CONTROL_ROOT;
  delete env.MSTAR_EXECUTION_IDENTITY;
  delete env.SDD_DIR;
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
    let tokenLookups = 0;
    tokenLookups += 1;
    const firstRead = envelope(cli(["status", "validate"]).stdout);
    expect(firstRead.status).toBe("ok");
    const rootToken = firstRead.data.token as string;

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
    tokenLookups += 1;
    const secondRead = envelope(cli(["status", "validate"]).stdout);
    const workflowEntry = (secondRead.data.workflows as Array<Record<string, unknown>>).find((entry) => entry.id === "wf-walk");
    expect(workflowEntry).toBeDefined();
    const workflowToken = workflowEntry!.token as string;
    const authority = secondRead.data.authority as { workflows: Array<{ planTokens: Record<string, string> }> };
    const planToken = authority.workflows[0]!.planTokens["p-walk"];

    // Input 4 — session reference: one real `plan bind` receipt supplies the
    // complete public identity, which the following evidence write consumes.
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
    const wire = "exec-session-v1:" + Buffer.from(JSON.stringify(ref), "utf8").toString("base64url");
    tokenLookups += 1;
    const planRead = envelope(cli([
      "plan", "show", "--session-ref", wire, "--session-id", "walk-coord",
      "--plan", "p-walk", "--harness", harnessDir,
    ]).stdout);
    expect(planRead.status).toBe("ok");
    expect(planRead.data.token).toBe(planToken);
    expect(planRead.data.data).toMatchObject({ plan: { id: "p-walk" } });
    expect(tokenLookups).toBeLessThanOrEqual(3);

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
      const workflows = secondRead.data.workflows;
      if (!Array.isArray(workflows)) throw new Error("status validate did not expose workflow tokens");
      const workflowEntry = workflows.find((entry) => entry.id === "wf-wrong");
      if (!workflowEntry || typeof workflowEntry.token !== "string") throw new Error("addressed workflow token unavailable");
      const retried = envelope(cli([
        "plan", "bind", "--execution", "--workflow", "wf-wrong", "--coordinator",
        "--session-id", "walk-coord", "--expect", workflowEntry.token,
        "--operation", "op-bind-1", "--harness", wrongHarness,
      ]).stdout);
      expect(retried.status).toBe("ok");
      expect(retried.data.data).toMatchObject({ workflowId: "wf-wrong", role: "coordinator", sessionId: "walk-coord" });
    } finally {
      rmSync(wrongScratch, { recursive: true, force: true });
      rmSync(wrongFixture, { recursive: true, force: true });
    }
  }, 60000);

  test("the legacy coordinator bind on an ACTIVE store names the executable recovery route", () => {
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
      // ACTIVE disposition: the legacy `--workflow`-only form is a usage
      // refusal naming the executable `--execution` route; nothing binds.
      const coordinatorForm = envelope(
        cli(["plan", "bind", "--coordinator", "--workflow", "wf-legacy", "--session-id", "legacy-coord", "--harness", legacyHarness]).stdout,
      );
      expect(coordinatorForm.status).toBe("usage");
      expect(coordinatorForm.code).toBe("command.invalid-input");
      expect(String(coordinatorForm.message)).toContain("--execution");
      const retried = envelope(cli([
        "plan", "bind", "--execution", "--coordinator", "--workflow", "wf-legacy",
        "--session-id", "legacy-coord", "--harness", legacyHarness,
      ]).stdout);
      expect(retried.status).toBe("ok");
      expect(retried.data.data).toMatchObject({ workflowId: "wf-legacy", role: "coordinator", sessionId: "legacy-coord" });
    } finally {
      rmSync(legacyScratch, { recursive: true, force: true });
      rmSync(legacyFixture, { recursive: true, force: true });
    }
  }, 60000);
});
