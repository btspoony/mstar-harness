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

test("custom types keep their literals", () => {
  expect(PHASE2_NOTICE_CUSTOM_TYPE).toBe("mstar:phase2-notice");
  expect(HANDOFF_NOTICE_CUSTOM_TYPE).toBe("mstar:model-handoff-notice");
});
