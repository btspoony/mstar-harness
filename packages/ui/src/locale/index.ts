/**
 * The locale surface: two dictionaries, one shape, and the per-screen copy
 * objects the screens already take as props.
 *
 * The screens were written prop-driven on purpose — Task 5 is what fills those
 * props, rather than a rewrite of every screen. `copyFor(locale)` is the seam:
 * each section of the dictionary *is* the matching screen's copy object, so a
 * screen needs no adapter and a dictionary change cannot leave one screen behind.
 */
import { en, type Copy } from "./en.ts";
import { zh } from "./zh.ts";

export type { Copy } from "./en.ts";
export { en } from "./en.ts";
export { zh } from "./zh.ts";

/** The locales the product ships. A host picks one; the product never guesses. */
export const LOCALES = ["en", "zh"] as const;
export type Locale = (typeof LOCALES)[number];

/** The tree for one locale. */
export function copyFor(locale: Locale): Copy {
  return locale === "zh" ? zh : en;
}

/** Whether a value is a locale this package ships (a host may hand us a string). */
export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * The copy a screen reads for one absence arm.
 *
 * The four arms own four key families, and the filtered-empty case owns a fifth
 * key *inside* the empty family — it is the same state ("the read succeeded and
 * there is nothing"), reached under filters. There is deliberately no generic
 * "no data" fallback: a screen that cannot name its arm has a bug, not a missing
 * translation.
 */
export type AbsenceCopyKey = "not-applicable" | "absent" | "empty" | "empty-filtered" | "unavailable";

export function absenceCopy(copy: Copy, key: AbsenceCopyKey) {
  return copy.state[key];
}
