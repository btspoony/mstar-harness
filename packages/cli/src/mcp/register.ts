import { resolve } from "node:path";
import type { McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { admitCommandInput, getCommandSchemas, isCliOnlyCommand, isPayloadPlaceholder, refusalEnvelope, sanitizeInputScalar } from "@mstar-harness/commands";
import { z } from "zod";
import type { CommandAdmission, CommandDefinition, CommandEnvelope, CommandSchemaDescriptor, InvocationContext, RefusalDiagnostic } from "@mstar-harness/commands";
import { createMcpEffects, type McpEffects } from "./effects.js";
import { actionOf, definitionForAction, foldFamilyTools, type FoldedFamilyTool } from "./fold.js";
import { inputFields } from "../schema-branches.js";
import { surfaceAssignmentRecovery } from "../command-adapter.js";
import { validateCommandOutcome } from "./outcome.js";
/**
 * Resolve the invocation context for one admitted call. It receives only the
 * immutable primitive session selector admission already validated — never the
 * handler value — so a resolver cannot reach or replace what the handler will
 * observe. The shared MCP connection carries no identity of its own: a
 * `sessionId` on the wire is the caller's per-call selector and nothing here
 * supplies a connection-wide default.
 *
 * `defaultHarness` is the root a launcher declared for every call (the stdio
 * server's `--harness` pin, or a non-blank `MSTAR_HARNESS_DIR`). Commands that
 * resolve their own root from an `input.harness` field never read
 * `controlRoot`, so admission fills that field from this default when the call
 * left it unset or blank; an explicit non-blank per-call value still wins. When
 * it is undefined the connection declared no root, and registration publishes
 * `harness` as REQUIRED on every tool that names such a field.
 */
export type ResolveContext = {
  (
    definition: CommandDefinition,
    sessionId: string | undefined,
    signal: AbortSignal,
    services: Array<{ close(): Promise<void> }>,
    effects: McpEffects,
    call?: ResolveContextCall,
  ): InvocationContext | Promise<InvocationContext>;
  readonly defaultHarness?: string;
  /**
   * True only when the LAUNCHER explicitly trusted a caller-declared
   * `sessionId` as an execution identity (`mstar mcp --trust-caller-session-id`,
   * off by default). An MCP server is a child process with no host-proven
   * caller identity, so the default connection publishes no session selector
   * and refuses one a caller supplies; the dsh native tools and the CLI are the
   * host-proven routes.
   */
  readonly callerIdentity?: boolean;
};

/**
 * The per-call facts the transport hands the resolver after admission: only
 * the immutable primitive selectors admission validated — never the handler
 * value. `harness` is the explicit root the CALLER named this call (a
 * non-blank `harness` field), undefined when the call named no root.
 */
export type ResolveContextCall = Readonly<{
  readonly harness?: string;
}>;

/**
 * The MCP-facing input shape: the command's own input plus the domain-owned
 * payload contracts, so a caller can construct a declared payload from
 * `tools/list` instead of guessing at an opaque field. Payload values keep
 * their object form, never JSON-encoded strings. Canonical unconditional
 * requirements are applied after composition; conditional alternatives and
 * safe defaults remain owned by shared admission. Publication reuses the
 * descriptor's JSON conversions and validation uses the composed Zod object.
 *
 * A descriptor is composed only when its key is a declared field the family
 * left as a permissive `z.unknown()` placeholder: that placeholder gains the
 * domain-owned shape. A field the input schema already shapes stays that
 * schema (it is the family's own transport contract — the workflow `--file`
 * path, which must stay a pathname), and a key that names no input field at
 * all is never injected, because a tool field the handler does not read is a
 * capability `tools/list` must not advertise. Descriptor keys are not required
 * to be payload field names — `persist.write` keys its per-kind contracts by
 * `kind` value — so they are published by the `schema` family alone.
 *
 * `unpinnedRootRequired` is the unpinned-connection rule: with no declared root,
 * a command that resolves its root from a DECLARED selector cannot rely on a
 * launcher default, so that selector is published and admitted as REQUIRED. A
 * model then cannot omit the one fact the root resolution needs. A pinned
 * connection keeps the field optional (the pin is the default).
 *
 * The selector is `rootInputs`, not a field literally named `harness`: the
 * declaration is the single authority for which inputs are root selectors
 * (`sdd.workspace` resolves its root from `controlRoot`).
 *
 * A UNION input (the `issue.close` family of closure actions) names its root
 * selector inside each branch and cannot be rewritten into an object schema
 * without losing the branches' conditional alternatives, so its requirement is
 * published the same way but enforced at admission (`unpinnedRootRefusal`) —
 * admission alone would answer the union's "invalid input" without naming the
 * field.
 */
function mcpInputContract(
  definition: CommandDefinition,
  descriptor: CommandSchemaDescriptor,
  options: Readonly<{ unpinnedRootRequired: boolean; rootInputs: readonly string[]; publishSelector: boolean }>,
) {
  const input = definition.input;
  const jsonSchema = descriptor.input as Record<string, unknown>;
  const selector = definition.cli.options.find((option) => option.context === "sessionId");
  // A command declares ONE root selector today; a command that ever declared
  // alternatives would need an anyOf (at least one), which this rule cannot
  // express as a flat `required` list.
  const requiredRoots = options.unpinnedRootRequired ? options.rootInputs : [];
  if (!(input instanceof z.ZodObject)) {
    const gatedRoots = requiredRoots.filter((field) => inputFields(jsonSchema).has(field));
    return {
      schema: input,
      jsonSchema: gatedRoots.length === 0 ? jsonSchema : { ...jsonSchema, required: [...descriptor.required, ...gatedRoots] },
      unpinnedRootGate: gatedRoots,
    };
  }
  const properties = { ...jsonSchema.properties as Record<string, Record<string, unknown>> };
  const composed: Record<string, z.core.$ZodType> = {};
  for (const [field, payload] of Object.entries(definition.payloads ?? {})) {
    if (!isPayloadPlaceholder(input.shape[field])) continue;
    composed[field] = payload.schema.optional();
    properties[field] = descriptor.payloadSchemas[field] as Record<string, unknown>;
  }
  const extended = Object.keys(composed).length === 0 ? input : input.safeExtend(composed);
  const requiredFields = new Set(descriptor.required);
  for (const field of requiredRoots) if (Object.hasOwn(properties, field)) requiredFields.add(field);
  const requiredShape: Record<string, z.core.$ZodType> = {};
  for (const field of requiredFields) {
    if (field === selector?.key) continue;
    const declared = extended.shape[field];
    if (declared instanceof z.ZodOptional) requiredShape[field] = declared.unwrap();
  }
  let schema = Object.keys(requiredShape).length === 0 ? extended : extended.safeExtend(requiredShape);
  // The session selector is the caller's per-call identity channel, and only a
  // launcher that explicitly trusted caller identity publishes it. On the
  // default shared connection the field does not exist, so a call that sends
  // one is refused by name (`callerIdentityFacts`) instead of vanishing.
  if (selector !== undefined && options.publishSelector) {
    schema = schema.safeExtend({ [selector.key]: z.string().optional() });
    properties[selector.key] = { type: "string" };
  }
  for (const [field, value] of Object.entries(descriptor.defaults)) {
    if (properties[field] !== undefined) properties[field] = { ...properties[field], default: value };
  }
  const required = selector === undefined ? [...requiredFields] : [...requiredFields].filter((field) => field !== selector.key);
  const requirements = descriptor.requirements.filter((entry) => entry.route === "mcp" && (options.publishSelector || entry.name !== selector?.key));
  return {
    schema,
    jsonSchema: {
      ...jsonSchema,
      required,
      properties,
      "x-mstar-requirements": requirements,
    },
    unpinnedRootGate: [],
  };
}

/**
 * The input fields that select this command's ROOT: the command's own
 * `rootInputs` when it declares them, else the `harness` field it publishes.
 * A command that only NAMES a harness (`store.execution.*`) declares an empty
 * list, so its target is never mistaken for the connection's root.
 */
function rootInputsOf(definition: CommandDefinition, descriptor: CommandSchemaDescriptor): readonly string[] {
  if (definition.rootInputs !== undefined) return definition.rootInputs;
  return inputFields(descriptor.input as Record<string, unknown>).has("harness") ? ["harness"] : [];
}

function handlerInput(definition: CommandDefinition, input: unknown, defaultHarness: string | undefined, harnessIsRoot: boolean): unknown {
  if (input === null || typeof input !== "object") return input;
  const record = input as Record<string, unknown>;
  const contextKeys = definition.cli.options.filter((option) => option.context === "sessionId").map((option) => option.key);
  const normalized = { ...record };
  for (const key of contextKeys) delete normalized[key];
  if (defaultHarness !== undefined && harnessIsRoot) normalized.harness = defaultHarness;
  return normalized;
}

/**
 * Normalize the ROOT selectors BEFORE the tool schema runs. Two rules:
 *
 * - the connection pin WINS. The resolver already pins `controlRoot`, but a
 *   command that resolves its own root from an input field would still read the
 *   caller's value, so a pinned connection overwrites a `harness` root selector
 *   with the pin and REMOVES any other root selector (the invocation context
 *   already carries the pin, and a workspace-root selector such as
 *   `sdd.workspace`'s `controlRoot` is not the harness dir). Writing the pin
 *   over the caller's value at the earliest seam is what makes every family
 *   judge that call the same way.
 * - a per-call value is resolved to an ABSOLUTE path. The invocation workspace
 *   is anchored at the root's parent, so a relative value would be re-resolved
 *   against that anchor by the handler and double-join the path (`x/.mstar`
 *   under an `x` anchor became `<anchor>/x/x/.mstar`). The launch directory is
 *   the only base a per-call selector can be relative to.
 *
 * A field that names an operation TARGET (`rootInputs: []`) is never touched:
 * the pin governs which store a command EXECUTES AGAINST, not which object an
 * operation NAMES. A caller's object is never mutated: a shallow copy carries
 * the normalized fields, and an object naming no root is returned untouched.
 */
function normalizedRootInputs(rootInputs: readonly string[], input: unknown, defaultHarness: string | undefined): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const named = rootInputs.filter((field) => Object.hasOwn(record, field));
  if (named.length === 0) return input;
  const normalized = { ...record };
  for (const field of named) {
    if (defaultHarness !== undefined) {
      if (field === "harness") normalized[field] = defaultHarness;
      else delete normalized[field];
      continue;
    }
    const value = normalized[field];
    if (typeof value === "string" && value.trim() !== "") normalized[field] = resolve(value);
  }
  return normalized;
}

