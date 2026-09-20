import { expect, test } from "bun:test";
import { formatNotice, statusNotice, fallbackNotice, PHASE2_NOTICE_CUSTOM_TYPE, HANDOFF_NOTICE_CUSTOM_TYPE } from "../src/notices";

test("statusNotice names the workflow and its actual status", () => {
  const n = statusNotice({ workflowId: "iter-x", status: "completed", detail: "observation stopped" });
  expect(n.title).toContain("iter-x");
  expect(n.title).toContain("completed");
  expect(n.title).not.toContain("Phase-2");
  expect(formatNotice(n)).toBe(`${n.title}: observation stopped`);
});

test("fallbackNotice never asserts a workflow status", () => {
  const n = fallbackNotice({ subject: "model handoff", detail: "navigation refused" });
  expect(n.title).not.toContain("Phase-2");
  expect(n.title).not.toMatch(/\b(completed|failed|stopped|running)\b/);
});

test("visible custom types are the shared bar titles", () => {
  expect(PHASE2_NOTICE_CUSTOM_TYPE).toBe("mstar:notice");
  expect(HANDOFF_NOTICE_CUSTOM_TYPE).toBe("mstar:notice");
});

test("a detail restating the title's own status sentence is rendered once", () => {
  // `phase2.workflow-terminal` observes exactly the sentence the title already
  // states, so the body must not repeat it.
  const terminal = statusNotice({
    workflowId: "iter-x",
    status: "completed",
    detail: "workflow iter-x is completed (phase2.workflow-terminal)",
  });
  expect(formatNotice(terminal)).toBe("Workflow iter-x is completed (phase2.workflow-terminal)");

  // Every other detail keeps the shared `<title>: <detail>` shape.
  const drift = statusNotice({
    workflowId: "iter-x",
    status: "running",
    detail: "workflow iter-x is bound elsewhere (phase2.ownership-drift)",
  });
  expect(formatNotice(drift)).toBe(
    "Workflow iter-x is running: workflow iter-x is bound elsewhere (phase2.ownership-drift)",
  );
});
