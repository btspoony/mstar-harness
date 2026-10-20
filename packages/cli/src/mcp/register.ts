import type { McpServer, StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { admitCommandInput, getCommandSchemas, isPayloadPlaceholder, refusalEnvelope } from "@mstar-harness/commands";
import { z } from "zod";
import type { CommandAdmission, CommandDefinition, CommandEnvelope, CommandSchemaDescriptor, InvocationContext } from "@mstar-harness/commands";
import { createMcpEffects, type McpEffects } from "./effects.js";
import { actionOf, definitionForAction, foldFamilyTools, type FoldedFamilyTool } from "./fold.js";
import { surfaceAssignmentRecovery } from "../command-adapter.js";
import { validateCommandOutcome } from "./outcome.js";
/**
 * Resolve the invocation context for one admitted call. It receives only the
 * immutable primitive session selector admission already validated — never the
 * handler value — so a resolver cannot reach or replace what the handler will
 * observe.
 *
 * `defaultSessionId` is the identity a launcher declared for every call (the
 * stdio server's `--identity-env` channel). It is read at admission so a
 * required session selector is satisfied by that declared default. On a
 * GENERIC unbound connection the per-call selector still wins; on a connection
 * whose identity the launcher LOCKED (`identityLocked` — a declared channel
 * whose variable resolved a USABLE session id at launch, the engine's single
 * safe-session-id rule: one safe path component `[A-Za-z0-9._-]+`, at most 128
 * characters, the scoped mount), no selector is published and a caller-supplied
 * one is stripped before admission, so the declared identity is the only
 * identity the connection can run under. The lock is set only for a value the
 * engine rule accepts: an invalid declaration is never a default — it is
 * dropped at launch, so the connection stays generic and the launch warning
 * states the rule and the recovery.
 *
 * `defaultHarness` is the root a launcher pinned for every call (the stdio
 * server's `--harness` channel). Commands that resolve their own root from an
 * `input.harness` field never read `controlRoot`, so admission fills that
 * field from this default when the call left it unset or blank; an explicit
 * non-blank per-call value still wins.
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
  readonly defaultSessionId?: string;
  readonly defaultHarness?: string;
  /**
   * True when the launcher locked this connection's identity: a declared
   * `--identity-env` channel WHOSE VARIABLE RESOLVED a USABLE session id at
   * launch (one safe path component `[A-Za-z0-9._-]+`, at most 128 characters,
   * per the engine's single safe-session-id rule; the per-agent scoped mount).
   * A declared channel the rule refuses, or one that is unset or blank, locks
   * nothing — the connection stays generic, names the cause, the rule and the
   * recoveries at launch without echoing the rejected value, and keeps the
   * per-call selector. On a locked connection the tools publish no session
   * selector and a caller-supplied selector is stripped BEFORE admission, so
   * the execution context uses the connection identity; generic unbound
   * connections keep the selector.
   */
  readonly identityLocked?: boolean;
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
 * The descriptor a LOCKED connection publishes: the identity is the
 * connection's, so the session selector is not an input the caller may
 * supply. Publication must agree with the input schema — a `CLI:` usage token,
 * a `required` entry or a "Caller-supplied" requirement naming `--session-id`
 * would advertise a parameter the tool does not publish and silently strips.
 * The shared descriptor is never mutated; the returned shallow view is the
 * only descriptor a locked connection renders or filters requirements from.
 */
function lockedDescriptor(descriptor: CommandSchemaDescriptor, selectorKey: string): CommandSchemaDescriptor {
  return {
    ...descriptor,
    required: descriptor.required.filter((field) => field !== selectorKey),
    requirements: descriptor.requirements.filter((entry) => entry.name !== selectorKey),
    cli: { ...descriptor.cli, options: descriptor.cli.options.filter((option) => option.key !== selectorKey) },
  };
}

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
 * `descriptor` is the published view: on a locked connection the caller passes
 * the selector-free `lockedDescriptor`, so `x-mstar-requirements` never names
 * the session selector while a generic connection keeps it.
 */
function mcpInputContract(definition: CommandDefinition, descriptor: CommandSchemaDescriptor, identityLocked: boolean) {
  const input = definition.input;
  const jsonSchema = descriptor.input as Record<string, unknown>;
  if (!(input instanceof z.ZodObject)) return { schema: input, jsonSchema };
  const properties = { ...jsonSchema.properties as Record<string, Record<string, unknown>> };
  const composed: Record<string, z.core.$ZodType> = {};
  for (const [field, payload] of Object.entries(definition.payloads ?? {})) {
    if (!isPayloadPlaceholder(input.shape[field])) continue;
    composed[field] = payload.schema.optional();
    properties[field] = descriptor.payloadSchemas[field] as Record<string, unknown>;
  }
  const extended = Object.keys(composed).length === 0 ? input : input.safeExtend(composed);
  const selector = definition.cli.options.find((option) => option.context === "sessionId");
  const requiredShape: Record<string, z.core.$ZodType> = {};
  for (const field of descriptor.required) {
    if (field === selector?.key) continue;
    const declared = extended.shape[field];
    if (declared instanceof z.ZodOptional) requiredShape[field] = declared.unwrap();
  }
  let schema = Object.keys(requiredShape).length === 0 ? extended : extended.safeExtend(requiredShape);
  // The session selector is published ONLY on a generic unbound connection.
  // A locked connection (a declared `--identity-env` channel whose variable
  // resolved a USABLE session id at launch — one safe path component
  // `[A-Za-z0-9._-]+`, at most 128 characters, per the engine's single
  // safe-session-id rule, the scoped per-agent mount) publishes no selector:
  // the identity belongs to the connection, and a published field a handler
  // then strips would invite exactly the override the lock forbids. A declared
  // channel the rule refuses, or one that is unset or blank, keeps the
  // connection generic and keeps publishing the selector.
  if (selector !== undefined && !identityLocked) {
    schema = schema.safeExtend({ [selector.key]: z.string().optional() });
    properties[selector.key] = { type: "string" };
  }
  for (const [field, value] of Object.entries(descriptor.defaults)) {
    if (properties[field] !== undefined) properties[field] = { ...properties[field], default: value };
  }
  const required = selector === undefined ? descriptor.required : descriptor.required.filter((field) => field !== selector.key);
  const requirements = descriptor.requirements.filter((entry) => entry.route === "mcp");
  return {
    schema,
    jsonSchema: {
      ...jsonSchema,
      required,
      properties,
      "x-mstar-requirements": requirements,
    },
  };
}

/**
 * A launcher-pinned root is only a default for a field the tool publishes: an
 * unset `input.harness` is filled from `defaultHarness` when the tool's declared
 * input schema advertises `harness`, and an explicit per-call value is never
 * overridden. A blank or whitespace-only value is not an override: the engine's
 * own root resolution treats it as absent, so treating it as explicit here
 * would silently fall back to the cwd probe. A tool that names no such field
 * receives nothing.
 */
function declaresHarness(contract: { jsonSchema: Record<string, unknown> }): boolean {
  const properties = contract.jsonSchema.properties;
  return properties !== null && typeof properties === "object" && Object.hasOwn(properties, "harness");
}

function handlerInput(definition: CommandDefinition, input: unknown, defaultHarness: string | undefined): unknown {
  if (input === null || typeof input !== "object") return input;
  const record = input as Record<string, unknown>;
  const contextKeys = definition.cli.options.filter((option) => option.context === "sessionId").map((option) => option.key);
  const normalized = { ...record };
  for (const key of contextKeys) delete normalized[key];
  const explicit = typeof normalized.harness === "string" && normalized.harness.trim() !== "";
  if (defaultHarness !== undefined && !explicit) normalized.harness = defaultHarness;
  return normalized;
}

/**
 * Normalize a blank `harness` BEFORE the tool schema runs. `handlerInput` fills
 * an absent value after admission has already parsed the input, so a `min(1)`
 * harness schema would refuse `""` as a usage error while a bare optional-string
 * schema would accept it — the same call judged differently by two families
 * that resolve the same root. Writing the pinned default over a blank value at
 * the earliest seam makes both uniform, and an explicit non-blank value is
 * untouched. The caller's object is never mutated: a shallow copy carries the
 * normalized field.
 */
function normalizedBlankHarness(input: unknown, defaultHarness: string | undefined): unknown {
  if (defaultHarness === undefined || input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (typeof record.harness !== "string" || record.harness.trim() !== "") return input;
  return { ...record, harness: defaultHarness };
}

/**
 * Strip a caller-supplied session selector BEFORE admission when the
 * connection identity is locked. A locked connection (a declared
 * `--identity-env` channel whose variable resolved a USABLE session id at
 * launch per the engine's single safe-session-id rule — one safe path
 * component `[A-Za-z0-9._-]+`, at most 128 characters, the scoped per-agent
 * mount) resolves every execution context from the identity the launcher
 * declared: a caller could otherwise pass a valid foreign session id and have
 * the engine resolve THAT identity's binding and CAS token, mutating within its
 * authority. The selector stays available on generic unbound connections —
 * including a declared channel the rule refuses, or one that is unset or
 * blank, which keeps the connection generic — where it is the documented
 * per-call identity channel. The caller's object is never mutated: a shallow
 * copy carries the stripped fields.
 */
function strippedSessionInput(definition: CommandDefinition, input: unknown, locked: boolean): unknown {
  if (!locked || input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const keys = definition.cli.options.filter((option) => option.context === "sessionId").map((option) => option.key);
  if (keys.length === 0) return input;
  const record = input as Record<string, unknown>;
  if (!keys.some((key) => record[key] !== undefined)) return input;
  const normalized = { ...record };
  for (const key of keys) delete normalized[key];
  return normalized;
}

/**
 * An admitted call bound to the definition its `action` selected. The
 * transport carries that definition alongside the immutable admission so the
 * handler validates the outcome and renders the assignment recovery with the
 * SELECTED command's identity, never the family tool's name.
 */
type FoldedAdmission = Extract<CommandAdmission, { success: true }> & Readonly<{ definition: CommandDefinition }>;

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
 * The refusal a folded tool returns when `action` names no member. It carries
 * the family's real action list plus the supported recovery — the family tool
 * itself and `mstar_schema` for field detail — so the caller can retry without
 * a second discovery round.
 *
 * The supplied selector is NEVER echoed, for the same reason
 * `undeclaredSelectorRefusal` never echoes one: any caller-controlled scalar can
 * be credential-shaped, and a value copied into `message` / `diagnostics[].received`
 * is forwarded wherever the refusal is read or recorded. Only its shape is
 * reported; both `mstar_schema` examples are runnable verbatim, selector
 * included — a published next step that the tool refuses is not a recovery.
 */
function unknownActionRefusal(family: FoldedFamilyTool, action: unknown): CommandEnvelope<never> {
  const listed = family.actions.map((entry) => JSON.stringify(entry)).join(" | ");
  const received = typeof action === "string" ? "supplied" : action === undefined ? "undefined" : typeof action;
  return refusalEnvelope({
    command: family.toolName,
    status: "usage",
    code: "command.invalid-input",
    exitCode: 2,
    message: `unknown action for ${family.toolName}; available actions: ${family.actions.join(", ")}`,
    helpRoute: `mstar schema --family ${family.family}`,
    recovery: `call ${family.toolName} with "action" set to one of the available actions; for one action's fields call mstar_schema {"action":"schema","family":"${family.family}"} and then {"action":"schema","command":"${family.definitions[0]!.id}"}`,
    diagnostics: [{ path: "action", code: "not_allowed", message: `action must be one of ${listed}`, expected: listed, received }],
    details: { actions: family.actions },
  });
}

/**
 * The refusal for a session selector the SELECTED action does not declare.
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
 * The refusal names the actions that DO accept the selector (that is the
 * discovery fact the family schema cannot publish) and never echoes the
 * supplied value: a session id is a credential-shaped fact, and echoing it
 * into an error the caller may forward adds no recovery. A LOCKED connection
 * is exempt: it publishes no selector at all, and `strippedSessionInput`
 * already owns the deliberate scrape of a caller-supplied one.
 */
function undeclaredSelectorRefusal(
  family: FoldedFamilyTool,
  definition: CommandDefinition,
  input: unknown,
  locked: boolean,
): CommandEnvelope<never> | undefined {
  if (locked || input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const declared = new Set(definition.cli.options.filter((option) => option.context === "sessionId").map((option) => option.key));
  for (const selector of family.selectors) {
    if (declared.has(selector.key) || record[selector.key] === undefined) continue;
    const action = actionOf(definition.id);
    const accepting = selector.actions.map((entry) => JSON.stringify(entry));
    return refusalEnvelope({
      command: definition.id,
      status: "usage",
      code: "command.invalid-input",
      exitCode: 2,
      message: `action ${JSON.stringify(action)} of ${family.toolName} does not declare the ${JSON.stringify(selector.key)} selector; it is accepted by: ${selector.actions.join(", ")}`,
      helpRoute: `mstar schema --family ${family.family}`,
      recovery: `drop ${JSON.stringify(selector.key)} to run this action under the connection identity, or call ${family.toolName} with "action" set to one of: ${selector.actions.join(", ")}`,
      diagnostics: [{
        path: selector.key,
        code: "not_allowed",
        message: `${selector.key} is not an input of ${definition.id}; the actions that accept it: ${selector.actions.join(", ")}`,
        expected: accepting.join(" | "),
        received: "supplied",
      }],
      details: { action: definition.id, selector: selector.key, acceptingActions: selector.actions },
    });
  }
  return undefined;
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
 * The refusal for a top-level input key the SELECTED action does not accept.
 *
 * A family publishes the UNION of its members' fields, and admission validates
 * the selected member's own object schema in strip mode: a key the member does
 * not declare is discarded with no diagnostic, so the call runs without the
 * constraint the caller believes it set. A stripped filter is the worst case —
 * an unfiltered page returned to a caller that asked for a filter reads as a
 * filtered page, which is a wrong result rather than lost input. That is the
 * same rule `undeclaredSelectorRefusal` enforces for the identity selector, so
 * the transport refuses BEFORE admission for every other published key too.
 *
 * The refusal names the fields the action DOES accept (capped; `mstar_schema`
 * is the full answer), and the sibling actions when the key belongs to one of
 * them — a fact the family schema cannot publish. Only the key name is echoed,
 * never its value.
 *
 * The family selector keys and `action` are transport fields, not member
 * inputs: `action` selects the member and the selector is owned by
 * `undeclaredSelectorRefusal` (and deliberately stripped on a locked
 * connection), so neither reaches this arm.
 *
 * Nested `payload` object contents are NOT examined here: a payload contract is
 * member detail that admission owns, and this index only names top-level
 * fields. A `payload` key the selected action does not accept at all is a
 * top-level miss and refuses; a key INSIDE an accepted payload is validated by
 * the action's own payload schema, which reports its own diagnostics.
 */
function undeclaredFieldRefusal(
  family: FoldedFamilyTool,
  definition: CommandDefinition,
  input: unknown,
): CommandEnvelope<never> | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const action = actionOf(definition.id);
  const accepted = family.acceptedFields.get(action) ?? [];
  // Transport fields, never member inputs: `action` selects the member, and a
  // session selector is owned by `undeclaredSelectorRefusal` on a generic
  // connection and deliberately stripped on a locked one. Read them from the
  // family's definitions rather than from `family.selectors`: a locked
  // connection publishes no selector, so that list is empty there and a
  // supplied one must still be scraped silently, not refused as a typo.
  const transport = new Set<string>(["action"]);
  for (const member of family.definitions) {
    for (const option of member.cli.options) {
      if (option.context === "sessionId") transport.add(option.key);
    }
  }
  const declared = new Set<string>([...accepted, ...transport]);
  const rejected = Object.keys(record).find((key) => record[key] !== undefined && !declared.has(key));
  if (rejected === undefined) return undefined;
  const acceptingActions = [...family.acceptedFields]
    .filter(([sibling, fields]) => sibling !== action && fields.includes(rejected))
    .map(([sibling]) => sibling);
  const payloadNote = rejected === "payload"
    ? "; nested payload contents belong to the action's own payload schema, not to this field index"
    : "";
  return refusalEnvelope({
    command: definition.id,
    status: "usage",
    code: "command.invalid-input",
    exitCode: 2,
    message: `action ${JSON.stringify(action)} of ${family.toolName} does not accept the field ${JSON.stringify(rejected)}; it accepts: ${cappedFieldList(accepted)}${payloadNote}`,
    helpRoute: `mstar schema --family ${family.family}`,
    recovery: `drop ${JSON.stringify(rejected)}${acceptingActions.length === 0 ? "" : ` (the action(s) that accept it: ${acceptingActions.join(", ")})`}, or call mstar_schema {"action":"schema","command":${JSON.stringify(definition.id)}} for this action's real input shape`,
    diagnostics: [{
      path: rejected,
      code: "not_allowed",
      message: `${rejected} is not an input of ${definition.id}; the fields it accepts: ${cappedFieldList(accepted)}`,
      expected: cappedFieldList(accepted),
      received: "supplied",
    }],
    details: {
      action: definition.id,
      field: rejected,
      acceptedFields: accepted,
      ...(acceptingActions.length === 0 ? {} : { acceptingActions }),
    },
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
  const identityLocked = resolveContext.identityLocked === true;
  // One lock-adjusted view per member feeds every published surface: the
  // family schema, `x-mstar-requirements` and the description all agree that a
  // locked connection owns the identity. Admission keeps using the unwrapped
  // descriptor and the composed schema, exactly as the per-command route did.
  const prepared = new Map<string, {
    definition: CommandDefinition;
    descriptor: CommandSchemaDescriptor;
    contract: ReturnType<typeof mcpInputContract>;
    harnessDefault: boolean;
  }>();
  const members = definitions.map((definition) => {
    const descriptor = getCommandSchemas([definition])[0]!;
    const selector = definition.cli.options.find((option) => option.context === "sessionId");
    const published = identityLocked && selector !== undefined ? lockedDescriptor(descriptor, selector.key) : descriptor;
    const contract = mcpInputContract(definition, published, identityLocked);
    prepared.set(definition.id, { definition, descriptor, contract, harnessDefault: declaresHarness(contract) });
    return {
      definition,
      // The descriptor's `required` is the published authority (it also
      // carries the lock filter); the input schema's own copy predates it.
      input: { ...(published.input as Readonly<Record<string, unknown>>), required: published.required },
      ...(identityLocked || selector === undefined ? {} : { selector: { key: selector.key } }),
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
            return { issues: [{ message: JSON.stringify(unknownActionRefusal(family, action)) }] };
          }
          const locked = resolveContext.identityLocked === true;
          const selectorRefusal = undeclaredSelectorRefusal(family, definition, input, locked);
          if (selectorRefusal !== undefined) {
            return { issues: [{ message: JSON.stringify(selectorRefusal) }] };
          }
          const fieldRefusal = undeclaredFieldRefusal(family, definition, input);
          if (fieldRefusal !== undefined) {
            return { issues: [{ message: JSON.stringify(fieldRefusal) }] };
          }
          const entry = prepared.get(definition.id)!;
          const defaultSessionId = resolveContext.defaultSessionId;
          const defaultHarness = entry.harnessDefault ? resolveContext.defaultHarness : undefined;
          const admitted = admitCommandInput(
            definition,
            normalizedBlankHarness(strippedSessionInput(definition, strippedActionInput(input), locked), defaultHarness),
            entry.descriptor,
            entry.contract.schema,
            (data) => handlerInput(definition, data, defaultHarness),
            defaultSessionId === undefined ? undefined : { sessionId: defaultSessionId },
          );
          return admitted.success ? { value: { ...admitted, definition } } : { issues: [{ message: JSON.stringify(admitted.envelope) }] };
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
      // never leaves the capability. On a locked connection the admitted
      // selector is always undefined (stripped before admission), so the
      // connection identity below is the only identity this call can run
      // under.
      const { definition } = admitted;
      const resolved = await resolveContext(definition, admitted.sessionId, extra.mcpReq.signal, services, connectionEffects, { harness: admitted.harness });
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
