import { describe, expect, test } from "bun:test";
import { executeCommand } from "../src/definitions.js";
import { failure as auditFailure } from "../src/families/audit.js";
import { failure as dashboardFailure } from "../src/families/dashboard.js";
import { failure as milestoneFailure } from "../src/families/milestone.js";
import { failure as prReviewFailure } from "../src/families/pr-review.js";
import type { InvocationContext } from "../src/types.js";

/**
 * B1 error-fidelity contract. A typed engine error carries machine facts in
 * `code`, `details` and (`details.recovery`) the caller must see verbatim; each
 * confirmed drop site is pinned here on the MECHANISM (which values travel),
 * not just the exit code, so a future regression that re-simplifies one of them
 * to a message-only wrapper fails.
 */
const ENGINE_MESSAGE = "engine refused this exact operation";
const ENGINE_DETAILS = { workflow_id: "wf-1", path: "expect", current_facts: ["at revision 9"] };

function engineError(code: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(ENGINE_MESSAGE), details === undefined ? { code } : { code, details });
}

describe("B1 confirmed error-fidelity sites", () => {
  test("pr-review drops neither code, details nor recovery; an untyped error stays its own failed envelope", () => {
    const typed = prReviewFailure("pr-review.post", engineError("pr-review.post.unauthorized", ENGINE_DETAILS));
    expect(typed).toMatchObject({ status: "refused", code: "pr-review.post.unauthorized", exitCode: 1 });
    expect(typed.message.split("\n", 1)[0]).toBe(ENGINE_MESSAGE);
    expect(typed.details).toMatchObject(ENGINE_DETAILS);
    expect(typed.details).toHaveProperty("helpRoute");

    // An untyped internal failure keeps the family's own `error` outcome (the
    // documented contract), not a fabricated engine refusal.
    const untyped = prReviewFailure("pr-review.tally", new Error("malformed findings JSON"));
    expect(untyped).toMatchObject({ status: "error", code: "pr-review.tally.failed", exitCode: 1 });
  });

  test("milestone preserves the engine code, message and details alongside its own operation fact", () => {
    const result = milestoneFailure("milestone.update", engineError("milestone.revision-conflict", { expectedStoreRevision: 4 }));
    expect(result).toMatchObject({ status: "refused", code: "milestone.revision-conflict", exitCode: 1 });
    expect(result.message.split("\n", 1)[0]).toBe(ENGINE_MESSAGE);
    expect(result.details).toMatchObject({ operation: "milestone.update", expectedStoreRevision: 4 });
  });

  test("dashboard preserves engine details and a top-level recovery without dropping its operation fact", () => {
    const result = dashboardFailure("dashboard.start-failed", engineError("dashboard.start-failed", { port: 4000 }));
    expect(result).toMatchObject({ status: "refused", code: "dashboard.start-failed", exitCode: 1 });
    expect(result.message.split("\n", 1)[0]).toBe(ENGINE_MESSAGE);
    expect(result.details).toMatchObject({ operation: "dashboard", port: 4000 });
  });

  test("audit carries the engine code, details and message through unchanged", () => {
    const result = auditFailure("audit.promote", engineError("catalog.registration-conflict", { workflow_id: "wf-2" }));
    expect(result).toMatchObject({ status: "refused", code: "catalog.registration-conflict", exitCode: 1 });
    expect(result.message.split("\n", 1)[0]).toBe(ENGINE_MESSAGE);
    expect(result.details).toMatchObject({ workflow_id: "wf-2" });
  });

  test("session.recover reports every absent field at once, each with its own path diagnostic", async () => {
    const context: InvocationContext = {
      cwd: process.cwd(),
      controlRoot: null,
      versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
      signal: new AbortController().signal,
      effects: {
        async readInput() { return ""; },
        async spawn() { throw new Error("session.recover must not spawn a process"); },
        async startDashboard() { throw new Error("dashboard is unavailable in this test"); },
        async openBrowser() { throw new Error("browser is unavailable in this test"); },
      },
    };
    // Only `workflow` is supplied: every conditionally/absolutely required field
    // is absent, and ONE refusal must name each — never one field per call.
    const result = await executeCommand("session.recover", { workflow: "wf-recover" }, context);
    expect(result).toMatchObject({ status: "usage", code: "command.invalid-input", exitCode: 2 });
    const diagnostics = result.details?.diagnostics;
    if (!Array.isArray(diagnostics)) throw new Error("the aggregated refusal must carry structured diagnostics");
    const paths = diagnostics.map((entry) => (entry as { path?: string }).path);
    for (const path of ["priorSession or unowned (exactly one)", "reason", "attestation", "expect", "operation"]) {
      expect(paths).toContain(path);
    }
  });
});
