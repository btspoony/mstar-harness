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
 */
export function launchDirectoryRefusal(
  command: string,
  context: InvocationContext,
  target: LaunchDirectoryTarget,
): CommandEnvelope<never> | undefined {
  if (context.launchDirectory !== true) return undefined;
  const offending = target.fields === undefined ? undefined : firstUnnamed(target.fields);
  if (target.fields !== undefined && offending === undefined) return undefined;
  const subject = offending?.subject ?? target.subject;
  const supplied = offending?.value;
  const reason = supplied === undefined
    ? `${subject} would come from this invocation's working directory`
    : `${subject} would resolve against this invocation's working directory`;
  // reachability: manual — the recovery names the launcher's `mstar mcp --workspace` / `--harness` declaration, which the command-catalog grammar the linter reads does not model (`mstar mcp` is not a catalog command); the per-field half of the recovery is the emitted diagnostic, and the behavioural suite pins this text.
  return refusalEnvelope({
    command,
    status: "usage",
    code: "command.invalid-input",
    exitCode: 2,
    message:
      `${command}: ${reason}, and this connection declared no workspace: that directory is the MCP server's ` +
      "LAUNCH directory (the host's own), which says nothing about the caller's workspace",
    ...(offending === undefined ? {} : {
      diagnostics: [{
        path: offending.field,
        code: supplied === undefined ? "required" : "invalid_type",
        message: supplied === undefined
          ? `${offending.field} is required, as an absolute path: the launch directory is never used as ${subject}`
          : `${offending.field} must be an absolute path: a relative one would resolve against the launch directory`,
        expected: "absolute path",
        received: supplied === undefined ? "undefined" : "relative path",
      }],
    }),
    recovery: LAUNCH_DIRECTORY_RECOVERY,
  });
}

/** The first field a launch-directory invocation must not resolve there, if any. */
function firstUnnamed(fields: readonly LaunchDirectoryField[]): LaunchDirectoryField | undefined {
  for (const field of fields) {
    if (field.value === undefined) {
      if (field.optional === true) continue;
      return field;
    }
    if (!path.isAbsolute(field.value)) return field;
  }
  return undefined;
}
