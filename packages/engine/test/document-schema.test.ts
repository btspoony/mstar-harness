/**
 * Document schema validator — plan / assignment / sdd-brief / pm-acceptance
 * front matter declared in the plan documents (compass D15/D17).
 *
 * Spec sources:
 * - Field tables: plan `20261125-frontmatter-core` Task 3 brief — the four
 *   kind schemas, the assignment conditional budget rule
 *   (`packages/engine/src/dispatch.ts` `validateAssignmentFields` /
 *   `REVIEW_SEAT_ROLES`), the canonical-PM-template unknown-field rule
 *   (`skills/mstar-roles/references/project-manager/dispatch-and-assignment.md`
 *   `Assignment Template (Canonical)`).
 * - Violation codes: `document.frontmatter.missing` / `.unknown` /
 *   `.invalid` / `.absent`; severity missing/invalid/unknown = high.
 *
 * Fence positions: the opening `---` is document line 1, so the first
 * frontmatter key line is document line 2.
 */
import { describe, expect, test } from "bun:test";
import { documentSchema, validateDocumentFrontmatter } from "../src/document-schema.js";
import type { GateResult, ValidationResult } from "../src/core.js";

function doc(fm: string, body = "# Body\n"): string {
  return `---\n${fm}\n---\n${body}`;
}

const PLAN_FM = [
  "plan_id: 20261125-frontmatter-core",
  "execution: sdd",
  "working_branch: iteration/iter-20261125-frontmatter",
  "main_worktree_branch: 5.0",
  "delivery_kind: development",
  "status: Todo",
].join("\n");

const ASSIGNMENT_FM = [
  "execute_as: fullstack-dev",
  "delegation: forbidden",
  "task_category: logic",
  "task_budget: M — one implementer round",
  "working_branch: feature/20261125-frontmatter-core",
].join("\n");

const BRIEF_FM = ["plan_id: 20261125-frontmatter-core", "task: 3", "files:", "- packages/engine/src/document-schema.ts"].join("\n");

const ACCEPTANCE_FM = [
  "plan_id: 20261125-frontmatter-core",
  "gate: pm-acceptance",
  "verdict: Approve",
  "generated_at: 2026-11-26T08:00:00Z",
].join("\n");

function codesOf(gate: GateResult): string[] {
  return gate.violations.map((v) => v.code);
}

function onlyViolation(gate: GateResult): ValidationResult {
  expect(gate.violations.length).toBe(1);
  return gate.violations[0];
}

describe("validateDocumentFrontmatter — complete documents pass", () => {
  test("complete plan passes", () => {
    const gate = validateDocumentFrontmatter("plan", doc(`${PLAN_FM}\ntitle: Sample plan`), "sample-plan");
    expect(gate.ok).toBe(true);
    expect(gate.violations).toEqual([]);
  });

  test("complete assignment passes with optional template fields", () => {
    const gate = validateDocumentFrontmatter(
      "assignment",
      doc(
        `${ASSIGNMENT_FM}\nexecution_mode: sdd\nwrite_domain: work\nenforcement: hard\n` +
          "worktree_path: /repo.worktrees/example\nplan_id: 20261125-frontmatter-core\n" +
          "iteration_id: iter-20261125-frontmatter\nworkflow_id: wf-1\ncontrol_write_paths:\n- .mstar/notes/x.jsonl\n" +
          "skill_presets: standard\nprimary: Small feature\nacceptance_criteria: done\nreport_format: Completion Report",
      ),
      "sample-assignment",
    );
    expect(gate.ok).toBe(true);
    expect(gate.violations).toEqual([]);
  });

  test("complete sdd-brief passes", () => {
    const gate = validateDocumentFrontmatter("sdd-brief", doc(BRIEF_FM), "sample-brief");
    expect(gate.ok).toBe(true);
    expect(gate.violations).toEqual([]);
  });

  test("complete pm-acceptance passes", () => {
    const gate = validateDocumentFrontmatter("pm-acceptance", doc(ACCEPTANCE_FM), "sample-acceptance");
    expect(gate.ok).toBe(true);
    expect(gate.violations).toEqual([]);
  });
});

