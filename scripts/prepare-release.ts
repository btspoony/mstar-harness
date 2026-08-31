#!/usr/bin/env bun
/**
 * prepare-release.ts — assemble changelog fragments + bump every surface.
 *
 * Usage:
 *   bun run release:prepare                 # auto patch bump (1.8.6 -> 1.8.7)
 *   bun run release:prepare -- 1.9.0         # explicit version
 *   bun run release:prepare -- --minor       # auto minor bump
 *
 * What it does:
 *   1. Resolves the next version (explicit arg or auto bump from root package.json).
 *   2. Reads `.changes/unreleased/*.md` fragments and groups them by changelog + category.
 *   3. Inserts a new `## [<version>] - <date>` section into each changelog
 *      (under `## [Unreleased]`), auto-appending a Version-alignment block.
 *   4. Bumps all version surfaces (including the portable Agent Plugins manifest) + the INSTALL.md marketplace example.
 *   5. Moves consumed fragments to `.changes/archive/<version>/`.
 *
 * Fragment format (`.changes/unreleased/<slug>.md`):
 *   ---
 *   category: Harness        # optional; default per package (Harness | Changed | ...)
 *   packages: root           # optional; comma list of root | cli | opencode | engine
 *   ---
 *   - English bullet.
 *   - Another English bullet.
 *
 *   <!-- CN -->
 *   - 中文要点。
 *
 * This script only edits the working tree. Commit + PR is the caller's job
 * (the `release-prep` workflow commits and opens the `release vX.Y.Z` PR).
 */
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import {
  CHANGELOGS,
  INSTALL_REF,
  RELEASE_VERSION_RE,
  VERSION_SURFACES,
  compareSemver,
  isPrereleaseVersion,
} from "./release-surfaces.ts";

type Fragment = {
  file: string;
  category?: string;
  packages: string[];
  en: string;
  cn: string;
};

const CHANGES_DIR = ".changes";
const UNRELEASED_DIR = `${CHANGES_DIR}/unreleased`;
const ARCHIVE_DIR = `${CHANGES_DIR}/archive`;

// Valid `packages:` tokens for changelog fragments (.changes/README.md).
const FRAGMENT_PACKAGES = ["root", "cli", "opencode", "engine", "dsh"];

const DEFAULT_CATEGORY: Record<string, string> = {
  root: "Harness",
  cli: "Changed",
  opencode: "Bundled harness skills (`harness-skills/` at publish)",
  engine: "Changed",
  dsh: "Changed",
};

function parseArgs(argv: string[]): { version?: string; bump: "patch" | "minor" } {
  const rest = argv.slice(2).filter((a) => a !== "--");
  let version: string | undefined;
  let bump: "patch" | "minor" = "patch";
  for (const a of rest) {
    if (/^\d+\.\d+\.\d+/.test(a)) version = a;
    else if (a === "--minor") bump = "minor";
    else if (a === "--patch") bump = "patch";
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { version, bump };
}

function bumpVersion(v: string, kind: "patch" | "minor"): string {
  const [maj, min, pat] = v.split(".").map((n) => parseInt(n, 10));
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

async function readCurrentVersion(): Promise<string> {
  const pkg = (await Bun.file("package.json").json()) as { version: string };
  if (!pkg.version) throw new Error("package.json has no version");
  return pkg.version;
}

function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const fm: Record<string, string> = {};
  if (!text.startsWith("---")) return { fm, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fm, body: text };
  const fmText = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\n/, "");
  for (const line of fmText.split("\n")) {
    const m = line.match(/^([A-Za-z0-9 _-]+):\s*(.*)$/);
    if (m) fm[m[1].trim()] = m[2].trim();
  }
  return { fm, body };
}

export function parseFragment(file: string, text: string): Fragment {
  const { fm, body } = parseFrontmatter(text);
  const cnMarker = body.indexOf("\n<!-- CN -->");
  const strip = (s: string) => s.replace(/^\n+/, "").replace(/\n+$/, "");
  const en = cnMarker === -1 ? body : body.slice(0, cnMarker);
  const cn = cnMarker === -1 ? "" : body.slice(cnMarker + "\n<!-- CN -->".length);
  const packages = (fm.packages ?? "root")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    file,
    category: fm.category?.trim() || undefined,
    packages: packages.length ? packages : ["root"],
    en: strip(en),
    cn: strip(cn),
  };
}

/**
 * Validate normalized fragment `packages:` tokens against the release-surface
 * enum (root | cli | opencode | engine | dsh — .changes/README.md). Returns
 * every error string (collect-all, not first-error); an empty list validates
 * clean (callers keep the existing ["root"] default). Exported for tests.
 */
