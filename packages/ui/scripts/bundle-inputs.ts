/**
 * Which files under `packages/ui/src` the dashboard bundle is built from.
 *
 * The shared source tree also carries colocated tests (`*.test.ts(x)`). `bun test`
 * compiles those, the browser bundle never imports them, so editing one cannot make
 * the generated dashboard assets stale — and demanding a CLI rebuild for it sent the
 * reader of `check:stale` to rebuild a bundle that would not change.
 */
export function isBundleInput(path: string): boolean {
  return !/\.test\.tsx?$/.test(path);
}
