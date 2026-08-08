/**
 * Engine design-md module — DESIGN.md token frontmatter validation, light/dark
 * parity, and completeness level audit.
 *
 * Spec sources (cited per test): mstar-design-md SKILL.md (YAML frontmatter
 * SSOT, dual-theme rules, completeness levels),
 * mstar-design-md/references/design-md-spec.md (§1.5 token store, §4 light/dark
 * contract, §5 upgrade placeholders), and
 * mstar-design-md/references/completeness-checklist.md (Level 1–3 items).
 */
import { describe, expect, test } from "bun:test";
import {
  assertLightDarkParity,
  completenessLevel,
  parseDesignFrontmatter,
  validateDesignTokenFrontmatter,
} from "../src/design-md.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Full Level 1 frontmatter (template shape: version, name, description,
 * colors with required tokens, typography copy+heading, spacing, rounded;
 * Level 2 sections commented out with LEVEL2_PLACEHOLDER). */
const FM_LEVEL1 = `---
version: 0.1.0
name: "Acme Design"
description: "Acme Design is a minimal, high-contrast design system. This is the Light theme."
colors:
  background-100: "#ffffff"
  # LEVEL2_PLACEHOLDER: secondary surface — uncomment when upgrading
  # background-200: "#f5f5f5"
  gray-1000: "#171717"
  gray-900: "#666666"
  blue-700: "#0066ff"
  red-700: "#e60000"
  amber-700: "#ffaa00"
typography:
  copy-16:
    fontFamily: Geist Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
  heading-32:
    fontFamily: Geist Sans
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.02em
spacing:
  base: 4px
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  6: 24px
rounded:
  sm: 6px
---
`;

/** Full Level 3 frontmatter — everything active, including components and
 * P3 color variants. */
const FM_LEVEL3 = `---
version: 0.1.0
name: "Acme Design"
description: "Acme Design full design system. Light theme; dark theme at DESIGN.dark.md."
colors:
  background-100: "#ffffff"
  background-200: "#f5f5f5"
  background-300: "#e5e5e5"
  gray-100: "#f5f5f5"
  gray-200: "#ebebeb"
  gray-300: "#e6e6e6"
  gray-400: "#eaeaea"
  gray-500: "#c9c9c9"
  gray-600: "#a8a8a8"
  gray-700: "#8f8f8f"
  gray-800: "#7d7d7d"
  gray-900: "#666666"
  gray-1000: "#171717"
  gray-alpha-100: "#0000000d"
  gray-alpha-200: "#00000015"
  gray-alpha-300: "#0000001a"
  gray-alpha-400: "#00000014"
  gray-alpha-500: "#00000036"
  gray-alpha-600: "#0000003d"
  blue-700: "#006bff"
  blue-800: "#0059ec"
  blue-900: "#005ff2"
  blue-1000: "#002359"
  red-700: "#fc0035"
  red-800: "#ea001d"
  red-900: "#d8001b"
  red-1000: "#47000c"
  amber-700: "#ffae00"
  amber-800: "#ff9300"
  amber-900: "#aa4d00"
  amber-1000: "#561900"
  green-700: "#28a948"
  green-800: "#279141"
  green-900: "#107d32"
  green-1000: "#003a00"
  teal-700: "#00ac96"
  teal-800: "#00927f"
  teal-900: "#007f70"
  teal-1000: "#003f34"
  purple-700: "#a000f8"
  purple-800: "#8500d1"
  purple-900: "#7d00cc"
  purple-1000: "#2f004e"
  pink-700: "#f22782"
  pink-800: "#e4106e"
  pink-900: "#c41562"
  pink-1000: "#460523"
  blue-700-p3: "oklch(57.61% 0.2508 258.23)"
typography:
  copy-16:
    fontFamily: Geist Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
  heading-32:
    fontFamily: Geist Sans
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.02em
  heading-24:
    fontFamily: Geist Sans
    fontSize: 24px
    fontWeight: 600
    lineHeight: 32px
    letterSpacing: -0.01em
  heading-20:
    fontFamily: Geist Sans
    fontSize: 20px
    fontWeight: 600
    lineHeight: 26px
    letterSpacing: -0.005em
  label-14:
    fontFamily: Geist Sans
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: 0
  button-14:
    fontFamily: Geist Sans
    fontSize: 14px
    fontWeight: 500
    lineHeight: 20px
    letterSpacing: 0
spacing:
  base: 4px
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  6: 24px
  8: 32px
  10: 40px
  16: 64px
  24: 96px
rounded:
  sm: 6px
  md: 12px
  lg: 16px
  full: 9999px
components:
  button-primary:
    backgroundColor: "{colors.gray-1000}"
    textColor: "{colors.background-100}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: 40px
  button-secondary:
    backgroundColor: "{colors.background-100}"
    textColor: "{colors.gray-1000}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: 40px
  button-small:
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
    height: 32px
  input:
    backgroundColor: "{colors.background-100}"
    textColor: "{colors.gray-1000}"
    typography: "{typography.label-14}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: 40px
  card:
    backgroundColor: "{colors.background-100}"
    rounded: "{rounded.lg}"
  modal:
    backgroundColor: "{colors.background-200}"
    rounded: "{rounded.md}"
  tooltip:
    backgroundColor: "{colors.gray-1000}"
    rounded: "{rounded.sm}"
  menu:
    backgroundColor: "{colors.background-100}"
    rounded: "{rounded.md}"
---
`;

