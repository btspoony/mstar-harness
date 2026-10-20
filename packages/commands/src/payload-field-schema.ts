import { ISSUE_PAYLOAD_SCHEMAS, type PayloadFieldSchema } from "@mstar-harness/engine";
import { z } from "zod";

/**
 * The one projection from the engine's payload registry to an admission schema.
 *
 * `issue` publishes a registry type as a `payload` field and `plan issue-add`
 * publishes one as the ITEMS of its `entries` array, so both families read the
 * same field rules from `ISSUE_PAYLOAD_SCHEMAS` instead of restating them. The
 * registry stays the authority for which fields exist and what each accepts;
 * this module only decides how one declared field is enforced.
 */
export function fieldSchema(field: PayloadFieldSchema, condition?: string): z.ZodType {
  let schema: z.ZodType;
  if (field.type === "object") {
    schema = z.object(Object.fromEntries(Object.entries(field.properties ?? {}).map(([name, child]) => [name, fieldSchema(child, condition)])));
  } else if (field.type === "string[]") {
    let array = z.array(z.string());
    if (field.minItems !== undefined) array = array.min(field.minItems);
    if (field.itemsNonblank) array = array.refine((items) => items.every((item) => item.trim() !== ""));
    schema = array;
  } else if (field.type === "string" || field.type === "string | null") {
    // `"string | null"` is the declared union spelling (the null arm also
    // arrives as the separate `nullable` flag, applied below). Treating it as a
    // free-form string keeps the type the contract states: falling through to
    // `z.unknown()` would accept any JSON value where the domain declares a
    // string-or-null.
    if (field.values !== undefined) {
      // An enum is its own constraint: every member is a non-empty string by
      // construction, so `nonblankWhenPresent` has nothing left to assert on it
      // (applying a refine here would be provably-true dead code). It applies
      // only to a free-form string.
      schema = z.enum(field.values as [string, ...string[]]);
    } else {
      let text = z.string();
      if (field.nonblankWhenPresent) text = text.refine((value) => value.trim() !== "", `${field.description ?? "field"} must be nonblank when present`);
      schema = text;
    }
  } else {
    schema = z.unknown();
  }
  if (field.nullable) schema = schema.nullable();
  return field.required || (condition !== undefined && field.requiredWhen?.includes(condition) === true) ? schema : schema.optional();
}

/**
 * One registry type as an object schema. `condition` names the disposition (or
 * verb) whose `requiredWhen` fields become required, so a conditional payload
 * keeps the requirement the registry declares for that branch.
 */
export function payloadSchema(
  typeName: keyof typeof ISSUE_PAYLOAD_SCHEMAS,
  condition?: string,
): z.ZodObject<Record<string, z.core.$ZodType>> {
  const fields = ISSUE_PAYLOAD_SCHEMAS[typeName] as Record<string, PayloadFieldSchema>;
  return z.object(Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, fieldSchema(field, condition)])));
}
