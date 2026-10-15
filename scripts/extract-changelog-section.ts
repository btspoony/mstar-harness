#!/usr/bin/env bun
/**
 * extract-changelog-section.ts — print one `## [<version>]` section of CHANGELOG.md.
 *
 * Usage:
 *   bun run scripts/extract-changelog-section.ts <version> [--max-bytes <n>]
 *
 * `--max-bytes` caps the output for body-size-limited consumers — GitHub
 * truncates a PR body at 65536 characters and a Release body at 125000, so a
 * large release (a major line with many fragments) otherwise fails at
 * `gh pr create`. The cut lands on a line boundary (never mid-code-point or
 * mid-line) and appends a notice naming where the full text lives.
 *
 * The cap is expressed in bytes because a UTF-8 byte count is always >= the
 * character count, so a byte cap can never overflow a platform character cap.
 * A cap below the notice size yields the notice alone.
 */

/** Body of `## [version]` in `changelog`, or undefined when absent/empty. */
export function extractSection(changelog: string, version: string): string | undefined {
  const header = `## [${version}]`;
  const start = changelog.indexOf(header);

  if (start === -1) return undefined;

  const afterHeader = changelog.slice(start + header.length);
  const nextSection = afterHeader.search(/\n## \[/);
  const body = (nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection)).trim();

  return body || undefined;
}

/** `section` cut to at most `maxBytes` UTF-8 bytes plus a truncation notice. */
export function truncateSection(section: string, maxBytes: number): string {
  const notice = `\n\n> Truncated at ${maxBytes} bytes to fit the platform body limit. Full section: \`CHANGELOG.md\`.`;
  const head = Buffer.from(section, "utf8")
    .subarray(0, Math.max(0, maxBytes - Buffer.byteLength(notice)))
    .toString("utf8");
  const boundary = head.lastIndexOf("\n");

  return `${boundary > 0 ? head.slice(0, boundary) : ""}${notice}`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const maxBytesIndex = argv.indexOf("--max-bytes");
  const maxBytesArg = maxBytesIndex === -1 ? undefined : argv.splice(maxBytesIndex, 2)[1];
  const version = argv[0] ?? process.env.RELEASE_VERSION;
  const maxBytes = maxBytesArg === undefined ? 0 : Number(maxBytesArg);

  if (!version || (maxBytesIndex !== -1 && (!Number.isInteger(maxBytes) || maxBytes <= 0))) {
    console.error("Usage: bun run scripts/extract-changelog-section.ts <version> [--max-bytes <n>]");
    process.exit(1);
  }

  const changelog = await Bun.file("CHANGELOG.md").text();
  const section = extractSection(changelog, version);

  if (!section) {
    console.error(`No CHANGELOG section found for ## [${version}]`);
    process.exit(1);
  }

  const capped = maxBytes > 0 && Buffer.byteLength(section) > maxBytes;
  process.stdout.write(capped ? truncateSection(section, maxBytes) : section);
}

if (import.meta.main) await main();
