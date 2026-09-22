/**
 * Harness ignore policy — adapter fence/doctor byte preservation.
 *
 * `appendHarnessProjectGitignore` (the install write path) and
 * `missingHarnessProcessGitignoreEntries` (the read path behind the four
 * `doctor` loops) share the engine `hasHarnessRootDeclaration` predicate: an
 * authored harness-root declaration makes `<projectRoot>/.gitignore`
 * author-owned, so the fence writes no bytes and doctor reports no missing
 * canonical entries. An undeclared file still receives the canonical entries
 * (fresh bootstrap), and the generic `appendGitignore` used for unrelated
 * plugin rules keeps appending — the harness no-op does not leak into it.
 *
 * Every case uses a temporary repository directory; nothing here touches a
 * real checkout.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HARNESS_PROCESS_GITIGNORE,
  appendGitignore,
  appendHarnessProjectGitignore,
  missingHarnessProcessGitignoreEntries,
} from "../src/adapters/shared-install";

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "mstar-harness-ignore-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Authored policy: comment, CRLF, duplicate rule, negation, no final newline. */
const AUTHORED = "# authored harness policy\r\n.mstar/**\r\n.mstar/**\r\n!.mstar/specs/**";

describe("harness authored ignore", () => {
  test("missingHarnessProcessGitignoreEntries reports nothing for a declared file", () => {
    expect(missingHarnessProcessGitignoreEntries(AUTHORED)).toEqual([]);
    expect(missingHarnessProcessGitignoreEntries("!.agents/knowledge/**\n")).toEqual([]);
    expect(missingHarnessProcessGitignoreEntries("/.mstar/\n")).toEqual([]);
  });

  test("missingHarnessProcessGitignoreEntries still reports the canonical set for an undeclared file", () => {
    // `.mstarc` is the config entry, not a harness-root rule: a file holding
    // only `node_modules/` and `.mstarc` stays undeclared (the canonical set is
    // still reported), and the `.mstarc` entry already present is not
    // re-reported — the report is the absent subset, never a duplicate.
    const missing = missingHarnessProcessGitignoreEntries("node_modules/\n.mstarc\n");
    expect(missing).not.toHaveLength(0);
    expect(missing).toContain(".mstar/**");
    expect(missing).not.toContain(".mstarc");
    expect(missing).toEqual(HARNESS_PROCESS_GITIGNORE.filter((entry) => entry !== ".mstarc"));
    expect(missingHarnessProcessGitignoreEntries("")).toEqual(HARNESS_PROCESS_GITIGNORE);
  });

  test("appendHarnessProjectGitignore leaves a declared file byte-for-byte unchanged", () => {
    withRoot((root) => {
      writeFileSync(join(root, ".gitignore"), AUTHORED, "utf8");

      expect(appendHarnessProjectGitignore(root, false)).toEqual([]);
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(AUTHORED);
    });
  });

  test("appendHarnessProjectGitignore is a declared-file no-op in dry-run too", () => {
    withRoot((root) => {
      writeFileSync(join(root, ".gitignore"), AUTHORED, "utf8");

      expect(appendHarnessProjectGitignore(root, true)).toEqual([]);
      expect(readFileSync(join(root, ".gitignore"), "utf8")).toBe(AUTHORED);
    });
  });

  test("appendHarnessProjectGitignore bootstraps an undeclared file with the canonical entries", () => {
    withRoot((root) => {
      writeFileSync(join(root, ".gitignore"), "node_modules/\n", "utf8");

      const notes = appendHarnessProjectGitignore(root, false);
      expect(notes).toEqual(HARNESS_PROCESS_GITIGNORE.map((entry) => `Added ${entry} to .gitignore`));
      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      expect(gitignore.startsWith("node_modules/\n")).toBe(true);
      for (const entry of HARNESS_PROCESS_GITIGNORE) expect(gitignore).toContain(entry);
    });
  });

  test("appendHarnessProjectGitignore bootstraps a missing .gitignore", () => {
    withRoot((root) => {
      expect(appendHarnessProjectGitignore(root, false).length).toBe(HARNESS_PROCESS_GITIGNORE.length);
      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      for (const entry of HARNESS_PROCESS_GITIGNORE) expect(gitignore).toContain(entry);
    });
  });

  test("a dry-run fresh bootstrap reports the entries without writing the file", () => {
    withRoot((root) => {
      expect(appendHarnessProjectGitignore(root, true).length).toBe(HARNESS_PROCESS_GITIGNORE.length);
      expect(existsSync(join(root, ".gitignore"))).toBe(false);
    });
  });

  test("generic appendGitignore still appends to a declared file (the harness no-op does not leak)", () => {
    withRoot((root) => {
      writeFileSync(join(root, ".gitignore"), AUTHORED, "utf8");

      expect(appendGitignore(root, [".omp/plugins/"], false)).toEqual(["Added .omp/plugins/ to .gitignore"]);
      const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
      expect(gitignore.startsWith(AUTHORED)).toBe(true);
      expect(gitignore).toContain(".omp/plugins/");
    });
  });
});
