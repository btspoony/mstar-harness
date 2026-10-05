/**
 * help-disclosure.test.ts — #324 CLI-surface contract: the help an agent sees
 * must state where each execution input comes from. Asserted against the real
 * CLI help route (spawned the same way global-cli tests spawn it), so the
 * assertions hold against the rendered commander output, not source strings.
 *
 * Precondition: the engine/commands/cli dist bundles exist (`bun run
 * --cwd packages/cli build`) — the dev entry imports @mstar-harness/commands.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import path from "node:path";

const CLI_ENTRY = path.join(import.meta.dir, "index.ts");

type CliResult = { stdout: string; stderr: string };

function runHelp(args: readonly string[]): CliResult {
  const stdout = execFileSync(process.execPath, [CLI_ENTRY, ...args, "--help"], {
    env: { ...process.env, MSTAR_HARNESS_DIR: "" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { stdout, stderr: "" };
}

function optionHelp(help: string, flag: string): string {
  const lines = help.split("\n");
  const start = lines.findIndex((line) => line.trimStart().startsWith(flag));
  expect(start).toBeGreaterThanOrEqual(1);
  const text: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!;
    // A new option row starts at commander's 2-space option indent; wrapped
    // continuation lines are indented to the description column instead.
    if (index > start && /^ {2}--/.test(line)) break;
    if (index > start && !line.trimStart().startsWith(flag)) text.push(line.trim());
    else text.push(line.replace(new RegExp(`^\\s*${flag.replace(/[-[\]()/{}.*+?^$|\\]/g, "\\$&")}\\s*`), ""));
  }
  return text.join(" ").trim();
}

describe("#324 help disclosure", () => {
  test("status validate help discloses all three token JSON locations", () => {
    const { stdout } = runHelp(["status", "validate"]);
    expect(stdout).toContain("data.token");
    expect(stdout).toContain("data.workflows[].token");
    expect(stdout).toContain("data.authority.workflows[].planTokens[<planId>]");
  });

  test("workflow register names the root token source on --expect", () => {
    const { stdout } = runHelp(["workflow", "register"]);
    const help = optionHelp(stdout, "--expect <value>");
    expect(help).toContain("root execution token");
    expect(help).toContain("mstar status validate");
    expect(help).toContain("data.token");
  });

  test("iteration register names the root token source on --expect", () => {
    const { stdout } = runHelp(["iteration", "register"]);
    const help = optionHelp(stdout, "--expect <value>");
    expect(help).toContain("root execution token");
    expect(help).toContain("data.token");
  });

  test("workflow evidence names the workflow token source and the session-ref wire format", () => {
    const { stdout } = runHelp(["workflow", "evidence"]);
    const expectHelp = optionHelp(stdout, "--expect <value>");
    expect(expectHelp).toContain("workflow's execution token");
    expect(expectHelp).toContain("data.workflows[].token");
    const refHelp = optionHelp(stdout, "--session-ref <value>");
    expect(refHelp).toContain("exec-session-v1:");
    expect(refHelp).toContain("storeId, epoch, workflowId, role, sessionId, planId");
  });

  test("workflow lifecycle names the workflow token source on --expect", () => {
    const { stdout } = runHelp(["workflow", "lifecycle"]);
    const help = optionHelp(stdout, "--expect <value>");
    expect(help).toContain("workflow's execution token");
    expect(help).toContain("data.workflows[].token");
  });

  test("plan bind names both seat token kinds and the self-read fallback", () => {
    const { stdout } = runHelp(["plan", "bind"]);
    const help = optionHelp(stdout, "--expect <value>");
    expect(help).toContain("coordinator bind takes");
    expect(help).toContain("data.workflows[].token");
    expect(help).toContain("--plan bind takes");
    expect(help).toContain("data.authority.workflows[].planTokens[<planId>]");
    expect(help).toContain("read at bind time when omitted");
    expect(optionHelp(stdout, "--session-ref <value>")).toContain("exec-session-v1:");
  });

  test("plan prepare names the plan token source on --expect and --session-ref wire format", () => {
    const { stdout } = runHelp(["plan", "prepare"]);
    const expectHelp = optionHelp(stdout, "--expect <value>");
    expect(expectHelp).toContain("plan's execution token");
    expect(expectHelp).toContain("data.authority.workflows[].planTokens[<planId>]");
    expect(optionHelp(stdout, "--session-ref <value>")).toContain("exec-session-v1:");
  });
  test("plan prepare help labels the --expect token kind", () => {
    const help = optionHelp(runHelp(["plan", "prepare"]).stdout, "--expect <value>");
    expect(help).toContain("token kind: plan");
  });

  test("plan show discloses the session-ref wire format", () => {
    const { stdout } = runHelp(["plan", "show"]);
    expect(optionHelp(stdout, "--session-ref <value>")).toContain("exec-session-v1:");
  });

  test("status workflow-close names the workflow token source and the session-ref wire format", () => {
    const { stdout } = runHelp(["status", "workflow-close"]);
    const expectHelp = optionHelp(stdout, "--expect <token>");
    expect(expectHelp).toContain("workflow's execution token");
    expect(expectHelp).toContain("data.workflows[].token");
    const refHelp = optionHelp(stdout, "--session-ref <wire>");
    expect(refHelp).toContain("exec-session-v1:");
    expect(refHelp).toContain("plan bind --execution");
  });

  test("session recover names the required CAS token per recovery form", () => {
    const { stdout } = runHelp(["session", "recover"]);
    const help = optionHelp(stdout, "--expect <token>");
    expect(help).toContain("required");
    expect(help).toContain("coordinator recovery");
    expect(help).toContain("data.workflows[].token");
    expect(help).toContain("--plan");
    expect(help).toContain("data.authority.workflows[].planTokens[<planId>]");
  });
});
