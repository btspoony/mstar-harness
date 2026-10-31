import type { CommandDefinition } from "@mstar-harness/commands";
import { inputFields } from "../schema-branches.js";

/**
 * The family a definition belongs to: the FIRST segment of its authored CLI
 * path, which is also what `mstar_schema --family` resolves
 * (`packages/commands/src/families/schema.ts` filters
 * `entry.cli.path[0] === family`).
 *
 * Deriving it from the definition — not from its id — is what keeps the
 * published tool name, the family description and the `mstar_schema` recovery
 * text pointed at the same family the discovery route accepts. The corpus
 * agrees on both derivations today (the fold suite asserts it over
 * `getCommandDefinitions()`), but an id whose prefix drifted from its authored
 * path would otherwise publish `mstar_<id prefix>` while its recovery named a
 * family that `mstar_schema` refuses as unknown.
 *
 * The id-prefix fallback covers only a definition that never passed
 * `validateCommandDefinitions` (it refuses an empty `cli.path`, so no real
 * command reaches here): a hand-built fixture, or a future caller constructing
 * a definition directly. An id with no `.` is its own family, and its action is
 * the id itself, so every published tool keeps the same `<family>` + `action`
 * shape and no command needs a second tool.
 */
export function familyOf(definition: CommandDefinition): string {
  const segment = definition.cli.path[0];
  if (segment !== undefined) return segment;
  const dot = definition.id.indexOf(".");
  return dot === -1 ? definition.id : definition.id.slice(0, dot);
}

/**
 * The action a command id publishes inside its family: everything after the
 * first `.` (`store.execution.restore` keeps `execution.restore`), or the id
 * itself for a family-less command.
 */
export function actionOf(commandId: string): string {
  const dot = commandId.indexOf(".");
  return dot === -1 ? commandId : commandId.slice(dot + 1);
}

/**
 * `mstar_<family>`: the published tool name, with `.` and `-` folded to `_`.
 */
export function familyToolName(family: string): string {
  return `mstar_${family.replace(/[.-]/g, "_")}`;
}

/**
 * One line of family purpose, and the only hand-maintained text in this
 * module. A command declaration describes ONE action, so a family-level
 * purpose cannot be derived from it; everything else here (actions, merged
 * fields, required lists, defaults) is derived from the declarations. Adding
 * an action needs no entry; a NEW family without one is named by the fold
 * suite's purpose-coverage test, and the runtime falls back to the family name
 * so a missing line never blocks publication.
 */
export const FAMILY_PURPOSE: Readonly<Record<string, string>> = {
  status: "Lifecycle, findings and tech-debt status reads, closes and retirements.",
  persist: "Read and replace persisted review or JSON documents.",
  migrate: "Retired legacy-plan migration; refuses without mutating.",
  iteration: "Iteration phase gates, push cadence and registration.",
  plan: "Coordinator plan rows: bind, progress, complete and issue links. bind writes the engine row only; a dsh-coordinating session that needs dsh-local ledger attribution uses the native mstar_plan_bind.",
  session: "Launch or recover a coordinator session identity.",
  workflow: "Workflow lifecycle: register, evidence, phase, policy and branch anchors.",
  issue: "Issue store: capture, triage, closure and links.",
  milestone: "Project milestones: add, update, assign issues and read rollups.",
  project: "Project-to-provider correspondence: bind a store project to the external project it mirrors, and read it back.",
  catalog: "Catalog rows: discover, import, register, link, reconcile and purge.",
  roadmap: "Project roadmap: reviewed Markdown import, export and replace.",
  store: "Execution store: init, upgrade, migrate, backup, restore and export.",
  "workflow-note": "Workflow note ledger: append notes and read coverage facts.",
  sdd: "SDD task evidence: workspace, task briefs, review packages, context and exec.",
  audit: "Codebase audit: scaffold a review report, secret-scan and supply-chain checks.",
  dispatch: "Validate an Assignment's fields and branch protection.",
  worktree: "Worktree isolation: entry/plan checks, QC alignment and guarded cleanup.",
  review: "Map an execution mode to QC seats and assert tri identity.",
  lint: "Lint harness artifacts by content type.",
  "design-md": "Validate DESIGN.md tokens, light/dark parity and completeness.",
  compound: "Validate a knowledge document and its index scope.",
  skill: "Lint a skill directory.",
  roles: "Validate the role mapping and load-order corpus.",
  qc: "Validate a saved QC seat report.",
  "pr-review": "PR review: size, seat prompt, tally, report path, worktree and post.",
  harness: "Scaffold harness directories and the default project.",
  doctor: "Validate the host setup for one supported target.",
  plugin: "Validate a plugin package against Agent Plugins v1.0.0.",
  path: "Resolve harness, specs, workflow, project and review directories.",
  host: "Host detection and skill-root resolution.",
  dashboard: "Start the read-only Morning Star dashboard on 127.0.0.1.",
  schema: "Bounded command-contract discovery: one leaf command, a family list or a payload schema.",
  report: "Create an offline, redacted issue-report draft.",
};

