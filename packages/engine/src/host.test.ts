/**
 * host.test.ts — proof for capability-based dsh detection.
 *
 * A live dsh session exposes a delegation channel chosen by its profile: the
 * `subagent` tool, or the Agent Teams tools `spawn_teammate` /
 * `team_task_create` (`@deepseek-ai/dsh-experimental-tool-agent-team`). Any
 * one of them must resolve to `dsh`, while the ordered rows other hosts own
 * keep winning ahead of it.
 */
import { describe, expect, test } from "bun:test";
import { detectHost } from "./host.js";

describe("detectHost — every dsh delegation token resolves to dsh", () => {
  for (const signal of ["subagent", "spawn_teammate", "team_task_create"] as const) {
    test(`${signal} → dsh`, () => {
      expect(detectHost([signal])).toBe("dsh");
    });
  }

  test("a subagent + team task-board token pair → dsh", () => {
    expect(detectHost(["subagent", "team_task_create"])).toBe("dsh");
  });
});

describe("detectHost — the other rows keep their order", () => {
  test("question alone → opencode", () => {
    expect(detectHost(["question"])).toBe("opencode");
  });

  test("subagent_type wins over a dsh token (cursor row stays first)", () => {
    expect(detectHost(["subagent_type", "spawn_teammate"])).toBe("cursor");
  });
});