describe("validateDocumentFrontmatter — missing required fields", () => {
  test("missing plan fields report document.frontmatter.missing per field", () => {
    const gate = validateDocumentFrontmatter("plan", doc("plan_id: p1"), "plan");
    expect(gate.ok).toBe(false);
    const codes = codesOf(gate);
    expect(codes).toEqual([
      "document.frontmatter.missing",
      "document.frontmatter.missing",
      "document.frontmatter.missing",
      "document.frontmatter.missing",
      "document.frontmatter.missing",
    ]);
    for (const v of gate.violations) {
      expect(v.severity).toBe("high");
    }
    const fields = gate.violations.map((v) => v.message);
    expect(fields.join(" ")).toContain("execution");
    expect(fields.join(" ")).toContain("working_branch");
    expect(fields.join(" ")).toContain("main_worktree_branch");
    expect(fields.join(" ")).toContain("delivery_kind");
    expect(fields.join(" ")).toContain("status");
  });

  test("missing brief task reports missing", () => {
    const gate = validateDocumentFrontmatter("sdd-brief", doc("plan_id: p1"), "brief");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.missing");
    expect(v.message).toContain("task");
  });

  test("conditional budget/return_shape required for a review seat", () => {
    const fm = "execute_as: qc-specialist\ndelegation: forbidden\ntask_category: logic\nworking_branch: feature/x";
    const gate = validateDocumentFrontmatter("assignment", doc(fm), "assignment");
    const codes = codesOf(gate);
    expect(codes).toContain("document.frontmatter.missing");
    const messages = gate.violations.map((v) => v.message).join(" ");
    expect(messages).toContain("budget");
    expect(messages).toContain("return_shape");
    expect(messages).not.toContain("task_budget");
  });

  test("conditional budget rule also fires on audit category", () => {
    const fm = "execute_as: fullstack-dev\ndelegation: forbidden\ntask_category: audit\nworking_branch: feature/x";
    const gate = validateDocumentFrontmatter("assignment", doc(fm), "assignment");
    const messages = gate.violations.map((v) => v.message).join(" ");
    expect(messages).toContain("budget");
    expect(messages).toContain("return_shape");
  });

  test("review seat with budget and return_shape passes", () => {
    const fm =
      "execute_as: code-reviewer\ndelegation: forbidden\ntask_category: audit (secondary)\n" +
      "budget: M\nreturn_shape: verdict\nworking_branch: feature/x";
    const gate = validateDocumentFrontmatter("assignment", doc(fm), "assignment");
    expect(gate.ok).toBe(true);
  });

  test("implement round requires task_budget instead", () => {
    const fm = "execute_as: fullstack-dev\ndelegation: forbidden\ntask_category: logic\nworking_branch: feature/x";
    const gate = validateDocumentFrontmatter("assignment", doc(fm), "assignment");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.missing");
    expect(v.message).toContain("task_budget");
  });

  test("exactly one of working_branch or branch_policy", () => {
    const both =
      `${ASSIGNMENT_FM}\nbranch_policy: direct on feature/x — reason`;
    const gate = validateDocumentFrontmatter("assignment", doc(both), "assignment");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("working_branch");
  });

  test("generated_at is required as ISO-8601 on pm-acceptance", () => {
    const fm = ACCEPTANCE_FM.replace("generated_at: 2026-11-26T08:00:00Z", "generated_at: not-a-date");
    const gate = validateDocumentFrontmatter("pm-acceptance", doc(fm), "acceptance");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("generated_at");
    expect(v.message).toContain("ISO-8601");
  });
});

describe("validateDocumentFrontmatter — unknown fields", () => {
  test("unknown plan field reports document.frontmatter.unknown", () => {
    const gate = validateDocumentFrontmatter("plan", doc(`${PLAN_FM}\nsurprise: 1`), "plan");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.unknown");
    expect(v.severity).toBe("high");
    expect(v.message).toContain("surprise");
  });

  test("unknown assignment field reports unknown, canonical template keys do not", () => {
    const gate = validateDocumentFrontmatter("assignment", doc(`${ASSIGNMENT_FM}\ninvented_key: 1`), "assignment");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.unknown");
    expect(v.message).toContain("invented_key");
  });

  test("known optional assignment template keys are accepted", () => {
    const gate = validateDocumentFrontmatter(
      "assignment",
      doc(
        `${ASSIGNMENT_FM}\n` +
          [
            "sdd_implementer_session: fresh",
            "sdd_dir: /x",
            "sdd_context_file: /x/context.json",
            "skill_presets: standard",
            "qc_mode: N/A",
            "review_package_path: N/A",
            "qc_report_path: N/A",
            "who_runs_this_turn: fullstack-dev",
            "primary: Small feature",
            "dev_routing: single stream",
            "parallelism: serial",
            "additional_gates: none",
            "phase_gate_checklist: go",
            "control_harness_root: /x/.mstar",
            "review_cwd: N/A",
            "review_range: N/A",
            "diff_basis: N/A",
            "write_domain: work",
            "main_worktree_branch: 5.0",
            "acceptance_gate: pm-acceptance",
            "acceptance_gate_reason: scope",
            "findings_cleanup: allow-residual",
            "why_this_agent: role fit",
            "pm_task_board_coverage: t3",
            "roadmap_deferred_scope: N/A",
            "task_budget_ok: placeholder-unknown",
          ].join("\n"),
      ),
      "assignment",
    );
    // task_budget_ok is NOT a canonical template field, so exactly one unknown violation appears.
    expect(gate.ok).toBe(false);
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.unknown");
    expect(v.message).toContain("task_budget_ok");
  });
});

