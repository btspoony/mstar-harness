/**
 * Commands that belong to the local CLI only.
 *
 * Store-level operations move or reshape the WHOLE execution store — including
 * `execution_sessions` rows, whose `session_id` is a bearer identity on an
 * opted-in MCP connection. They cannot be redacted without making a backup
 * unrestorable, and they are not runtime work: an operator runs them against a
 * checkout, with an absolute path, in a shell. MCP is for the runtime surface
 * (plans, workflows, issues, ledger reads), so these are not published there.
 *
 * `linear.auth` is here for a different reason: completing it needs a human in a
 * browser, and it writes a credential into host state. A tool call on a shared
 * connection can do neither — it would block on an authorization nobody is
 * watching, or store a token the operator never granted. The operator runs it in
 * a shell on the machine that will hold the credential.
 *
 * Diagnosis is unaffected: `status validate` reports which workflows exist and
 * who holds them by role and epoch.
 */
const CLI_ONLY_PREFIXES = ["store.", "linear.auth"] as const;

/** True when a command is store-level and therefore CLI-only. */
export function isCliOnlyCommand(id: string): boolean {
  return CLI_ONLY_PREFIXES.some((prefix) => id.startsWith(prefix));
}
