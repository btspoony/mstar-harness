/**
 * `catalogRootDir` — the repository root follows the caller's checkout for the
 * same repository and keeps its own root for another repository (follow-up to
 * the tracked-result relocation: one catalog operation answers from one
 * checkout).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogRootDir } from "../src/catalog.js";

const roots: string[] = [];

function gitRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture", "commit", "-q", "-m", "fixture"],
    { cwd: root },
  );
  mkdirSync(join(root, ".mstar"), { recursive: true });
}

function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "catalog-roots-")));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("catalogRootDir repository root", () => {
  test("a linked checkout resolves the repository root in its own checkout", () => {
    const main = repo();
    gitRepo(main);
    const worktree = join(main, ".worktrees", "feat");
    execFileSync("git", ["worktree", "add", "-q", "-b", "feat", worktree], { cwd: main });
    const context = { harnessDir: join(main, ".mstar"), checkoutRoot: realpathSync(worktree) };
    expect(catalogRootDir(context, "repository")).toBe(realpathSync(worktree));
    // Process roots keep answering from the control checkout.
    expect(catalogRootDir(context, "harness")).toBe(join(main, ".mstar"));
  });

  test("another repository's checkout keeps that repository's root", () => {
    const main = repo();
    gitRepo(main);
    const other = repo();
    gitRepo(other);
    const context = { harnessDir: join(main, ".mstar"), checkoutRoot: realpathSync(other) };
    expect(catalogRootDir(context, "repository")).toBe(realpathSync(main));
  });

  test("a context without a checkout root keeps the process harness parent", () => {
    const main = repo();
    gitRepo(main);
    expect(catalogRootDir({ harnessDir: join(main, ".mstar") }, "repository")).toBe(main);
  });

  test("a harness nested below the repository anchors the corpora at the repository root", () => {
    // A nested `.mstarc` layout (`harness_dir=runtime/harness`) must not push
    // the `.agents/` corpora down to `runtime/.agents/`: they are tracked
    // results of the repository, and only the repository root is committable
    // at a stable path.
    const main = repo();
    gitRepo(main);
    // The harness dir exists in the real case: the store lives in it.
    mkdirSync(join(main, "runtime", "harness"), { recursive: true });
    const context = { harnessDir: join(main, "runtime", "harness") };
    expect(catalogRootDir(context, "specs")).toBe(join(main, ".agents", "specs"));
    expect(catalogRootDir(context, "knowledge")).toBe(join(main, ".agents", "knowledge"));
  });
});
