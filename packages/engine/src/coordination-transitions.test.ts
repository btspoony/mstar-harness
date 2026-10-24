import { describe, expect, test } from "bun:test";
import { CoordinationError } from "./coordination-write.js";
import { projectBucketOf } from "./coordination-transitions.js";
import { _DEFAULT_PROJECT } from "./project.js";
import type { PlanRow } from "./status.js";

describe("projectBucketOf", () => {
  test("proves the project bucket for a valid component", () => {
    expect(projectBucketOf({ metadata: { project_id: "alpha-1" } } as unknown as PlanRow)).toBe("alpha-1");
    expect(projectBucketOf({ metadata: {} } as unknown as PlanRow)).toBe(_DEFAULT_PROJECT);
  });

  test("refuses an unsafe project id with a stable message and keeps the raw cause", () => {
    let refusal: unknown;
    try {
      projectBucketOf({ metadata: { project_id: "../escape" } } as unknown as PlanRow);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CoordinationError);
    const error = refusal as CoordinationError;
    expect(error.code).toBe("coordination.invalid-input");
    expect(error.message).toContain("Invalid metadata.project_id: it must be a single safe path component.");
    expect(error.message).toContain("mstar status validate");
    expect(error.details.field).toBe("metadata.project_id");
    expect(String(error.details.cause)).toContain("metadata.project_id must be a single safe path component");
  });
});
