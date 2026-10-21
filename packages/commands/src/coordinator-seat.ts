import { getCommandDefinitions } from "./definitions.js";
import type { CommandDefinition } from "./types.js";

/**
 * The coordinator-seat command set — the ONE derivation both leaf guards read:
 * `packages/dsh/src/gates/leaf-seat.ts` on the host's `tools/pre-execute`
 * boundary, and `packages/cli/src/mcp/server.ts` for a `--seat leaf` stdio
 * connection. Neither layer keeps its own list: a hand list in each is how the
 * two came to refuse different sets, and why every new coordinator action
 * reopened the same hole.
 *
 * Derivation. The authority is the coordinator identity the command layer
 * builds from the caller-supplied session
 * (`grep -n 'role: *"coordinator"' packages/commands/src`): a command belongs
 * here when it works under that identity and
 *
 * - establishes or replaces a seat over an EXISTING workflow (`plan.bind`,
 *   `session.recover`), or
 * - writes workflow-scope delivery, lifecycle, adoption or coordinator ledger
 *   state: every action of the `workflow` family (`evidence`,
 *   `delivery-anchors`, `adopt-terminal`, `phase`, `lifecycle`,
 *   `execution-policy`, `integration-worktree`, and the create-only
 *   `register`), `status.workflow-close`, `workflow-note.append`, and the
 *   create-only `iteration.register`.
 *
 * Naming a whole family is deliberate: a workflow action added later is
 * refused for a leaf the moment it is published, instead of waiting for someone
 * to remember this module. A READ-ONLY action that joins a seat family must
 * therefore be published in a family of its own, or that entry becomes an
 * explicit action list.
 *
 * A command that merely acts THROUGH an existing binding mints no seat and
 * keeps the leaf's route: `plan.prepare` / `plan.progress` / `plan.show` /
 * `plan.issue-add` / `plan.issue-close` (the plan-row work a leaf does),
 * `session.run` (it mints an identity for a CHILD process, never a seat for
 * this caller) and `workflow-note.coverage` (a read).
 *
 * A new command that needs a seat is added HERE, once; both guards follow. The
 * colocated suite asserts every covered id resolves back through its published
 * family tool name, and the CLI leaf-seat suite asserts the published name rule
 * below agrees with the fold.
 */
const SEAT_FAMILIES: readonly string[] = ["workflow"];

/** Family → the coordinator-seat actions of an otherwise leaf-reachable family. */
const SEAT_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  plan: ["bind", "complete"],
  session: ["recover"],
  status: ["workflow-close"],
  "workflow-note": ["append"],
  iteration: ["register"],
};

/**
 * The folded MCP tool name a family publishes: `mstar_<family>` with `.` and
 * `-` folded to `_` — the rule `packages/cli/src/mcp/fold.ts` (`familyToolName`)
 * publishes with. The host guard sees only that published name, so the answer
 * has to be derivable here too; the CLI leaf-seat suite asserts the two agree
 * over the whole corpus.
 */
export function foldedFamilyToolName(family: string): string {
  return `mstar_${family.replace(/[.-]/g, "_")}`;
}

/** The family a definition publishes under — its authored CLI path segment. */
function familyOf(definition: CommandDefinition): string {
  return definition.cli.path[0] ?? definition.id.split(".")[0]!;
}

/** The action a command id publishes inside its family (`workflow-note.append` → `append`). */
function actionOf(commandId: string): string {
  const dot = commandId.indexOf(".");
  return dot === -1 ? commandId : commandId.slice(dot + 1);
}

function isSeatDefinition(definition: CommandDefinition): boolean {
  const family = familyOf(definition);
  return SEAT_FAMILIES.includes(family) || (SEAT_ACTIONS[family] ?? []).includes(actionOf(definition.id));
}

type SeatIndex = Readonly<{
  ids: ReadonlySet<string>;
  actions: ReadonlyMap<string, ReadonlyMap<string, string>>;
}>;

let seatIndexCache: SeatIndex | undefined;

function seatIndex(): SeatIndex {
  if (seatIndexCache !== undefined) return seatIndexCache;
  const ids = new Set<string>();
  const actions = new Map<string, Map<string, string>>();
  for (const definition of getCommandDefinitions()) {
    if (!isSeatDefinition(definition)) continue;
    ids.add(definition.id);
    const tool = foldedFamilyToolName(familyOf(definition));
    const byAction = actions.get(tool) ?? new Map<string, string>();
    byAction.set(actionOf(definition.id), definition.id);
    actions.set(tool, byAction);
  }
  seatIndexCache = { ids, actions };
  return seatIndexCache;
}

/** True when `commandId` is a coordinator-seat command (the CLI server's view). */
export function isCoordinatorSeatCommand(commandId: string): boolean {
  return seatIndex().ids.has(commandId);
}

/**
 * The coordinator-seat command id one folded MCP call selects, or undefined
 * when the call is not one (the dsh host guard's view: it knows only the
 * published tool name and the call's `action` argument).
 */
export function coordinatorSeatCommandFor(toolName: string, action: unknown): string | undefined {
  if (typeof action !== "string") return undefined;
  return seatIndex().actions.get(toolName)?.get(action);
}
