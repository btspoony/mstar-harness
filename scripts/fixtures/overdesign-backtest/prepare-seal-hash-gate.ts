export function assertPrepareSealFresh(assignmentBytes: string, recordedSha256: string) {
  if (sha256(assignmentBytes) !== recordedSha256) {
    throw new Error("assignment-stale: prepared assignment bytes changed");
  }
}