/** Dark variant of FM_LEVEL3 — same token names, different values. */
const FM_DARK = FM_LEVEL3.replace(/"#ffffff"/, '"#111111"')
  .replace(/"#f5f5f5"/, '"#1a1a1a"')
  .replace(/"#e5e5e5"/, '"#242424"')
  .replace(/"#171717"/, '"#f5f5f5"')
  .replace(/"#666666"/, '"#a3a3a3"')
  .replace(/"#006bff"/, '"#58a6ff"');

/** Missing the whole `colors` group. */
const FM_NO_COLORS = `---
version: 0.1.0
name: "Acme Design"
description: "Test fixture."
typography:
  copy-16:
    fontFamily: Geist Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
spacing:
  base: 4px
  1: 4px
rounded:
  sm: 6px
---
`;

/** Colors with an invalid hex value and a "[...]" placeholder value. */
const FM_BAD_COLORS = `---
version: 0.1.0
name: "Acme Design"
description: "Test fixture."
colors:
  background-100: "not-a-color"
  gray-1000: "[#171717]"
  blue-700: "#0066ff"
typography:
  copy-16:
    fontFamily: Geist Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
spacing:
  base: 4px
  1: 4px
rounded:
  sm: 6px
---
`;

/** Typography token missing one of the five required properties. */
const FM_BAD_TYPOGRAPHY = `---
version: 0.1.0
name: "Acme Design"
description: "Test fixture."
colors:
  background-100: "#ffffff"
typography:
  copy-16:
    fontFamily: Geist Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
spacing:
  base: 4px
  1: 4px
rounded:
  sm: 6px
---
`;

/** Spacing without `base`, and a non-px value. */
const FM_BAD_SPACING = `---
version: 0.1.0
name: "Acme Design"
description: "Test fixture."
colors:
  background-100: "#ffffff"
typography:
  copy-16:
    fontFamily: Geist Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
spacing:
  1: 4px
  2: 8px
  3: "12"
rounded:
  sm: 6px
---
`;

/** Rounded value that is not a pixel length. */
const FM_BAD_ROUNDED = `---
version: 0.1.0
name: "Acme Design"
description: "Test fixture."
colors:
  background-100: "#ffffff"
typography:
  copy-16:
    fontFamily: Geist Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
spacing:
  base: 4px
  1: 4px
rounded:
  sm: "6rem"
---
`;

/** Component section with a reference that does not resolve. */
const FM_BAD_COMPONENT_REF = `---
version: 0.1.0
name: "Acme Design"
description: "Test fixture."
colors:
  background-100: "#ffffff"
  gray-1000: "#171717"
typography:
  copy-16:
    fontFamily: Geist Sans
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
  button-14:
    fontFamily: Geist Sans
    fontSize: 14px
    fontWeight: 500
    lineHeight: 20px
spacing:
  base: 4px
  1: 4px
rounded:
  sm: 6px
components:
  button-primary:
    backgroundColor: "{colors.gray-1000}"
    typography: "{typography.button-14}"
    rounded: "{rounded.sm}"
    height: 40px
  button-error:
    backgroundColor: "{colors.red-800}"
---
`;

/** Document without any frontmatter block. */
const FM_NONE = `# Acme Design

Acme Design is a minimal design system.
`;

/** Level 1 frontmatter with the typography placeholder style from the
 * template (`"[font-family]"`). */
