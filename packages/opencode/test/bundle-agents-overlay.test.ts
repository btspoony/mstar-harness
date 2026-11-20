/**
 * OpenCode agents overlay contract — `bundle-harness-assets` copies the
 * shared repo-root `agents/` (the cross-host subagent surface) into
 * `harness-agents/`, then overlays this package's OpenCode-only `agents/`
 * (the `mode: primary` project-manager seat) on top.
 *
 * The overlay is the only mechanism that preserves PM for OpenCode, so the
 * real-mirror assertions below pin its presence in the generated
 * `harness-agents/` — a regression that drops the overlay merge fails here
 * instead of silently shipping OpenCode without its primary orchestration
 * agent. The mirror is gitignored, but CI builds this package (bundle-assets)
 * before running the test suite, so the assertions execute for real there;
 * they skip gracefully in bare checkouts (same pattern as the dsh mirror
 * specs).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyTree,
  destAgents,
  mergeTree,
  packageRoot,
  repoRoot,
  sourceAgents,
  sourceOpenCodeAgents,
} from "../scripts/bundle-harness-assets.ts";
import { MorningStarHarnessPlugin } from "../src/mstar.js";

/** A tiny throwaway source/dest pair; never touches the real mirrors. */
async function fixturePair(): Promise<{ src: string; dest: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "opencode-agents-overlay-"));
  const src = join(root, "opencode-agents");
  const dest = join(root, "harness-agents");
  await mkdir(src, { recursive: true });
  await mkdir(dest, { recursive: true });
  return { src, dest, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("bundle-harness-assets — resolved paths", () => {
  test("anchors packageRoot one level under the repo root and mirrors repo-root agents/", () => {
    expect(packageRoot).toBe(join(repoRoot, "packages", "opencode"));
    expect(sourceAgents).toBe(join(repoRoot, "agents"));
    expect(destAgents).toBe(join(packageRoot, "harness-agents"));
    expect(sourceOpenCodeAgents).toBe(join(packageRoot, "agents"));
  });
});

describe("mergeTree — overlay contract on a tiny fixture", () => {
  test("copies the overlay on top of dest without clearing it", async () => {
    const { src, dest, cleanup } = await fixturePair();
    try {
      await writeFile(join(dest, "fullstack-dev.md"), "---\nmode: subagent\n---\nsource: shared-shell\n");
      await writeFile(join(dest, "project-manager.md"), "---\nmode: subagent\n---\nsource: stale-seat\n");
      await writeFile(join(src, "project-manager.md"), "---\nmode: primary\n---\nsource: opencode-overlay\n");

      mergeTree("opencode-agents", src, dest);

      expect(readdirSync(dest).sort()).toEqual(["fullstack-dev.md", "project-manager.md"]);
      expect(readFileSync(join(dest, "fullstack-dev.md"), "utf8")).toContain("source: shared-shell");
      const primary = readFileSync(join(dest, "project-manager.md"), "utf8");
      expect(primary).toContain("mode: primary");
      expect(primary).toContain("source: opencode-overlay");
      expect(primary).not.toContain("source: stale-seat");
    } finally {
      await cleanup();
    }
  });

  test("copyTree still replaces a stale dest tree instead of merging into it", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencode-agents-copytree-"));
    const src = join(root, "agents");
    const dest = join(root, "harness-agents");
    try {
      await mkdir(src, { recursive: true });
      await mkdir(join(dest, "stale"), { recursive: true });
      await writeFile(join(src, "fullstack-dev.md"), "---\nmode: subagent\n---\nsource: replacement-shell\n");
      await writeFile(join(dest, "fullstack-dev.md"), "---\nmode: subagent\n---\nsource: stale-shell\n");
      await writeFile(join(dest, "stale", "old.md"), "leftover");

      copyTree("agents", src, dest);

      expect(existsSync(join(dest, "stale"))).toBe(false);
      expect(readdirSync(dest)).toEqual(["fullstack-dev.md"]);
      const shared = readFileSync(join(dest, "fullstack-dev.md"), "utf8");
      expect(shared).toContain("source: replacement-shell");
      expect(shared).not.toContain("source: stale-shell");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});


// Bundled-mirror assertion: the mirror is gitignored and produced by
// bundle-assets (the build runs it before the test suite in CI), so this
// fails in CI if the overlay merge is ever dropped. Skips in bare checkouts
// where bundle-assets has not run.
test.skipIf(!existsSync(destAgents))("the bundled overlay exposes the primary PM and shared agents to OpenCode", async () => {
  const hooks = await MorningStarHarnessPlugin();
  const config: Parameters<NonNullable<typeof hooks.config>>[0] = {};
  await hooks.config?.(config);
  expect(config.agent?.["project-manager"]?.mode).toBe("primary");
  expect(config.agent?.["fullstack-dev"]?.mode).toBe("subagent");
});

test("packed artifact carries harness-agents (package.json files)", () => {
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { files?: string[] };
  expect(pkg.files).toContain("harness-agents");
});
