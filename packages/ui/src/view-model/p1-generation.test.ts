import { describe, expect, test } from "bun:test";

import { resolveRead, resolveRecord } from "./state";

const noGeneration = { generation: null } as const;
const published = { generation: 4 } as const;

describe("P1: a null generation does not veto a successful read", () => {
  test("a store-backed read renders with no published generation", () => {
    // Issues, Projects and Roadmap do not need the execution projection at all; the
    // engine answers their envelopes with `generation: null` and a real payload.
    const arm = resolveRead({ data: { items: [1, 2] }, projection: noGeneration }, { whenNull: "empty" });
    expect(arm.kind).toBe("populated");
  });

  test("a single record renders with no published generation", () => {
    const arm = resolveRecord({ data: { id: "I-1" }, projection: noGeneration }, { unavailableReason: "x" });
    expect(arm.kind).toBe("populated");
  });

  test("a read that DECLARES it needs the projection still reports unavailable", () => {
    // The execution views live in the projection: their rows cannot be trusted without
    // a generation, and that veto must survive.
    const list = resolveRead(
      { data: { items: [1] }, projection: noGeneration },
      { whenNull: "empty", requiresProjection: true },
    );
    expect(list.kind).toBe("unavailable");
    const one = resolveRecord(
      { data: { id: "w" }, projection: noGeneration },
      { unavailableReason: "x", requiresProjection: true },
    );
    expect(one.kind).toBe("unavailable");
  });

  test("a published generation changes nothing for either kind of read", () => {
    expect(resolveRead({ data: { items: [] }, projection: published }, { whenNull: "empty", isEmpty: () => true }).kind).toBe("empty");
    expect(resolveRecord({ data: { id: "a" }, projection: published }, { unavailableReason: "x" }).kind).toBe("populated");
  });
});
