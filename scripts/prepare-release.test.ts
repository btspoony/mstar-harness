/**
 * scripts/prepare-release.ts — fragment `packages:` token validation.
 */
import { parseFragment, syncRootEngineSpec, validateFragmentPackages } from "./prepare-release.ts";
import { RELEASE_VERSION_RE, compareSemver, isPrereleaseVersion } from "./release-surfaces.ts";

describe("validateFragmentPackages (release packages enum)", () => {
  test("cli, root (comma+space, mixed case 'CLI, Root') is valid and normalized lowercase", () => {
    const frag = parseFragment("mixed-case.md", `---
packages: CLI, Root
---
- bullet`);
    expect(frag.packages).toEqual(["cli", "root"]);
    expect(validateFragmentPackages(frag.packages, frag.file)).toEqual([]);
  });

  test("single unknown token produces one error naming file + token", () => {
    const errors = validateFragmentPackages(["root", "scripts"], "typo.md");
    expect(errors).toEqual([
      'typo.md: unknown packages token "scripts" (expected one of root|cli|opencode|engine|dsh)',
    ]);
  });

  test("collects every error across files/tokens (not first-error only)", () => {
    const errors = [
      ...validateFragmentPackages(["cli", "clii", "scripts"], "a.md"),
      ...validateFragmentPackages(["engine", "dshh"], "b.md"),
    ];
    expect(errors).toEqual([
      'a.md: unknown packages token "clii" (expected one of root|cli|opencode|engine|dsh)',
      'a.md: unknown packages token "scripts" (expected one of root|cli|opencode|engine|dsh)',
      'b.md: unknown packages token "dshh" (expected one of root|cli|opencode|engine|dsh)',
    ]);
  });

  test("empty/whitespace tokens are filtered; empty packages: value defaults to [root]", () => {
    const empty = parseFragment("empty.md", `---
packages:
---
- bullet`);
    expect(empty.packages).toEqual(["root"]);
    expect(validateFragmentPackages(empty.packages, "empty.md")).toEqual([]);

    const ws = parseFragment("ws.md", `---
packages: root, , cli,
---
- bullet`);
    expect(ws.packages).toEqual(["root", "cli"]);
    expect(validateFragmentPackages(ws.packages, "ws.md")).toEqual([]);
  });
});

describe("syncRootEngineSpec (root manifest engine dependency)", () => {
  const manifest = (spec: string) => `{
  "name": "morning-star",
  "dependencies": {
    "@mstar-harness/engine": "${spec}"
  },
  "devDependencies": {
    "@mstar-harness/engine": "workspace:*"
  }
}
`;

  test("rewrites workspace:* to the release range, devDependencies untouched", () => {
    const out = syncRootEngineSpec(manifest("workspace:*"), "3.5.0");
    expect(out).toContain('"dependencies": {\n    "@mstar-harness/engine": "^3.5.0"\n  }');
    expect(out).toContain('"devDependencies": {\n    "@mstar-harness/engine": "workspace:*"\n  }');
  });

  test("rewrites a stale semver range to the new release range", () => {
    const out = syncRootEngineSpec(manifest("^3.4.0"), "3.5.0");
    expect(out).toContain('"@mstar-harness/engine": "^3.5.0"');
    expect(out).not.toContain("^3.4.0");
  });

  test("rewrites the engine spec to a prerelease range (^3.6.0-alpha.1)", () => {
    const out = syncRootEngineSpec(manifest("workspace:*"), "3.6.0-alpha.1");
    expect(out).toContain('"@mstar-harness/engine": "^3.6.0-alpha.1"');
  });
});

describe("RELEASE_VERSION_RE / isPrereleaseVersion (shared release version contract)", () => {
  test("accepts stable and prerelease versions", () => {
    expect(RELEASE_VERSION_RE.test("3.6.0")).toBe(true);
    expect(RELEASE_VERSION_RE.test("3.6.0-alpha.1")).toBe(true);
  });

  test("rejects malformed versions (short core, v-prefix, build metadata)", () => {
    expect(RELEASE_VERSION_RE.test("3.6")).toBe(false);
    expect(RELEASE_VERSION_RE.test("v3.6.0")).toBe(false);
    expect(RELEASE_VERSION_RE.test("3.6.0-alpha.1+build")).toBe(false);
  });

  test("rejects prerelease identifiers violating semver §9 grammar", () => {
    expect(RELEASE_VERSION_RE.test("3.6.0-alpha..1")).toBe(false);
    expect(RELEASE_VERSION_RE.test("3.6.0-alpha.01")).toBe(false);
    expect(RELEASE_VERSION_RE.test("3.6.0-.alpha")).toBe(false);
  });

  test("accepts a bare numeric prerelease identifier", () => {
    expect(RELEASE_VERSION_RE.test("3.6.0-0")).toBe(true);
  });

  test("isPrereleaseVersion flags only versions with a suffix", () => {
    expect(isPrereleaseVersion("3.6.0")).toBe(false);
    expect(isPrereleaseVersion("3.6.0-alpha.1")).toBe(true);
  });
});

describe("compareSemver (prerelease-aware, semver 2.0.0 §11)", () => {
  test("prerelease sorts below the same core release", () => {
    expect(compareSemver("3.6.0-alpha.1", "3.6.0")).toBeLessThan(0);
  });

  test("prerelease of a newer core outranks an older stable", () => {
    expect(compareSemver("3.6.0-alpha.1", "3.5.9")).toBeGreaterThan(0);
  });

  test("numeric prerelease identifiers compare numerically", () => {
    expect(compareSemver("3.6.0-alpha.1", "3.6.0-alpha.2")).toBeLessThan(0);
    expect(compareSemver("3.6.0-alpha.10", "3.6.0-alpha.9")).toBeGreaterThan(0);
  });

  test("alphanumeric identifiers sort ASCII-lexically after numeric", () => {
    expect(compareSemver("3.6.0-alpha.1", "3.6.0-beta")).toBeLessThan(0);
  });

  test("equal versions compare equal", () => {
    expect(compareSemver("3.6.0", "3.6.0")).toBe(0);
  });
});
