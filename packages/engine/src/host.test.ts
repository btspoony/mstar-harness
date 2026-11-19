/**
 * host.test.ts — proof for capability-based dsh detection.
 *
 * A live dsh session exposes a delegation channel chosen by its profile: the
 * `subagent` tool, or the Agent Teams tool `team_task_create`
 * (`@deepseek-ai/dsh-experimental-tool-agent-team`). Any one of them must
 * resolve to `dsh`, while the ordered rows other hosts own keep winning
 * ahead of it.
 */
import { describe, expect, test } from "bun:test";
import { detectHost, resolveSkillRoot } from "./host.js";

describe("Devin host capabilities", () => {
  for (const signal of ["run_subagent", "read_subagent", "message_user", "devin_*"] as const) {
    test(`${signal} identifies Devin before generic namespace signals`, () => {
      expect(detectHost([signal])).toBe("devin");
      expect(detectHost([signal, "functions.*", "tool_search"])).toBe("devin");
    });
  }

  test("empty and unknown signals remain ambiguous", () => {
    expect(detectHost([])).toBe("ambiguous");
    expect(detectHost(["unknown" as never])).toBe("ambiguous");
  });

  test("skill roots follow the installed plugin mount with optional relative paths", async () => {
    const manifest = await Bun.file(new URL("../../../.devin-plugin/plugin.json", import.meta.url)).json();
    const skill = "sample-skill";
    const base = `${manifest.skills}${skill}`;
    expect(resolveSkillRoot("devin", { skill })).toBe(base);
    expect(resolveSkillRoot("devin", { skill, rel: "" })).toBe(base);
    expect(resolveSkillRoot("devin", { skill, rel: "references/example.md" })).toBe(`${base}/references/example.md`);
  });
});

describe("detectHost -- every dsh delegation token resolves to dsh", () => {
  for (const signal of ["subagent", "team_task_create"] as const) {
    test(`${signal} -> dsh`, () => {
      expect(detectHost([signal])).toBe("dsh");
    });
  }

  test("a subagent + team task-board token pair -> dsh", () => {
    expect(detectHost(["subagent", "team_task_create"])).toBe("dsh");
  });
});

describe("detectHost -- the other rows keep their order", () => {
  test("question alone -> opencode", () => {
    expect(detectHost(["question"])).toBe("opencode");
  });

  test("subagent_type wins over a dsh token (cursor row stays first)", () => {
    expect(detectHost(["subagent_type", "team_task_create"])).toBe("cursor");
  });
});
