/** Minimal semver 2.0.0 comparator for stable `X.Y.Z` with optional prerelease (without build metadata). */
function splitVersion(v: string): [string, string | undefined] {
  const dash = v.indexOf("-");
  if (dash === -1) return [v, undefined];
  return [v.slice(0, dash), v.slice(dash + 1)];
}

function compareCore(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const ia = a.split(".");
  const ib = b.split(".");
  const n = Math.min(ia.length, ib.length);
  for (let i = 0; i < n; i++) {
    const d = compareIdentifier(ia[i], ib[i]);
    if (d !== 0) return d;
  }
  return ia.length - ib.length;
}

function compareIdentifier(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const na = BigInt(a);
    const nb = BigInt(b);
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compare two semver versions; negative / 0 / positive as `a` < / = / > `b`. */
export function compareSemver(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  const coreDiff = compareCore(coreA, coreB);
  if (coreDiff !== 0) return coreDiff;
  return comparePrerelease(preA, preB);
}
