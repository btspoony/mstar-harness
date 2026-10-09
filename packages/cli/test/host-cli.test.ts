/** Command-owned CLI subprocess coverage; fixture and assertion contracts are preserved. */
import { describe, expect, test } from "bun:test";
import { runCli } from "./harness";
import { cliEnvelope, expectUsageDiagnostic } from "./support/cli-assertions";

// ---------------------------------------------------------------------------
// mstar host detect
// ---------------------------------------------------------------------------

describe("mstar host detect — tool-shape host matrix", () => {
  const cases: { signals: string; host: string }[] = [
    { signals: "subagent_type", host: "cursor" },
    { signals: "question", host: "opencode" },
    { signals: "task_subagent", host: "opencode" },
    { signals: "task_agent_batch,ask,hub", host: "omp" },
    { signals: "Agent,AgentSwarm", host: "kimi" },
    { signals: "Agent,EnterPlanMode,TodoWrite", host: "zcode" },
    { signals: "plan_slash,goal", host: "codex" },
  ];
  for (const { signals, host } of cases) {
    test(`${signals} → ${host}, exit 0`, () => {
      const result = runCli(["host", "detect", "--signals", signals]);
      expect(result.exitCode).toBe(0);
      expect(cliEnvelope(result).data?.host).toBe(host);
    });
  }

  test("unknown signal token → usage, exit 2", () => {
    const result = runCli(["host", "detect", "--signals", "question,nope"]);
    expect(result.exitCode).toBe(2);
    expect(cliEnvelope(result).message).toBe('unknown signal "nope"');
  });

  test("empty --signals → usage, exit 2", () => {
    const result = runCli(["host", "detect", "--signals", ""]);
    expect(result.exitCode).toBe(2);
    expect(cliEnvelope(result).message).toBe("Rejected --signals: expected string >= 1; received ");
  });

  test("missing --signals → usage, exit 2", () => {
    const result = runCli(["host", "detect"]);
    expect(result.exitCode).toBe(2);
    expectUsageDiagnostic(result, "signals");
  });
});

// ---------------------------------------------------------------------------
// mstar host skill-root — per-host resolution matrix (audit-004)
// ---------------------------------------------------------------------------

describe("mstar host skill-root — loaded skill-root resolution (audit-004)", () => {
  test("opencode resolves to the package-internal harness-skills mount (exit 0)", () => {
    const result = runCli(["host", "skill-root", "--host", "opencode", "--skill", "mstar-roles"]);
    expect(result.exitCode).toBe(0);
    expect(cliEnvelope(result, "ok", "host.skill-root.ok").data?.root).toBe("harness-skills/mstar-roles");
  });

  test("cursor resolves with a skill-relative path suffix (exit 0)", () => {
    const result = runCli([
      "host",
      "skill-root",
      "--host",
      "cursor",
      "--skill",
      "mstar-roles",
      "--rel",
      "references/opencode.md",
    ]);
    expect(result.exitCode).toBe(0);
    expect(cliEnvelope(result, "ok", "host.skill-root.ok").data?.root).toContain("references/opencode.md");
  });

  test("omp resolves to the skill:// URI form (exit 0)", () => {
    const result = runCli(["host", "skill-root", "--host", "omp", "--skill", "mstar-roles"]);
    expect(result.exitCode).toBe(0);
    expect(cliEnvelope(result, "ok", "host.skill-root.ok").data?.root).toBe("skill://mstar-roles");
  });

  test("pi prints the deferred-resolution notice shape (exit 0)", () => {
    const result = runCli(["host", "skill-root", "--host", "pi", "--skill", "mstar-roles"]);
    expect(result.exitCode).toBe(0);
    expect(cliEnvelope(result, "ok", "host.skill-root.ok").data?.root).toContain("deferred: pi has no plugin API in v1");
  });

  test("dsh resolves to the bundled skill dir form (exit 0)", () => {
    const result = runCli(["host", "skill-root", "--host", "dsh", "--skill", "mstar-roles"]);
    expect(result.exitCode).toBe(0);
    expect(cliEnvelope(result, "ok", "host.skill-root.ok").data?.root).toBe("$DSH_BUNDLED_SKILL_DIR/mstar-roles");
  });

  test("empty --skill value is a usage error (exit 2)", () => {
    const result = runCli(["host", "skill-root", "--host", "opencode", "--skill="]);
    expect(result.exitCode).toBe(2);
    expect(cliEnvelope(result, "usage", "command.invalid-input").message).toBe("Rejected --skill: expected string >= 1; received ");
  });

  test("unknown host is a usage error (exit 2)", () => {
    const result = runCli(["host", "skill-root", "--host", "bogus", "--skill", "mstar-roles"]);
    expect(result.exitCode).toBe(2);
    expect(cliEnvelope(result, "usage", "command.invalid-input").message).toContain('unknown host "bogus"');
  });
});
