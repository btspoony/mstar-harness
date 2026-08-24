/**
 * scripts/prepare-release.ts — fragment `packages:` token validation.
 */
import { describe, expect, test } from "bun:test";
import { parseFragment, validateFragmentPackages } from "./prepare-release.ts";

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