/** One family member as the MCP route publishes it. */
export type FoldMember = Readonly<{
  definition: CommandDefinition;
  /**
   * The member's published input JSON schema: the command descriptor's own
   * input. Merging the descriptor (rather than a hand-written list, or the
   * payload-composed transport view) keeps the family contract a field index —
   * one action's nested payload shape is `mstar_schema` detail, and repeating
   * it in every family schema is the duplication this fold removes.
   */
  input: Readonly<Record<string, unknown>>;
  /**
   * The per-call identity selector this member publishes on a GENERIC
   * connection, present only when the member declares one and the connection
   * identity is not locked. It is a transport field, not a member input field,
   * so it is injected here exactly as the per-command route did.
   */
  selector?: Readonly<{ key: string }>;
}>;

/**
 * A selector a family publishes ONCE while only some of its actions read it.
 * The `properties` union is family-wide, so the fact that an action does not
 * accept it cannot be expressed there: this map is published as the
 * `x-mstar-selectors` index (a host-side injector must not fill a selector the
 * selected action does not declare), and the transport reads it to refuse a
 * supplied selector instead of letting the action's schema strip it silently,
 * and to name the actions that do accept it in the recovery.
 */
export type FamilySelector = Readonly<{
  key: string;
  /** The actions that declare this selector, in declaration order. */
  actions: readonly string[];
}>;

/** One published tool: a whole command family selected by `action`. */
export type FoldedFamilyTool = Readonly<{
  family: string;
  toolName: string;
  /** The published `action` values, in declaration order. */
  actions: readonly string[];
  definitions: readonly CommandDefinition[];
  /**
   * Every selector the family publishes, with the actions that accept it. A
   * key listed here is published on the family tool (properties AND the
   * `x-mstar-selectors` index); a key whose action list does not contain the
   * selected action must be refused before admission.
   */
  selectors: readonly FamilySelector[];
  /**
   * The top-level input fields each action accepts, keyed by action, in the
   * order the member's own input schema publishes them — the SELECTED member's
   * own field set as admission sees it.
   *
   * The published schema is the union of these sets, so it cannot say that a
   * key belongs to one action and not another. This map is the transport's only
   * source for that fact: admission validates the selected member's own object
   * schema (strip mode), so a key the member does not declare disappears
   * without a diagnostic, and a stripped filter reads exactly like an applied
   * one.
   */
  acceptedFields: ReadonlyMap<string, readonly string[]>;
  /** The published JSON schema: required `action` plus the merged member fields. */
  descriptorView: Readonly<Record<string, unknown>>;
  description: string;
}>;

/**
 * The fields one member input publishes, including the branches of a union
 * input (`schema` is an anyOf of three selector objects). The traversal is
 * shared with the rendered contract (`schema-branches.ts`), so the family index
 * and the CLI/payload contract can never disagree about which keywords publish
 * fields.
 */
function publishedFields(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(inputFields(input));
}

function requiredFields(input: Readonly<Record<string, unknown>>): readonly string[] {
  return Array.isArray(input.required)
    ? input.required.filter((field): field is string => typeof field === "string")
    : [];
}

/**
 * The selector alternatives of a member input whose ROOT requires nothing:
 * `mstar_schema` is a union of three strict objects, each requiring exactly one
 * of `command` / `family` / `type`, so its root `required` is empty while no
 * call without one of them is accepted. Reading only the root would publish
 * "no required fields" and invite a request the command refuses.
 *
 * Only a genuine choice qualifies (two or more branches that each require a
 * field); a single-branch union is not a selector. The requirement is published
 * in the compact per-action line, not as a family-level `anyOf`: `anyOf` would
 * say "at least one", which admits the two-selector call admission refuses.
 */
