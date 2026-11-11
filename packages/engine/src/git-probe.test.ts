/**
 * Git probe locale stability (I-001081).
 *
 * The fatal-128 classification cannot tell "not a repository" from any other
 * fatal 128 by exit code, so it reads Git's stderr. A translated Git must
 * therefore classify exactly like the C-locale one.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { checkoutRootOrFailure } from "./git-probe.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-git-probe-"));
const REPO = join(ROOT, "repo");
const PLAIN = join(ROOT, "plain");
const BROKEN = join(ROOT, "broken");

mkdirSync(REPO);
execFileSync("git", ["init", "-q"], { cwd: REPO, stdio: ["ignore", "ignore", "ignore"] });
mkdirSync(PLAIN);
// A `.git` file Git cannot parse: fatal 128 without the non-repository message.
mkdirSync(BROKEN);
writeFileSync(join(BROKEN, ".git"), "garbage\n");

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function stderrOfProbe(dir: string, locale: string): string {
  try {
    execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: locale, LANG: locale, LANGUAGE: locale },
    });
    return "";
  } catch (error) {
    if (typeof error === "object" && error !== null && "stderr" in error) {
      const stderr = error.stderr;
      if (typeof stderr === "string") return stderr;
      if (stderr instanceof Uint8Array) return Buffer.from(stderr).toString("utf8");
    }
    return "";
  }
}

// Translation is only reachable when the locale data exists on this machine.
// Without it the same suite still runs, it just cannot prove the pin.
const translatedGit = stderrOfProbe(PLAIN, "de_DE.UTF-8") !== stderrOfProbe(PLAIN, "C");

function underLocale<T>(locale: string, run: () => T): T {
  const saved = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, LANGUAGE: process.env.LANGUAGE };
  process.env.LC_ALL = locale;
  process.env.LANG = locale;
  process.env.LANGUAGE = locale;
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("checkoutRootOrFailure", () => {
  test("resolves a real checkout root", () => {
    expect(checkoutRootOrFailure(REPO)).toEqual({ root: realpathSync(REPO), failed: false });
  });

  test("classifies a non-repository directory as the non-git start", () => {
    expect(checkoutRootOrFailure(PLAIN)).toEqual({ root: null, failed: false });
  });

  test("fails closed for a fatal 128 that is not a missing repository", () => {
    expect(checkoutRootOrFailure(BROKEN)).toEqual({ root: null, failed: true });
  });

  test.skipIf(!translatedGit)("classifies identically under a translated Git", () => {
    const cLocale = {
      repo: checkoutRootOrFailure(REPO),
      plain: underLocale("C", () => checkoutRootOrFailure(PLAIN)),
      broken: underLocale("C", () => checkoutRootOrFailure(BROKEN)),
    };
    expect(underLocale("de_DE.UTF-8", () => checkoutRootOrFailure(REPO))).toEqual(cLocale.repo);
    expect(underLocale("de_DE.UTF-8", () => checkoutRootOrFailure(PLAIN))).toEqual(cLocale.plain);
    expect(underLocale("de_DE.UTF-8", () => checkoutRootOrFailure(BROKEN))).toEqual(cLocale.broken);
  });
});