describe("validateDocumentFrontmatter — invalid values", () => {
  test("invalid plan enum reports document.frontmatter.invalid naming accepted values", () => {
    const gate = validateDocumentFrontmatter("plan", doc(PLAN_FM.replace("status: Todo", "status: Finished")), "plan");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.severity).toBe("high");
    expect(v.message).toContain("status");
    for (const accepted of ["Todo", "InProgress", "InReview", "Done", "Blocked"]) {
      expect(v.message).toContain(accepted);
    }
  });

  test("invalid delivery_kind lists accepted values", () => {
    const gate = validateDocumentFrontmatter("plan", doc(PLAN_FM.replace("delivery_kind: development", "delivery_kind: release")), "plan");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("development");
    expect(v.message).toContain("verification");
    expect(v.message).toContain("report-only");
  });

  test("brief task must be an integer", () => {
    const gate = validateDocumentFrontmatter("sdd-brief", doc("plan_id: p1\ntask: three"), "brief");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("task");
  });

  test("acceptance verdict enum is enforced", () => {
    const gate = validateDocumentFrontmatter(
      "pm-acceptance",
      doc(ACCEPTANCE_FM.replace("verdict: Approve", "verdict: Ship it")),
      "acceptance",
    );
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("Approve with residuals");
    expect(v.message).toContain("Needs Discussion");
  });

  test("acceptance gate is fixed to pm-acceptance", () => {
    const gate = validateDocumentFrontmatter("pm-acceptance", doc(ACCEPTANCE_FM.replace("gate: pm-acceptance", "gate: other")), "acceptance");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("pm-acceptance");
  });

  test("control_write_paths rejects glob entries", () => {
    const gate = validateDocumentFrontmatter(
      "assignment",
      doc(`${ASSIGNMENT_FM}\ncontrol_write_paths:\n- .mstar/plans/*`),
      "assignment",
    );
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("control_write_paths");
  });

  test("a field present twice reports invalid at high severity", () => {
    const gate = validateDocumentFrontmatter("plan", doc(`${PLAN_FM}\nstatus: Todo\nstatus: Done`), "plan");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.severity).toBe("high");
  });
});

describe("validateDocumentFrontmatter — absent front matter", () => {
  test("missing fence reports document.frontmatter.absent", () => {
    const gate = validateDocumentFrontmatter("plan", "# Plan without fence\n", "plan");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.absent");
    expect(v.severity).toBe("high");
  });

  test("unterminated fence reports absent", () => {
    const gate = validateDocumentFrontmatter("plan", `---\n${PLAN_FM}\n(no closing fence`, "plan");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.absent");
  });
});

