/**
 * Engine roles module — role mapping/parameter-table validation and the
 * load-order lint.
 *
 * Spec sources (each test cites the skill/reference section it enforces;
 * roadmap §8.5 C2 — engine unit tests cite the source section as spec):
 * - Role Reference Mapping (14 agent ids → `references/<role>.md`; shared
 * families `fullstack-dev*` / `qc-specialist*` point at ONE shared file):
 * `mstar-roles` SKILL.md § Role Reference Mapping + § Maintenance Rules
 * ("Keep shared-family roles (`fullstack-dev*`, `qc-specialist*`) on one
 * shared reference file").
 * - Parameter Table contract: `mstar-roles` SKILL.md § Parameter Table
 * (SSOT) — dev track `primary` / `parallel_secondary`; QC reviewer_index
 * unique 1/2/3, each seat with a focus and `qc<index>` report_suffix
 * (`qc1.md`…`qc3.md` under `{SDD_DIR}/review/`).
 * - Load-order contract: `mstar-harness-core` SKILL.md § 与其它 `mstar-*`
 * skill 的加载契约 + `mstar-roles` SKILL.md § Load Order (Spec A2 —
 * single load-selection authority): direct topics declare core-first
 * except exact standalone `mstar-coding-behavior` (no mandatory load
 * declaration) and the `mstar-roles` hub bootstrap (identity→preset
 * decision matrix: identity-first / Skill presets none+standard /
 * role-owned methods / unknown-preset refusal, plus conditional core
 * conflict authority). Broad or text-claimed exemptions are rejected.
 *
 * Corpus fixtures use the read-only control checkout (assignment: "mapping
 * fixtures with real rolesDir from control checkout read-only"), overridable
 * with `MSTAR_CONTROL_SKILLS`; failure fixtures use temp dirs.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEV_TRACK_PARAMS,
  QC_REVIEWER_PARAMS,
  ROLE_MAPPING,
  SHARED_FAMILIES,
  lintLoadOrder,
  validateRoleMapping,
  type DevTrackParam,
  type QcReviewerParam,
  type RoleMappingEntry,
} from "../src/roles.js";
import type { GateResult } from "../src/core.js";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/**
 * Locate the read-only skill corpus: `MSTAR_CONTROL_SKILLS` env override →
 * THIS checkout's own `skills/` (upward walk — tests must validate the
 * corpus this checkout ships, which in feature worktrees differs from the
 * primary checkout that stays on `main`) → the primary control checkout
 * path as a last resort. Returns `null` when no corpus is available so
 * corpus tests skip instead of failing on machines without the harness
 * checkout.
 *
 * Documented trade-off ( kept intentionally): the two
 * `test.skipIf(CORPUS === null)` corpus tests are env-conditional — a CI
 * machine without the checkout would pass with them disabled. They run in
 * this checkout via the upward walk, and the checked-in fixtures (e.g.
 * lint.test.ts FRONTMATTER_REAL_*) keep the invariants covered
 * unconditionally; a checked-in full-corpus fixture is the future upgrade
 * path if machine-independent enforcement is required.
 *
 * Env override semantics are unchanged (gate runs may still point the
 * validator at an explicit skills root, e.g.
 * `MSTAR_CONTROL_SKILLS=<checkout>/skills`); only the default resolution
 * order flipped so the corpus under test is this checkout's own.
 */