/**
 * The root the ADMITTED call named: the first root selector the command
 * declares with a non-blank value, read from the input BEYOND admission (a
 * handler value never leaves the capability, so a non-`harness` selector such as
 * `sdd.workspace`'s `controlRoot` has no other route to the resolver). Pinned
 * behaviour is unchanged by construction: the seam already replaced `harness`
 * with the pin and removed every other root selector, and the resolver prefers
 * the pin over any call root.
 */
function callRootOf(rootInputs: readonly string[], input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const field of rootInputs) {
    const value = record[field];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** True when the call supplied a non-blank value for one root selector (a blank value is not a declaration). */
function namedRoot(field: string, input: unknown): boolean {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The facts of the unpinned-connection root requirement: cause, recovery and its
 * one `required` diagnostic. The two refusals that report it — the one that
 * reports it alone and the one that aggregates it with the refused selectors,
 * the rejected fields and admission's diagnostics — read the same facts here, so
 * an omitted selector means the same thing and recovers through the same routes
 * on either. It is not a helper the refusals may skip: a message that names the
 * selector without the recovery leaves the caller guessing at the same cost.
 *
 * `field` is the selector the command DECLARES (`rootInputs`), never an assumed
 * `harness`: a command whose root selector is spelled differently must be
 * refused — and recovered — by that name.
 */
function unpinnedRootFacts(
  definition: CommandDefinition,
  field: string,
): Readonly<{ message: string; recovery: string; diagnostic: RefusalDiagnostic }> {
  return {
    message: `${definition.id} needs the call's "${field}" selector: this MCP connection declared no control root, and the command resolves its root from that field`,
    recovery: `pass \`${field}\` naming this call's root directory (an absolute path, or one relative to the server's launch directory), or declare the root for the whole connection \u2014 \`mstar mcp --harness <absolute path>\`, or a non-blank MSTAR_HARNESS_DIR in the server environment \u2014 and no call needs the selector`,
    diagnostic: {
      path: field,
      code: "required",
      message: `${field} is required: this connection declared no control root`,
      expected: "present",
      received: "undefined",
    },
  };
}

/**
 * The refusal for an omitted root selector on a UNION input. Admission cannot
 * make a branch field required without dropping the branches' conditional
 * alternatives, and its own verdict on a union is "invalid input" — which names
 * neither the missing selector nor a recovery. The envelope and its `required`
 * diagnostic follow the shape every family uses for a mandated field, so a
 * caller reads the same cause through the same route whichever input schema the
 * action has.
 *
 * Admission's own diagnostics join this one (`admission`): the missing selector
 * must not cost a second attempt to learn the fields the action also refused —
 * report-all is the contract on every route.
 */
function unpinnedRootRefusal(
  definition: CommandDefinition,
  field: string,
  admission?: Extract<CommandAdmission, { success: false }>,
): CommandEnvelope<never> {
  const facts = unpinnedRootFacts(definition, field);
  const admissionDiagnostics = (admission?.envelope.details?.diagnostics ?? []) as readonly RefusalDiagnostic[];
  return refusalEnvelope({
    command: definition.id,
    status: "usage",
    code: "command.invalid-input",
    exitCode: 2,
    message: facts.message,
    helpRoute: `mstar schema --command ${definition.id}`,
    recovery: facts.recovery,
    diagnostics: [facts.diagnostic, ...admissionDiagnostics],
  });
}

/**
 * The textual facts of the caller-declared-identity refusal: cause, recovery
 * and diagnostics. Shared by the ONE input refusal below, which frames them
 * either alone (the identity problem is the only one) or aggregated with the
 * rejected fields and the action's own admission diagnostics — one response,
 * every problem, one retry.
 *
 * An MCP server is a child process with no host-proven caller identity, so
 * accepting the value would let any caller address another session's
 * coordinator row. The recovery names the routes that really exist: the dsh
 * native tool for the operations it covers (plan bind, audit report validation,
 * execution clear) and the CLI for everything else. It is deliberately explicit
 * that plan prepare/progress/complete have NO native tool yet instead of
 * implying one. The supplied value is never echoed: a session id is
 * credential-shaped, and a value copied into a refusal travels wherever the
 * refusal is read.
 */
function callerIdentityFacts(
  definition: CommandDefinition,
  selectors: readonly string[],
): Readonly<{ message: string; recovery: string; diagnostics: readonly RefusalDiagnostic[] }> {
  const cli = `mstar ${definition.cli.path.join(" ")}`;
  const native = definition.id === "plan.bind"
    ? "the dsh native tool `mstar_plan_bind` (its identity is the carrying session's `exec.agent.id`)"
    : undefined;
  const planGap = ["plan.prepare", "plan.progress", "plan.complete"].includes(definition.id);
  return {
    message: `${definition.id} cannot run on this MCP connection: a caller-declared session identity was supplied, and this server was not launched with --trust-caller-session-id. `
      + "An MCP child process has no host-proven caller identity, so a sessionId on the wire cannot become a coordinator identity.",
    recovery: [
      "Drop `sessionId` on this connection; it is not a published field unless the launcher opts in.",
      ...(native === undefined ? [] : [`The host-proven route for this operation is ${native}.`]),
      `Otherwise run \`${cli}\` from the session's shell, which takes --session-id or MSTAR_HOST_SESSION_ID.`,
      ...(planGap ? ["No dsh native tool covers plan prepare/progress/complete yet; the CLI is the only route for them."] : []),
    ].join(" "),
    diagnostics: selectors.map((key) => ({
      path: key,
      code: "not_allowed",
      message: `${key} is not an input of this connection: it carries no host-proven caller identity`,
      expected: "omitted",
      received: "supplied",
    })),
  };
}

/** The declared session selectors the CALL supplied, for the untrusted-connection refusal. */
function suppliedSelectors(family: FoldedFamilyTool, input: unknown): readonly string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  const declared = new Set<string>();
  for (const member of family.definitions) {
    for (const option of member.cli.options) {
      if (option.context === "sessionId") declared.add(option.key);
    }
  }
  return [...declared].filter((key) => record[key] !== undefined);
}

/**
 * An admitted call bound to the definition its `action` selected. The
 * transport carries that definition alongside the immutable admission so the
 * handler validates the outcome and renders the assignment recovery with the
 * SELECTED command's identity, never the family tool's name. `callRoot` is the
 * root selector the call named (see `callRootOf`), resolved once at validation
 * so the handler never re-reads the handler value.
 */
type FoldedAdmission = Extract<CommandAdmission, { success: true }> & Readonly<{
  definition: CommandDefinition;
  callRoot: string | undefined;
}>;

/**
 * Remove the family `action` selector before admission: it names the member,
 * it is not one of the member's fields, and a strict member schema would
 * refuse it as unknown. The caller's object is never mutated.
 */
function strippedActionInput(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const { action: _action, ...rest } = input as Record<string, unknown>;
  return rest;
}

/**
 * Remove already-refused keys before admission so one refusal reports every
 * problem once: a rejected key and a refused selector stay in
 * `undeclaredInputRefusal`, and admission reports only the selected action's
 * declared fields. The caller's object is never mutated.
 */
function withoutFields(input: unknown, fields: readonly string[]): unknown {
  if (fields.length === 0) return input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const rest = { ...(input as Record<string, unknown>) };
  for (const field of fields) delete rest[field];
  return rest;
}

/**
 * The refusal a folded tool returns when `action` names no member. It carries
 * the family's real action list plus the supported recovery — the family tool
 * itself and `mstar_schema` for field detail — so the caller can retry without
 * a second discovery round, together with every supplied key NO member accepts
 * (`familyWideInvalidFields`): those are invalid whatever action is chosen, so
 * reporting the action first and them second is the one-key-per-attempt loop
 * `packages/cli/AGENTS.md` forbids.
 *
 * The supplied selector is NEVER echoed, for the same reason
 * the refusal builders never echo one: any caller-controlled scalar can
 * be credential-shaped, and a value copied into `message` / `diagnostics[].received`
 * is forwarded wherever the refusal is read or recorded. Only its shape is
 * reported; both `mstar_schema` examples are runnable verbatim, selector
 * included — a published next step that the tool refuses is not a recovery.
 * A rejected KEY is caller-controlled text too, so it goes through the shipped
 * input sanitizer exactly as `undeclaredInputRefusal` does.
 */
function unknownActionRefusal(family: FoldedFamilyTool, action: unknown, rejected: readonly string[]): CommandEnvelope<never> {
  const listed = family.actions.map((entry) => JSON.stringify(entry)).join(" | ");
  const received = typeof action === "string" ? "supplied" : action === undefined ? "undefined" : typeof action;
  const keys = rejected.map(sanitizeInputScalar);
  const dropped = keys.map((key) => JSON.stringify(key)).join(", ");
  const accepted = cappedFieldList(familyAcceptedFields(family));
  return refusalEnvelope({
    command: family.toolName,
    status: "usage",
    code: "command.invalid-input",
    exitCode: 2,
    message: `unknown action for ${family.toolName}; available actions: ${family.actions.join(", ")}`
      + (keys.length === 0 ? "" : `; no action of this family accepts the field${keys.length === 1 ? "" : "s"} ${dropped}`),
    helpRoute: `mstar schema --family ${family.family}`,
    recovery: `call ${family.toolName} with "action" set to one of the available actions; for one action's fields call mstar_schema {"action":"schema","family":"${family.family}"} and then {"action":"schema","command":"${family.definitions[0]!.id}"}`
      + (keys.length === 0 ? "" : `; drop ${dropped}`),
    diagnostics: [
      { path: "action", code: "not_allowed", message: `action must be one of ${listed}`, expected: listed, received },
      ...keys.map((key) => ({
        path: key,
        code: "not_allowed",
        message: `${key} is not an input of ${family.toolName}; no action of this family accepts it`,
        expected: accepted,
        received: "supplied",
      })),
    ],
    details: {
      actions: family.actions,
      ...(keys.length === 0 ? {} : { fields: keys }),
    },
  });
}

/** A published selector the SELECTED action does not declare, with its accepting actions. */
type RefusedSelector = Readonly<{ key: string; acceptingActions: readonly string[] }>;

/**
 * The session selectors the SELECTED action does not declare.
 *
 * A family publishes its selector once for the whole tool, but only some
 * actions read it. On the others the key is not a declared context key, so
 * `handlerInput` does not strip it and the action's Zod object (strip, never
 * strict) silently discards the value: the call runs under the connection
 * identity and the caller sees no signal that the identity it passed was
 * ignored. That is the same rule the input-contract comment states — a tool
 * field the handler does not read must not be advertised — so the transport
 * refuses BEFORE admission instead of letting the field vanish.
 *
 * Every refused selector is returned, not the first: the refusal aggregates
 * with the rejected fields and the action's own admission diagnostics into one
 * response. The refusal names the actions that DO accept each selector (that is
 * the discovery fact the family schema cannot publish) and never echoes the
 * supplied value: a session id is a credential-shaped fact, and echoing it into
 * an error the caller may forward adds no recovery.
 */
function undeclaredSelectors(
  family: FoldedFamilyTool,
  definition: CommandDefinition,
  input: unknown,
): readonly RefusedSelector[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  const declared = new Set(definition.cli.options.filter((option) => option.context === "sessionId").map((option) => option.key));
  return family.selectors
    .filter((selector) => !declared.has(selector.key) && record[selector.key] !== undefined)
    .map((selector) => ({ key: selector.key, acceptingActions: selector.actions }));
}

/**
 * How many accepted field names one refusal prints before truncating. The list
 * is the discovery fact the refusal exists to carry, but a family whose action
 * declares twenty fields would turn a one-line refusal into a page; past the
 * cap the recovery (`mstar_schema`) is the full answer.
 */
const ACCEPTED_FIELD_LIST_CAP = 12;

/** `a, b, ...` for a field list, truncated after {@link ACCEPTED_FIELD_LIST_CAP}. */
function cappedFieldList(fields: readonly string[]): string {
  if (fields.length === 0) return "no fields";
  return fields.length <= ACCEPTED_FIELD_LIST_CAP
    ? fields.join(", ")
    : `${fields.slice(0, ACCEPTED_FIELD_LIST_CAP).join(", ")}, ...`;
}

/**
 * The top-level input keys the SELECTED action does not accept.
 *
 * A family publishes the UNION of its members' fields, and admission validates
 * the selected member's own object schema in strip mode: a key the member does
 * not declare is discarded with no diagnostic, so the call runs without the
 * constraint the caller believes it set. A stripped filter is the worst case —
 * an unfiltered page returned to a caller that asked for a filter reads as a
 * filtered page, which is a wrong result rather than lost input. That is the
 * same rule `undeclaredInputRefusal` enforces for the identity selector, so
 * the transport refuses BEFORE admission for every other published key too.
 *
 * EVERY rejected key is returned, not the first: report-all is the contract
 * (`packages/cli/AGENTS.md`), and a one-key-per-attempt loop is a defect.
 *
 * The family selector keys and `action` are transport fields, not member
 * inputs: `action` selects the member and the session selector is owned by
 * `undeclaredSelectors`, so neither reaches this arm.
 *
 * Nested `payload` object contents are NOT examined here: a payload contract is
 * member detail that admission owns, and this index only names top-level
 * fields. A `payload` key the selected action does not accept at all is a
 * top-level miss and refuses; a key INSIDE an accepted payload is validated by
 * the action's own payload schema, which reports its own diagnostics.
 */
function undeclaredFields(family: FoldedFamilyTool, definition: CommandDefinition, input: unknown, callerIdentity: boolean): readonly string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  const accepted = family.acceptedFields.get(actionOf(definition.id)) ?? [];
  const declared = new Set<string>([...accepted, ...transportFields(family, callerIdentity)]);
  return Object.keys(record).filter((key) => record[key] !== undefined && !declared.has(key));
}

