/**
 * The replay-stable half of one execution receipt: what a served replay must
 * reproduce field for field. `replayed` IS the replay marker and `recovery` is
 * this call's own outcome sidecar, so both legitimately differ between a commit
 * and its replay; every other field is the recorded receipt.
 *
 * Test-only helper: no production import.
 */
export function receiptStable(receipt: unknown): Record<string, unknown> {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error(`expected an execution receipt object, received ${JSON.stringify(receipt)}`);
  }
  const { replayed: _replayed, recovery: _recovery, ...stable } = receipt as Record<string, unknown>;
  return stable;
}
