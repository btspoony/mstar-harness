/**
 * scripts/prepare-release.ts — fragment `packages:` token validation.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bumpJsonVersion, bumpVersion, parseFragment, syncRootDependencySpecs, validateFragmentPackages } from "./prepare-release.ts";
import {
  DEFAULT_VERSION_PATH,
  CHANGELOGS,
  RELEASE_VERSION_RE,
  VERSION_SURFACES,
  compareSemver,
  isPrereleaseVersion,
  readVersionAt,
} from "./release-surfaces.ts";

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
      'typo.md: unknown packages token "scripts" (expected one of root|cli|opencode|opencode-v2|engine|commands|dsh|omp)',
    ]);
  });

  test("accepts published command package token", () => {
    expect(validateFragmentPackages(["commands"], "new-packages.md")).toEqual([]);
  });
  test("accepts the OpenCode V2 package token", () => {
    expect(validateFragmentPackages(["opencode-v2"], "new-packages.md")).toEqual([]);
  });

  test("collects every error across files/tokens (not first-error only)", () => {
    const errors = [
      ...validateFragmentPackages(["cli", "clii", "scripts"], "a.md"),
      ...validateFragmentPackages(["engine", "dshh"], "b.md"),
    ];
    expect(errors).toEqual([
      'a.md: unknown packages token "clii" (expected one of root|cli|opencode|opencode-v2|engine|commands|dsh|omp)',
      'a.md: unknown packages token "scripts" (expected one of root|cli|opencode|opencode-v2|engine|commands|dsh|omp)',
      'b.md: unknown packages token "dshh" (expected one of root|cli|opencode|opencode-v2|engine|commands|dsh|omp)',
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

describe("syncRootDependencySpecs (hosted root manifest)", () => {
  const manifest = (spec: string) => `{
  "dependencies": {
    "@mstar-harness/commands": "${spec}",
    "@mstar-harness/engine": "${spec}",
  },
  "devDependencies": {
    "@mstar-harness/commands": "workspace:*"
  }
}
`;

  test("rewrites every workspace runtime dependency and leaves build links untouched", () => {
    const out = syncRootDependencySpecs(manifest("workspace:*"), "3.5.0");
    for (const name of ["commands", "engine"]) {
      expect(out).toContain(`"@mstar-harness/${name}": "^3.5.0"`);
    }
    expect(out).toContain('"devDependencies": {\n    "@mstar-harness/commands": "workspace:*"\n  }');
  });

  test("rewrites stale ranges to stable and prerelease release ranges", () => {
    expect(syncRootDependencySpecs(manifest("^3.4.0"), "3.5.0")).not.toContain("^3.4.0");
    expect(syncRootDependencySpecs(manifest("workspace:*"), "3.6.0-alpha.1")).toContain('"@mstar-harness/engine": "^3.6.0-alpha.1"');
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

describe("bumpVersion (auto-bump, prerelease graduation)", () => {
  test("stable current bumps patch/minor as before", () => {
    expect(bumpVersion("3.5.1", "patch")).toBe("3.5.2");
    expect(bumpVersion("3.5.1", "minor")).toBe("3.6.0");
  });

  test("prerelease current graduates to the same-core stable on patch/default", () => {
    expect(bumpVersion("3.6.0-alpha.1", "patch")).toBe("3.6.0");
  });

  test("prerelease current graduates to the next minor stable on minor", () => {
    expect(bumpVersion("3.6.0-alpha.1", "minor")).toBe("3.7.0");
  });
});

describe("marketplace manifest surfaces (nested version locator)", () => {
  test("both marketplace manifests are version surfaces located at plugins.0.version", () => {
    const nested = VERSION_SURFACES.filter((s) => s.versionPath !== undefined);
    expect(nested.map((s) => s.path).sort()).toEqual([".claude-plugin/marketplace.json", "marketplace.json"]);
    for (const s of nested) expect(s.versionPath).toBe("plugins.0.version");
  });
  test("commands remain versioned; the standalone MCP package is retired", () => {
    expect(VERSION_SURFACES.map((surface) => surface.path)).toContain("packages/commands/package.json");
    expect(VERSION_SURFACES.map((surface) => surface.path)).not.toContain("packages/mcp/package.json");
    expect(CHANGELOGS.map((surface) => surface.pkg)).toContain("commands");
    expect(CHANGELOGS.map((surface) => surface.pkg)).not.toContain("mcp");
  });

  test("readVersionAt walks the dotted locator; default reads the root version", () => {
    const doc = { version: "1.0.0", plugins: [{ name: "x", version: "2.0.0" }] };
    expect(readVersionAt(doc, "plugins.0.version")).toBe("2.0.0");
    expect(readVersionAt(doc, DEFAULT_VERSION_PATH)).toBe("1.0.0");
    expect(readVersionAt(doc, "plugins.9.version")).toBeUndefined();
    expect(readVersionAt(doc, "plugins.0.name")).toBe("x");
    expect(readVersionAt(doc, "plugins.1.version")).toBeUndefined();
  });
});

describe("bumpJsonVersion (locator-aware bump)", () => {
  const MARKETPLACE_FIXTURE = JSON.stringify(
    {
      name: "mstar-local",
      plugins: [{ name: "morning-star-harness", version: "3.7.0", source: { source: "github" } }],
    },
    null,
    2,
  );

  /**
   * Invariant: `process.cwd()` is captured before `chdir` and restored, and
   * the temp dir removed, in `finally` — even when `fn` throws (asserted by
   * the dedicated restoration test below).
   */
  async function withTempCwd(files: Record<string, string>, fn: () => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "mstar-release-"));
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      for (const [name, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, name)), { recursive: true });
        writeFileSync(join(dir, name), content);
      }
      await fn();
    } finally {
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("bumps a marketplace manifest at plugins.0.version; validate re-reads via the locator", async () => {
    await withTempCwd({ "marketplace.json": MARKETPLACE_FIXTURE }, async () => {
      await bumpJsonVersion("marketplace.json", "3.7.0", "3.7.1", "plugins.0.version");
      const json = JSON.parse(readFileSync("marketplace.json", "utf8"));
      expect(readVersionAt(json, "plugins.0.version")).toBe("3.7.1");
    });
  });

  test("default locator still bumps a plain root-version document", async () => {
    await withTempCwd({ "pkg.json": `{"name":"x","version":"1.2.3"}` }, async () => {
      await bumpJsonVersion("pkg.json", "1.2.3", "1.2.4");
      expect(JSON.parse(readFileSync("pkg.json", "utf8")).version).toBe("1.2.4");
    });
  });

  test("fails loud when the located version is not the current release", async () => {
    await withTempCwd({ "marketplace.json": MARKETPLACE_FIXTURE }, async () => {
      await expect(bumpJsonVersion("marketplace.json", "9.9.9", "3.7.1", "plugins.0.version")).rejects.toThrow(
        /version at "plugins.0.version" is 3.7.0, expected "9.9.9"/,
      );
    });
  });

  test("replaces only the located occurrence when an earlier key carries the same version string", async () => {
    // Models the QC F-002 scenario: a root-level version key textually before
    // plugins[0].version with the same old value — the located span, not the
    // first textual occurrence, must be rewritten.
    const fixture = `{
  "version": "3.7.0",
  "plugins": [{ "name": "morning-star-harness", "version": "3.7.0", "source": { "source": "github" } }]
}
`;
    await withTempCwd({ "marketplace.json": fixture }, async () => {
      await bumpJsonVersion("marketplace.json", "3.7.0", "3.7.1", "plugins.0.version");
      const json = JSON.parse(readFileSync("marketplace.json", "utf8"));
      expect(json.version).toBe("3.7.0"); // earlier textual occurrence untouched
      expect(readVersionAt(json, "plugins.0.version")).toBe("3.7.1"); // only the located key moved
    });
  });

  test("prerelease version flows through the nested locator unchanged", async () => {
    await withTempCwd({ "marketplace.json": MARKETPLACE_FIXTURE }, async () => {
      await bumpJsonVersion("marketplace.json", "3.7.0", "3.8.0-alpha.1", "plugins.0.version");
      const json = JSON.parse(readFileSync("marketplace.json", "utf8"));
      expect(readVersionAt(json, "plugins.0.version")).toBe("3.8.0-alpha.1");
    });
  });

  test("withTempCwd restores process.cwd() even when the callback throws", async () => {
    const before = process.cwd();
    await expect(
      withTempCwd({ "x.json": "{}" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(process.cwd()).toBe(before);
  });
});
