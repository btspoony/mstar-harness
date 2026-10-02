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
  { id: "workflow.register", fields: ["expect", "operation"], labels: ["session identity", "expect", "operation"] },
  { id: "workflow.evidence", fields: ["sessionRef", "expect", "operation"], labels: ["session identity", "sessionRef", "expect", "operation"] },
  { id: "iteration.register", fields: ["expect", "operation"], labels: ["session identity", "expect", "operation"] },
];

function missingDiagnosticSet(message: string): Set<string> {
  const prefix = "Active registration is missing ";
  const end = message.indexOf(". CLI:");
  if (!message.startsWith(prefix) || end < 0) throw new Error(`missing diagnostic section: ${message}`);
  return new Set(message.slice(prefix.length, end).split(", "));
}

function missingCombinations(labels: readonly string[], activeFields: readonly string[]) {
  return Array.from({ length: 2 ** labels.length }, (_, mask) => {
    const missing = labels.filter((_, index) => (mask & (1 << index)) !== 0);
    const present = labels.filter((label) => !missing.includes(label));
    return { missing, present };
  }).filter(({ missing, present }) => missing.length > 0 && activeFields.some((field) => present.includes(field)));
}

async function refuse(id: string, fields: string[], identity = true) {
  const ctx = context(identity ? "main-session" : undefined);
  return definition(id).execute(input(id, ctx.cwd, fields), ctx);
}

describe("active registration refusal diagnostics", () => {
  for (const route of routes) {
    const combinations = missingCombinations(route.labels, route.fields);
    for (const { missing, present } of combinations) {
      const hasIdentity = !missing.includes("session identity");
      const presentArguments = present.filter((field) => field !== "session identity");
      test(`${route.id} aggregates missing fields: ${missing.join(" + ")}`, async () => {
        const result = await refuse(route.id, presentArguments, hasIdentity);
        expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
        if (result.status !== "usage") throw new Error("expected usage refusal");
        expect(missingDiagnosticSet(result.message)).toEqual(new Set(missing));
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

  test("no-identity refusals explain session.run child semantics for register and evidence", async () => {
    const register = await refuse("workflow.register", ["operation"], false);
    expect(register).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (register.status !== "usage") throw new Error("expected usage refusal");
    expect(register.message).toContain("session.run child carries a minted local identity");
    expect(register.message).toContain("main session or pass an explicit --session-id");

    const evidence = await refuse("workflow.evidence", ["sessionRef"], false);
    expect(evidence).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    if (evidence.status !== "usage") throw new Error("expected usage refusal");
    expect(evidence.message).toContain("session.run child carries a minted local identity");
    expect(evidence.message).toContain("main session or pass an explicit --session-id");
  });
});