describe("documentSchema — the field table", () => {
  test("plan schema lists required and optional fields", () => {
    const schema = documentSchema("plan");
    expect(schema.kind).toBe("plan");
    expect(schema.required.map((f) => f.name)).toEqual([
      "plan_id",
      "execution",
      "working_branch",
      "main_worktree_branch",
      "delivery_kind",
      "status",
    ]);
    expect(schema.optional.map((f) => f.name)).toContain("title");
    const status = schema.required.find((f) => f.name === "status");
    expect(status?.enum).toEqual(["Todo", "InProgress", "InReview", "Done", "Blocked"]);
  });

  test("assignment schema covers the canonical template keys", () => {
    const schema = documentSchema("assignment");
    const names = [...schema.required, ...schema.optional].map((f) => f.name);
    expect(names).toContain("execute_as");
    expect(names).toContain("execution_mode");
    expect(names).toContain("control_write_paths");
    expect(names).toContain("enforcement");
    expect(names).toContain("plan_id");
    expect(names).toContain("iteration_id");
    expect(names).toContain("workflow_id");
  });

  test("sdd-brief and pm-acceptance schemas", () => {
    expect(documentSchema("sdd-brief").required.map((f) => f.name)).toEqual(["plan_id", "task"]);
    const acceptance = documentSchema("pm-acceptance");
    expect(acceptance.required.map((f) => f.name)).toEqual(["plan_id", "gate", "verdict", "generated_at"]);
    const verdict = acceptance.required.find((f) => f.name === "verdict");
    expect(verdict?.enum).toEqual(["Approve", "Approve with residuals", "Request Changes", "Needs Discussion"]);
  });
});

describe("validateDocumentFrontmatter — violation source and gate shape", () => {
  test("violations carry the source label in the message", () => {
    const gate = validateDocumentFrontmatter("plan", "no fence here", "my-plan-doc");
    const v = onlyViolation(gate);
    expect(v.message).toContain("my-plan-doc");
  });

  test("gate with violations is not ok", () => {
    const gate = validateDocumentFrontmatter("plan", doc("plan_id: p1"), "plan");
    expect(gate.ok).toBe(false);
  });
});

describe("validateDocumentFrontmatter — T3-R1 enum type checking", () => {
  test.each([
    ["boolean", "status: true"],
    ["numeric", "status: 1"],
    ["list", "status: [Todo]"],
    ["map", "status:\n  nested: value"],
  ])("a %s status value is invalid, not accepted", (_kind, statusLine) => {
    const fm = PLAN_FM.replace("status: Todo", statusLine);
    const gate = validateDocumentFrontmatter("plan", doc(fm), "plan");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("status");
    expect(v.message).toContain("Todo");
  });

  test("assignment write_domain enum rejects non-string values", () => {
    const gate = validateDocumentFrontmatter("assignment", doc(`${ASSIGNMENT_FM}\nwrite_domain: true`), "assignment");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("control");
    expect(v.message).toContain("work");
  });

  test("acceptance verdict enum rejects numeric values", () => {
    const gate = validateDocumentFrontmatter(
      "pm-acceptance",
      doc(ACCEPTANCE_FM.replace("verdict: Approve", "verdict: 42")),
      "acceptance",
    );
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("verdict");
  });
});

describe("validateDocumentFrontmatter — T3-R2 canonical template allowlist", () => {
  test("every canonical template field is a known assignment field", () => {
    const canonicalFields = [
      ["execute_as: fullstack-dev"],
      ["delegation: forbidden"],
      ["execution_mode: sdd"],
      ["sdd_implementer_session: fresh"],
      ["sdd_dir: /x/sdd"],
      ["sdd_context_file: /x/sdd/context.json"],
      ["skill_presets: standard"],
      ["qc_mode: N/A"],
      ["review_package_path: N/A"],
      ["qc_report_path: N/A"],
      ["who_runs_this_turn: fullstack-dev"],
      ["primary: Small feature"],
      ["task_category: logic"],
      ["dev_routing: single stream"],
      ["parallelism: serial"],
      ["additional_gates: none"],
      ["phase_gate_checklist: go"],
      ["working_branch: feature/20261125-frontmatter-core"],
      ["control_harness_root: /x/.mstar"],
      ["review_cwd: /x"],
      ["worktree_path: /x"],
      ["plan_id: 20261125-frontmatter-core"],
      ["plan_scope: inherited read-only"],
      ["review_range: 5da651986..HEAD"],
      ["diff_basis: merge-base"],
      ["write_domain: work"],
      ["main_worktree_branch: 5.0"],
      ["acceptance_gate: pm-acceptance"],
      ["acceptance_gate_reason: scope"],
      ["findings_cleanup: allow-residual"],
      ["why_this_agent: role fit"],
      ["pm_task_board_coverage: t3"],
      ["roadmap_deferred_scope: N/A"],
      ["task: one deliverable"],
      ["checkpoint_comment_rule: commit then report"],
      ["why_batching_is_safe: independent ids"],
      ["scope: in/out"],
      ["inputs: brief"],
      ["budget: M"],
      ["task_budget: M — one round"],
      ["return_shape: verdict"],
      ["severity_bar: blocking"],
      ["input_provenance: observed"],
      ["deliverables: one file"],
      ["acceptance_criteria: done"],
      ["evidence_required: tests"],
      ["constraints: no expansion"],
      ["effort: M"],
      ["orchestration_guard: none"],
      ["plan_path: /x/plan.md"],
      ["report_format: Completion Report"],
      ["execution_evidence: none"],
      ["control_write_paths:", "- .mstar/notes/x.jsonl"],
    ];
    const fm = canonicalFields.map((lines) => lines.join("\n")).join("\n");
    const gate = validateDocumentFrontmatter("assignment", doc(fm), "assignment");
    const unknowns = gate.violations.filter((v) => v.code === "document.frontmatter.unknown");
    expect(unknowns).toEqual([]);
    const messages = gate.violations.map((v) => v.message).join(" ");
    expect(messages).not.toContain("checkpoint_comment_rule \u2014");
    expect(messages).not.toContain("plan_scope \u2014");
    expect(messages).not.toContain("scope \u2014");
    expect(messages).not.toContain("why_batching_is_safe \u2014");
  });
});