const FM_LEVEL1_PLACEHOLDER_VALUES = `---
version: 0.1.0
name: "[Design System Name]"
description: "[Design System Name] is a minimal design system."
colors:
  background-100: "[#ffffff]"
  gray-1000: "#171717"
  gray-900: "#666666"
  blue-700: "#0066ff"
  red-700: "#e60000"
  amber-700: "#ffaa00"
typography:
  copy-16:
    fontFamily: "[font-family]"
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
  heading-32:
    fontFamily: "[font-family]"
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.02em
spacing:
  base: 4px
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  6: 24px
rounded:
  sm: 6px
---
`;

const hasCode = (g: { violations: { code: string }[] }, code: string) =>
  g.violations.some((v) => v.code === code);

// ---------------------------------------------------------------------------
// parseDesignFrontmatter — mstar-design-md SKILL.md § YAML frontmatter SSOT
// ---------------------------------------------------------------------------

describe("parseDesignFrontmatter", () => {
  test("parses the five token groups from a full frontmatter", () => {
    const fm = parseDesignFrontmatter(FM_LEVEL3);
    expect(fm).not.toBeNull();
    expect(fm!.colors["background-100"]).toBe("#ffffff");
    expect(fm!.colors["blue-700-p3"]).toBe("oklch(57.61% 0.2508 258.23)");
    const copy = fm!.typography["copy-16"] as Record<string, unknown>;
    expect(copy.fontFamily).toBe("Geist Sans");
    expect(fm!.spacing.base).toBe("4px");
    expect(fm!.spacing["10"]).toBe("40px");
    expect(fm!.rounded.full).toBe("9999px");
    const button = fm!.components["button-primary"] as Record<string, unknown>;
    expect(button.height).toBe("40px");
  });

  test("skips commented-out (LEVEL2_PLACEHOLDER) keys", () => {
    const fm = parseDesignFrontmatter(FM_LEVEL1);
    expect(fm).not.toBeNull();
    expect(fm!.colors["background-200"]).toBeUndefined();
    expect(fm!.colors["background-100"]).toBe("#ffffff");
  });

  test("returns null when there is no frontmatter block", () => {
    expect(parseDesignFrontmatter(FM_NONE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// validateDesignTokenFrontmatter — design-md-spec §1.5 token store
// ---------------------------------------------------------------------------

describe("validateDesignTokenFrontmatter", () => {
  test("passes a complete Level 3 frontmatter", () => {
    const result = validateDesignTokenFrontmatter(FM_LEVEL3);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("passes the template-shaped Level 1 frontmatter", () => {
    expect(validateDesignTokenFrontmatter(FM_LEVEL1).ok).toBe(true);
  });

  test("reports missing frontmatter block", () => {
    const result = validateDesignTokenFrontmatter(FM_NONE);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "design-md.tokens.missing-frontmatter")).toBe(true);
  });

  test("reports a missing required token group (colors)", () => {
    const result = validateDesignTokenFrontmatter(FM_NO_COLORS);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "design-md.tokens.missing-group")).toBe(true);
    expect(result.violations.filter((v) => v.code === "design-md.tokens.missing-group")).toHaveLength(1);
  });

  test("reports invalid color values and placeholder values", () => {
    const result = validateDesignTokenFrontmatter(FM_BAD_COLORS);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "design-md.tokens.color-format")).toBe(true);
    expect(hasCode(result, "design-md.tokens.placeholder")).toBe(true);
  });

  test("reports typography tokens missing one of the five properties", () => {
    const result = validateDesignTokenFrontmatter(FM_BAD_TYPOGRAPHY);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "design-md.tokens.typography-shape")).toBe(true);
  });

  test("reports spacing without base and non-px spacing values", () => {
    const result = validateDesignTokenFrontmatter(FM_BAD_SPACING);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "design-md.tokens.spacing-base")).toBe(true);
    expect(hasCode(result, "design-md.tokens.spacing-format")).toBe(true);
  });

  test("reports rounded values that are not pixel lengths", () => {
    const result = validateDesignTokenFrontmatter(FM_BAD_ROUNDED);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "design-md.tokens.rounded-format")).toBe(true);
  });

  test("reports unresolvable {path} references in components", () => {
    const result = validateDesignTokenFrontmatter(FM_BAD_COMPONENT_REF);
    expect(result.ok).toBe(false);
    const refViolations = result.violations.filter((v) => v.code === "design-md.tokens.ref-unresolved");
    expect(refViolations.length).toBe(1);
    expect(refViolations[0].message).toContain("{colors.red-800}");
  });
});

