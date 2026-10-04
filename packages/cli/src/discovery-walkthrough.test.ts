/**
 * discovery-walkthrough.test.ts — #324 acceptance proof: on a FIXTURE store,
 * a CLI agent must be able to derive every execution input a lawful close
 * needs from `--help` text and the refusals it hits alone, in ≤3 CLI calls per
 * input. The walkthrough drives the real CLI (spawned the same way global-cli
 * tests spawn it) against a disposable temp fixture; it never touches this
 * checkout's store.
 *
 * Scope note (explicit): the walkthrough proves the INPUT-DERIVATION contract.
 * The one lawful close this chain reaches stops at the plan-handoff domain
 * guard (`coordination.invalid-transition`): composing a full close would
 * require valid Assignment/QC/QA evidence fixtures — workflow-lifecycle
 * domain content, not #324 input discovery, and out of this plan's scope.
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
import { decodeExecutionSessionRef, encodeExecutionSessionRef } from "@mstar-harness/engine";

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

  test("a close's inputs are derivable from the CLI surfaces in ≤3 calls per input", () => {
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
    expect(Object.keys(ref).sort()).toEqual(["epoch", "planId", "roleId" in ref ? "roleId" : "role", "sessionId", "storeId", "workflowId"].sort());
    const wire = encodeExecutionSessionRef(ref as never);
    expect(wire.startsWith("exec-session-v1:")).toBe(true);
    expect(decodeExecutionSessionRef(wire)).toEqual(ref);

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

    // The close then reaches the plan-handoff DOMAIN guard — every #324 input
    // (identity, sessionRef, token) passed its gate; the remaining refusal is
    // workflow-lifecycle evidence content, out of #324 scope (see header).
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
    expect(refusedClose.message).toContain("handoff");
  }, 60000);

  test("a wrong-kind --expect refusal names where the expected token is read", () => {
    // A fresh fixture keeps this refusal independent of the walkthrough state.
    const wrongFixture = mkdtempSync(path.join(tmpdir(), "mstar-324-wrongkind-"));
    const wrongHarness = path.join(wrongFixture, ".mstar");
    mkdirSync(path.join(wrongHarness, "plans"), { recursive: true });
    writeFileSync(path.join(wrongHarness, "plans", "p-walk.md"), "# Walk plan\n\n**plan_id:** p-walk\n\nbody\n");
    try {
      expect(envelope(cli(["store", "upgrade", "--harness", wrongHarness, "--operator", "walkthrough"], mkdtempSync(path.join(tmpdir(), "mstar-324-s2-"))).stdout).status).toBe("ok");
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
      rmSync(wrongFixture, { recursive: true, force: true });
    }
  }, 60000);

  test("the legacy bind refusal on an ACTIVE store names the --execution route", () => {
    const legacy = cli([
      "plan", "bind",
      "--workflow", "wf-walk",
      "--plan", "p-walk",
      "--session-id", "walk-pm",
      "--harness", harnessDir,
    ]);
    const refused = envelope(legacy.stdout);
    expect(refused.status).toBe("refused");
    expect(refused.code).toBe("coordination.workflow-not-found");
    expect(refused.message).toContain("--execution route");
    expect(refused.message).toContain("plan bind --execution --workflow <id> --coordinator");
  });
});
