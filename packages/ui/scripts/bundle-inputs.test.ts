/**
 * `check:stale` compares the generated dashboard assets against the files the bundle
 * is built from. A colocated test is not one of them: `primitives.test.tsx` and the
 * screen tests live under `src`, but a test edit changes no shipped byte, and the
 * check demanding a dashboard rebuild for it was a false alarm.
 */
import { describe, expect, test } from "bun:test";

import { isBundleInput } from "./bundle-inputs";

describe("a dashboard input is a file the browser bundle imports", () => {
  test("components, screens, styles and view models are inputs", () => {
    expect(isBundleInput("packages/ui/src/components/Nav.tsx")).toBe(true);
    expect(isBundleInput("packages/ui/src/styles/base.css")).toBe(true);
    expect(isBundleInput("packages/ui/src/view-model/issues.ts")).toBe(true);
  });

  test("colocated tests are not", () => {
    expect(isBundleInput("packages/ui/src/components/primitives.test.tsx")).toBe(false);
    expect(isBundleInput("packages/ui/src/purity.test.ts")).toBe(false);
    // A name that merely ends in `test` is still a source file.
    expect(isBundleInput("packages/ui/src/view-model/latest.ts")).toBe(true);
  });
});