/**
 * The transport fields of the WHOLE family: `action` plus, on a connection that
 * publishes it, every member's session selector. Neither is a member input -
 * one selects the member, the other is the opt-in identity channel - so no
 * action can call them invalid.
 *
 * Read from the family's definitions rather than from `family.selectors`: the
 * published selector list marks a member's own selector, while this set must
 * cover every member's selector so an action that reads none still reports it
 * as a transport field instead of a typo. On the default connection no session
 * selector is published at all, so none is exempt: a supplied one reaches the
 * named caller-identity refusal before this set is consulted.
 */
function transportFields(family: FoldedFamilyTool, callerIdentity: boolean): ReadonlySet<string> {
  const keys = new Set<string>(["action"]);
  if (!callerIdentity) return keys;
  for (const member of family.definitions) {
    for (const option of member.cli.options) {
      if (option.context === "sessionId") keys.add(option.key);
    }
  }
  return keys;
}

/** Every top-level field at least one action of the family accepts, in declaration order. */
function familyAcceptedFields(family: FoldedFamilyTool): readonly string[] {
  const accepted = new Set<string>();
  for (const fields of family.acceptedFields.values()) for (const field of fields) accepted.add(field);
  return [...accepted];
}

/**
 * The top-level keys NO action of the family accepts and no transport field
 * owns. Being accepted by no member is decidable without selecting an action,
 * so the unknown/missing-action refusal reports such a key in the same
 * response instead of spending a second round trip on it.
 *
 * A key at least ONE action accepts is NOT reported here: it is not invalid
 * until an action that does not declare it is selected, and that
 * selected-action case belongs to `undeclaredFields` /
 * `undeclaredInputRefusal`.
 */
