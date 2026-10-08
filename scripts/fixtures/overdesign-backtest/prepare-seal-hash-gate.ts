// scan-only corpus: consumed as text by lint-overdesign-backtest.test.ts; not compiled (outside tsconfig include)
export function assertPrepareSealFresh(assignmentBytes: string, recordedSha256: string) {
  if (sha256(assignmentBytes) !== recordedSha256) {
    throw new Error("assignment-stale: prepared assignment bytes changed");
  }
}
