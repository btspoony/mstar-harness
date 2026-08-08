/**
 * Engine design-md module — DESIGN.md token frontmatter validation, light/dark
 * parity, and completeness level audit.
 *
 * Spec sources (all embedded as constants — no runtime skill-file reads):
 * - mstar-design-md SKILL.md: YAML frontmatter is the SSOT for token values;
 *   dual theme = same token names, different values; three completeness
 *   levels with LEVEL2/LEVEL3_PLACEHOLDER upgrade markers.
 * - mstar-design-md/references/design-md-spec.md §1.5 (token store: colors /
 *   typography / spacing / rounded / components shapes), §3 (token naming),
 *   §4 (light/dark contract), §5 (upgrade placeholders), §6 ({path} refs).
 * - mstar-design-md/references/completeness-checklist.md: Level 1–3 items;
 *   placeholders (`"[...]"`) never count as complete.
 *
 * Judgment stays prompt — this module is the deterministic half.
 */
import type { GateResult, ValidationResult } from "./core.js";

function violation(severity: ValidationResult["severity"], code: string, message: string, fix?: string): ValidationResult {
  return { ok: false, severity, code, message, fix };
}

// ---------------------------------------------------------------------------
// YAML-lite frontmatter parsing
// ---------------------------------------------------------------------------

type YamlScalar = string | number | boolean;
type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };

/** Parsed DESIGN.md frontmatter. Group values are `unknown` because a
 * malformed group (e.g. `colors: red`) is a scalar; validation reports it. */
export type DesignFrontmatter = {
  version?: string;
  name?: string;
  description?: string;
  colors: Record<string, unknown>;
  typography: Record<string, unknown>;
  spacing: Record<string, unknown>;
  rounded: Record<string, unknown>;
  components: Record<string, unknown>;
};

/** Sentinel key for a token group whose YAML value is a scalar, not a map
 * (documented — real token names never start with `__`). */
const RAW_GROUP = "__raw";

const isMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse a YAML scalar: strip surrounding quotes, cut trailing inline
 * comments (unquoted only), and coerce numbers/booleans. */
function parseScalar(raw: string): YamlScalar {
  const trimmed = raw.trim();
  const quoted = /^"([^"]*)"$/.exec(trimmed) ?? /^'([^']*)'$/.exec(trimmed);
  if (quoted) return quoted[1];
  const cut = trimmed.split(/\s+#/)[0].trim();
  if (/^-?\d+(?:\.\d+)?$/.test(cut)) return Number(cut);
  if (/^(?:true|false)$/.test(cut)) return cut === "true";
  return cut;
}

type Line = { indent: number; text: string };

/** Parse a map block: consecutive `key: value` / `key:` lines at `indent`. */
function parseMapBlock(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const map: Record<string, YamlValue> = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const match = /^([^:]+):(.*)$/.exec(lines[i].text);
    if (match === null) {
      i++;
      continue;
    }
    const key = parseScalar(match[1].trim()).toString();
    const rest = match[2].trim();
    if (rest === "") {
      const nested = i + 1 < lines.length && lines[i + 1].indent > indent;
      if (nested) {
        const child = parseBlock(lines, i + 1, lines[i + 1].indent);
        map[key] = child.value;
        i = child.next;
      } else {
        map[key] = "";
        i++;
      }
    } else {
      map[key] = parseScalar(rest);
      i++;
    }
  }
  return { value: map, next: i };
}

/** Parse a list block: consecutive `- item` lines at `indent`. */
function parseListBlock(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  const list: YamlValue[] = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("-")) {
    const rest = lines[i].text.slice(1).trim();
    const match = /^([^:]+):(.*)$/.exec(rest);
    if (match !== null && match[2].trim() === "" && i + 1 < lines.length && lines[i + 1].indent > indent) {
      const child = parseBlock(lines, i + 1, lines[i + 1].indent);
      list.push({ [parseScalar(match[1].trim()).toString()]: child.value });
      i = child.next;
    } else if (match !== null) {
      list.push({ [parseScalar(match[1].trim()).toString()]: parseScalar(match[2].trim()) });
      i++;
    } else {
      list.push(parseScalar(rest));
      i++;
    }
  }
  return { value: list, next: i };
}

