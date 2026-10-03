/**
 * Engine roles module — role mapping / parameter-table validation and the
 * load-order lint (thin; roadmap §8.2 `roles` row, §4.3).
 *
 * Source skills (semantic SSOT — this module implements their deterministic
 * rules, it never redefines them; roadmap §8.5 C2):
 * - `mstar-roles` SKILL.md § Role Reference Mapping — the 14 agent ids →
 * `references/<role>.md` table (shared families `fullstack-dev*` /
 * `qc-specialist*` on ONE shared file per § Maintenance Rules).
 * - `mstar-roles` SKILL.md § Parameter Table (SSOT) — dev track
 * `primary` / `parallel_secondary`; QC seats `reviewer_index` 1/2/3,
 * each with a `focus` and a `qc<index>` `report_suffix` landing at
 * `{SDD_DIR}/review/qc1.md`…`qc3.md`.
 * - `mstar-harness-core` SKILL.md § 与其它 `mstar-*` skill 的加载契约 —
 * core stays the lifecycle/authorization semantic authority; the LOAD
 * SELECTION authority is `mstar-roles` (Spec A2: single load-selection
 * authority, no second mandatory-role table). Direct topics declare core
 * first in their Load Order / First action section, except standalone
 * `mstar-coding-behavior`, which has no mandatory load declaration, and
 * the `mstar-roles` hub bootstrap, which declares its identity→preset
 * decision matrix (identity-first, `Skill presets:` none/standard arms,
 * role-owned methods, unknown-preset refusal) and conditional core
 * conflict-authority pointer. Both exceptions are keyed on exact names.
 *
 * The parameter tables live here as machine data (roadmap §4.3:
 * "parameter tables → data"); `validateRoleMapping` checks the tables'
 * integrity against the on-disk skill layout and the parameter contract.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { GateResult, Severity, ValidationResult } from "./core.js";

function violation(severity: Severity, code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

/** One row of the role reference mapping (mstar-roles § Role Reference
 * Mapping): `agentId` → skill-relative reference file. */
export type RoleMappingEntry = { agentId: string; reference: string };

/** The 14 role ids → `references/<role>.md` mapping, embedded as data
 * (mstar-roles § Role Reference Mapping; shared families point at the
 * shared reference files). */
export const ROLE_MAPPING: readonly RoleMappingEntry[] = [
  { agentId: "project-manager", reference: "references/project-manager.md" },
  { agentId: "product-manager", reference: "references/product-manager.md" },
  { agentId: "architect", reference: "references/architect.md" },
  { agentId: "code-reviewer", reference: "references/code-reviewer.md" },
  { agentId: "fullstack-dev", reference: "references/fullstack-dev-shared.md" },
  { agentId: "fullstack-dev-2", reference: "references/fullstack-dev-shared.md" },
  { agentId: "frontend-dev", reference: "references/frontend-dev.md" },
  { agentId: "qa-engineer", reference: "references/qa-engineer.md" },
  { agentId: "qc-specialist", reference: "references/qc-specialist-shared.md" },
  { agentId: "qc-specialist-2", reference: "references/qc-specialist-shared.md" },
  { agentId: "qc-specialist-3", reference: "references/qc-specialist-shared.md" },
  { agentId: "ops-engineer", reference: "references/ops-engineer.md" },
  { agentId: "writing-specialist", reference: "references/writing-specialist.md" },
  { agentId: "prompt-engineer", reference: "references/prompt-engineer.md" },
];

/** A role family that MUST resolve to one shared reference file
 * (mstar-roles § Maintenance Rules: "Keep shared-family roles
 * (`fullstack-dev*`, `qc-specialist*`) on one shared reference file"). */
export type RoleFamily = { family: string; memberIds: readonly string[] };

export const SHARED_FAMILIES: readonly RoleFamily[] = [
  { family: "fullstack-dev", memberIds: ["fullstack-dev", "fullstack-dev-2"] },
  { family: "qc-specialist", memberIds: ["qc-specialist", "qc-specialist-2", "qc-specialist-3"] },
];

/** Dev-track parameter row (mstar-roles § Parameter Table (SSOT) — dev
 * track): `primary` (backend-led) or `parallel_secondary` (second track). */
export type DevTrackParam = { roleId: string; track: "primary" | "parallel_secondary" };

export const DEV_TRACK_PARAMS: readonly DevTrackParam[] = [
  { roleId: "fullstack-dev", track: "primary" },
  { roleId: "fullstack-dev-2", track: "parallel_secondary" },
];

/** QC reviewer parameter row (mstar-roles § Parameter Table (SSOT) — QC
 * reviewer): seat index, review focus, and the `qc<index>` report suffix
 * that lands at `{SDD_DIR}/review/qc<index>.md`. */
