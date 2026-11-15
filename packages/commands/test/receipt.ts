/**
 * The replay-stable half of one execution receipt: what a served replay must
 * reproduce field for field. `replayed` IS the replay marker, so it legitimately
 * differs between a commit and its replay; every other field — including the
 * `recovery` sidecar, which the engine re-exposes from the RECORDED receipt — is
 * the recorded receipt and must compare equal.
 *
 * Test-only helper: no production import.
 */
export function receiptStable(receipt: unknown): Record<string, unknown> {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error(`expected an execution receipt object, received ${JSON.stringify(receipt)}`);
  }
  const { replayed: _replayed, ...stable } = receipt as Record<string, unknown>;
  return stable;
}
