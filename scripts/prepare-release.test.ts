/**
 * scripts/prepare-release.ts — registry-row ensure logic (qc1 F-002).
 *
 * The root changelog heads must carry an `@mstar-harness/engine` registry
 * row + `packages/engine/CHANGELOG.md` package-history link even when the
 * row was never hand-added (the Engine npm package is a version surface
 * since 1.8.8). `ensureEngineRegistryRow` inserts both at release-prep time;
 * tests run on temp changelog heads — the real changelogs are never
 * hand-edited (AGENTS.md §1 changelog rule).
 */
import { describe, expect, test } from "bun:test";
import { ensureEngineRegistryRow } from "./prepare-release.ts";

const EN_HEAD = `# Changelog

Chinese summary: [CHANGELOG_CN.md](CHANGELOG_CN.md).

All notable changes to this repository are documented here. Published harness surfaces are at **1.8.8** unless noted:

| Surface | Package / manifest | Version |
| --- | --- | --- |
| Monorepo root | \`morning-star\` (\`package.json\`) | **1.8.8** |
| CLI | \`@mstar-harness/cli\` (\`packages/cli\`) | **1.8.8** |
| OpenCode plugin | \`@mstar-harness/opencode\` (\`packages/opencode\`) | **1.8.8** |
| Cursor plugin | \`.cursor-plugin/plugin.json\` | **1.8.8** |
| Codex plugin | \`.codex-plugin/plugin.json\` | **1.8.8** |
| Kimi plugin | \`.kimi-plugin/plugin.json\` | **1.8.8** |
| ZCode plugin | \`.zcode-plugin/plugin.json\` | **1.8.8** |
| omp plugin | \`.omp-plugin/plugin.json\` / \`.claude-plugin/plugin.json\` | **1.8.8** |
| Agent Plugins manifest | \`plugin.json\` | **1.8.8** |

Package-specific histories: [\`packages/cli/CHANGELOG.md\`](packages/cli/CHANGELOG.md), [\`packages/opencode/CHANGELOG.md\`](packages/opencode/CHANGELOG.md).

## [Unreleased]

## [1.8.8] - 2026-08-06

### Harness

- Some prior release note.
`;

const CN_HEAD = `# 更新日志

本仓库 harness 发布面版本以 [CHANGELOG.md](CHANGELOG.md) 为准：**1.8.8**。

| 发布面 | 位置 | 版本 |
| --- | --- | --- |
| monorepo 根 | \`morning-star\`（\`package.json\`） | **1.8.8** |
| CLI | \`@mstar-harness/cli\`（\`packages/cli\`） | **1.8.8** |
| OpenCode 插件 | \`@mstar-harness/opencode\`（\`packages/opencode\`） | **1.8.8** |
| Cursor 插件 | \`.cursor-plugin/plugin.json\` | **1.8.8** |
| Codex 插件 | \`.codex-plugin/plugin.json\` | **1.8.8** |
| Kimi 插件 | \`.kimi-plugin/plugin.json\` | **1.8.8** |
| ZCode 插件 | \`.zcode-plugin/plugin.json\` | **1.8.8** |
| omp 插件 | \`.omp-plugin/plugin.json\` / \`.claude-plugin/plugin.json\` | **1.8.8** |
| Agent Plugins 清单 | \`plugin.json\` | **1.8.8** |

各包独立日志：[packages/cli/CHANGELOG.md](packages/cli/CHANGELOG.md)、[packages/opencode/CHANGELOG.md](packages/opencode/CHANGELOG.md)。

## [Unreleased]

## [1.8.8] - 2026-08-06

### Harness

- 某条历史记录。
`;