export type QcReviewerParam = { roleId: string; reviewerIndex: number; focus: string; reportSuffix: string };

export const QC_REVIEWER_PARAMS: readonly QcReviewerParam[] = [
  {
    roleId: "qc-specialist",
    reviewerIndex: 1,
    focus: "Architecture coherence and maintainability risk",
    reportSuffix: "qc1",
  },
  {
    roleId: "qc-specialist-2",
    reviewerIndex: 2,
    focus: "Security and correctness risk",
    reportSuffix: "qc2",
  },
  {
    roleId: "qc-specialist-3",
    reviewerIndex: 3,
    focus: "Performance and reliability risk",
    reportSuffix: "qc3",
  },
];

/** Override point for tests / future role-table extensions; every slot
 * defaults to the embedded SSOT tables above. */
export type RoleMappingOptions = {
  mapping?: readonly RoleMappingEntry[];
  families?: readonly RoleFamily[];
  devTrack?: readonly DevTrackParam[];
  qcReviewers?: readonly QcReviewerParam[];
};

/**
 * Validate the role mapping + parameter tables against the on-disk skill
 * layout (mstar-roles § Role Reference Mapping / § Parameter Table (SSOT)
 * / § Maintenance Rules):
 * - every mapped agent id resolves to `references/<role>.md` under
 * `rolesDir`;
 * - shared families (`fullstack-dev*`, `qc-specialist*`) resolve to ONE
 * shared reference file each;
 * - every parameter row references a mapped role, exactly once;
 * - dev track values are `primary` / `parallel_secondary`;
 * - the QC parameter table contract holds: reviewer_index is exactly
 * {1, 2, 3} across the three seats, each seat has a focus, and
 * `report_suffix === qc<reviewer_index>`.
 *
 * Violations:
 * - `roles.mapping.reference.missing` — mapped reference file not on disk
 * - `roles.mapping.family.member.missing` — family member absent from mapping
 * - `roles.mapping.family.shared` — family members resolve to different files
 * - `roles.param.role.missing` — parameter row names an unmapped role
 * - `roles.param.role.duplicate` — role appears in two parameter rows
 * - `roles.param.track` — dev track value not primary/parallel_secondary
 * - `roles.param.qc.index.set` — reviewer_index set ≠ {1, 2, 3} (high)
 * - `roles.param.qc.focus.missing` — QC seat without a focus
 * - `roles.param.qc.suffix` — report_suffix ≠ qc<reviewer_index>
 */