function resolveCorpusRoot(): string | null {
  const fromEnv = process.env.MSTAR_CONTROL_SKILLS;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  let dir = import.meta.dir;
  for (;;) {
    const candidate = join(dir, "skills");
    if (existsSync(join(candidate, "mstar-roles", "SKILL.md"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const CORPUS = resolveCorpusRoot();

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Touch every mapped reference file under `dir` (empty markdown files). */
function writeMappedFiles(dir: string, mapping: readonly RoleMappingEntry[]): void {
  for (const { reference } of mapping) {
    const p = join(dir, reference);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "# fixture\n");
  }
}

function violationsOf(result: GateResult): string[] {
  return result.violations.map((v) => v.code);
}

/** Mutate one entry of the embedded mapping table (pure, for fixtures). */
function remap(mutate: (m: RoleMappingEntry) => RoleMappingEntry): RoleMappingEntry[] {
  return ROLE_MAPPING.map(mutate);
}

// ---------------------------------------------------------------------------
// ROLE_MAPPING data
// ---------------------------------------------------------------------------

test("ROLE_MAPPING mirrors mstar-roles SSOT: code-reviewer → references/code-reviewer.md", () => {
  expect(ROLE_MAPPING.find((m) => m.agentId === "code-reviewer")?.reference).toBe("references/code-reviewer.md");
});

// ---------------------------------------------------------------------------
// validateRoleMapping
// ---------------------------------------------------------------------------

describe("validateRoleMapping", () => {
  test.skipIf(CORPUS === null)(
    "real corpus: every mapped agent id resolves to references/<role>.md (read-only control checkout)",
    () => {
      const rolesDir = join(CORPUS as string, "mstar-roles");
      const result = validateRoleMapping(rolesDir);
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    },
  );

  test("missing references directory → reference.missing for every mapped role", () => {
    const dir = tmpRoot("roles-empty-");
    try {
      const result = validateRoleMapping(dir);
      expect(result.ok).toBe(false);
      const codes = violationsOf(result);
      expect(codes).toHaveLength(ROLE_MAPPING.length);
      expect(codes.every((c) => c === "roles.mapping.reference.missing")).toBe(true);
      expect(codes).toContain("roles.mapping.reference.missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("partial references → only the missing roles are flagged", () => {
    const dir = tmpRoot("roles-partial-");
    try {
      mkdirSync(join(dir, "references"), { recursive: true });
      for (const f of ["project-manager.md", "architect.md", "frontend-dev.md"]) {
        writeFileSync(join(dir, "references", f), "# fixture\n");
      }
      const result = validateRoleMapping(dir);
      expect(result.ok).toBe(false);
      expect(violationsOf(result)).toHaveLength(ROLE_MAPPING.length - 3);
      expect(violationsOf(result).every((c) => c === "roles.mapping.reference.missing")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shared family fullstack-dev* must resolve to ONE shared file", () => {
    const dir = tmpRoot("roles-family-dev-");
    try {
      const diverging = remap((m) =>
        m.agentId === "fullstack-dev-2" ? { ...m, reference: "references/fullstack-dev-2.md" } : m,
      );
      writeMappedFiles(dir, diverging);
      const result = validateRoleMapping(dir, { mapping: diverging });
      expect(result.ok).toBe(false);
      expect(violationsOf(result)).toContain("roles.mapping.family.shared");
      expect(violationsOf(result)).not.toContain("roles.mapping.reference.missing");
      const msg = result.violations.find((v) => v.code === "roles.mapping.family.shared")?.message ?? "";
      expect(msg).toContain("fullstack-dev");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shared family qc-specialist* must resolve to ONE shared file", () => {
    const dir = tmpRoot("roles-family-qc-");
    try {
      const diverging = remap((m) =>
        m.agentId === "qc-specialist-2" ? { ...m, reference: "references/qc-specialist-2.md" } : m,
      );
      writeMappedFiles(dir, diverging);
      const result = validateRoleMapping(dir, { mapping: diverging });
      expect(result.ok).toBe(false);
      expect(violationsOf(result)).toContain("roles.mapping.family.shared");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("family member absent from the mapping → member.missing (no double-reporting)", () => {
    const dir = tmpRoot("roles-family-missing-");
    try {
      const without = ROLE_MAPPING.filter((m) => m.agentId !== "qc-specialist-2");
      writeMappedFiles(dir, without);
      const result = validateRoleMapping(dir, { mapping: without });
      expect(result.ok).toBe(false);
      expect(violationsOf(result)).toContain("roles.mapping.family.member.missing");
      expect(violationsOf(result)).not.toContain("roles.mapping.family.shared");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("defaults validate clean against a fully-populated temp roles dir", () => {
    const dir = tmpRoot("roles-full-");
    try {
      writeMappedFiles(dir, ROLE_MAPPING);
      expect(validateRoleMapping(dir).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("QC reviewer_index must be exactly {1, 2, 3} across the three seats", () => {
    const dir = tmpRoot("roles-qc-index-");
    try {
      writeMappedFiles(dir, ROLE_MAPPING);
      const badSets: Array<Array<QcReviewerParam["reviewerIndex"]>> = [
        [1, 1, 3],
        [1, 2],
        [1, 2, 4],
      ];
      for (const indices of badSets) {
        const qcReviewers = QC_REVIEWER_PARAMS.map((p, i) => ({ ...p, reviewerIndex: indices[i] ?? 0 }));
        const result = validateRoleMapping(dir, { qcReviewers });
        expect(result.ok).toBe(false);
        expect(violationsOf(result)).toContain("roles.param.qc.index.set");
        expect(result.violations.find((v) => v.code === "roles.param.qc.index.set")?.severity).toBe("high");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("QC report_suffix must equal qc<reviewer_index> (qc1.md…qc3.md contract)", () => {
    const dir = tmpRoot("roles-qc-suffix-");
    try {
      writeMappedFiles(dir, ROLE_MAPPING);
      const qcReviewers = QC_REVIEWER_PARAMS.map((p) =>
        p.roleId === "qc-specialist" ? { ...p, reportSuffix: "review1" } : p,
      );
      const result = validateRoleMapping(dir, { qcReviewers });
      expect(result.ok).toBe(false);
      const v = result.violations.find((x) => x.code === "roles.param.qc.suffix");
      expect(v).toBeDefined();
      expect(v?.message).toContain("qc-specialist");
      expect(v?.message).toContain("qc1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("QC focus must be non-empty", () => {
    const dir = tmpRoot("roles-qc-focus-");
    try {
      writeMappedFiles(dir, ROLE_MAPPING);
      const qcReviewers = QC_REVIEWER_PARAMS.map((p) =>
        p.roleId === "qc-specialist-2" ? { ...p, focus: "   " } : p,
      );
      const result = validateRoleMapping(dir, { qcReviewers });
      expect(result.ok).toBe(false);
      expect(violationsOf(result)).toContain("roles.param.qc.focus.missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parameter rows must reference mapped roles", () => {
    const dir = tmpRoot("roles-param-role-");
    try {
      writeMappedFiles(dir, ROLE_MAPPING);
      const qcReviewers = [...QC_REVIEWER_PARAMS, { roleId: "qc-specialist-9", reviewerIndex: 1, focus: "x", reportSuffix: "qc1" }];
      const devTrack: DevTrackParam[] = [...DEV_TRACK_PARAMS, { roleId: "fullstack-dev-9", track: "primary" }];
      const result = validateRoleMapping(dir, { qcReviewers, devTrack });
      expect(result.ok).toBe(false);
      const codes = violationsOf(result);
      expect(codes).toContain("roles.param.role.missing");
      const missing = result.violations.filter((v) => v.code === "roles.param.role.missing");
      expect(missing.some((v) => v.message.includes("qc-specialist-9"))).toBe(true);
      expect(missing.some((v) => v.message.includes("fullstack-dev-9"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("parameter rows must be unique per role", () => {
    const dir = tmpRoot("roles-param-dup-");
    try {
      writeMappedFiles(dir, ROLE_MAPPING);
      const devTrack = [...DEV_TRACK_PARAMS, { roleId: "fullstack-dev", track: "primary" }];
      const result = validateRoleMapping(dir, { devTrack });
      expect(result.ok).toBe(false);
      expect(violationsOf(result)).toContain("roles.param.role.duplicate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid dev track value → roles.param.track", () => {
    const dir = tmpRoot("roles-param-track-");
    try {
      writeMappedFiles(dir, ROLE_MAPPING);
      const devTrack: DevTrackParam[] = [{ roleId: "fullstack-dev", track: "tertiary" as DevTrackParam["track"] }];
      const result = validateRoleMapping(dir, { devTrack });
      expect(result.ok).toBe(false);
      expect(violationsOf(result)).toContain("roles.param.track");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("embedded parameter tables satisfy the contract (self-consistency)", () => {
    const dir = tmpRoot("roles-self-");
    try {
      writeMappedFiles(dir, ROLE_MAPPING);
      expect(validateRoleMapping(dir, { devTrack: DEV_TRACK_PARAMS, qcReviewers: QC_REVIEWER_PARAMS }).ok).toBe(true);
      expect(new Set(QC_REVIEWER_PARAMS.map((p) => p.reviewerIndex))).toEqual(new Set([1, 2, 3]));
      for (const p of QC_REVIEWER_PARAMS) expect(p.reportSuffix).toBe(`qc${p.reviewerIndex}`);
      expect(SHARED_FAMILIES.map((f) => f.family)).toEqual(["fullstack-dev", "qc-specialist"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// lintLoadOrder
// ---------------------------------------------------------------------------

describe("lintLoadOrder", () => {
  test.skipIf(CORPUS === null)(
    "real corpus: topics retain core-first except standalone coding behavior and the roles hub bootstrap",
    () => {
      const corpus = CORPUS as string;
      const record: Record<string, string> = {};
      for (const entry of readdirSync(corpus)) {
        const dir = join(corpus, entry);
        if (!entry.startsWith("mstar-") || !statSync(dir).isDirectory()) continue;
        const skillMd = join(dir, "SKILL.md");
        if (existsSync(skillMd)) record[entry] = readFileSync(skillMd, "utf8");
      }
      expect(Object.keys(record).length).toBeGreaterThan(0);
      const result = lintLoadOrder(record);
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    },
  );

  test("mstar-harness-core itself is exempt (no self-declaration)", () => {
    const result = lintLoadOrder({ "mstar-harness-core": "# Core\nNo load order section here at all.\n" });
    expect(result.ok).toBe(true);
  });

  test("non-mstar skills are not required to declare core", () => {
    const result = lintLoadOrder({ "grill-me": "# Grill\n## Workflow\nDo the thing.\n" });
    expect(result.ok).toBe(true);
  });

  test("exact coding-behavior is exempt without a Load Order section or core mention", () => {
    const result = lintLoadOrder({
      "mstar-coding-behavior": "# Coding Behavior\n## Workflow\nInspect the affected behavior.\n",
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("exact coding-behavior is exempt from core-first even with a Load Order section", () => {
    const result = lintLoadOrder({
      "mstar-coding-behavior": "## Load Order\nNo dependency.\n",
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test.each(["mstar-coding-behavior-extra", "mstar-other-topic"])(
    "standalone claims do not exempt another topic: %s",
    (name) => {
      const result = lintLoadOrder({
        [name]: "# Standalone topic\nStandalone use requires no other skill.\n",
      });
      expect(result.ok).toBe(false);
      expect(violationsOf(result)).toEqual(["roles.loadorder.section.missing"]);
    },
  );

  test("standalone claims inside another topic's Load Order do not waive core-first", () => {
    const result = lintLoadOrder({
      "mstar-other-topic": "## Load Order\nStandalone use requires no other skill.\n",
    });
    expect(result.ok).toBe(false);
    expect(violationsOf(result)).toEqual(["roles.loadorder.core.missing"]);
  });

  test("missing Load Order section → roles.loadorder.section.missing", () => {
    const result = lintLoadOrder({ "mstar-host": "# Host\n## Detect active host\nSome table.\n" });
    expect(result.ok).toBe(false);
    const v = result.violations.find((x) => x.code === "roles.loadorder.section.missing");
    expect(v).toBeDefined();
    expect(v?.message).toContain("mstar-host");
  });

  test("Load Order section without the core mention → roles.loadorder.core.missing", () => {
    const result = lintLoadOrder({
      "mstar-host": "# Host\n## Load Order\nRead `mstar-iteration` first, then this skill.\n",
    });
    expect(result.ok).toBe(false);
    expect(result.violations.map((x) => x.code)).toContain("roles.loadorder.core.missing");
  });

  test("core mention in a LATER section does not satisfy the Load Order check", () => {
    const result = lintLoadOrder({
      "mstar-x": "# X\n## Load Order\nRead `mstar-iteration` first.\n## Workflow\nRead `mstar-harness-core` here.\n",
    });
    expect(result.ok).toBe(false);
    expect(result.violations.map((x) => x.code)).toEqual(["roles.loadorder.core.missing"]);
  });

  test("Chinese-suffixed Load Order heading with core mention passes", () => {
    const result = lintLoadOrder({
      "mstar-dispatch-gates":
        "## Load order（必读顺序）\n\n**首次 Read 本 skill 前：必须先 Read `mstar-harness-core`（SKILL.md）。**",
    });
    expect(result.ok).toBe(true);
  });

  test("First action heading passes (mstar-host style)", () => {
    const result = lintLoadOrder({
      "mstar-host": "# Host\n## First action\n\nRead **`mstar-harness-core`** before this skill.\n",
    });
    expect(result.ok).toBe(true);
  });

  test("parenthesized Load Order heading passes", () => {
    const result = lintLoadOrder({
      "mstar-docs": "## Load Order (Required)\n\n1. Read `mstar-harness-core` first (SKILL.md).\n",
    });
    expect(result.ok).toBe(true);
  });

 // --- Spec A2: the one hub-bootstrap exception (mstar-roles) -------------

  const HUB_OK =
    "## Load Order\n\n" +
    "This hub is the **single load-selection authority**.\n\n" +
    "1. Read this skill — **identity-first**: mission, scope, NEVER rules before any skill list.\n" +
    "2. Apply the Assignment **`Skill presets:`** decision — explicit `none` ⇒ no optional topic preset; " +
    "omitted on a substantive round ⇒ `standard`; **role-owned** methods load regardless of preset.\n" +
    "3. **Unknown preset** or missing required identity ⇒ Needs Context / Blocked.\n" +
    "4. Whenever `mstar-harness-core` is loaded it remains the global entry (conflict authority).\n";

  test("hub bootstrap exception: mstar-roles passes with the decision matrix instead of a core-first declaration", () => {
    const result = lintLoadOrder({ "mstar-roles": HUB_OK });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("hub missing its Load Order section → roles.loadorder.section.missing", () => {
    const result = lintLoadOrder({ "mstar-roles": "# Roles\n## Role Reference Mapping\ntable\n" });
    expect(result.ok).toBe(false);
    expect(result.violations.map((x) => x.code)).toContain("roles.loadorder.section.missing");
  });

  test("negative: hub missing the identity boundary fails (identity-first token)", () => {
    const withoutIdentity = HUB_OK.replace(
      "— **identity-first**: mission, scope, NEVER rules before any skill list.",
      "— read the reference.",
    );
    expect(withoutIdentity).not.toBe(HUB_OK);
    const result = lintLoadOrder({ "mstar-roles": withoutIdentity });
    expect(result.ok).toBe(false);
    const v = result.violations.find((x) => x.code === "roles.loadorder.hub.bootstrap.missing");
    expect(v).toBeDefined();
    expect(v?.message).toContain("identity-first");
  });

  test("negative: hub missing the standard arm fails (decision matrix incomplete)", () => {
    const withoutStandard = HUB_OK.replace("omitted on a substantive round ⇒ `standard`; ", "");
    expect(withoutStandard).not.toBe(HUB_OK);
    const result = lintLoadOrder({ "mstar-roles": withoutStandard });
    expect(result.ok).toBe(false);
    const v = result.violations.find((x) => x.code === "roles.loadorder.hub.bootstrap.missing");
    expect(v).toBeDefined();
    expect(v?.message).toContain("standard");
  });

  test("negative: hub missing the role-owned methods arm fails", () => {
    const withoutOwned = HUB_OK.replace("**role-owned** methods load regardless of preset.", "");
    expect(withoutOwned).not.toBe(HUB_OK);
    const result = lintLoadOrder({ "mstar-roles": withoutOwned });
    expect(result.ok).toBe(false);
    const v = result.violations.find((x) => x.code === "roles.loadorder.hub.bootstrap.missing");
    expect(v).toBeDefined();
    expect(v?.message).toContain("role-owned");
  });

  test("negative: hub without the unknown-preset refusal arm fails (unknown preset must be rejected, not inferred)", () => {
    const withoutUnknown = HUB_OK.replace(
      "3. **Unknown preset** or missing required identity ⇒ Needs Context / Blocked.\n",
      "",
    );
    expect(withoutUnknown).not.toBe(HUB_OK);
    const result = lintLoadOrder({ "mstar-roles": withoutUnknown });
    expect(result.ok).toBe(false);
    const v = result.violations.find((x) => x.code === "roles.loadorder.hub.bootstrap.missing");
    expect(v).toBeDefined();
    expect(v?.message).toContain("unknown preset");
  });

  test("hub without the core conflict-authority pointer still fails core.missing", () => {
    const withoutPointer = HUB_OK.replace(
      "4. Whenever `mstar-harness-core` is loaded it remains the global entry (conflict authority).\n",
      "",
    );
    expect(withoutPointer).not.toBe(HUB_OK);
    const result = lintLoadOrder({ "mstar-roles": withoutPointer });
    expect(result.ok).toBe(false);
    expect(result.violations.map((x) => x.code)).toContain("roles.loadorder.core.missing");
  });

  test("negative: broad exemption rejected — an arbitrary topic with the hub-style bootstrap still needs core-first", () => {
 // The hub exception is keyed on the skill name `mstar-roles`. A topic
 // that copies the hub bootstrap but drops the conditional core pointer
 // (i.e. claims the core-first exemption for itself) must still fail
 // roles.loadorder.core.missing.
    const exemptClaim = HUB_OK.replace(
      "4. Whenever `mstar-harness-core` is loaded it remains the global entry (conflict authority).\n",
      "",
    );
    expect(exemptClaim).not.toBe(HUB_OK);
    const result = lintLoadOrder({ "mstar-some-topic": exemptClaim });
    expect(result.ok).toBe(false);
    expect(result.violations.map((x) => x.code)).toContain("roles.loadorder.core.missing");
    expect(result.violations.some((x) => x.code === "roles.loadorder.hub.bootstrap.missing")).toBe(false);
  });

  test("empty record → ok", () => {
    expect(lintLoadOrder({}).ok).toBe(true);
  });

  test("mixed record reports only the failing skill", () => {
    const result = lintLoadOrder({
      "mstar-good": "## Load Order\nRead `mstar-harness-core` first.\n",
      "mstar-bad": "## Load Order\nRead `mstar-iteration` first.\n",
    });
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.message).toContain("mstar-bad");
  });
});
