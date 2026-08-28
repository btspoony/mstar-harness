/**
 * scripts/prepare-release.ts — fragment `packages:` token validation.
 */
import { describe, expect, test } from "bun:test";
import { parseFragment, syncRootEngineSpec, validateFragmentPackages } from "./prepare-release.ts";

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

  test("throws when the root manifest has no engine runtime dependency", () => {
    expect(() =>
      syncRootEngineSpec(`{ "dependencies": { "zod": "^4.0.0" } }`, "3.5.0"),
    ).toThrow('could not find dependencies["@mstar-harness/engine"]');
  });
});
