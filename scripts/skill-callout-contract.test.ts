/**
 * skill-callout-contract.test.ts — pins the assertions `standalone-smoke.ts`
 * runs over the skill corpus: a callout is a blockquote that carries the
 * shared-contract pointer, the contract owns the engine-absent fallback, and
 * a zero-callout scan fails instead of passing on no hits.
 */
import { describe, expect, test } from "bun:test";
import {
  ENGINE_CHECK_CONTRACT_DOC,
  ENGINE_CHECK_CONTRACT_HEADING,
  ENGINE_CHECK_CONTRACT_POINTER,
  ENGINE_CHECK_FALLBACK_NEEDLE,
  ENGINE_CHECK_MARKER,
  checkCalloutPresence,
  checkContractDoc,
  scanCalloutContract,
} from "./skill-callout-contract.ts";

const callout = (body: string) => `> ${ENGINE_CHECK_MARKER} ${body}`;
const conforming = `${callout("run `mstar status validate` (engine `validateStatus`). On `fail`, do not proceed — fix and re-run.")} ${ENGINE_CHECK_CONTRACT_POINTER}`;

describe("standalone-smoke callout assertions", () => {
  test("a callout that closes with the shared-contract pointer passes", () => {
    const scan = scanCalloutContract("skills/mstar-foo/SKILL.md", conforming);
    expect(scan.callouts).toBe(1);
    expect(scan.failures).toEqual([]);
  });

  test("a callout without the pointer fails, naming the pointer", () => {
    const scan = scanCalloutContract(
      "skills/mstar-foo/SKILL.md",
      callout("run `mstar status validate`. On `fail`, do not proceed — fix and re-run."),
    );
    expect(scan.callouts).toBe(1);
    expect(scan.failures).toEqual([
      `skills/mstar-foo/SKILL.md:1 callout lacks the shared-contract pointer ("${ENGINE_CHECK_CONTRACT_POINTER}")`,
    ]);
  });

  test("the marker outside a blockquote fails (advisory callouts only)", () => {
    const scan = scanCalloutContract("skills/mstar-foo/SKILL.md", `**Engine check:** run \`mstar status validate\``);
    expect(scan.callouts).toBe(0);
    expect(scan.failures).toEqual([
      "skills/mstar-foo/SKILL.md:1 callout marker must be a blockquote (advisory callouts only)",
    ]);
  });

  test("a marker-less corpus scans clean, so presence is a separate assertion", () => {
    const scan = scanCalloutContract("skills/mstar-foo/SKILL.md", "Plain prose about `mstar status validate`.");
    expect(scan).toEqual({ callouts: 0, failures: [] });
  });

  test("zero callouts fails — a check cannot pass on no hits", () => {
    expect(checkCalloutPresence(0)).toEqual([
      "found 0 Engine-check callouts — the marker or the scan is broken, not the corpus",
    ]);
    expect(checkCalloutPresence(1)).toEqual([]);
    expect(checkCalloutPresence(48)).toEqual([]);
  });

  test("the contract doc must own the section and the engine-absent fallback", () => {
    expect(checkContractDoc(ENGINE_CHECK_CONTRACT_DOC, `${ENGINE_CHECK_CONTRACT_HEADING}\n\n${ENGINE_CHECK_FALLBACK_NEEDLE}.`)).toEqual(
      [],
    );
    expect(checkContractDoc(ENGINE_CHECK_CONTRACT_DOC, ENGINE_CHECK_FALLBACK_NEEDLE)).toEqual([
      `${ENGINE_CHECK_CONTRACT_DOC} is missing the "${ENGINE_CHECK_CONTRACT_HEADING}" section`,
    ]);
    expect(checkContractDoc(ENGINE_CHECK_CONTRACT_DOC, ENGINE_CHECK_CONTRACT_HEADING)).toEqual([
      `${ENGINE_CHECK_CONTRACT_DOC} does not state the engine-absent fallback ("${ENGINE_CHECK_FALLBACK_NEEDLE}")`,
    ]);
  });
});
