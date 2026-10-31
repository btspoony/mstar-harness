/**
 * mstarc.test.ts — linear binding section: additive parse + validation
 * (binding-config plan Task 1).
 */
import { describe, expect, test } from "bun:test";
import {
  LINEAR_SECTION,
  parseLinearBinding,
  parseMstarc,
} from "./mstarc.js";

const VALID_LINEAR = ["[linear]", "enabled=true", "mode=mirror", "workspace=acme", "team=eng"].join("\n");

describe("parseMstarc [linear] collection", () => {
  test("a valid [linear] block parses to four fields", () => {
    const out = parseMstarc(VALID_LINEAR);
    expect(out.linear).toEqual({ enabled: "true", mode: "mirror", workspace: "acme", team: "eng" });
  });

  test("an absent [linear] section leaves existing behavior untouched", () => {
    const out = parseMstarc("[config]\nharness_dir=.custom\n; comment\nunknown_section\n[other]\nkey=value\n");
    expect(out.harnessDir).toBe(".custom");
    expect(out.linear).toBeUndefined();
    expect(out.linearMapping).toBeUndefined();
  });

  test("[linear.mapping] overrides are collected and unknown mapping keys are ignored by the validator", () => {
    const out = parseMstarc(`${VALID_LINEAR}\n[linear.mapping]\nseverity.high=critical\nfuture-key=ignored\n`);
    expect(out.linearMapping).toEqual({ "severity.high": "critical", "future-key": "ignored" });
    const parsed = parseLinearBinding(out.linear, out.linearMapping);
    expect(parsed.ok && parsed.binding.mapping.severity).toEqual({ high: "critical" });
  });
});

describe("parseLinearBinding", () => {
  test("absent section → enabled=false with the default (identity) mapping", () => {
    const parsed = parseLinearBinding(undefined, undefined);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.binding.enabled).toBe(false);
      expect(parsed.binding.mode).toBe("mirror");
      expect(parsed.binding.mapping).toEqual({ disposition: {}, kind: {}, severity: {} });
    }
  });

  test("an unknown mode is refused by name", () => {
    const parsed = parseLinearBinding({ enabled: "true", mode: "yaml", workspace: "w", team: "t" }, undefined);
    expect(parsed).toEqual({
      ok: false,
      code: "linear.mode-refused",
      message: 'linear.mode-refused: [linear] mode "yaml" is not supported; only "mirror" is accepted this iteration',
    });
  });

  test("enabled=true with a missing workspace/team is refused by name", () => {
    const missingTeam = parseLinearBinding({ enabled: "true", workspace: "w" }, undefined);
    expect(missingTeam).toMatchObject({ ok: false, code: "linear.binding-incomplete" });
    expect((missingTeam as { message: string }).message).toContain("team");
    const missingBoth = parseLinearBinding({ enabled: "true" }, undefined);
    expect((missingBoth as { message: string }).message).toContain("workspace, team");
  });

  test("enabled=false does not require workspace/team", () => {
    const parsed = parseLinearBinding({ enabled: "false" }, undefined);
    expect(parsed.ok).toBe(true);
  });

  test("F8: common boolean spellings are enabled; an unreadable value is refused by name", () => {
    for (const spelling of ["true", "TRUE", "1", "yes", "On"]) {
      const parsed = parseLinearBinding({ enabled: spelling, workspace: "w", team: "t" }, undefined);
      expect([spelling, parsed.ok && parsed.binding.enabled]).toEqual([spelling, true]);
    }
    for (const spelling of ["false", "FALSE", "0", "no", "off"]) {
      const parsed = parseLinearBinding({ enabled: spelling }, undefined);
      expect([spelling, parsed.ok && parsed.binding.enabled]).toEqual([spelling, false]);
    }
    const refused = parseLinearBinding({ enabled: "maybe" }, undefined);
    expect(refused).toMatchObject({ ok: false, code: "linear.binding-invalid" });
    expect((refused as { message: string }).message).toContain('enabled="maybe"');
  });

  test(`section constant stays "${LINEAR_SECTION}"`, () => {
    expect(LINEAR_SECTION).toBe("linear");
  });
});
