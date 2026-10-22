import { describe, expect, test } from "bun:test";
import { redactSessionIds, REDACTED_SESSION_ID } from "./session-redaction.js";

/**
 * One fixture per authority shape that carries a session id, each under its own
 * name: a coordinator ref, a plan's coordination block (prepared/completed),
 * an identity recovery, and a terminal adoption. A redaction that only knows
 * the `coordinator` key passes the first block and fails the other three, which
 * is exactly the regression this pins.
 */
describe("redactSessionIds", () => {
  test("rewrites every session-id field family and keeps the surrounding facts", () => {
    const payload = {
      workflows: [{
        state: { id: "wf-1" },
        coordinator: { role: "coordinator", epoch: 3, sessionId: "live-coordinator" },
        plans: [{
          id: "plan-1",
          coordination: {
            revision: 7,
            prepared: { prepared_by: "live-preparer", at: "2026-01-01" },
            progress: { completed_by: "live-completer" },
            identity_recoveries: [{
              session_id: "live-recovery",
              prior_session_id: "live-prior",
              stopped_session_ids: ["live-stopped-a", "live-stopped-b"],
            }],
          },
        }],
      }],
      terminalAdoptions: [{ actor_session_id: "live-actor", status: "completed" }],
      integrationLease: { holder: "live-lease-holder", branch: "feature/x" },
    };

    const out = JSON.stringify(redactSessionIds(payload));

    for (const id of [
      "live-coordinator",
      "live-preparer",
      "live-completer",
      "live-recovery",
      "live-prior",
      "live-stopped-a",
      "live-stopped-b",
      "live-actor",
      "live-lease-holder",
    ]) {
      expect(out).not.toContain(id);
    }
    // The non-identity facts a reader relies on survive.
    expect(out).toContain('"role":"coordinator"');
    expect(out).toContain('"epoch":3');
    expect(out).toContain('"revision":7');
    expect(out).toContain('"status":"completed"');
    expect(out.split(REDACTED_SESSION_ID).length - 1).toBe(9);
  });

  test("leaves blank and non-string values untouched", () => {
    expect(redactSessionIds({ sessionId: "", prepared_by: null, session_id: 42 })).toEqual({
      sessionId: "",
      prepared_by: null,
      session_id: 42,
    });
  });

  test("does not mutate the input payload", () => {
    const input = { coordinator: { sessionId: "live" } };
    redactSessionIds(input);
    expect(input.coordinator.sessionId).toBe("live");
  });
});