export function validateRoleMapping(rolesDir: string, options: RoleMappingOptions = {}): GateResult {
  const mapping = options.mapping ?? ROLE_MAPPING;
  const families = options.families ?? SHARED_FAMILIES;
  const devTrack = options.devTrack ?? DEV_TRACK_PARAMS;
  const qcReviewers = options.qcReviewers ?? QC_REVIEWER_PARAMS;
  const violations: ValidationResult[] = [];

  const referenceById = new Map(mapping.map((m) => [m.agentId, m.reference]));

 // 1) Every mapped agent id resolves to references/<role>.md on disk.
  for (const { agentId, reference } of mapping) {
    if (!existsSync(join(rolesDir, reference))) {
      violations.push(
        violation(
          "medium",
          "roles.mapping.reference.missing",
          `role "${agentId}" maps to ${reference} which does not exist under ${rolesDir} (mstar-roles \u00a7 Role Reference Mapping)`,
          `create ${join(rolesDir, reference)} or fix the mapping row`,
        ),
      );
    }
  }

 // 2) Shared families point at ONE shared reference file.
  for (const { family, memberIds } of families) {
    const absent = memberIds.filter((id) => !referenceById.has(id));
    for (const id of absent) {
      violations.push(
        violation(
          "medium",
          "roles.mapping.family.member.missing",
          `shared family "${family}" member "${id}" is absent from the role mapping (mstar-roles \u00a7 Role Reference Mapping)`,
          `add "${id}" to the mapping`,
        ),
      );
    }
    if (absent.length === 0) {
      const refs = new Set(memberIds.map((id) => referenceById.get(id)));
      if (refs.size !== 1) {
        violations.push(
          violation(
            "medium",
            "roles.mapping.family.shared",
            `shared family "${family}" (${memberIds.join(", ")}) must resolve to ONE shared reference file \u2014 got ${[...refs].join(", ")} (mstar-roles \u00a7 Maintenance Rules: "Keep shared-family roles on one shared reference file")`,
            `point every "${family}" member at the same references/<role>-shared.md`,
          ),
        );
      }
    }
  }

 // 3) Parameter rows reference mapped roles, exactly once per role.
  const tableByRole = new Map<string, string>();
  const checkParamRoles = (rows: readonly { roleId: string }[], table: string): void => {
    for (const row of rows) {
      const existing = tableByRole.get(row.roleId);
      if (existing !== undefined) {
        violations.push(
          violation(
            "medium",
            "roles.param.role.duplicate",
            `role "${row.roleId}" appears in both the ${existing} and ${table} parameter rows (mstar-roles \u00a7 Parameter Table (SSOT))`,
            "remove the duplicate row",
          ),
        );
      } else {
        tableByRole.set(row.roleId, table);
      }
      if (!referenceById.has(row.roleId)) {
        violations.push(
          violation(
            "medium",
            "roles.param.role.missing",
            `${table} parameter row references unknown role "${row.roleId}" (mstar-roles \u00a7 Parameter Table (SSOT))`,
            `add "${row.roleId}" to the role mapping or drop the row`,
          ),
        );
      }
    }
  };
  checkParamRoles(devTrack, "dev track");
  checkParamRoles(qcReviewers, "QC reviewer");

 // 4) Dev track values.
  for (const row of devTrack) {
    if (row.track !== "primary" && row.track !== "parallel_secondary") {
      violations.push(
        violation(
          "medium",
          "roles.param.track",
          `dev track for "${row.roleId}" is "${String(row.track)}" \u2014 must be primary or parallel_secondary (mstar-roles \u00a7 Parameter Table (SSOT))`,
          'set track to "primary" or "parallel_secondary"',
        ),
      );
    }
  }

 // 5) QC parameter table contract: reviewer_index exactly {1, 2, 3} with
 // matching focus / report_suffix.
  const indices = qcReviewers.map((r) => r.reviewerIndex).sort((a, b) => a - b);
  const unique = new Set(indices);
  if (indices.length !== 3 || unique.size !== 3 || indices[0] !== 1 || indices[1] !== 2 || indices[2] !== 3) {
    violations.push(
      violation(
        "high",
        "roles.param.qc.index.set",
        `QC reviewer_index must be exactly {1, 2, 3} across the three qc-specialist* seats \u2014 got [${indices.join(", ")}] (mstar-roles \u00a7 Parameter Table (SSOT))`,
        "assign reviewer_index 1/2/3 to qc-specialist / qc-specialist-2 / qc-specialist-3",
      ),
    );
  }
  for (const row of qcReviewers) {
    if (row.focus.trim() === "") {
      violations.push(
        violation(
          "medium",
          "roles.param.qc.focus.missing",
          `QC seat "${row.roleId}" (reviewer_index ${row.reviewerIndex}) has an empty focus (mstar-roles \u00a7 Parameter Table (SSOT))`,
          "add the review focus",
        ),
      );
    }
    if (row.reportSuffix !== `qc${row.reviewerIndex}`) {
      violations.push(
        violation(
          "medium",
          "roles.param.qc.suffix",
          `QC seat "${row.roleId}" report_suffix "${row.reportSuffix}" must equal qc${row.reviewerIndex} \u2014 tri reports land at {SDD_DIR}/review/qc1.md\u2026qc3.md (mstar-roles \u00a7 Parameter Table (SSOT))`,
          `set report_suffix to qc${row.reviewerIndex}`,
        ),
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

/** Heading of a Load Order / First action section ("## Load Order
 * (Required)", "## Load order（必读顺序）", "## First action"). */
const LOAD_ORDER_HEADING_RE = /^#{1,6}\s+[^\r\n]*\b(?:load[\s-]*order|first\s+action)\b[^\r\n]*$/i;

/** Required bootstrap assertions of the `mstar-roles` hub Load Order
 * section (mstar-roles § Load Order = single load-selection authority;
 * Spec A2 "identity→none/standard/methods assertions"): the identity
 * boundary, the Assignment `Skill presets:` decision field with its
 * `none` and `standard` arms, role-owned methods that load regardless of
 * preset, and the unknown-preset / missing-identity refusal arm.
 * Case-insensitive substring tokens — the hub declares the decision, the
 * lint verifies each arm is declared. */
const HUB_BOOTSTRAP_ASSERTIONS: ReadonlyArray<{ marker: string; why: string }> = [
  { marker: "identity-first", why: "identity boundary before any skill list" },
  { marker: "skill presets", why: "Assignment Skill presets decision field" },
  { marker: "none", why: "explicit none => identity only, no optional topic preset" },
  { marker: "standard", why: "omitted on a substantive round => standard preset" },
  { marker: "role-owned", why: "role-owned methods / evidence obligations load regardless of preset" },
  { marker: "unknown preset", why: "unknown preset / missing identity => Needs Context / Blocked, never infer PM" },
];

/**
 * Extract the first Load Order / First action section (heading + body until
 * the next heading of the same or a shallower level). Returns `null` when no
 * such heading exists.
 */
function extractLoadOrderSection(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m === null) continue;
    if (LOAD_ORDER_HEADING_RE.test(lines[i])) {
      start = i;
      level = m[1].length;
      break;
    }
  }
  if (start === -1) return null;
  const section = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m !== null && m[1].length <= level) break;
    section.push(lines[i]);
  }
  return section.join("\n");
}