function parseBlock(lines: Line[], start: number, indent: number): { value: YamlValue; next: number } {
  if (lines[start] !== undefined && lines[start].text.startsWith("-")) return parseListBlock(lines, start, indent);
  return parseMapBlock(lines, start, indent);
}

/**
 * Parse the leading `---`-fenced YAML frontmatter of a DESIGN.md into the
 * five token groups plus version/name/description. Commented-out lines
 * (including `# LEVEL2_PLACEHOLDER:` markers) are skipped, so only ACTIVE
 * tokens count — matching the checklist rule that commented keys are not
 * complete. Returns `null` when the text has no frontmatter block.
 *
 * A token group whose YAML value is a scalar is stored as
 * `{ [RAW_GROUP]: <value> }` so validation can report `group-not-map`.
 */
export function parseDesignFrontmatter(frontmatterText: string): DesignFrontmatter | null {
  const body = frontmatterText.replace(/^\uFEFF/, "");
  const lines = body.split(/\r?\n/);
  if (lines.length === 0 || !lines[0].trim().startsWith("---")) return null;
  const inner: Line[] = [];
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "---") break;
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const indent = lines[i].match(/^ */)![0].length;
    inner.push({ indent, text: lines[i].slice(indent) });
  }
  if (inner.length === 0) return null;
  const top = parseBlock(inner, 0, inner[0].indent);
  if (!isMap(top.value)) return null;
  const fm: DesignFrontmatter = { colors: {}, typography: {}, spacing: {}, rounded: {}, components: {} };
  for (const [key, value] of Object.entries(top.value)) {
    if (key === "version" || key === "name" || key === "description") {
      if (typeof value === "string") fm[key] = value;
    } else if (key === "colors" || key === "typography" || key === "spacing" || key === "rounded" || key === "components") {
      fm[key] = isMap(value) ? value : { [RAW_GROUP]: value };
    }
  }
  return fm;
}

// ---------------------------------------------------------------------------
// validateDesignTokenFrontmatter — design-md-spec §1.5
// ---------------------------------------------------------------------------

/** sRGB hex (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) — spec §2.2. */
const HEX_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** Wide-gamut P3 equivalent (`oklch(...)`) — spec §2.2. */
const OKLCH_RE = /^oklch\([^)]*\)$/i;
/** Pixel length (`4px`, `9999px`, `-0.5px`). */
const PX_RE = /^-?\d+(?:\.\d+)?px$/;
/** Template placeholder value (`"[#ffffff]"`, `"[font-family]"`) — never a
 * concrete token (completeness-checklist § How to use item 5). */
const PLACEHOLDER_RE = /^\[.*\]$/;
/** The five typography properties (spec §1.5: "exactly five properties"). */
const TYPOGRAPHY_PROPS = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"] as const;
/** Component {path} reference — `{colors.X}` / `{typography.X}` / `{rounded.X}`. */
const REF_RE = /^\{([a-z]+)\.([^}]+)\}$/;
/** Reference groups that may be traced per spec §6. */
const REF_GROUPS = ["colors", "typography", "rounded"] as const;

const isPlaceholder = (value: string) => PLACEHOLDER_RE.test(value);