describe("ensureEngineRegistryRow (qc1 F-002)", () => {
  test("inserts the Engine registry row after the CLI row with the new version (EN)", () => {
    const next = ensureEngineRegistryRow(EN_HEAD, "1.9.0");
    expect(next).toContain(
      "| CLI | `@mstar-harness/cli` (`packages/cli`) | **1.8.8** |\n| Engine | `@mstar-harness/engine` (`packages/engine`) | **1.9.0** |",
    );
    // Engine row inserted exactly once (the history link is verified in its
    // own test); surrounding table rows untouched.
    expect(next.match(/@mstar-harness\/engine/g)).toHaveLength(1);
    expect(next).toContain("| OpenCode plugin | `@mstar-harness/opencode` (`packages/opencode`) | **1.8.8** |");
    expect(next).toContain("| Agent Plugins manifest | `plugin.json` | **1.8.8** |");
  });

  test("appends the packages/engine/CHANGELOG.md package-history link (EN)", () => {
    const next = ensureEngineRegistryRow(EN_HEAD, "1.9.0");
    expect(next).toContain(
      "Package-specific histories: [`packages/cli/CHANGELOG.md`](packages/cli/CHANGELOG.md), [`packages/opencode/CHANGELOG.md`](packages/opencode/CHANGELOG.md), [`packages/engine/CHANGELOG.md`](packages/engine/CHANGELOG.md).",
    );
  });

  test("inserts the Engine row + link into the CN head (full-width parens style)", () => {
    const next = ensureEngineRegistryRow(CN_HEAD, "1.9.0");
    expect(next).toContain(
      "| CLI | `@mstar-harness/cli`（`packages/cli`） | **1.8.8** |\n| Engine | `@mstar-harness/engine`（`packages/engine`） | **1.9.0** |",
    );
    expect(next).toContain(
      "各包独立日志：[packages/cli/CHANGELOG.md](packages/cli/CHANGELOG.md)、[packages/opencode/CHANGELOG.md](packages/opencode/CHANGELOG.md)、[packages/engine/CHANGELOG.md](packages/engine/CHANGELOG.md)。",
    );
  });

  test("is idempotent: a head that already carries the engine row + link is unchanged", () => {
    const already = ensureEngineRegistryRow(EN_HEAD, "1.9.0");
    expect(ensureEngineRegistryRow(already, "1.9.0")).toBe(already);
  });

  test("leaves the release-history region (after ## [Unreleased]) untouched", () => {
    const next = ensureEngineRegistryRow(EN_HEAD, "1.9.0");
    expect(next.endsWith(EN_HEAD.slice(EN_HEAD.indexOf("## [Unreleased]")))).toBe(true);
  });

  test("combines with bumpRegistryHead: pre-existing cells bump, inserted Engine cell keeps the new version", () => {
    // ensure inserts with the NEW version; bumpRegistryHead then rewrites the
    // remaining old cells — the Engine row must not drift back to the old
    // version and must stay in sync.
    const ensured = ensureEngineRegistryRow(EN_HEAD, "1.9.0");
    const bumped = bumpRegistryHeadShim(ensured, "1.8.8", "1.9.0");
    expect(bumped).toContain("| CLI | `@mstar-harness/cli` (`packages/cli`) | **1.9.0** |");
    expect(bumped).toContain("| Engine | `@mstar-harness/engine` (`packages/engine`) | **1.9.0** |");
    expect(bumped).toContain("| Cursor plugin | `.cursor-plugin/plugin.json` | **1.9.0** |");
  });
});

/**
 * Local mirror of prepare-release's `bumpRegistryHead` (head-region
 * `**oldV**` → `**newV**` replace) — kept inline so the interplay test does
 * not depend on non-exported internals beyond the function under test.
 */
function bumpRegistryHeadShim(changelog: string, oldV: string, newV: string): string {
  const unreleased = changelog.indexOf("## [Unreleased]");
  const head = unreleased === -1 ? changelog : changelog.slice(0, unreleased);
  const rest = unreleased === -1 ? "" : changelog.slice(unreleased);
  return head.replaceAll(`**${oldV}**`, `**${newV}**`) + rest;
}
