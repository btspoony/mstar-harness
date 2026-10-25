/**
 * The absence-state resolver, and the negative assertions that keep D30's
 * contraction from being undone by a later transform.
 *
 * `state.test.ts` owns two things: the four arms must be four distinct answers
 * for four distinct inputs, and `loading` must never borrow one of them.
 */
import { describe, expect, test } from "bun:test";

import {
  absenceCopyFamily,
  isAbsence,
  resolveMember,
  resolveRead,
  resolveRecord,
  resolveSubjectMember,
} from "./state.ts";

const read = <T>(data: T) => ({ state: "read" as const, data });

describe("the four absence arms are distinct answers", () => {
  test("not-applicable — the subject does not resolve", () => {
    const arm = resolveMember({ state: "not-applicable", reason: "no project resolves for this read" }, {
      whenNull: "empty",
    });
    expect(arm).toEqual({ kind: "not-applicable", reason: "no project resolves for this read" });
  });

  test("absent — the subject declares no such concept", () => {
    const arm = resolveMember(read(null), { whenNull: "absent" });
    expect(arm).toEqual({ kind: "absent" });
  });

  test("empty — the read succeeded and the collection holds nothing", () => {
    const arm = resolveMember(read<readonly string[]>([]), {
      whenNull: "empty",
      isEmpty: (rows) => rows.length === 0,
    });
    expect(arm).toEqual({ kind: "empty" });
  });

  test("unavailable — the read failed, carrying the store's own reason", () => {
    const arm = resolveMember({ state: "unavailable", reason: "no such table: projection_workflows" }, {
      whenNull: "empty",
    });
    expect(arm).toEqual({ kind: "unavailable", reason: "no such table: projection_workflows" });
  });

  test("populated carries the value", () => {
    expect(resolveMember(read(["a"]), { whenNull: "empty" })).toEqual({ kind: "populated", value: ["a"] });
  });
});

describe("loading is a phase, not a subject state", () => {
  test("every member reports loading while the transport is reading", () => {
    for (const member of [
      read(null),
      read(["x"]),
      { state: "not-applicable" as const, reason: "no project" },
      { state: "unavailable" as const, reason: "failed" },
    ]) {
      expect(resolveMember(member, { phase: "loading", whenNull: "empty" }).kind).toBe("loading");
    }
  });

  test("loading borrows none of the four absence copy families", () => {
    expect(absenceCopyFamily("loading")).toBeNull();
    expect(isAbsence("loading")).toBe(false);
  });

  test("each absence arm owns its own copy family and populated owns none", () => {
    const families = (["not-applicable", "absent", "empty", "unavailable"] as const).map((arm) =>
      absenceCopyFamily(arm),
    );
    expect(families).toEqual(["state.not-applicable", "state.absent", "state.empty", "state.unavailable"]);
    expect(new Set(families).size).toBe(4);
    expect(absenceCopyFamily("populated")).toBeNull();
    expect(absenceCopyFamily("loading")).toBeNull();
  });
});

describe("an un-resolved subject is not-applicable, and only the resolver decides", () => {
  // The point of this entry point: one decision point for `not-applicable`. A
  // screen that derived the arm itself would be a second authority, and the same
  // read would then be called two different things in two places.
  test("subject un-resolved + a successful read that returned nothing → not-applicable", () => {
    const arm = resolveSubjectMember(read(null), {
      whenNull: "absent",
      subjectResolves: false,
      unresolvedReason: "no active workflow",
    });
    expect(arm).toEqual({ kind: "not-applicable", reason: "no active workflow" });
  });

  test("subject resolved + the same read → absent, not not-applicable", () => {
    const arm = resolveSubjectMember(read(null), {
      whenNull: "absent",
      subjectResolves: true,
      unresolvedReason: "no active workflow",
    });
    expect(arm).toEqual({ kind: "absent" });
  });

  test("a statement the store already made wins over the subject test", () => {
    // An unavailable read is not the resolver's to reinterpret.
    const arm = resolveSubjectMember({ state: "unavailable", reason: "read failed" }, {
      whenNull: "absent",
      subjectResolves: false,
      unresolvedReason: "no active workflow",
    });
    expect(arm).toEqual({ kind: "unavailable", reason: "read failed" });
  });

  test("a pending read never borrows the subject answer", () => {
    const arm = resolveSubjectMember(read(null), {
      phase: "loading",
      whenNull: "absent",
      subjectResolves: false,
      unresolvedReason: "no active workflow",
    });
    expect(arm.kind).toBe("loading");
  });

  test("a populated read passes through untouched", () => {
    const arm = resolveSubjectMember(read(["a"]), {
      whenNull: "empty",
      subjectResolves: true,
      unresolvedReason: "n/a",
    });
    expect(arm).toEqual({ kind: "populated", value: ["a"] });
  });
});

