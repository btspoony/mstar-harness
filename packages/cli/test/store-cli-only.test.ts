/** Command-owned CLI coverage for store-level commands, which are CLI-only. */
import { describe, expect, test } from "bun:test";
import { runCli } from "./harness";

/**
 * Each verb keeps its OWN option list (`optionsByVerb`), so a dropped `harness`
 * entry would remove the field from that verb's help and descriptor while the
 * handler still refuses the call: a command that advertises an optional target
 * it cannot run without. Every list is asserted, not one shared construction.
 */
describe("store-level commands stay on the CLI", () => {
  for (const verb of ["export", "restore", "restore-preview"] as const) {
    test(`store execution ${verb} advertises its required target and refuses an omitted one`, () => {
      const help = runCli(["store", "execution", verb, "--help"]);
      expect([verb, help.exitCode]).toEqual([verb, 0]);
      expect(help.stdout).toContain("Required inputs: harness");

      // The published contract, not only the help prose: a regression that
      // drops `harness` from this verb's option list must fail here.
      const descriptor = runCli(["schema", "--command", `store.execution.${verb}`]);
      expect(descriptor.exitCode).toBe(0);
      const published = (JSON.parse(descriptor.stdout) as { data: { descriptor: { input: { required?: string[] } } } })
        .data.descriptor.input.required;
      expect([verb, published]).toEqual([verb, ["harness"]]);

      const call = runCli(["store", "execution", verb]);
      expect([verb, call.exitCode]).toEqual([verb, 2]);
      expect(call.stdout).toContain('"message":"harness is required"');
      expect(call.stdout).toContain('"required":["harness"]');
    });
  }
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
