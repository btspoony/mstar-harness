/** Command-owned CLI coverage for store-level commands, which are CLI-only. */
import { describe, expect, test } from "bun:test";
import { runCli } from "./harness";

describe("store-level commands stay on the CLI", () => {
  test("store execution export advertises its required target and refuses an omitted one", () => {
    // The MCP retirement removed the tool, not the command: its CLI contract is
    // still enforced by the handler and must keep a regression.
    const help = runCli(["store", "execution", "export", "--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Required inputs: harness");

    const call = runCli(["store", "execution", "export"]);
    expect(call.exitCode).toBe(2);
    expect(call.stdout).toContain('"message":"harness is required"');
    expect(call.stdout).toContain('"required":["harness"]');
  });
});

describe("store-level discovery", () => {
  test("family discovery marks every store member CLI-only", () => {
    // An agent that lists the family must learn the tool does not exist, not
    // call a missing tool and guess.
    const result = runCli(["schema", "--family", "store"]);
    expect(result.exitCode).toBe(0);
    const members = (JSON.parse(result.stdout) as { data: { members: Array<{ id: string; transport?: string }> } })
      .data.members;
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((member) => member.transport === "cli")).toBe(true);
    expect(members.some((member) => member.id === "store.execution.export")).toBe(true);
  });
});

describe("store-level leaf discovery", () => {
  test("a store command's leaf descriptor is marked CLI-only, a runtime one is not", () => {
    const store = runCli(["schema", "--command", "store.execution.export"]);
    expect(store.exitCode).toBe(0);
    expect((JSON.parse(store.stdout) as { data: { transport?: string } }).data.transport).toBe("cli");

    const runtime = runCli(["schema", "--command", "plan.progress"]);
    expect(runtime.exitCode).toBe(0);
    expect((JSON.parse(runtime.stdout) as { data: { transport?: string } }).data.transport).toBeUndefined();
  });
});