/**
 * Validate a DESIGN.md frontmatter against the token-store contract
 * (design-md-spec §1.5): the colors/typography/spacing/rounded groups must
 * exist with spec-typed values, `components` (optional below Level 2) must
 * carry `{path}` references that resolve within the same file.
 *
 * Violation codes:
 * - `design-md.tokens.missing-frontmatter` — no `---` block
 * - `design-md.tokens.missing-group` — required group absent/empty
 * - `design-md.tokens.group-not-map` — group value is a scalar
 * - `design-md.tokens.color-format` — not hex or oklch()
 * - `design-md.tokens.typography-shape` — not exactly the five properties
 * - `design-md.tokens.spacing-base` / `spacing-key` / `spacing-format`
 * - `design-md.tokens.rounded-format` — not a px length
 * - `design-md.tokens.components-shape` — component entry not a map
 * - `design-md.tokens.ref-unresolved` — `{group.key}` does not resolve
 * - `design-md.tokens.placeholder` — `"[...]"` template value (low)
 */
export function validateDesignTokenFrontmatter(frontmatterText: string): GateResult {
  const violations: ValidationResult[] = [];
  const fm = parseDesignFrontmatter(frontmatterText);
  if (fm === null) {
    violations.push(
      violation(
        "medium",
        "design-md.tokens.missing-frontmatter",
        "no `---` YAML frontmatter block found — DESIGN.md must open with a fenced frontmatter holding the token SSOT (design-md-spec §1.5)",
        "add a `---` fenced frontmatter with version, name, description, and the colors/typography/spacing/rounded groups",
      ),
    );
    return { ok: false, violations };
  }

  const groupEntries = (group: keyof DesignFrontmatter): [string, unknown][] => {
    const value = fm[group];
    if (!isMap(value) || RAW_GROUP in value) return [];
    return Object.entries(value);
  };
  const groupIsMap = (group: keyof DesignFrontmatter): boolean => {
    const value = fm[group];
    return isMap(value) && !(RAW_GROUP in value);
  };

  for (const group of ["colors", "typography", "spacing", "rounded"] as const) {
    if (!isMap(fm[group])) {
      violations.push(
        violation("medium", "design-md.tokens.group-not-map", `token group "${group}" must be a YAML map, not a scalar (design-md-spec §1.5)`, `rewrite \`${group}\` as a nested map`),
      );
    } else if (!groupIsMap(group)) {
      violations.push(
        violation("medium", "design-md.tokens.group-not-map", `token group "${group}" must be a YAML map, not a scalar (design-md-spec §1.5)`, `rewrite \`${group}\` as a nested map`),
      );
    } else if (groupEntries(group).length === 0) {
      violations.push(
        violation(
          "medium",
          "design-md.tokens.missing-group",
          `missing required token group "${group}" — colors/typography/spacing/rounded are required by the frontmatter SSOT (design-md-spec §1.5)`,
          `add an active \`${group}:\` block with concrete token values`,
        ),
      );
    }
  }
  // `components` is optional below Level 2 (template keeps it commented),
  // but when present it must be a map.
  if (!isMap(fm.components) || !groupIsMap("components")) {
    violations.push(
      violation("medium", "design-md.tokens.group-not-map", `token group "components" must be a YAML map, not a scalar (design-md-spec §1.5)`, `rewrite \`components\` as a nested map`),
    );
  }

  const placeholder = (group: string, name: string, value: string) =>
    violations.push(
      violation(
        "low",
        "design-md.tokens.placeholder",
        `token "${group}.${name}" uses a "[...]" template value — placeholders never count as concrete tokens (completeness-checklist § How to use item 5)`,
        `replace \`${value}\` with a concrete value`,
      ),
    );

  for (const [name, value] of groupEntries("colors")) {
    if (typeof value !== "string") {
      violations.push(violation("medium", "design-md.tokens.color-format", `color "${name}" must be a string value (design-md-spec §2.2)`, "quote the color value"));
      continue;
    }
    if (isPlaceholder(value)) {
      placeholder("colors", name, value);
    } else if (!HEX_RE.test(value) && !OKLCH_RE.test(value)) {
      violations.push(
        violation(
          "medium",
          "design-md.tokens.color-format",
          `color "${name}" = "${value}" is not a hex (\`#rrggbb\`/\`#rrggbbaa\`) or oklch() value (design-md-spec §2.2)`,
          "use an sRGB hex value, optionally with a `-p3` oklch() twin",
        ),
      );
    }
  }

  for (const [name, value] of groupEntries("typography")) {
    if (!isMap(value)) {
      violations.push(
        violation("medium", "design-md.tokens.typography-shape", `typography token "${name}" must be a map of the five properties (design-md-spec §1.5)`, "give it fontFamily/fontSize/fontWeight/lineHeight/letterSpacing"),
      );
      continue;
    }
    const keys = Object.keys(value);
    const missing = TYPOGRAPHY_PROPS.filter((p) => !keys.includes(p));
    const extra = keys.filter((k) => !(TYPOGRAPHY_PROPS as readonly string[]).includes(k));
    if (missing.length > 0 || extra.length > 0) {
      violations.push(
        violation(
          "medium",
          "design-md.tokens.typography-shape",
          `typography token "${name}" must have exactly the five properties fontFamily/fontSize/fontWeight/lineHeight/letterSpacing (design-md-spec §1.5)${missing.length > 0 ? ` — missing: ${missing.join(", ")}` : ""}${extra.length > 0 ? ` — extra: ${extra.join(", ")}` : ""}`,
          "align the token with the five-property shape",
        ),
      );
    }
    for (const prop of ["fontFamily", "fontSize"] as const) {
      const v = value[prop];
      if (typeof v === "string" && isPlaceholder(v)) placeholder("typography", name, v);
      else if (typeof v !== "string" || v.trim() === "") {
        violations.push(
          violation("medium", "design-md.tokens.typography-shape", `typography token "${name}" has an empty \`${prop}\` (design-md-spec §1.5)`, `fill \`${prop}\` with a concrete value`),
        );
      }
    }
  }

  if (groupIsMap("spacing")) {
    const spacing = fm.spacing as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(spacing, "base")) {
      violations.push(
        violation("medium", "design-md.tokens.spacing-base", 'spacing must declare the base unit as `base` (design-md-spec §2.4)', "add `base: 4px` (or 8px) to the spacing group"),
      );
    }
    for (const [name, value] of Object.entries(spacing)) {
      if (name !== "base" && name !== RAW_GROUP && !/^\d+$/.test(name)) {
        violations.push(
          violation("medium", "design-md.tokens.spacing-key", `spacing key "${name}" must be \`base\` or a numeric multiplier (design-md-spec §1.5)`, "use numeric scale-step keys or `base`"),
        );
      }
      if (typeof value === "string" && isPlaceholder(value)) {
        placeholder("spacing", name, value);
      } else if (typeof value !== "string" || !PX_RE.test(value)) {
        violations.push(
          violation("medium", "design-md.tokens.spacing-format", `spacing value "${name}" = "${String(value)}" is not a px length (design-md-spec §1.5)`, "use a pixel value like `4px`"),
        );
      }
    }
  }

  for (const [name, value] of groupEntries("rounded")) {
    if (typeof value === "string" && isPlaceholder(value)) {
      placeholder("rounded", name, value);
    } else if (typeof value !== "string" || !PX_RE.test(value)) {
      violations.push(
        violation("medium", "design-md.tokens.rounded-format", `rounded value "${name}" = "${String(value)}" is not a px length (design-md-spec §1.5)`, "use a pixel value like `6px`"),
      );
    }
  }

  for (const [name, value] of groupEntries("components")) {
    if (!isMap(value)) {
      violations.push(
        violation("medium", "design-md.tokens.components-shape", `component token "${name}" must be a map of properties (design-md-spec §2.8)`, "give it backgroundColor/textColor/typography/rounded/padding/height"),
      );
      continue;
    }
    for (const [prop, v] of Object.entries(value)) {
      if (typeof v !== "string") continue; // numeric literals (height: 40px) are fine
      if (isPlaceholder(v)) {
        placeholder("components", `${name}.${prop}`, v);
        continue;
      }
      const ref = REF_RE.exec(v);
      if (ref === null) continue; // direct literal
      const [, refGroup, refKey] = ref;
      const resolves =
        (REF_GROUPS as readonly string[]).includes(refGroup) &&
        groupIsMap(refGroup as keyof DesignFrontmatter) &&
        Object.prototype.hasOwnProperty.call(fm[refGroup as keyof DesignFrontmatter] as Record<string, unknown>, refKey);
      if (!resolves) {
        violations.push(
          violation(
            "medium",
            "design-md.tokens.ref-unresolved",
            `component "${name}" references "${v}" which does not resolve to an active token in this frontmatter (design-md-spec §6 — {path} refs MUST trace back to a key)`,
            `add the referenced token or use a literal value`,
          ),
        );
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// assertLightDarkParity — design-md-spec §4
// ---------------------------------------------------------------------------

const PARITY_GROUPS = ["colors", "typography", "spacing", "rounded", "components"] as const;

/**
 * Assert the light/dark dual-theme contract (design-md-spec §4 rules 1–4):
 * both files define the SAME token key set across all five groups; only
 * values differ. Every token active in one file must be active in the other.
 *
 * Violation codes:
 * - `design-md.parity.missing-frontmatter` — either file has no block
 * - `design-md.parity.missing-dark` — token present in light only
 * - `design-md.parity.missing-light` — token present in dark only
 */
export function assertLightDarkParity(lightFm: string, darkFm: string): GateResult {
  const violations: ValidationResult[] = [];
  const light = parseDesignFrontmatter(lightFm);
  const dark = parseDesignFrontmatter(darkFm);
  if (light === null || dark === null) {
    violations.push(
      violation(
        "medium",
        "design-md.parity.missing-frontmatter",
        `light/dark parity needs a YAML frontmatter in both files — ${light === null ? "DESIGN.md" : "DESIGN.dark.md"} has none (design-md-spec §4 rules 1–2)`,
        "add the fenced frontmatter to both theme files",
      ),
    );
    return { ok: false, violations };
  }

  const activeKeys = (fm: DesignFrontmatter): Set<string> => {
    const keys = new Set<string>();
    for (const group of PARITY_GROUPS) {
      const value = fm[group];
      if (!isMap(value) || RAW_GROUP in value) continue;
      for (const key of Object.keys(value)) keys.add(`${group}.${key}`);
    }
    return keys;
  };
  const lightKeys = activeKeys(light);
  const darkKeys = activeKeys(dark);

  for (const key of lightKeys) {
    if (!darkKeys.has(key)) {
      violations.push(
        violation(
          "medium",
          "design-md.parity.missing-dark",
          `token "${key}" is active in DESIGN.md but missing from DESIGN.dark.md — both files must define the same token set (design-md-spec §4 rule 3)`,
          "add the token to DESIGN.dark.md with a dark-appropriate value",
        ),
      );
    }
  }
  for (const key of darkKeys) {
    if (!lightKeys.has(key)) {
      violations.push(
        violation(
          "medium",
          "design-md.parity.missing-light",
          `token "${key}" is active in DESIGN.dark.md but missing from DESIGN.md — DESIGN.md is the SSOT for token names (design-md-spec §4 rules 3–4)`,
          "add the token to DESIGN.md, or remove it from the dark file",
        ),
      );
    }
  }
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// completenessLevel — completeness-checklist.md Level 1–3
// ---------------------------------------------------------------------------

/** Completeness level verdict (checklist § Verdict). */
export type CompletenessLevel = "BELOW_MVP" | "MVP" | "Standard" | "Production";

/** One checklist item: id, owning level, source, and pass/fail. */
export type CompletenessItem = {
  id: string;
  level: 1 | 2 | 3;
  ok: boolean;
  source: "frontmatter" | "body";
};

/** A `LEVEL2_PLACEHOLDER` / `LEVEL3_PLACEHOLDER` marker found in the text. */
export type CompletenessPlaceholder = { level: 2 | 3; marker: string; line: number };

/** Result of `completenessLevel`. `bodyUnverified` is true when the caller
 * passed no checklist (body-only items were excluded from the level
 * computation and Production is capped at Standard). */
export type CompletenessResult = {
  level: CompletenessLevel;
  items: CompletenessItem[];
  /** Ids failing at the next-highest level boundary (or the current level
   * when below MVP). */
  missing: string[];
  placeholders: CompletenessPlaceholder[];
  upgradeTo: 2 | 3 | null;
  bodyUnverified: boolean;
};

const GRAY_STEPS = ["100", "200", "300", "400", "500", "600", "700", "800", "900", "1000"] as const;
const ALPHA_STEPS = ["100", "200", "300", "400", "500", "600"] as const;
const ACCENT_SCALES = ["blue", "red", "amber", "green", "teal", "purple", "pink"] as const;
/** Body-only checklist items (verified by the caller via the checklist arg). */
const BODY_ITEM_IDS = [
  "breakpoints-2",
  "breakpoints-4",
  "components-button-states",
  "components-input-states",
  "spacing-rhythm",
  "dark-exists",
  "dark-parity",
  "elevation-shadows",
  "motion-easing",
  "motion-durations",
  "motion-reduced",
  "voice-content",
] as const;
/** Level 3 body-only items — the Production gate cannot be certified from
 * frontmatter alone. */
const L3_BODY_ITEM_IDS = [
  "dark-exists",
  "dark-parity",
  "elevation-shadows",
  "motion-easing",
  "motion-durations",
  "motion-reduced",
  "voice-content",
] as const;

/** A value counts as concrete when it is a non-empty string (or number)
 * that is not a `"[...]"` template placeholder. */
function isConcrete(value: unknown): boolean {
  if (typeof value === "number") return true;
  return typeof value === "string" && value !== "" && !isPlaceholder(value);
}

/** Active key in a group with a concrete value (checklist item 5: commented
 * keys and placeholder values do not count). */
function groupHasConcrete(fm: DesignFrontmatter | null, group: keyof DesignFrontmatter, key: string): boolean {
  if (fm === null) return false;
  const value = fm[group];
  if (!isMap(value) || RAW_GROUP in value) return false;
  const entry = value[key];
  return entry !== undefined && isConcrete(entry);
}

/** Typography token complete when all five properties are present and their
 * values are concrete (checklist: "with all five properties filled"). */
function typographyTokenComplete(fm: DesignFrontmatter | null, key: string): boolean {
  if (fm === null) return false;
  const group = fm.typography;
  if (!isMap(group) || RAW_GROUP in group) return false;
  const entry = group[key];
  if (!isMap(entry)) return false;
  return TYPOGRAPHY_PROPS.every((p) => Object.prototype.hasOwnProperty.call(entry, p) && isConcrete(entry[p]));
}

function countRoleTokens(fm: DesignFrontmatter | null, role: string): number {
  if (fm === null) return 0;
  const group = fm.typography;
  if (!isMap(group) || RAW_GROUP in group) return 0;
  return Object.keys(group).filter((k) => k.startsWith(`${role}-`) && typographyTokenComplete(fm, k)).length;
}

function countNumericSpacingSteps(fm: DesignFrontmatter | null): number {
  if (fm === null) return 0;
  const group = fm.spacing;
  if (!isMap(group) || RAW_GROUP in group) return 0;
  return Object.keys(group).filter((k) => k !== "base" && k !== RAW_GROUP && /^\d+$/.test(k)).length;
}

function hasComponent(fm: DesignFrontmatter | null, name: string): boolean {
  if (fm === null) return false;
  const group = fm.components;
  if (!isMap(group) || RAW_GROUP in group) return false;
  return isMap(group[name]);
}

const LEVEL_RANK: Record<CompletenessLevel, number> = { BELOW_MVP: 0, MVP: 1, Standard: 2, Production: 3 };

/**
 * Determine the DESIGN.md completeness level from its frontmatter
 * (completeness-checklist.md): Level 1 (MVP) → Level 2 (Standard) → Level 3
 * (Production). A level is complete only when all items at that level and
 * below pass; placeholder values and commented-out keys never count.
 *
 * Body-only items (breakpoints, elevation, motion, voice, dark-file) cannot
 * be verified from frontmatter — pass their ids in `checklist` to confirm
 * them. When `checklist` is omitted, body items are excluded from level
 * computation and Production is capped at Standard (`bodyUnverified: true`).
 *
 * Placeholder detection scans for `LEVEL2_PLACEHOLDER` / `LEVEL3_PLACEHOLDER`
 * markers (design-md-spec §5) and suggests the implied upgrade target.
 */
export function completenessLevel(frontmatterText: string, checklist?: readonly string[]): CompletenessResult {
  const fm = parseDesignFrontmatter(frontmatterText);
  const bodyUnverified = checklist === undefined;
  const bodyOk = (id: string) => (checklist ?? []).includes(id);

  const items: CompletenessItem[] = [];
  const add = (id: string, level: 1 | 2 | 3, source: "frontmatter" | "body", ok: boolean) => {
    items.push({ id, level, ok, source });
  };

  // --- Level 1 (MVP) — checklist § Level 1 ---
  add("fm-exists", 1, "frontmatter", fm !== null);
  add("version", 1, "frontmatter", fm !== null && typeof fm.version === "string" && isConcrete(fm.version));
  add(
    "name-description",
    1,
    "frontmatter",
    fm !== null && typeof fm.name === "string" && isConcrete(fm.name) && typeof fm.description === "string" && isConcrete(fm.description),
  );
  add("colors-background", 1, "frontmatter", groupHasConcrete(fm, "colors", "background-100"));
  add("colors-text", 1, "frontmatter", groupHasConcrete(fm, "colors", "gray-1000") && groupHasConcrete(fm, "colors", "gray-900"));
  add("colors-accent", 1, "frontmatter", ACCENT_SCALES.some((a) => groupHasConcrete(fm, "colors", `${a}-700`)));
  add("colors-semantic", 1, "frontmatter", groupHasConcrete(fm, "colors", "red-700") && groupHasConcrete(fm, "colors", "amber-700"));
  add("type-copy", 1, "frontmatter", countRoleTokens(fm, "copy") >= 1);
  add("type-heading", 1, "frontmatter", countRoleTokens(fm, "heading") >= 1);
  add("spacing-scale", 1, "frontmatter", groupHasConcrete(fm, "spacing", "base") && countNumericSpacingSteps(fm) >= 5);
  add("rounded-sm", 1, "frontmatter", groupHasConcrete(fm, "rounded", "sm"));
  add("breakpoints-2", 1, "body", bodyOk("breakpoints-2"));

  // --- Level 2 (Standard) — checklist § Level 2 ---
  add(
    "colors-background-scale",
    2,
    "frontmatter",
    ["background-100", "background-200", "background-300"].every((k) => groupHasConcrete(fm, "colors", k)),
  );
  add("colors-gray-scale", 2, "frontmatter", GRAY_STEPS.every((s) => groupHasConcrete(fm, "colors", `gray-${s}`)));
  add("colors-alpha-scale", 2, "frontmatter", ALPHA_STEPS.every((s) => groupHasConcrete(fm, "colors", `gray-alpha-${s}`)));
  add(
    "colors-accent-scales",
    2,
    "frontmatter",
    ACCENT_SCALES.every((a) => ["700", "800", "900", "1000"].every((s) => groupHasConcrete(fm, "colors", `${a}-${s}`))),
  );
  add("type-headings-3", 2, "frontmatter", countRoleTokens(fm, "heading") >= 3);
  add("type-label", 2, "frontmatter", countRoleTokens(fm, "label") >= 1);
  add("type-button", 2, "frontmatter", countRoleTokens(fm, "button") >= 1);
  add("spacing-full", 2, "frontmatter", countNumericSpacingSteps(fm) >= 9);
  add("rounded-full", 2, "frontmatter", ["sm", "md", "lg", "full"].every((k) => groupHasConcrete(fm, "rounded", k)));
  add(
    "components-button",
    2,
    "frontmatter",
    hasComponent(fm, "button-primary") && hasComponent(fm, "button-secondary") && hasComponent(fm, "button-small"),
  );
  add("components-input", 2, "frontmatter", hasComponent(fm, "input"));
  add("breakpoints-4", 2, "body", bodyOk("breakpoints-4"));
  add("components-button-states", 2, "body", bodyOk("components-button-states"));
  add("components-input-states", 2, "body", bodyOk("components-input-states"));
  add("spacing-rhythm", 2, "body", bodyOk("spacing-rhythm"));

  // --- Level 3 (Production) — checklist § Level 3 ---
  const componentNames: string[] = [];
  if (fm !== null && isMap(fm.components)) {
    for (const key of Object.keys(fm.components)) {
      if (key !== RAW_GROUP && isMap(fm.components[key])) componentNames.push(key);
    }
  }
  const namesJoined = componentNames.join(" ");
  add(
    "components-library",
    3,
    "frontmatter",
    componentNames.length >= 4 &&
      /card/i.test(namesJoined) &&
      /modal/i.test(namesJoined) &&
      /tooltip/i.test(namesJoined) &&
      /menu|dropdown/i.test(namesJoined),
  );
  add("dark-exists", 3, "body", bodyOk("dark-exists"));
  add("dark-parity", 3, "body", bodyOk("dark-parity"));
  add("elevation-shadows", 3, "body", bodyOk("elevation-shadows"));
  add("motion-easing", 3, "body", bodyOk("motion-easing"));
  add("motion-durations", 3, "body", bodyOk("motion-durations"));
  add("motion-reduced", 3, "body", bodyOk("motion-reduced"));
  add("voice-content", 3, "body", bodyOk("voice-content"));

  // Level computation: body items participate only when a checklist was given.
  const participating = items.filter((it) => it.source === "frontmatter" || !bodyUnverified);
  const failing = (level: number) => participating.filter((it) => it.level === level && !it.ok).map((it) => it.id);
  const fail1 = failing(1);
  const fail2 = failing(2);
  const fail3 = failing(3);
  let level: CompletenessLevel;
  let missing: string[];
  if (fail1.length > 0) {
    level = "BELOW_MVP";
    missing = fail1;
  } else if (fail2.length > 0) {
    level = "MVP";
    missing = fail2;
  } else if (fail3.length > 0) {
    level = "Standard";
    missing = fail3;
  } else {
    level = "Production";
    missing = [];
  }
  if (level === "Production" && bodyUnverified) {
    // Production's checklist is dominated by body/dual-theme items (7 of 9);
    // without body confirmation the engine cannot certify it. (In this
    // branch `checklist` is undefined by definition of bodyUnverified.)
    level = "Standard";
    missing = [...L3_BODY_ITEM_IDS];
  }

  // Placeholder markers (design-md-spec §5) → upgrade suggestion.
  const placeholders: CompletenessPlaceholder[] = [];
  frontmatterText.split(/\r?\n/).forEach((line, index) => {
    const m = /\b(LEVEL([23])_PLACEHOLDER)\b/.exec(line);
    if (m !== null) placeholders.push({ level: Number(m[2]) as 2 | 3, marker: m[1], line: index + 1 });
  });
  const rank = LEVEL_RANK[level];
  const candidate = placeholders
    .map((p) => p.level)
    .filter((l) => l > rank)
    .sort((a, b) => b - a)[0];
  const upgradeTo: 2 | 3 | null = candidate === undefined ? null : candidate;

  return { level, items, missing, placeholders, upgradeTo, bodyUnverified };
}
