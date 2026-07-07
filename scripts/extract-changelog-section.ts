#!/usr/bin/env bun

const version = process.argv[2] ?? process.env.RELEASE_VERSION;

if (!version) {
  console.error("Usage: bun run scripts/extract-changelog-section.ts <version>");
  process.exit(1);
}

const changelog = await Bun.file("CHANGELOG.md").text();
const header = `## [${version}]`;
const start = changelog.indexOf(header);

if (start === -1) {
  console.error(`No CHANGELOG section found for ${header}`);
  process.exit(1);
}

const afterHeader = changelog.slice(start + header.length);
const nextSection = afterHeader.search(/\n## \[/);
const body = (nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection)).trim();

if (!body) {
  console.error(`CHANGELOG section for ${version} is empty`);
  process.exit(1);
}

process.stdout.write(body);
