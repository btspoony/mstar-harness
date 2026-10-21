import { describe, expect, test } from "bun:test";
import { getCommandDefinitions } from "./definitions.js";
import { coordinatorSeatCommandFor, foldedFamilyToolName, isCoordinatorSeatCommand } from "./coordinator-seat.js";

const seatIds = (): readonly string[] =>
  getCommandDefinitions().filter((definition) => isCoordinatorSeatCommand(definition.id)).map((definition) => definition.id);

describe("coordinator-seat derivation", () => {
  test("every covered id resolves back through its published family tool name", () => {
    const seat = getCommandDefinitions().filter((definition) => isCoordinatorSeatCommand(definition.id));
    expect(seat.length).toBeGreaterThan(0);
    for (const definition of seat) {
      const action = definition.id.slice(definition.id.indexOf(".") + 1);
      // The dsh host guard sees only the published name plus the action; this
      // is the one view both guards must agree on.
      expect(coordinatorSeatCommandFor(foldedFamilyToolName(definition.cli.path[0]!), action)).toBe(definition.id);
    }
  });

  test("covers the workflow family and every seat-establishing command", () => {
    const ids = seatIds();
    for (const definition of getCommandDefinitions().filter((entry) => entry.cli.path[0] === "workflow")) {
      expect(ids).toContain(definition.id);
    }
    for (const id of [
      "plan.bind",
      "plan.complete",
      "session.recover",
      "status.workflow-close",
      "workflow-note.append",
      "iteration.register",
    ]) {
      expect(ids).toContain(id);
    }
  });

  test("keeps the leaf's plan-row route and the child-identity launch reachable", () => {
    for (const id of [
      "plan.prepare",
      "plan.progress",
      "plan.show",
      "plan.issue-add",
      "plan.issue-close",
      "session.run",
      "workflow-note.coverage",
      "issue.add",
      "schema",
    ]) {
      expect(isCoordinatorSeatCommand(id)).toBe(false);
    }
  });

  test("answers undefined for an unknown tool, action or action type", () => {
    expect(coordinatorSeatCommandFor("mstar_workflow", "nope")).toBeUndefined();
    expect(coordinatorSeatCommandFor("mstar_nope", "append")).toBeUndefined();
    expect(coordinatorSeatCommandFor("mstar_plan", 7)).toBeUndefined();
  });
});
