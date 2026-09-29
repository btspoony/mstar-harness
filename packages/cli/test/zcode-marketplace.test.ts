/**
 * zcode adapter — bootstrap marketplace entry seeding.
 *
 * The bootstrap `marketplace.json` seed carries the CLI release version so a
 * current-CLI install seeds a coherent snapshot. ZCode's marketplace refresh
 * overwrites the seed with the repo-shipped manifest, after which the snapshot
 * version may be newer or older than this CLI — that skew is the update
 * signal, which is why doctor deliberately does not gate on it.
 */
import { describe, expect, test } from "bun:test";
import { marketplacePluginEntry } from "../src/adapters/zcode";
import { readHarnessVersion } from "../src/utils";

describe("marketplacePluginEntry (zcode bootstrap snapshot)", () => {
  test("seeds version from the CLI release version", () => {
    expect(marketplacePluginEntry().version).toBe(readHarnessVersion());
  });

  test("entry shape stays in sync with the repo-shipped marketplace manifests", () => {
    const entry = marketplacePluginEntry();
    expect(entry.name).toBe("morning-star-harness");
    expect(entry.source).toEqual({ source: "github", repo: "btspoony/mstar-harness", ref: "main" });
    expect(entry.displayName).toBe("Morning Star Harness");
    expect(entry.category).toBe("Productivity");
    expect(entry.icon).toContain("assets/icon.png");
  });
});
