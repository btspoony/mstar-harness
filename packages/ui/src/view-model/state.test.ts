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

describe("a single-record read never claims absence for a null record", () => {
  const projection = (generation: number | null) => ({ generation });

  test("a null record is unavailable with the read's own reason, not absent", () => {
    const arm = resolveRecord({ data: null, projection: projection(4) }, { unreadableReason: "record not readable" });
    expect(arm).toEqual({ kind: "unavailable", reason: "record not readable" });
  });

  test("no projection generation is unavailable even when a record is present", () => {
    const arm = resolveRecord({ data: { id: "I-1" }, projection: projection(null) }, { unreadableReason: "no generation" });
    expect(arm).toEqual({ kind: "unavailable", reason: "no generation" });
  });

  test("a readable record is populated", () => {
    const arm = resolveRecord({ data: { id: "I-1" }, projection: projection(4) }, { unreadableReason: "n/a" });
    expect(arm).toEqual({ kind: "populated", value: { id: "I-1" } });
  });

  test("a pending read stays loading", () => {
    const arm = resolveRecord({ data: null, projection: projection(4) }, { phase: "loading", unreadableReason: "n/a" });
    expect(arm.kind).toBe("loading");
  });
});

describe("a plain envelope read resolves through the same arms", () => {
  const projection = (generation: number | null) => ({ generation, diagnostics: [], freshness: "current" as const, builtAt: null, checkedAt: "" });

  test("no valid projection generation is unavailable, never empty", () => {
    const arm = resolveRead({ data: [], projection: projection(null) }, {
      whenNull: "empty",
      isEmpty: (rows: readonly unknown[]) => rows.length === 0,
    });
    expect(arm.kind).toBe("unavailable");
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
