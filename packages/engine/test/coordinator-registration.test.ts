import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPendingCatalogRegistrations } from "../src/catalog-registration.js";
import { registerShippedCatalogExecution } from "../src/execution-registration.js";
import { readExecutionState, type ExecutionContext } from "../src/execution-store.js";
import { initializeStore, type StoreContext } from "../src/store-db.js";

const root = mkdtempSync(join(tmpdir(), "mstar-coordinator-registration-"));

async function fixture(name: string): Promise<{ harnessDir: string; context: StoreContext; planId: string; execution: ExecutionContext }> {
  const harnessDir = mkdtempSync(join(root, name));
  mkdirSync(join(harnessDir, ".mstar"), { recursive: true });
  const context: StoreContext = { harnessDir };
  (await initializeStore(context)).close();
  const planId = "fixture-plan";
  mkdirSync(join(harnessDir, "plans"), { recursive: true });
  writeFileSync(join(harnessDir, "plans", `${planId}.md`), `# Fixture plan\n\n**plan_id:** ${planId}\n`);
  return {
    harnessDir,
    context,
    planId,
    execution: {
      harnessDir,
      caller: { sessionId: "session-fixture", role: "coordinator", workflowId: "wf-coordinator" },
    },
  };
}

/**
 * The registration input the single ACTIVE seam accepts: the workflow identity,
 * not the retired journaled FILE-form request. `registerShippedCatalogExecution`
 * derives the root creation token and the catalog revision internally and
 * commits through `commitExecutionRegistration`, so the fixture no longer
 * plants a status.json/snapshot write.
 */
function workflowInput(harnessDir: string, planId: string) {
  return {
    kind: "plan" as const,
    workflowId: "wf-coordinator",
    options: {
      harnessDir,
      plan: { id: planId, title: "Fixture plan", file: `plans/${planId}.md` },
      deliveryKind: "development" as const,
      branchSource: "feature/fixture",
      branchTarget: "main",
      project: "harness",
      startedAt: "2026-09-18T00:00:00.000Z",
    },
  };
}

describe("coordinator-bound catalog registration (ACTIVE seam)", () => {
  test("commits the registration through the single ACTIVE transaction", async () => {
    const { harnessDir, context, planId, execution } = await fixture("commit-");
    const receipt = await registerShippedCatalogExecution(execution, {
      actor: "project-manager",
      workflow: workflowInput(harnessDir, planId),
      operationId: "op-coordinator",
      expectedCatalogRevision: 0,
    });

    expect(receipt).toMatchObject({ operationId: "op-coordinator", workflowId: "wf-coordinator", catalogRevision: 1 });
    // The committed registration is readable from the ACTIVE authority, and no
    // legacy journal row is left pending.
    const state = await readExecutionState(context);
    expect(state.data.workflows.map((entry) => entry.state.id)).toEqual(["wf-coordinator"]);
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
    // The retired file registration route wrote status.json / snapshot.json:
    // neither exists after a DB-only registration.
    expect(existsSync(join(harnessDir, "status.json"))).toBe(false);
    expect(existsSync(join(harnessDir, "workflows", "wf-coordinator"))).toBe(false);
  });

  test("replays the same operation idempotently after ordinary progress", async () => {
    const { harnessDir, context, planId, execution } = await fixture("progress-");
    const input = {
      actor: "project-manager",
      workflow: workflowInput(harnessDir, planId),
      operationId: "op-coordinator-progress",
      expectedCatalogRevision: 0,
    };
    await registerShippedCatalogExecution(execution, input);

    // A second identical request replays through `readOperationReplay` instead
    // of committing twice.
    await expect(registerShippedCatalogExecution(execution, input)).resolves.toMatchObject({
      operationId: "op-coordinator-progress",
      workflowId: "wf-coordinator",
    });
    const state = await readExecutionState(context);
    expect(state.data.workflows).toHaveLength(1);
    expect(await listPendingCatalogRegistrations(context)).toEqual([]);
  });
});

afterAll(() => { rmSync(root, { recursive: true, force: true }); });
