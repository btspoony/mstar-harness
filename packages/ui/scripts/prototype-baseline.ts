/**
 * The one reader of the tracked design baseline, `design-system/prototype.html`.
 *
 * Every comparator (`check:snapshot`, `check:declarations`, `check:selectors`, `check:tones`)
 * loads the prototype through here, so "unreadable baseline" has one implementation and one
 * regression test. The four scripts keep their own exit: they print
 * `<script>: <the message below>` and exit 1.
 */
import { readFileSync } from "node:fs";

/** Reads the baseline, or throws an error whose message names the path it could not read. */
export function loadPrototype(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`${path} is unreadable — the tracked prototype is the baseline`);
  }
}