function selectorAlternatives(input: Readonly<Record<string, unknown>>): readonly string[] {
  if (requiredFields(input).length > 0) return [];
  const branches = ["anyOf", "oneOf"]
    .flatMap((keyword) => Array.isArray(input[keyword]) ? input[keyword] as unknown[] : [])
    .map((branch) => requiredFields(branch !== null && typeof branch === "object" ? branch as Readonly<Record<string, unknown>> : {}))
    .filter((fields) => fields.length > 0);
  return branches.length >= 2 ? branches.flat() : [];
}

/**
 * True when two declarations of one shared field name cannot both be published
 * as one family-level declaration: they disagree on the accepted JSON type, on
 * the enumerated value set, or on whether a nested structure is declared at
 * all. Publishing either declaration for every action would advertise a
 * request the sibling refuses (an `open` disposition for a closure action).
 *
 * A difference of STRICTNESS alone (`minLength`, `minItems`, ...) stays
 * publishable: the first declaration is the union's shape, a stricter sibling
 * refuses a value at admission naming that field, and no enumerated value is
 * advertised that the sibling rejects.
 */
function conflictingDeclarations(first: Readonly<Record<string, unknown>>, other: Readonly<Record<string, unknown>>): boolean {
  const same = (key: string) => JSON.stringify(first[key]) === JSON.stringify(other[key]);
  if (!same("type") || !same("enum") || !same("const")) return true;
  return Object.hasOwn(first, "properties") !== Object.hasOwn(other, "properties")
    || Object.hasOwn(first, "required") !== Object.hasOwn(other, "required");
}

function familyDescription(
  family: string,
  members: readonly FoldMember[],
  actions: readonly string[],
  perAction: readonly string[],
): string {
  const lines = [FAMILY_PURPOSE[family] ?? `${family} commands.`];
  members.forEach((member, index) => {
    const required = requiredFields(member.input);
    const alternatives = selectorAlternatives(member.input);
    // A payload contract is member detail, not a field requirement: naming it
    // here keeps the per-action line honest without repeating the nested shape
    // in every family schema. `mstar_schema` is the discovery path.
    const payload = Object.keys(member.definition.payloads ?? {}).length === 0 ? "" : "; payload via mstar_schema";
    const requirement = alternatives.length > 0
      ? `exactly one of ${alternatives.join(", ")}`
      : required.length === 0 ? "no required fields" : required.join(", ");
    lines.push(`- ${actions[index]}: ${requirement}${payload}`);
  });
  // A field the family cannot publish without contradicting one of its actions
  // is named here instead: the caller still learns it exists, and the per-action
  // contract stays the `mstar_schema` call the next line points at.
  if (perAction.length > 0) lines.push(`Varies by action: ${perAction.join(", ")} (mstar_schema).`);
  // The pointer names the id SHAPE, not only one example: the detail command
  // takes `<family>.<action>`, and a reader who needs another action must be
  // able to derive its id. Naming every id would exceed the surface budget, so
  // one real member id carries the spelling and the pattern carries the rule.
  // The example is the member's OWN id, never a rebuilt `<family>.<action>`,
  // so a family name that is not its id prefix cannot advertise an id that does
  // not exist.
  //
  // `"action":"schema"` is not decoration: `mstar_schema` refuses a call with
  // no selector, so an example without it is a next step that always fails.
  const example = members[0]!.definition.id;
  lines.push(actions[0] === family
    ? `Fields: mstar_schema {"action":"schema","command":"${example}"}.`
    : `Fields: mstar_schema {"action":"schema","command":"<family>.<action>"} (e.g. "${example}").`);
  return lines.join("\n");
}

/**
 * Fold published members into one tool per family. The property set is the
 * union of the members' input schemas, the only unconditional requirement is
 * `action`, and the action enum is the family's real action list.
 *
 * REFUSED at publication time, each naming both parties: two families that fold
 * to one tool name, two members that publish the same action, and a member field
 * named `action` (the family selector owns that name).
 *
 * NOT refused: a key several members declare with different shapes. Refusing
 * would delete real families — `issue.payload` is an untyped placeholder on
 * `add` and a typed object on `close`, and `issue.disposition` carries an enum
 * on `add` and a single closure value on `close`. Such a key is therefore
 * WITHHELD from the family schema (the description names it "varies by
 * action") instead of publishing one action's declaration to every caller: a
 * published enum that a sibling refuses is a request the tool advertises and
 * then rejects. A strictness-only difference (`issue.id`: bare string on `add`,
 * `minLength(1)` on `show`) is still published once, because it enumerates no
 * value the sibling rejects.
 */
