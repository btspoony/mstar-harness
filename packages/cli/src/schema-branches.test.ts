import { describe, expect, test } from "bun:test";
import { inputFields, unionBranchSchemas } from "./schema-branches";

/**
 * The union traversal is the ONE reading of "which keywords publish an input
 * object's fields", shared by the folded family index (`mcp/fold.ts` — the
 * surface every MCP caller reads) and the rendered contract
 * (`command-adapter.ts` — payload-field list and CLI option types).
 *
 * A copy that lagged one keyword would leave an action ACCEPTING a field the
 * published surface no longer names: admission strips the value silently, so
 * nothing fails loudly. No current definition publishes a `oneOf` input, which
 * is exactly why the traversal is pinned here rather than only through a real
 * command: the next input that needs `oneOf` must be covered by construction.
 */
describe("the shared input-schema union traversal", () => {
  test("reads the root and every anyOf / oneOf alternative, transitively", () => {
    const root = {
      properties: { action: { type: "string" } },
      anyOf: [
        { properties: { first: { type: "string" } } },
        {
          oneOf: [
            { properties: { second: { type: "number" } } },
            { properties: { third: { type: "boolean" } } },
          ],
        },
      ],
    };
    const names = [...inputFields(root).keys()].sort();
    expect(names).toEqual(["action", "first", "second", "third"]);
  });

  test("keeps the root's declaration first on a shared key", () => {
    const root = {
      properties: { branch: { type: "string" } },
      anyOf: [{ properties: { branch: { type: "string", enum: ["from-branch"] } } }],
    };
    const fields = inputFields(root);
    // The transport decides what a key the called action does not declare, so
    // it must see the root's own shape, not an alternative's.
    expect(fields.get("branch")).toEqual({ type: "string" });
  });

  test("never descends into a property's own alternatives", () => {
    // A nested `payload` union describes the VALUE of `payload`; reading its
    // members as input fields would advertise a field the caller cannot pass.
    const root = {
      properties: {
        payload: { oneOf: [{ properties: { nested: { type: "string" } } }] },
      },
    };
    expect([...inputFields(root).keys()]).toEqual(["payload"]);
    expect(unionBranchSchemas(root)).toHaveLength(1);
  });

  test("tolerates a schema that publishes no fields", () => {
    expect(inputFields({ type: "object" }).size).toBe(0);
    expect(inputFields(null).size).toBe(0);
    expect(inputFields({ properties: { broken: null } }).size).toBe(0);
    expect(unionBranchSchemas("not-a-schema")).toEqual([]);
  });
});