describe("validateDocumentFrontmatter — T3-R3 exactly one branch form for writable assignments", () => {
  const BASE = "execute_as: fullstack-dev\ndelegation: forbidden\ntask_category: logic\ntask_budget: M";

  test("writable assignment with neither branch form is invalid", () => {
    const gate = validateDocumentFrontmatter("assignment", doc(BASE), "assignment");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("branch");
  });

  test("writable assignment with both branch forms is invalid", () => {
    const gate = validateDocumentFrontmatter("assignment", doc(`${BASE}\nworking_branch: feature/x\nbranch_policy: direct on main — hotfix`), "assignment");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("working_branch");
  });

  test("writable assignment with only working_branch passes", () => {
    const gate = validateDocumentFrontmatter("assignment", doc(`${BASE}\nworking_branch: feature/x`), "assignment");
    expect(gate.ok).toBe(true);
  });

  test("writable assignment with only branch_policy passes", () => {
    const gate = validateDocumentFrontmatter("assignment", doc(`${BASE}\nbranch_policy: direct on main — hotfix`), "assignment");
    expect(gate.ok).toBe(true);
  });

  test("read-only role without any branch form passes", () => {
    const fm = "execute_as: explore\ndelegation: forbidden\ntask_category: logic\ntask_budget: XS";
    const gate = validateDocumentFrontmatter("assignment", doc(fm), "assignment");
    expect(gate.ok).toBe(true);
  });

  test("writable assignment with an empty working_branch is invalid", () => {
    const gate = validateDocumentFrontmatter("assignment", doc(`${BASE}\nworking_branch:`), "assignment");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("non-empty");
  });

  test("writable assignment with a whitespace-only working_branch is invalid", () => {
    const gate = validateDocumentFrontmatter("assignment", doc(`${BASE}\nworking_branch:   `), "assignment");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("non-empty");
  });

  test("writable assignment with an empty branch_policy is invalid", () => {
    const gate = validateDocumentFrontmatter("assignment", doc(`${BASE}\nbranch_policy:`), "assignment");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("non-empty");
  });

  test("writable assignment with a whitespace-only branch_policy is invalid", () => {
    const gate = validateDocumentFrontmatter("assignment", doc(`${BASE}\nbranch_policy:   `), "assignment");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("non-empty");
  });

  test("empty working_branch beside a non-empty branch_policy passes — empty counts as absent", () => {
    const gate = validateDocumentFrontmatter("assignment", doc(`${BASE}\nworking_branch:\nbranch_policy: direct on main — hotfix`), "assignment");
    expect(gate.ok).toBe(true);
  });

  test("both empty branch forms count as neither declared", () => {
    const gate = validateDocumentFrontmatter("assignment", doc(`${BASE}\nworking_branch:\nbranch_policy:`), "assignment");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("non-empty");
  });
});

