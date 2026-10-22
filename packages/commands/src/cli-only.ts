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
 * Diagnosis is unaffected: `status validate` reports which workflows exist and
 * who holds them by role and epoch.
 */
const CLI_ONLY_PREFIXES = ["store."] as const;

/** True when a command is store-level and therefore CLI-only. */
export function isCliOnlyCommand(id: string): boolean {
  return CLI_ONLY_PREFIXES.some((prefix) => id.startsWith(prefix));
}