function familyWideInvalidFields(family: FoldedFamilyTool, input: unknown, callerIdentity: boolean): readonly string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
  const record = input as Record<string, unknown>;
  const declared = new Set<string>([...familyAcceptedFields(family), ...transportFields(family, callerIdentity)]);
  return Object.keys(record).filter((key) => record[key] !== undefined && !declared.has(key));
}

/**
 * The ONE refusal for a call whose selected action does not declare part of its
 * input: every refused selector, every rejected top-level field plus, when the
 * selected action's own admission also refuses the remaining input,
 * admission's diagnostics — one response, every problem, one retry.
 *
 * A caller-declared identity on an unopted connection joins the same response
 * (`unpublished`): the identity diagnostic, the rejected fields and the
 * admission diagnostics are one answer, not two attempts. The envelope keeps
 * the identity frame in that case, because the security fact is the reason the
 * call cannot run at all.
 *
 * An omitted root selector on an unpinned connection joins it too
 * (`missingRoot`): the requirement is computed before this branch is chosen, so
 * a call that also carries a rejected key never learns the root requirement one
 * retry later. Its diagnostic leads the list — the connection-wide requirement
 * is the fact this refusal is the ONLY place to learn.
 *
 * The refusal names the actions that accept each refused selector, the fields
 * the action DOES accept (capped; `mstar_schema` is the full answer) and the
 * sibling actions a rejected key belongs to. It never echoes a caller-supplied
 * value VERBATIM: an object key is caller-controlled text and can be
 * credential-shaped, so every echoed key goes through the shipped input
 * sanitizer (`sanitizeInputScalar`) in the message, the recovery, the
 * diagnostic path and `details` alike.
 */