// ---------------------------------------------------------------------------
// assertLightDarkParity — design-md-spec §4 light/dark dual-theme contract
// ---------------------------------------------------------------------------

describe("assertLightDarkParity", () => {
  test("passes when both files define the same token key sets", () => {
    const result = assertLightDarkParity(FM_LEVEL3, FM_DARK);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test("flags a token present in light but missing in dark", () => {
    const dark = FM_DARK.replace(/\n  gray-alpha-100: "#0000000d"/, "");
    const result = assertLightDarkParity(FM_LEVEL3, dark);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "design-md.parity.missing-dark")).toBe(true);
    const v = result.violations.find((x) => x.code === "design-md.parity.missing-dark")!;
    expect(v.message).toContain("colors.gray-alpha-100");
  });

  test("flags a token present in dark but missing in light", () => {
    // Insert the extra token inside the colors section (indent 2) — the dark
    // file must not invent tokens DESIGN.md lacks (spec §4 rule 3).
    const withExtra = FM_DARK.replace(
      '  blue-700-p3: "oklch(57.61% 0.2508 258.23)"\n',
      '  blue-700-p3: "oklch(57.61% 0.2508 258.23)"\n  extra-token: "#123456"\n',
    );
    const result = assertLightDarkParity(FM_LEVEL3, withExtra);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "design-md.parity.missing-light")).toBe(true);
  });

  test("never compares values — different values with same keys pass", () => {
    // FM_DARK already differs in values; assertLightDarkParity(FM_LEVEL3, FM_DARK) is ok=true
    expect(assertLightDarkParity(FM_LEVEL3, FM_DARK).ok).toBe(true);
  });

  test("reports missing frontmatter in either file", () => {
    const result = assertLightDarkParity(FM_LEVEL3, FM_NONE);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "design-md.parity.missing-frontmatter")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// completenessLevel — completeness-checklist.md Level 1–3
// ---------------------------------------------------------------------------

describe("completenessLevel", () => {
  test("Level 1 frontmatter audits as MVP", () => {
    const result = completenessLevel(FM_LEVEL1);
    expect(result.level).toBe("MVP");
    expect(result.bodyUnverified).toBe(true);
  });

  test("full Level 3 frontmatter audits as Production with body checklist", () => {
    const body = [
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
    ];
    const result = completenessLevel(FM_LEVEL3, body);
    expect(result.level).toBe("Production");
    expect(result.missing).toEqual([]);
    expect(result.bodyUnverified).toBe(false);
  });

  test("full Level 3 frontmatter without the body checklist stops at Standard (frontmatter-provable)", () => {
    const result = completenessLevel(FM_LEVEL3);
    // dark-exists / dark-parity / elevation / motion / voice are body items —
    // not provable from this file alone.
    expect(result.level).toBe("Standard");
  });

  test("missing gray-900 demotes below MVP", () => {
    const broken = FM_LEVEL1.replace(/\n  gray-900: "#666666"/, "");
    const result = completenessLevel(broken);
    expect(result.level).toBe("BELOW_MVP");
    expect(result.missing).toContain("colors-text");
  });

  test("detects LEVEL2_PLACEHOLDER / LEVEL3_PLACEHOLDER markers and suggests upgrade", () => {
    const result = completenessLevel(FM_LEVEL1);
    expect(result.placeholders.length).toBeGreaterThan(0);
    expect(result.placeholders.some((p) => p.level === 2)).toBe(true);
    expect(result.upgradeTo).toBe(2);
  });

  test("reports items with per-level membership", () => {
    const result = completenessLevel(FM_LEVEL1);
    const copy = result.items.find((i) => i.id === "type-copy");
    expect(copy).toBeDefined();
    expect(copy!.ok).toBe(true);
    const label = result.items.find((i) => i.id === "type-label");
    expect(label!.ok).toBe(false);
    expect(label!.level).toBe(2);
  });

  test("placeholder values fail their checklist items", () => {
    const result = completenessLevel(FM_LEVEL1_PLACEHOLDER_VALUES);
    expect(result.level).toBe("BELOW_MVP");
    expect(result.missing).toContain("name-description");
    expect(result.missing).toContain("colors-background");
    expect(result.missing).toContain("type-copy");
  });
});
