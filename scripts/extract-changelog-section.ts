#!/usr/bin/env bun
/**
 * extract-changelog-section.ts — print one `## [<version>]` section of CHANGELOG.md.
 *
 * Usage:
 *   bun run scripts/extract-changelog-section.ts <version> [--max-bytes <n>]
 *
 * `--max-bytes` caps the output for body-size-limited consumers — GitHub
 * rejects a PR body over 65536 characters and a Release body over 125000
 * ("Body is too long"), so a large release (a major line with many fragments)
 * otherwise fails at `gh pr create`. The cut lands on a line boundary (never
 * mid-code-point or mid-line) and appends a notice naming where the full text
 * lives.
 *
 * The cap is expressed in bytes because a UTF-8 byte count is always >= the
 * character count, so a byte cap can never overflow a platform character cap.
 * A cap below the byte length of the notice is refused, since the notice it
 * must carry would not fit.
 */

/**
 * Body of `## [version]` in `changelog`: `undefined` when the heading is
 * absent, `""` when it is present with an empty body — the caller needs both
 * to name the right cause.
 */
export function extractSection(changelog: string, version: string): string | undefined {
  const header = `## [${version}]`;
  const start = changelog.indexOf(header);

  if (start === -1) return undefined;

  const afterHeader = changelog.slice(start + header.length);
  const nextSection = afterHeader.search(/\n## \[/);

  return (nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection)).trim();
}

/** The truncation notice for a given `maxBytes` cap — the single source of its text. */
export function truncationNotice(maxBytes: number): string {
  return `\n\n> Truncated at ${maxBytes} bytes to fit the platform body limit. Full section: \`CHANGELOG.md\`.`;
}

/** Byte length of `truncationNotice(maxBytes)`, i.e. the smallest usable cap. */
export function truncationNoticeBytes(maxBytes: number): number {
  return Buffer.byteLength(truncationNotice(maxBytes), "utf8");
}

/** `section` cut to at most `maxBytes` UTF-8 bytes plus a truncation notice. */
export function truncateSection(section: string, maxBytes: number): string {
  const notice = truncationNotice(maxBytes);
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
  const usage = "Usage: bun run scripts/extract-changelog-section.ts <version> [--max-bytes <n>]";

  // Checked first, and before the file is read: without a version there is no
  // heading to look for, so a section-lookup refusal would name the wrong cause.
  if (!version) {
    console.error(
      "A release version is required — pass it as the first argument (e.g. `bun run scripts/extract-changelog-section.ts 4.0.0`) or set RELEASE_VERSION.",
    );
    process.exit(1);
  }

  if (maxBytesIndex !== -1) {
    const maxBytes = Number(maxBytesArg);
    if (maxBytesArg === undefined || !Number.isInteger(maxBytes) || maxBytes <= 0) {
      console.error(
        `${usage}\n--max-bytes requires a positive integer — ${
          maxBytesArg === undefined ? "no value was given" : `got "${maxBytesArg}"`
        }; pass e.g. --max-bytes 60000.`,
      );
      process.exit(1);
    }

    // Smallest cap whose own truncation notice fits inside it (87 today).
    let floor = 1;
    while (floor < truncationNoticeBytes(floor)) floor++;

    if (maxBytes < floor) {
      console.error(
        `${usage}\n--max-bytes ${maxBytes} is below the ${floor}-byte truncation notice it must carry; pass --max-bytes ${floor} or larger.`,
      );
      process.exit(1);
    }

    return run(version, maxBytes);
  }

  return run(version, 0);
}

async function run(version: string, maxBytes: number): Promise<void> {
  let changelog: string;

  try {
    changelog = await Bun.file("CHANGELOG.md").text();
  } catch (error) {
    // Strip the errno prefix so a raw stack/ENOENT never reaches the operator.
    const reason = (error as Error).message.split("\n")[0].replace(/^[A-Z][A-Z0-9]+:\s*/, "");
    console.error(
      `CHANGELOG.md is not readable in ${process.cwd()} (${reason}) — run this from the repository root that holds CHANGELOG.md.`,
    );
    process.exit(1);
  }

  const section = extractSection(changelog, version);

  if (section === undefined) {
    console.error(
      `No CHANGELOG section found for ## [${version}] in CHANGELOG.md — check the version against an existing \`## [x.y.z]\` heading, or set RELEASE_VERSION to that version.`,
    );
    process.exit(1);
  }

  if (section === "") {
    console.error(
      `CHANGELOG section for ${version} is empty in CHANGELOG.md — add its bullets (or the matching fragments) before extracting.`,
    );
    process.exit(1);
  }

  const capped = maxBytes > 0 && Buffer.byteLength(section) > maxBytes;
  process.stdout.write(capped ? truncateSection(section, maxBytes) : section);
}

if (import.meta.main) await main();