function undeclaredInputRefusal(
  family: FoldedFamilyTool,
  definition: CommandDefinition,
  selectors: readonly RefusedSelector[],
  rejected: readonly string[],
  admission: Extract<CommandAdmission, { success: false }> | undefined,
  unpublished: readonly string[] = [],
  missingRoot?: string,
): CommandEnvelope<never> {
  const action = actionOf(definition.id);
  const accepted = family.acceptedFields.get(action) ?? [];
  const acceptedList = cappedFieldList(accepted);
  const keys = rejected.map(sanitizeInputScalar);
  const dropped = keys.map((key) => JSON.stringify(key)).join(", ");
  const root = missingRoot === undefined ? undefined : unpinnedRootFacts(definition, missingRoot);
  const identity = unpublished.length === 0 ? undefined : callerIdentityFacts(definition, unpublished);
  const selectorClauses = selectors.map((selector) => {
    const key = sanitizeInputScalar(selector.key);
    return `${JSON.stringify(key)} (accepted by: ${selector.acceptingActions.join(", ")})`;
  });
  const selectorNames = selectors.map((selector) => JSON.stringify(sanitizeInputScalar(selector.key))).join(", ");
  const selectorActions = [...new Set(selectors.flatMap((selector) => selector.acceptingActions))];
  const acceptingActions = [...family.acceptedFields]
    .filter(([sibling, fields]) => sibling !== action && fields.some((field) => rejected.includes(field)))
    .map(([sibling]) => sibling);
  const admissionDiagnostics = (admission?.envelope.details?.diagnostics ?? []) as readonly RefusalDiagnostic[];
  const payloadNote = rejected.includes("payload")
    ? "; nested payload contents belong to the action's own payload schema, not to this field index"
    : "";
  const message = [
    ...(root === undefined ? [] : [root.message]),
    ...(identity === undefined ? [] : [identity.message]),
    selectors.length === 0 ? "" :
      `action ${JSON.stringify(action)} of ${family.toolName} does not declare the selector${selectors.length === 1 ? "" : "s"} ${selectorClauses.join(", ")}`,
    rejected.length === 0 ? "" :
      `it does not accept the field${keys.length === 1 ? "" : "s"} ${dropped}; it accepts: ${acceptedList}${payloadNote}`,
  ].filter(Boolean).join("; ");
  const recovery = [
    ...(root === undefined ? [] : [root.recovery]),
    ...(identity === undefined ? [] : [identity.recovery]),
    selectors.length === 0 ? "" :
      `drop ${selectorNames} to run ${definition.id} under the connection identity, or call ${family.toolName} with "action" set to one of: ${selectorActions.join(", ")}`,
    rejected.length === 0 ? "" :
      `drop ${dropped}${acceptingActions.length === 0 ? "" : ` (the action(s) that accept it: ${acceptingActions.join(", ")})`}, or call mstar_schema {"action":"schema","command":${JSON.stringify(definition.id)}} for this action's real input shape`,
  ].filter(Boolean).join("; ");
  const diagnostics = [
    ...(root === undefined ? [] : [root.diagnostic]),
    ...(identity?.diagnostics ?? []),
    ...selectors.map((selector) => {
      const key = sanitizeInputScalar(selector.key);
      return {
        path: key,
        code: "not_allowed",
        message: `${key} is not an input of ${definition.id}; the actions that accept it: ${selector.acceptingActions.join(", ")}`,
        expected: selector.acceptingActions.map((entry) => JSON.stringify(entry)).join(" | "),
        received: "supplied",
      };
    }),
    ...keys.map((key) => ({
      path: key,
      code: "not_allowed",
      message: `${key} is not an input of ${definition.id}; the fields it accepts: ${acceptedList}`,
      expected: acceptedList,
      received: "supplied",
    })),
    ...admissionDiagnostics,
  ];
  const details = {
    action: definition.id,
    ...(identity === undefined ? {} : { identity: { selectors: unpublished, trust: "off" } }),
    ...(selectors.length === 0 ? {} : {
      selectors: selectors.map((selector) => ({ key: sanitizeInputScalar(selector.key), acceptingActions: selector.acceptingActions })),
    }),
    ...(rejected.length === 0 ? {} : { fields: keys, acceptedFields: accepted }),
    ...(acceptingActions.length === 0 ? {} : { acceptingActions }),
  };
  return identity === undefined
    ? refusalEnvelope({
      command: definition.id,
      status: "usage",
      code: "command.invalid-input",
      exitCode: 2,
      message,
      helpRoute: `mstar schema --family ${family.family}`,
      recovery,
      diagnostics,
      details,
    })
    : refusalEnvelope({
      command: definition.id,
      status: "refused",
      code: "mcp.caller-identity-unavailable",
      exitCode: 1,
      message,
      helpRoute: `mstar schema --command ${definition.id}`,
      recovery,
      diagnostics,
      details,
    });
}

