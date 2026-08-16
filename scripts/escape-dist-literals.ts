/**
 * Dist literal escaper — `bun scripts/escape-dist-literals.ts <file...>`.
 *
 * Escapes every non-ASCII character outside comments in a BUILD OUTPUT file
 * (e.g. `packages/cli/dist/mstar-harness.js`) to a `\uXXXX` escape, in place.
 *
 * Why: `bun build` re-prints string literals and normalizes `\uXXXX` escapes
 * back to raw multi-byte UTF-8 (verified empirically), and bun 1.2.17
 * misdecodes raw multi-byte UTF-8 in literals when executing the 366KB
 * `// @bun` CLI bundle (iteration spec §7). Regex literals keep their source
 * escapes, so source-level escaping alone fixes the parsing path — but the
 * fix-hint / message strings (engine modules inlined into the bundle) still
 * decode wrong unless the final bundle is ASCII. This script is the
 * bundler-level guarantee: after `bun build`, the CLI dist carries only
 * ASCII literals and decodes identically under bun, node, or any runtime.
 *
 * `\uXXXX` is valid in every non-comment code position the escaper can hit
 * (string/template text, regex literals, identifier escapes), so the
 * transform is semantics-preserving; comments are skipped for cleanliness.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { commentMask } from "./ascii-literal-utils.ts";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: bun scripts/escape-dist-literals.ts <file...>");
  process.exit(2);
}

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const mask = commentMask(src);
  let out = "";
  let count = 0;
  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i);
    if (code > 0x7f && mask[i] === 0) {
      // \uXXXX escape of the code unit — valid in strings, template text,
      // regexes, and identifier escapes; value-identical to the raw char.
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      count++;
    } else {
      out += src[i];
    }
  }
  if (count > 0) {
    writeFileSync(file, out);
    console.log(`escape-dist-literals: ${file}: ${count} non-ASCII character(s) escaped`);
  } else {
    console.log(`escape-dist-literals: ${file}: clean`);
  }
}
