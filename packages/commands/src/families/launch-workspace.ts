import path from "node:path";
import { refusalEnvelope } from "../envelope.js";
import type { CommandEnvelope, InvocationContext } from "../types.js";

/**
 * The null-root refusal rule, for the commands a connection admits WITHOUT a
 * control root: their `cwd` is then the MCP server's launch directory, so it is
 * the HOST's checkout and says nothing about the caller's workspace. A member
 * whose contract would default a path input to it, or take the checkout itself
 * as its subject, refuses per call instead of answering about (or writing into)
 * a directory the caller never named.
 *
 * The CLI never trips this: its `cwd` is the directory the caller ran from. The
 * fact is optional so only a transport that knows it publishes it.
 */
/** One input that would resolve against a launch-directory invocation. */
export interface LaunchDirectoryField {
  readonly field: string;
  /** What the field names, for the cause and the diagnostic. */
  readonly subject: string;
  readonly value: string | undefined;
  /**
   * The omission is derived from another NAMED input, so only a RELATIVE value
   * is refused (e.g. a sibling directory of a directory the caller named).
   */
  readonly optional?: boolean;
}

/**
 * What a member refuses to take from the launch directory: the inputs that
 * name a directory (`fields`), or, for a command whose SUBJECT is the checkout
 * itself (`doctor`'s project scope, `pr-review.size` / `post`), that subject.
 */
export type LaunchDirectoryTarget =
  | { readonly fields: readonly LaunchDirectoryField[]; readonly subject?: undefined }
  | { readonly subject: string; readonly fields?: undefined };

/**
 * The launcher recoveries, which work for every command: either declares the
 * directory the call runs in, so `cwd` is no longer the host's. The per-field
 * half of the recovery is the emitted diagnostic, so this literal stays one
 * statically provable statement.
 */
const LAUNCH_DIRECTORY_RECOVERY = "Declare the connection's workspace with `mstar mcp --workspace <absolute path>`; or pin the harness root with `mstar mcp --harness <absolute path>` (or a non-blank MSTAR_HARNESS_DIR in the server environment), which anchors the workspace at the root's parent.";

/**
 * Refuse when this invocation runs from a connection's launch directory and
 * `target` would therefore come from it; `undefined` means the caller may
 * proceed (its workspace was named, or every input names its own directory).
 *
 * EVERY offending input is reported in one refusal: a call that omits two
 * unnamed paths must not learn about them one attempt at a time.
 */
export function launchDirectoryRefusal(
  command: string,
  context: InvocationContext,
  target: LaunchDirectoryTarget,
): CommandEnvelope<never> | undefined {
  if (context.launchDirectory !== true) return undefined;
  // The subject form names the checkout a command answers ABOUT; the field form
  // names every input that would resolve against it.
  const subjectCauses = target.fields === undefined ? [cause(target.subject, undefined)] : undefined;
  const offending = target.fields === undefined ? [] : unnamed(target.fields);
  if (subjectCauses === undefined && offending.length === 0) return undefined;
  const causes = subjectCauses ?? offending.map((field) => cause(field.subject, field.value));
  // reachability: manual — the recovery names the launcher's `mstar mcp --workspace` / `--harness` declaration, which the command-catalog grammar the linter reads does not model (`mstar mcp` is not a catalog command); the per-field half of the recovery is the emitted diagnostic, and the behavioural suite pins this text.
  return refusalEnvelope({
    command,
    status: "usage",
    code: "command.invalid-input",
    exitCode: 2,
    message:
      `${command}: ${causes.join("; ")}, and this connection declared no workspace: that directory is the MCP server's ` +
      "LAUNCH directory (the host's own), which says nothing about the caller's workspace",
    ...(subjectCauses === undefined ? { diagnostics: offending.map(diagnostic) } : {}),
    recovery: LAUNCH_DIRECTORY_RECOVERY,
  });
}

function cause(subject: string, supplied: string | undefined): string {
  return supplied === undefined
    ? `${subject} would come from this invocation's working directory`
    : `${subject} would resolve against this invocation's working directory`;
}

function diagnostic(field: LaunchDirectoryField): {
  path: string;
  code: "required" | "invalid_type";
  message: string;
  expected: string;
  received: string;
} {
  return field.value === undefined
    ? {
      path: field.field,
      code: "required",
      // Each diagnostic restates the class cause: a refusal with more than one
      // field replaces the envelope message with the bounded summary, so a
      // per-field line has to stay self-contained.
      message: `${field.field} is required, as an absolute path: the LAUNCH directory is never used as ${field.subject}`,
      expected: "absolute path",
      received: "undefined",
    }
    : {
      path: field.field,
      code: "invalid_type",
      message: `${field.field} must be an absolute path: a relative one would resolve against the LAUNCH directory, so it cannot name ${field.subject}`,
      expected: "absolute path",
      received: "relative path",
    };
}

/** Every field a launch-directory invocation must not resolve there. */
function unnamed(fields: readonly LaunchDirectoryField[]): LaunchDirectoryField[] {
  return fields.filter((field) =>
    field.value === undefined ? field.optional !== true : !path.isAbsolute(field.value));
}