/**
 * Lint load-order declarations across skill texts (mstar-harness-core
 * § 与其它 `mstar-*` skill 的加载契约 + mstar-roles § Load Order; Spec A2 —
 * single load-selection authority).
 *
 * Input: `skillTexts` maps skill name → full SKILL.md text. `mstar-harness-
 * core` itself and non-`mstar-*` skills are exempt.
 *
 * - `mstar-coding-behavior` is independently usable and exempt from
 * mandatory Load Order and core-first declarations by exact name only.
 * - Every other `mstar-*` topic skill (reached by direct invocation) must
 * have a Load Order / First action section naming `mstar-harness-core`
 * as its first dependency (mentions in later sections do not count).
 * - The `mstar-roles` hub bootstrap declares the preset decision matrix
 * instead of core-first (`roles.loadorder.hub.bootstrap.missing` when
 * tokens are missing) and retains the conditional core conflict-authority
 * pointer (`roles.loadorder.core.missing`). Broad exemptions are rejected.
 *
 * Violations:
 * - `roles.loadorder.section.missing` — no Load Order / First action section
 * - `roles.loadorder.core.missing` — topic section without the core-first
 * declaration, or hub section without the core conflict-authority pointer
 * - `roles.loadorder.hub.bootstrap.missing` — hub section missing the
 * identity→none/standard/methods/unknown-preset decision matrix
 */
export function lintLoadOrder(skillTexts: Record<string, string>): GateResult {
  const violations: ValidationResult[] = [];
  for (const [name, text] of Object.entries(skillTexts)) {
    if (!name.startsWith("mstar-") || name === "mstar-harness-core") continue;
    if (name === "mstar-coding-behavior") continue;
    const section = extractLoadOrderSection(text);
    if (section === null) {
      violations.push(
        violation(
          "medium",
          "roles.loadorder.section.missing",
          `skill "${name}" has no Load Order / First action section \u2014 mstar-* topics require a load declaration except exact mstar-coding-behavior (mstar-harness-core load contract; mstar-roles \u00a7 Load Order)`,
          `add a "## Load Order" section: topics name mstar-harness-core first; mstar-roles declares the Skill presets decision matrix`,
        ),
      );
      continue;
    }
    if (name === "mstar-roles") {
 // The one hub-bootstrap exception (Spec A2): the hub OWNS load
 // selection, so it does not declare core-first; it must declare the
 // identity→preset decision matrix and keep the conditional core
 // conflict-authority pointer. The exemption is keyed on the skill
 // name — any other topic claiming this bootstrap style still fails
 // the core-first check below (broad exemptions are rejected).
      const lower = section.toLowerCase();
      const missing = HUB_BOOTSTRAP_ASSERTIONS.filter((a) => !lower.includes(a.marker.toLowerCase()));
      if (missing.length > 0) {
        violations.push(
          violation(
            "medium",
            "roles.loadorder.hub.bootstrap.missing",
            `skill "${name}" Load Order section is missing the hub bootstrap decision matrix: ${missing
              .map((m) => `"${m.marker}" (${m.why})`)
              .join("; ")} (mstar-roles \u00a7 Load Order = single load-selection authority)`,
            "declare identity-first, the Skill presets none/standard decision, role-owned methods, and the unknown-preset / missing-identity refusal in the Load Order section",
          ),
        );
      }
      if (!section.includes("mstar-harness-core")) {
        violations.push(
          violation(
            "medium",
            "roles.loadorder.core.missing",
            `skill "${name}" Load Order section does not point at mstar-harness-core \u2014 the hub bootstrap is exempt from core-first, but core remains the lifecycle/authorization conflict authority and global entry whenever loaded`,
            "keep the conditional mstar-harness-core pointer (global entry / conflict authority) in the Load Order section",
          ),
        );
      }
      continue;
    }
    if (!section.includes("mstar-harness-core")) {
      violations.push(
        violation(
          "medium",
          "roles.loadorder.core.missing",
          `skill "${name}" Load Order section does not declare mstar-harness-core as its first dependency (mstar-harness-core load contract: exceptions are the mstar-roles hub bootstrap and exact standalone mstar-coding-behavior)`,
          "name mstar-harness-core first in the Load Order section",
        ),
      );
    }
  }
  return { ok: violations.length === 0, violations };
}
