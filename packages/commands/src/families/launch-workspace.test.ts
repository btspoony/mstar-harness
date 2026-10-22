/**
 * The shared launch-directory rule, unit-pinned.
 *
 * `launch-workspace.ts` is the one place a command family asks "would this input
 * come from the MCP server's LAUNCH directory?" — a directory that is the HOST's
 * checkout and says nothing about the caller's workspace. The whole-tool suites
 * reach its branches only through a full tool call, so the rule's own edges are
 * pinned here: an omitted path, a relative one, the `optional` (derived)
 * omission, the subject form, and the multi-field refusal that reports every
 * offending input at once.
 */
import { describe, expect, test } from "bun:test";
import { launchDirectoryDiagnostics, launchDirectoryRefusal, type LaunchDirectoryField } from "./launch-workspace.js";
import type { RefusalDiagnostic } from "../envelope.js";
import type { CommandEnvelope, InvocationContext } from "../types.js";

/** The launch-directory fact is the only context field these helpers read. */
function context(launchDirectory: true | undefined): InvocationContext {
  return {
    cwd: "/launch/directory",
    controlRoot: null,
    ...(launchDirectory === true ? { launchDirectory: true as const } : {}),
    versions: { engine: null, cli: "test", plugin: null, host: null, platform: "test" },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { throw new Error("unused"); },
      async startDashboard() { throw new Error("unused"); },
      async openBrowser() { throw new Error("unused"); },
    },
  };
}

/** The envelope facts these helpers emit: a usage refusal, narrowed once here. */
type UsageRefusal = Readonly<{
  status: "usage";
  code: string;
  exitCode: 2;
  message: string;
  details: Readonly<{ diagnostics?: readonly RefusalDiagnostic[]; recovery?: string }>;
}>;

function usageRefusal(envelope: CommandEnvelope<never> | undefined): UsageRefusal {
  if (envelope === undefined || envelope.status !== "usage") {
    throw new Error(`expected a usage refusal, got ${JSON.stringify(envelope)}`);
  }
  return envelope as UsageRefusal;
}

function field(overrides: Partial<LaunchDirectoryField> = {}): LaunchDirectoryField {
  return { field: "worktreePath", subject: "the plan's worktree", value: undefined, ...overrides };
}

describe("launchDirectoryRefusal", () => {
  test("does not refuse an invocation whose workspace was named", () => {
    expect(launchDirectoryRefusal("plan.execute", context(undefined), { fields: [field()] })).toBeUndefined();
    expect(launchDirectoryRefusal("doctor", context(undefined), { subject: "this checkout" })).toBeUndefined();
  });

  test("refuses an omitted path input and names the cause, the field and the recoveries", () => {
    const refused = usageRefusal(launchDirectoryRefusal("plan.execute", context(true), { fields: [field()] }));
    expect(refused).toMatchObject({ code: "command.invalid-input", exitCode: 2 });
    expect(refused.message).toContain("the plan's worktree would come from this invocation's working directory");
    expect(refused.message).toContain("LAUNCH directory");
    expect(refused.details.recovery).toContain("mstar mcp --workspace");
    expect(refused.details.recovery).toContain("mstar mcp --harness");
    expect(refused.details.diagnostics).toEqual([
      {
        path: "worktreePath",
        code: "required",
        message: "worktreePath is required, as an absolute path: the LAUNCH directory is never used as the plan's worktree",
        expected: "absolute path",
        received: "undefined",
      },
    ]);
  });

  test("refuses a relative input, and takes an absolute one", () => {
    const relative = usageRefusal(launchDirectoryRefusal("plan.execute", context(true), { fields: [field({ value: "wt/plan" })] }));
    expect(relative.message).toContain("would resolve against this invocation's working directory");
    expect(relative.details.diagnostics).toEqual([
      {
        path: "worktreePath",
        code: "invalid_type",
        message: "worktreePath must be an absolute path: a relative one would resolve against the LAUNCH directory, so it cannot name the plan's worktree",
        expected: "absolute path",
        received: "relative path",
      },
    ]);
    expect(launchDirectoryRefusal("plan.execute", context(true), { fields: [field({ value: "/abs/wt" })] })).toBeUndefined();
  });

  test("an optional omission is derived elsewhere, so only a RELATIVE value is refused", () => {
    // `optional` means another NAMED input derives this one (e.g. a sibling of a
    // directory the caller named): an omission is legitimate, a relative value is
    // still an input that would resolve against the launch directory.
    expect(launchDirectoryRefusal("pr-review.post", context(true), { fields: [field({ optional: true })] })).toBeUndefined();
    const relative = usageRefusal(
      launchDirectoryRefusal("pr-review.post", context(true), { fields: [field({ optional: true, value: "out/report.md" })] }),
    );
    expect(relative.details.diagnostics?.map((entry) => entry.code)).toEqual(["invalid_type"]);
  });

  test("reports EVERY offending input in one refusal", () => {
    const refused = usageRefusal(
      launchDirectoryRefusal("pr-review.post", context(true), {
        fields: [field({ field: "findings", subject: "the findings file" }), field({ field: "bodyFile", subject: "the review body" })],
      }),
    );
    // One attempt learns both, in the order the table lists them. The envelope
    // message is the bounded summary once there is more than one diagnostic, so
    // the class cause is asserted where it is emitted: on each per-field entry.
    expect(refused.details.diagnostics?.map((entry) => entry.path)).toEqual(["findings", "bodyFile"]);
    expect(refused.message).toContain("2 input issues");
    expect(refused.message).toContain("findings");
    expect(refused.message).toContain("bodyFile");
    expect(refused.details.diagnostics?.map((entry) => entry.message)).toEqual([
      "findings is required, as an absolute path: the LAUNCH directory is never used as the findings file",
      "bodyFile is required, as an absolute path: the LAUNCH directory is never used as the review body",
    ]);
  });

  test("the subject form refuses the checkout itself, with no per-field diagnostics", () => {
    const refused = usageRefusal(launchDirectoryRefusal("doctor", context(true), { subject: "this checkout" }));
    expect(refused.code).toBe("command.invalid-input");
    expect(refused.message).toContain("this checkout would come from this invocation's working directory");
    expect(refused.details.diagnostics).toBeUndefined();
  });
});

describe("launchDirectoryDiagnostics", () => {
  test("does not answer for an invocation whose workspace was named, or with nothing offending", () => {
    expect(launchDirectoryDiagnostics(context(undefined), { fields: [field()] })).toBeUndefined();
    expect(launchDirectoryDiagnostics(context(true), { fields: [field({ value: "/abs/wt" })] })).toBeUndefined();
  });

  test("answers the per-field entries and the launcher recovery a family joins into its own refusal", () => {
    const facts = launchDirectoryDiagnostics(context(true), {
      fields: [field(), field({ field: "reviewDir", subject: "the review directory", value: "reviews" })],
    });
    expect(facts?.diagnostics.map((entry) => `${entry.path}:${entry.code}`)).toEqual(["worktreePath:required", "reviewDir:invalid_type"]);
    expect(facts?.recovery).toContain("mstar mcp --workspace");
    expect(facts?.recovery).toContain("mstar mcp --harness");
  });
});
