/**
 * The schemas that publish one input object's top-level fields: the schema
 * itself plus every `anyOf` / `oneOf` alternative it is a union of,
 * transitively.
 *
 * Three readers ask that one question — the folded family field index
 * (`mcp/fold.ts`), the rendered contract's payload-field list, and the CLI
 * option type scan (`command-adapter.ts`) — and each used to carry its own
 * walk. A copy lags the moment one of them learns a keyword the others do not:
 * an action then still ACCEPTS a field the published surface no longer names,
 * admission strips it, and nothing fails loudly. This module is the single
 * traversal for all three.
 *
 * Only union alternatives are descended. A nested property's own alternatives
 * describe THAT field's value, never the input object's field list, so
 * descending into them would answer a different question.
 *
 * The root is always first, so a root-level declaration wins the first-wins
 * merge its callers apply; alternative branches follow in a stable depth-first
 * order that callers must not read as declaration order.
 * @param root - one input JSON schema (whatever a definition or descriptor published).
 */
export function unionBranchSchemas(root: unknown): Readonly<Record<string, unknown>>[] {
  const branches: Record<string, unknown>[] = [];
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === null || typeof candidate !== "object") continue;
    const schema = candidate as Record<string, unknown>;
    branches.push(schema);
    for (const keyword of ["anyOf", "oneOf"]) {
      const alternatives = schema[keyword];
      if (Array.isArray(alternatives)) pending.push(...alternatives);
    }
  }
  return branches;
}

/**
 * The field declarations one input JSON schema publishes, keyed by field name:
 * the merge of every {@link unionBranchSchemas} branch's `properties`, first
 * declaration winning byte-for-byte.
 *
 * This is the field list a caller may legitimately supply at the top level of a
 * call to that command — the set admission's own object schema accepts.
 * @param root - one input JSON schema.
 */
export function inputFields(root: unknown): ReadonlyMap<string, Readonly<Record<string, unknown>>> {
  const fields = new Map<string, Record<string, unknown>>();
  for (const branch of unionBranchSchemas(root)) {
    const properties = branch.properties;
    if (properties === null || typeof properties !== "object") continue;
    for (const [key, property] of Object.entries(properties as Record<string, unknown>)) {
      if (fields.has(key)) continue;
      if (property === null || typeof property !== "object") continue;
      fields.set(key, property as Record<string, unknown>);
    }
  }
  return fields;
}
