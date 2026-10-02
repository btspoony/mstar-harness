import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCommandDefinitions } from "../src/index.js";
import type { CommandEffects, InvocationContext } from "../src/types.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function context(sessionId?: string): InvocationContext {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "workflow-register-refusal-"));
  roots.push(cwd);
  const effects: CommandEffects = {
    async readInput() { return ""; },
    async spawn() { throw new Error("not used"); },
    async startDashboard() { throw new Error("not used"); },
    async openBrowser() { throw new Error("not used"); },
  };
  return { cwd, controlRoot: null, versions: { engine: null, cli: null, plugin: null, host: null, platform: null }, signal: new AbortController().signal, effects, ...(sessionId === undefined ? {} : { sessionId }) };
}

function definition(id: string) {
  const found = getCommandDefinitions().find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing command definition: ${id}`);
  return found;
}

function input(id: string, harness: string, present: readonly string[]) {
  const fields: Record<string, unknown> = {};
  if (id === "workflow.register") Object.assign(fields, { workflow: "wf-test", planId: "plan-test", planTitle: "Test", planFile: "plans/plan-test.md", deliveryKind: "development" });
  if (id === "workflow.evidence") {
    const file = path.join(harness, "evidence.json");
    writeFileSync(file, "{}");
    Object.assign(fields, { workflow: "wf-test", file });
  }
  if (id === "iteration.register") Object.assign(fields, { workflow: "wf-test", compassRef: "compass.md", branchBase: "main", branchIntegration: "integration", branchTargetIteration: "main", row: [JSON.stringify({ id: "plan-test" })] });
  Object.assign(fields, { harness });
  for (const field of present) fields[field] = field === "sessionRef" ? "invalid-ref" : `${field}-value`;
  return fields;
}

const routes = [
  { id: "workflow.register", missing: ["session identity", "expect", "operation"], fields: ["expect", "operation"] },
  { id: "workflow.evidence", missing: ["session identity", "sessionRef", "expect", "operation"], fields: ["sessionRef", "expect", "operation"] },
  { id: "iteration.register", missing: ["session identity", "expect", "operation"], fields: ["expect", "operation"] },
];

async function refuse(id: string, fields: string[], identity = true) {
  const ctx = context(identity ? "main-session" : undefined);
  return definition(id).execute(input(id, ctx.cwd, fields), ctx);
}

describe("active registration refusal diagnostics", () => {
  for (const route of routes) {
    for (const field of route.missing) {
      test(`${route.id} identifies missing ${field}`, async () => {
        const missingIdentity = field === "session identity";
        const provided = route.fields.filter((candidate) => missingIdentity || candidate !== field);
        const result = await refuse(route.id, provided, !missingIdentity);
        expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
        if (result.status !== "usage") throw new Error("expected usage refusal");
        expect(result.message).toContain(field);
        for (const other of route.missing) {
          expect(result.message.includes(`missing ${other}`)).toBe(other === field);
        }
        expect(result.message).toContain("CLI");
        expect(result.message).toContain("--session-id");
        expect(result.message).toContain("MSTAR_HOST_SESSION_ID");
        expect(result.message).toContain("MCP");
        expect(result.message).toContain("sessionId");
        expect(result.message).toContain("status validate");
        expect(result.message).toContain("replay id");
      });
    }
  }

  test("several missing fields are reported together and session.run child semantics are explained", async () => {
    const result = await refuse("workflow.register", ["operation"], false);
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (result.status !== "usage") throw new Error("expected usage refusal");
    expect(result.status === "usage" ? result.message : "").toContain("Active registration is missing session identity, expect.");
    expect(result.status === "usage" ? result.message : "").not.toContain("missing operation");
    expect(result.status === "usage" ? result.message : "").toContain("minted local identity");
    expect(result.status === "usage" ? result.message : "").toContain("main session");
    expect(result.status === "usage" ? result.message : "").toContain("--session-id");
    const evidence = await refuse("workflow.evidence", ["sessionRef"], false);
    expect(evidence.status === "usage" ? evidence.message : "").toContain("session.run child carries a minted local identity");
    expect(evidence.status === "usage" ? evidence.message : "").toContain("main session or pass an explicit --session-id");
  });
});