describe("a single-record read: null is absent, a failed read is unavailable", () => {
  const projection = (generation: number | null) => ({ generation });

  // The ruling, in one place: `null` means absent EVERYWHERE. A failed read
  // answers `unavailable` with the store's reason, so a null payload cannot also
  // mean "could not read" — that would give one fact two answers.
  test("a null record is absent", () => {
    const arm = resolveRecord({ data: null, projection: projection(4) }, { unavailableReason: "read failed" });
    expect(arm).toEqual({ kind: "absent" });
  });

  test("a missing payload is unavailable and carries the store's reason", () => {
    const arm = resolveRecord({ data: undefined, projection: projection(3) } as never, {
      unavailableReason: "read failed",
    });
    expect(arm).toEqual({ kind: "unavailable", reason: "read failed" });
  });

  test("a view that needs the projection is vetoed before its payload is read", () => {
    // For the execution views the projection IS the source, so a missing generation
    // must beat a present record: it can never be mistaken for content.
    const arm = resolveRecord({ data: { id: "w-1" }, projection: projection(null) }, {
      unavailableReason: "no generation",
      requiresProjection: true,
    });
    expect(arm).toEqual({ kind: "unavailable", reason: "no generation" });
  });

  test("a store-backed view is not vetoed by a missing generation", () => {
    const arm = resolveRecord({ data: { id: "I-1" }, projection: projection(null) }, { unavailableReason: "no generation" });
    expect(arm.kind).toBe("populated");
  });

  test("an omitted payload is unavailable, not a populated undefined", () => {
    // `undefined` is not `null`: a host mapping that forgets the member must reach
    // the failure arm, because `populated(undefined)` throws on first access.
    const arm = resolveRecord({ data: undefined, projection: projection(4) } as unknown as {
      data: { id: string } | null;
      projection: { generation: number | null };
    }, { unavailableReason: "read failed" });
    expect(arm).toEqual({ kind: "unavailable", reason: "read failed" });
  });

  test("a readable record is populated", () => {
    const arm = resolveRecord({ data: { id: "I-1" }, projection: projection(4) }, { unavailableReason: "n/a" });
    expect(arm).toEqual({ kind: "populated", value: { id: "I-1" } });
  });

  test("a pending read stays loading", () => {
    const arm = resolveRecord({ data: null, projection: projection(4) }, { phase: "loading", unavailableReason: "n/a" });
    expect(arm.kind).toBe("loading");
  });
});

describe("a malformed envelope reaches the unavailable arm, not a throw", () => {
  // A host mapping is a trust boundary: a member it forgot is a failure to state,
  // not a renderer crash.
  test("an envelope with no projection", () => {
    const arm = resolveRead({ data: [], projection: undefined } as unknown as {
      data: never[];
      projection: { generation: number | null };
    }, { whenNull: "empty", isEmpty: (rows: readonly unknown[]) => rows.length === 0 });
    expect(arm.kind).toBe("unavailable");
    expect(arm.kind === "unavailable" ? arm.reason : "").toContain("no projection");
  });

  test("an envelope with no payload", () => {
    const arm = resolveRead({ data: undefined, projection: { generation: 4 } } as unknown as {
      data: readonly unknown[];
      projection: { generation: number | null };
    }, { whenNull: "empty" });
    expect(arm.kind).toBe("unavailable");
  });

  test("a record read with no projection", () => {
    const arm = resolveRecord({ data: null, projection: undefined } as unknown as {
      data: null;
      projection: { generation: number | null };
    }, { unavailableReason: "read failed" });
    expect(arm).toEqual({ kind: "unavailable", reason: "read failed" });
  });
});

describe("a plain envelope read resolves through the same arms", () => {
  const projection = (generation: number | null) => ({ generation, diagnostics: [], freshness: "current" as const, builtAt: null, checkedAt: "" });

  test("a store-backed read with no generation is empty, not unavailable", () => {
    const arm = resolveRead({ data: [], projection: projection(null) }, {
      whenNull: "empty",
      isEmpty: (rows: readonly unknown[]) => rows.length === 0,
    });
    expect(arm.kind).toBe("empty");
    // The veto belongs to the views that declare it, and survives there.
    const vetoed = resolveRead({ data: [], projection: projection(null) }, {
      whenNull: "empty",
      isEmpty: (rows: readonly unknown[]) => rows.length === 0,
      requiresProjection: true,
    });
    expect(vetoed.kind).toBe("unavailable");
  });

  test("a valid generation with no rows is empty", () => {
    const arm = resolveRead({ data: [], projection: projection(3) }, {
      whenNull: "empty",
      isEmpty: (rows: readonly unknown[]) => rows.length === 0,
    });
    expect(arm).toEqual({ kind: "empty" });
  });

  test("a degraded member leaves its neighbours readable (per-member, not per-page)", () => {
    // The rule IA §5 rule 3 states: one failed member degrades that member only.
    const failed = resolveMember({ state: "unavailable", reason: "read failed" }, { whenNull: "empty" });
    const healthy = resolveMember(read(["row"]), { whenNull: "empty" });
    expect(failed.kind).toBe("unavailable");
    expect(healthy.kind).toBe("populated");
  });
});
