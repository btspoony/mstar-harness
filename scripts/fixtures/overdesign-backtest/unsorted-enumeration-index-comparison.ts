export function sameWitnesses(actual: string[], expected: string[]) {
  return actual.every((value, index) => value === expected[index]);
}