describe("validateDocumentFrontmatter — T3-R4 strict ISO-8601 generated_at", () => {
  test("invalid calendar day 2026-02-30 is rejected", () => {
    const fm = ACCEPTANCE_FM.replace("generated_at: 2026-11-26T08:00:00Z", "generated_at: 2026-02-30T08:00:00Z");
    const gate = validateDocumentFrontmatter("pm-acceptance", doc(fm), "acceptance");
    const v = onlyViolation(gate);
    expect(v.code).toBe("document.frontmatter.invalid");
    expect(v.message).toContain("generated_at");
  });

  test("a bad suffix or shape is rejected", () => {
    for (const bad of ["2026-11-26 08:00:00Z", "2026-11-26T08:00", "2026-11-26T08:00:00", "not-a-date", "2026-11-26T25:00:00Z"]) {
      const fm = ACCEPTANCE_FM.replace("generated_at: 2026-11-26T08:00:00Z", `generated_at: "${bad}"`);
      const gate = validateDocumentFrontmatter("pm-acceptance", doc(fm), "acceptance");
      expect(gate.ok).toBe(false);
    }
  });

  test("a valid numeric offset is accepted", () => {
    const fm = ACCEPTANCE_FM.replace("generated_at: 2026-11-26T08:00:00Z", "generated_at: 2026-11-26T08:00:00+02:30");
    const gate = validateDocumentFrontmatter("pm-acceptance", doc(fm), "acceptance");
    expect(gate.ok).toBe(true);
  });

  test("leap day 2024-02-29 passes, 2026-02-29 fails", () => {
    const leap = ACCEPTANCE_FM.replace("generated_at: 2026-11-26T08:00:00Z", "generated_at: 2024-02-29T08:00:00Z");
    expect(validateDocumentFrontmatter("pm-acceptance", doc(leap), "acceptance").ok).toBe(true);
    const nonLeap = ACCEPTANCE_FM.replace("generated_at: 2026-11-26T08:00:00Z", "generated_at: 2026-02-29T08:00:00Z");
    expect(validateDocumentFrontmatter("pm-acceptance", doc(nonLeap), "acceptance").ok).toBe(false);
  });
});

describe("validateDocumentFrontmatter — T3-R5 missing-field line numbers", () => {
  test("an absent required field reports line 1", () => {
    const gate = validateDocumentFrontmatter("plan", doc("plan_id: p1"), "plan");
    for (const v of gate.violations) {
      expect(v.message).toContain("plan:1: missing required field");
    }
  });

  test("an explicitly empty required field reports its entry line", () => {
    const fm = "plan_id: p1\nstatus:\nexecution: sdd\nworking_branch: b\nmain_worktree_branch: m\ndelivery_kind: development";
    const gate = validateDocumentFrontmatter("plan", doc(fm), "plan");
    const missing = gate.violations.filter((v) => v.code === "document.frontmatter.missing" && v.message.includes("status"));
    expect(missing.length).toBe(1);
    expect(missing[0].message).toContain("plan:3: missing required field status");
  });
});

describe("validateDocumentFrontmatter — T3-R6 empty fenced front matter", () => {
  test("a properly fenced empty front matter reports missing fields, not absent", () => {
    const gate = validateDocumentFrontmatter("plan", "---\n---\n# Body\n", "plan");
    expect(gate.ok).toBe(false);
    expect(codesOf(gate)).not.toContain("document.frontmatter.absent");
    const missingCount = gate.violations.filter((v) => v.code === "document.frontmatter.missing").length;
    expect(missingCount).toBe(6);
  });

  test("a whitespace-only fenced front matter is parsed, not absent", () => {
    const gate = validateDocumentFrontmatter("plan", "---\n\n   \n\n---\n# Body\n", "plan");
    expect(codesOf(gate)).not.toContain("document.frontmatter.absent");
    expect(codesOf(gate)).toContain("document.frontmatter.missing");
  });

  test("a comment-only fenced front matter is parsed, not absent", () => {
    const gate = validateDocumentFrontmatter("plan", "---\n# a comment\n---\n# Body\n", "plan");
    expect(codesOf(gate)).not.toContain("document.frontmatter.absent");
    expect(codesOf(gate)).toContain("document.frontmatter.missing");
  });

  test("a genuinely absent fence still reports absent", () => {
    const gate = validateDocumentFrontmatter("plan", "# no fence\n", "plan");
    expect(codesOf(gate)).toEqual(["document.frontmatter.absent"]);
  });

  test("an unterminated fence still reports absent", () => {
    const gate = validateDocumentFrontmatter("plan", "---\nplan_id: p1\n(no close", "plan");
    expect(codesOf(gate)).toEqual(["document.frontmatter.absent"]);
  });
});
