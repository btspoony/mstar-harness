/**
 * Git probe locale stability (I-001081).
 *
 * The fatal-128 classification cannot tell "not a repository" from any other
 * fatal 128 by exit code, so it reads Git's stderr. A translated Git must
 * therefore classify exactly like the C-locale one.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { checkoutRootOrFailure } from "./git-probe.js";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-git-probe-"));
const REPO = join(ROOT, "repo");
const PLAIN = join(ROOT, "plain");
const BROKEN = join(ROOT, "broken");
const STUB = join(ROOT, "git-stub");

mkdirSync(REPO);
execFileSync("git", ["init", "-q"], { cwd: REPO, stdio: ["ignore", "ignore", "ignore"] });
mkdirSync(PLAIN);
// A `.git` file Git cannot parse: fatal 128 without the non-repository message.
mkdirSync(BROKEN);
writeFileSync(join(BROKEN, ".git"), "garbage\n");

// Stand-in for a translated Git: it answers like Git, but speaks German
// whenever the child's LC_ALL is not C. No locale data is needed, so the pin is
// proven on every machine, CI included. It models only the LC_ALL decision; the
// `LANGUAGE` the probe still inherits from the parent is not reproduced (glibc
// skips translation entirely in the C locale, which is what the pin relies on).
writeFileSync(
  STUB,
  `#!/bin/sh
dir="$2"
if [ -d "$dir/.git" ]; then
  (cd "$dir" && pwd -P)
  exit 0
fi
if [ "\${LC_ALL:-}" = C ]; then
  if [ -f "$dir/.git" ]; then echo "fatal: invalid gitfile format: $dir/.git" >&2
  else echo "fatal: not a git repository (or any parent): .git" >&2; fi
else
  if [ -f "$dir/.git" ]; then echo "fatal: ungültiges Gitfile-Format: $dir/.git" >&2
  else echo "fatal: Kein Git-Repository (und kein übergeordnetes Verzeichnis): .git" >&2; fi
fi
exit 128
`,
);
chmodSync(STUB, 0o755);

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

function stubStderr(dir: string, locale: string): string {
  try {
    execFileSync(STUB, ["-C", dir, "rev-parse", "--show-toplevel"], {
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

  test("classifies identically when Git would translate its messages", () => {
    // A stub that never translates would make the assertions below vacuous.
    expect(stubStderr(PLAIN, "de_DE.UTF-8")).toContain("Kein Git-Repository");
    expect(stubStderr(PLAIN, "C")).toContain("not a git repository");

    // Baseline: the real Git classification under the locale the probe pins.
    const baseline = underLocale("C", () => ({
      repo: checkoutRootOrFailure(REPO),
      plain: checkoutRootOrFailure(PLAIN),
      broken: checkoutRootOrFailure(BROKEN),
    }));
    const probe = (dir: string, locale: string) =>
      underLocale(locale, () => checkoutRootOrFailure(dir, { gitPath: STUB }));

    expect(probe(REPO, "C")).toEqual(baseline.repo);
    expect(probe(PLAIN, "C")).toEqual(baseline.plain);
    expect(probe(BROKEN, "C")).toEqual(baseline.broken);

    expect(probe(REPO, "de_DE.UTF-8")).toEqual(baseline.repo);
    expect(probe(PLAIN, "de_DE.UTF-8")).toEqual(baseline.plain);
    expect(probe(BROKEN, "de_DE.UTF-8")).toEqual(baseline.broken);
  });
});