export function foldFamilyTools(members: readonly FoldMember[]): readonly FoldedFamilyTool[] {
  const groups = new Map<string, FoldMember[]>();
  for (const member of members) {
    const family = familyOf(member.definition);
    const group = groups.get(family);
    if (group === undefined) groups.set(family, [member]);
    else group.push(member);
  }
  const owners = new Map<string, string>();
  const tools: FoldedFamilyTool[] = [];
  for (const [family, group] of groups) {
    const toolName = familyToolName(family);
    const owner = owners.get(toolName);
    if (owner !== undefined) {
      throw new Error(`MCP tool name collision: ${toolName} (families ${owner} and ${family})`);
    }
    owners.set(toolName, family);
    const actions = group.map((member) => actionOf(member.definition.id));
    const duplicate = actions.find((action, index) => actions.indexOf(action) !== index);
    if (duplicate !== undefined) throw new Error(`${family}: duplicate action ${JSON.stringify(duplicate)}`);
    const properties: Record<string, unknown> = { action: { type: "string", enum: actions } };
    const selectors = new Map<string, string[]>();
    const acceptedFields = new Map<string, readonly string[]>();
    const perAction = new Set<string>();
    const requirements: Array<{ name: string; ownership: "caller"; route: "mcp"; help: string }> = [{
      name: "action",
      ownership: "caller",
      route: "mcp",
      help: "the family action to run; every other field belongs to that action",
    }];
    for (const [index, member] of group.entries()) {
      const fields = publishedFields(member.input);
      // The member's OWN field set, recorded before the union merge below: the
      // transport refuses a supplied key outside it instead of letting the
      // selected action's schema strip the value silently.
      acceptedFields.set(actions[index]!, Object.keys(fields));
      for (const [key, property] of Object.entries(fields)) {
        // The family selector owns the name: a member field that shadowed it
        // would be published away silently, so publication refuses instead.
        if (key === "action") {
          throw new Error(`${family}: ${member.definition.id} declares an "action" input, which the family selector owns`);
        }
        const published = properties[key];
        if (published === undefined) properties[key] = property;
        else if (conflictingDeclarations(published as Readonly<Record<string, unknown>>, property as Readonly<Record<string, unknown>>)) {
          perAction.add(key);
        }
      }
      // A member's identity selector is a transport field of the whole
      // connection, so the family publishes it once, with the member's own
      // requirement help, instead of competing with the member fields. The
      // accepting actions are recorded because the family schema cannot say
      // per action what the transport must refuse.
      const selector = member.selector;
      if (selector === undefined) continue;
      const accepting = selectors.get(selector.key) ?? [];
      accepting.push(actionOf(member.definition.id));
      selectors.set(selector.key, accepting);
      if (properties[selector.key] === undefined) properties[selector.key] = { type: "string" };
      if (!requirements.some((entry) => entry.name === selector.key)) {
        requirements.push({
          name: selector.key,
          ownership: "caller",
          route: "mcp",
          help: "per-call session identity",
        });
      }
    }
    // A field the family cannot publish for every action is withheld from the
    // union schema rather than published with one action's declaration: the
    // description names it and `mstar_schema` carries the per-action shape.
    for (const key of perAction) delete properties[key];
    // Derived once: the transport refuses a supplied selector by this map, and
    // the published index states the same per-action fact to a host that fills
    // the selector before the call.
    const familySelectors = [...selectors].map(([key, accepting]) => ({ key, actions: accepting }));
    tools.push({
      family,
      toolName,
      actions,
      definitions: group.map((member) => member.definition),
      selectors: familySelectors,
      acceptedFields,
      descriptorView: {
        type: "object",
        properties,
        required: ["action"],
        "x-mstar-requirements": requirements,
        ...(familySelectors.length === 0 ? {} : { "x-mstar-selectors": familySelectors }),
      },
      description: familyDescription(family, group, actions, [...perAction]),
    });
  }
  return tools;
}

/**
 * The real definition a folded call selects: the member publishing `action`.
 * `undefined` is an unknown action, which the caller must refuse with the
 * family's action list.
 */
export function definitionForAction(family: FoldedFamilyTool, action: string): CommandDefinition | undefined {
  return family.definitions.find((definition) => actionOf(definition.id) === action);
}