export function validateFragmentPackages(packages: string[], file: string): string[] {
  const errors: string[] = [];
  for (const tok of packages) {
    if (!FRAGMENT_PACKAGES.includes(tok)) {
      errors.push(`${file}: unknown packages token "${tok}" (expected one of ${FRAGMENT_PACKAGES.join("|")})`);
    }
  }
  return errors;
}

async function readFragments(): Promise<Fragment[]> {
  if (!existsSync(UNRELEASED_DIR)) return [];
  const files = readdirSync(UNRELEASED_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const out: Fragment[] = [];
  const errors: string[] = [];
  for (const f of files) {
    const frag = parseFragment(f, await Bun.file(`${UNRELEASED_DIR}/${f}`).text());
    errors.push(...validateFragmentPackages(frag.packages, f));
    out.push(frag);
  }
  if (errors.length) {
    // Fail loud: an unknown packages token matches no changelog target, so
    // buildSectionBody's filter would silently drop the fragment from every
    // changelog. Hard-stop before any changelog mutation or fragment archival.
    for (const e of errors) console.error(e);
    process.exit(1);
  }
  return out;
}

/** Build the markdown body for one changelog target, between the version header and the next section. */
function buildSectionBody(target: (typeof CHANGELOGS)[number], frags: Fragment[], version: string): string {
  const relevant = frags.filter((f) => f.packages.includes(target.pkg));

  // group by category (default per package), preserving fragment order
  const groups: { category: string; bullets: string[] }[] = [];
  for (const f of relevant) {
    const cat = f.category ?? DEFAULT_CATEGORY[target.pkg];
    let g = groups.find((x) => x.category === cat);
    if (!g) {
      g = { category: cat, bullets: [] };
      groups.push(g);
    }
    const body = target.lang === "cn" ? f.cn || f.en : f.en;
    for (const line of body.split("\n")) {
      const t = line.trimEnd();
      if (t.trim()) g.bullets.push(t);
    }
  }

  const lines: string[] = [];
  if (target.pkg === "root") {
    for (const g of groups) {
      lines.push(`### ${g.category}`, "", ...g.bullets, "");
    }
    if (target.lang === "cn") {
      lines.push(
        "### 版本对齐",
        "",
        `- 提升 monorepo 根、\`@mstar-harness/opencode\`、\`@mstar-harness/cli\`、\`@mstar-harness/engine\`、\`@mstar-harness/dsh\`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ ${version}**。`,
        "",
      );
    } else {
      lines.push(
        "### Version alignment",
        "",
        `- Bump monorepo root, \`@mstar-harness/opencode\`, \`@mstar-harness/cli\`, \`@mstar-harness/engine\`, \`@mstar-harness/dsh\`, Cursor/Codex/Kimi/ZCode/omp/Claude plugin manifests, and the portable Agent Plugins manifest: **→ ${version}**.`,
        "",
      );
    }
  } else {
    const cat = groups[0]?.category ?? DEFAULT_CATEGORY[target.pkg];
    const bullets: string[] = [];
    for (const g of groups) for (const b of g.bullets) bullets.push(b);
    lines.push(`### ${cat}`, "");
    if (bullets.length) lines.push(...bullets, "");
    const note =
      target.pkg === "opencode"
        ? `- Version alignment with harness **${version}** (no OpenCode package API change).`
        : `- Version alignment with harness **${version}**.`;
    lines.push(note, "", `See root [CHANGELOG.md](../../CHANGELOG.md) **${version}**.`, "");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function insertSection(changelog: string, version: string, date: string, body: string): string {
  const header = `## [${version}] - ${date}`;
  const unreleased = changelog.indexOf("## [Unreleased]");
  if (unreleased === -1) {
    const newSection = `\n${header}\n\n${body}\n`;
    return changelog.replace(/^(# .+\n(?:.*\n)*?\n)/, `$1${newSection}`);
  }
  const afterLine = changelog.indexOf("\n", unreleased) + 1;
  const tail = changelog.slice(afterLine).replace(/^\n/, "");
  return `${changelog.slice(0, afterLine)}\n${header}\n\n${body}\n\n${tail}`;
}

async function bumpJsonVersion(path: string, oldV: string, newV: string): Promise<void> {
  const text = await Bun.file(path).text();
  const re = new RegExp(`("version"\\s*:\\s*")${oldV.replace(/\./g, "\\.")}(")`);
  if (!re.test(text)) throw new Error(`${path}: could not find version field "${oldV}"`);
  await Bun.write(path, text.replace(re, `$1${newV}$2`));
}

/**
 * Bump the INSTALL.md marketplace example to `newV`. The old version is
 * derived from INSTALL.md's own quoted `"version"` field — never from the
 * release `current` — because after a prerelease the surfaces carry a
 * suffixed version while INSTALL.md stays on the last stable; passing that
 * suffixed `current` here would find no match and silently leave INSTALL.md
 * stale (and `release:validate` would then hard-fail the stable release).
 * Fails fast if the file or its version field is missing (validate would
 * fail later anyway).
 */
async function bumpInstall(newV: string): Promise<void> {
  const text = await Bun.file(INSTALL_REF.path).text();
  const m = text.match(/"version"\s*:\s*"(\d+\.\d+\.\d+)"/);
  if (!m) {
    throw new Error(`${INSTALL_REF.path}: could not find quoted "version" field (expected X.Y.Z)`);
  }
  await Bun.write(INSTALL_REF.path, text.replace(m[0], `"version": "${newV}"`));
}

/**
 * Rewrite the root manifest's runtime dependency on `@mstar-harness/engine`
 * to `^<version>`. The root package.json is the manifest git/hosted installs
 * resolve (`omp plugin install github:…`, `bun add github:…`), where the
 * `workspace:` protocol is unresolvable — the spec must be a plain semver
 * range so hosted installs fetch the published engine from npm. Dev checkouts
 * still link the workspace member (bun links when the range is satisfied).
 * Scoped to the `dependencies` block: internal packages keep `workspace:*`
 * devDependencies (bundled at build time). Pure text transform, exported for
 * tests.
 */
export function syncRootEngineSpec(text: string, version: string): string {
  const re = /("dependencies"\s*:\s*\{[^{}]*?"@mstar-harness\/engine"\s*:\s*")[^"]*(")/;
  if (!re.test(text)) {
    throw new Error('package.json: could not find dependencies["@mstar-harness/engine"]');
  }
  return text.replace(re, `$1^${version}$2`);
}

function archiveFragments(version: string, frags: Fragment[]): void {
  if (!frags.length) return;
  const dest = `${ARCHIVE_DIR}/${version}`;
  mkdirSync(dest, { recursive: true });
  for (const f of frags) {
    renameSync(`${UNRELEASED_DIR}/${f.file}`, `${dest}/${f.file}`);
  }
}

async function main(): Promise<void> {
  const { version: explicit, bump } = parseArgs(process.argv);
  const current = await readCurrentVersion();
  const version = explicit ?? bumpVersion(current, bump);
  const date = new Date().toISOString().slice(0, 10);

  if (!RELEASE_VERSION_RE.test(version)) {
    throw new Error(`Invalid version "${version}". Expected X.Y.Z or X.Y.Z-<prerelease>.`);
  }
  if (compareSemver(version, current) <= 0) {
    throw new Error(`Version ${version} must be greater than current ${current}.`);
  }

  console.log(`Preparing release ${current} -> ${version}\n`);

  const frags = await readFragments();
  console.log(`Fragments: ${frags.length}`);
  for (const f of frags) console.log(`  - ${f.file}  [packages: ${f.packages.join(", ")}]`);
  if (!frags.length) {
    console.log(`  (no fragments — section will contain only the Version-alignment block)`);
  }

  for (const target of CHANGELOGS) {
    const text = await Bun.file(target.path).text();
    const body = buildSectionBody(target, frags, version);
    const next = insertSection(text, version, date, body);
    await Bun.write(target.path, next);
    console.log(`changelog: ${target.path}`);
  }

  for (const s of VERSION_SURFACES) {
    await bumpJsonVersion(s.path, current, version);
    console.log(`bump: ${s.path}`);
  }

  // Internal packages (cli/opencode/dsh) bundle the engine at build time; their
  // devDependency keeps `workspace:*` and needs no sync. The ROOT manifest is
  // what git/hosted installs resolve, so its runtime engine dependency must
  // track the release as a plain semver range (`^<version>`) served by npm.
  {
    const rootPath = "package.json";
    const text = await Bun.file(rootPath).text();
    await Bun.write(rootPath, syncRootEngineSpec(text, version));
    console.log(`sync: ${rootPath} dependencies["@mstar-harness/engine"] -> ^${version}`);
  }
  if (isPrereleaseVersion(version)) {
    console.log(`skip: ${INSTALL_REF.path} (prerelease — stays at last stable)`);
  } else {
    await bumpInstall(version);
    console.log(`bump: ${INSTALL_REF.path}`);
  }

  archiveFragments(version, frags);

  console.log(`\nDone. Next: commit and open PR "release v${version}".`);
  console.log(`Validate with: bun run release:validate -- v${version}`);
}

// Run only when executed directly (`bun run scripts/prepare-release.ts`) —
// importing the module (unit tests) must not start the release flow.
if (import.meta.main) {
  main().catch((err) => {
    console.error(`\nprepare-release failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