export function registerMcpCommands(
  server: McpServer,
  definitions: readonly CommandDefinition[],
  resolveContext: ResolveContext,
  services: Array<{ close(): Promise<void> }> = [],
  onToolsRegistered?: (names: readonly string[]) => void,
): void {
  const connectionEffects = createMcpEffects(services);
  // A connection that declared no root cannot fill a root selector from a
  // launcher default, so every command that resolves its root from one must
  // receive it: publishing that selector as required is what stops a model from
  // forgetting the one fact the root resolution needs (and what makes admission
  // refuse the omission). The requirement is keyed on the DECLARED selector
  // (`rootInputs`), not on a field named `harness` — `sdd.workspace` resolves
  // its root from `controlRoot`, and advertising that as optional while the
  // resolver refuses its omission is a contract bug. A `harness` that is an
  // operation TARGET (`store.execution.*`, `rootInputs: []`) is not a root
  // selector and gains no such requirement.
  const unpinnedRootRequired = resolveContext.defaultHarness === undefined;
  // The launcher's explicit opt-in is the ONLY channel through which a
  // caller-declared session id becomes an execution identity. It is off unless
  // the deployment said otherwise (`mstar mcp --trust-caller-session-id`).
  const callerIdentity = resolveContext.callerIdentity === true;
  const prepared = new Map<string, {
    definition: CommandDefinition;
    descriptor: CommandSchemaDescriptor;
    contract: ReturnType<typeof mcpInputContract>;
    harnessDefault: boolean;
    rootInputs: readonly string[];
  }>();
  // Store-level commands are CLI-only: their payload is the whole store, so
  // publishing them on a shared connection would hand out `execution_sessions`
  // rows that no redaction can remove without breaking a restore. MCP carries
  // the runtime surface only.
  const members = definitions.filter((definition) => !isCliOnlyCommand(definition.id)).map((definition) => {
    const descriptor = getCommandSchemas([definition])[0]!;
    const selector = definition.cli.options.find((option) => option.context === "sessionId");
    const rootInputs = rootInputsOf(definition, descriptor);
    const harnessIsRoot = rootInputs.includes("harness");
    const contract = mcpInputContract(definition, descriptor, { unpinnedRootRequired, rootInputs, publishSelector: callerIdentity });
    prepared.set(definition.id, { definition, descriptor, contract, harnessDefault: harnessIsRoot, rootInputs });
    return {
      definition,
      // The composed contract's `required` is the published authority: the
      // command's own required fields plus the unpinned-connection root-selector
      // rule. The input schema's own copy predates both.
      input: { ...(descriptor.input as Readonly<Record<string, unknown>>), required: contract.jsonSchema.required },
      ...(selector === undefined || !callerIdentity ? {} : { selector: { key: selector.key } }),
    };
  });
  const families = foldFamilyTools(members);
  onToolsRegistered?.(families.map((family) => family.toolName));

  for (const family of families) {
    // The SDK owns its isError/text rejection protocol. One Standard Schema
    // issue carries the complete safe refusal, not a lossy generic Zod message.
    // Successful validation hands the admitted value to the executor: no
    // second input parse or descriptor conversion in the handler.
    const inputSchema: StandardSchemaWithJSON<unknown, FoldedAdmission> = {
      "~standard": {
        version: 1,
        vendor: "mstar-harness",
        jsonSchema: { input: () => family.descriptorView, output: () => family.descriptorView },
        validate(input) {
          const record = input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
          const action = record?.action;
          const definition = typeof action === "string" ? definitionForAction(family, action) : undefined;
          if (definition === undefined) {
            return { issues: [{ message: JSON.stringify(unknownActionRefusal(family, action, familyWideInvalidFields(family, input, callerIdentity))) }] };
          }
          // No caller-declared identity exists on this connection unless the
          // launcher opted in: the selector is unpublished, so a call that
          // supplies one is refused by name. `plan.progress` with a claimed
          // coordinator id can therefore not reach the execution ledger. The
          // fact is NOT answered on its own: it joins the rejected fields and
          // the action's own admission diagnostics in one refusal, so a second
          // attempt is never needed to surface the rest.
          const unpublishedSelectors = callerIdentity ? [] : suppliedSelectors(family, input);
          // The identity keys leave the input before the field index reads it:
          // otherwise the same key is reported twice (as an identity claim and
          // as a typo) instead of once with its real cause.
          const declaredInput = withoutFields(input, unpublishedSelectors);
          // Every input the selected action does not declare is collected
          // first, so one refusal reports all of it: the refused selectors, the
          // rejected top-level keys and the action's own admission diagnostics.
          // Both groups leave the admitted input, so admission reports only the
          // selected action's declared fields.
          const refusedSelectors = undeclaredSelectors(family, definition, declaredInput);
          const rejected = undeclaredFields(family, definition, declaredInput, callerIdentity);
          const entry = prepared.get(definition.id)!;
          // The declared root governs EVERY root selector, not only `harness`:
          // the pin must remove a `controlRoot` too, so it is read regardless of
          // which field the command uses. `handlerInput` fills the `harness`
          // field only when that field is the root (never for a target).
          const defaultHarness = resolveContext.defaultHarness;
          const rootInput = normalizedRootInputs(
            entry.rootInputs,
            strippedActionInput(withoutFields(declaredInput, [...refusedSelectors.map((selector) => selector.key), ...rejected])),
            defaultHarness,
          );
          const admitted = admitCommandInput(
            definition,
            rootInput,
            entry.descriptor,
            entry.contract.schema,
            (data) => handlerInput(definition, data, defaultHarness, entry.harnessDefault),
          );
          // The union input's root-selector requirement is computed BEFORE the
          // refusal branch is chosen, so it joins every refusal that fires: a
          // call that also carries a rejected key learns the requirement in the
          // same response instead of one retry later. Admission cannot enforce
          // it — every branch declares the field as optional so its conditional
          // alternatives survive — and the handler would then re-discover a root
          // from the invocation workspace, the silent cwd probe this rule exists
          // to remove.
          const missingRoot = entry.contract.unpinnedRootGate.find((field) => !namedRoot(field, input));
          if (unpublishedSelectors.length > 0 || refusedSelectors.length > 0 || rejected.length > 0) {
            return { issues: [{ message: JSON.stringify(undeclaredInputRefusal(family, definition, refusedSelectors, rejected, admitted.success ? undefined : admitted, unpublishedSelectors, missingRoot)) }] };
          }
          if (missingRoot !== undefined) {
            return { issues: [{ message: JSON.stringify(unpinnedRootRefusal(definition, missingRoot, admitted.success ? undefined : admitted)) }] };
          }
          return admitted.success
            ? { value: { ...admitted, definition, callRoot: callRootOf(entry.rootInputs, rootInput) } }
            : { issues: [{ message: JSON.stringify(admitted.envelope) }] };
        },
      },
    };
    // No `outputSchema` is published: one family tool serves every member's
    // output contract, and repeating the shared command envelope per tool would
    // restore most of the payload this fold removes. The per-call contract is
    // still enforced — `validateCommandOutcome` validates each response against
    // the SELECTED definition's own output schema — and the envelope shape a
    // caller needs is in the response it gets back.
    server.registerTool(family.toolName, {
      description: family.description,
      inputSchema,
    }, async (admitted, extra) => {
      // The resolver and the context consume only the primitive session
      // selector and the per-call root selector; the handler value itself
      // never leaves the capability. The connection has no identity of its
      // own, so a session id here is exactly what the caller put on the wire.
      const { definition, callRoot } = admitted;
      // A harness that names an operation target is not this call's root: only
      // a declared root selector may select the connection root, and a pinned
      // connection's selectors were already replaced or removed at the seam.
      const resolved = await resolveContext(definition, admitted.sessionId, extra.mcpReq.signal, services, connectionEffects, { harness: callRoot });
      const sessionId = admitted.sessionId ?? resolved.sessionId;
      const requestContext: InvocationContext = Object.freeze({
        ...resolved,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(resolved.host === undefined ? {} : { host: resolved.host }),
        versions: Object.freeze({ ...resolved.versions }),
        signal: extra.mcpReq.signal,
        effects: connectionEffects,
      });
      const validated = await connectionEffects.withInput(admitted.stdinText, requestContext, async () => {
        const envelope = await admitted.execute(requestContext);
        return validateCommandOutcome(definition, surfaceAssignmentRecovery(definition.id, envelope));
      });
      return {
        content: [{ type: "text", text: JSON.stringify(validated) }],
        structuredContent: validated,
        isError: validated.status !== "ok",
      };
    });
  }
}
