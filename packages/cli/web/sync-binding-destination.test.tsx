/**
 * The binding destination, without a browser.
 *
 * The browser gate (`test/render-gate.test.ts`) proves the mount against a real
 * page, but it skips wherever no browser is installed — so the ordinary CI run had
 * nothing holding the chain that regressed twice: the route resolved, the screen
 * shipped, and nothing mounted or painted. This asserts it from the read the
 * engine itself answers: the route the nav entry names mounts the destination, and
 * the screen paints that read's own answer rather than just its frame.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initializeStore, readDashboardView } from "@mstar-harness/engine";
import { copyFor } from "@mstar-harness/ui";

import { parseRoute } from "./route";
import { navRoute } from "./shell-chrome";
import { readSyncBinding, syncBindingOutcome } from "./sync-binding-data";
import { SyncBindingScreen, syncBindingDestination } from "./sync-binding-destination";

/** The binding view one real engine read answers, served through a stub transport. */
async function engineRead() {
  const harnessDir = join(mkdtempSync(join(tmpdir(), "mstar-sync-binding-web-")), ".mstar");
  mkdirSync(harnessDir, { recursive: true });
  (await initializeStore({ harnessDir })).close();
  const envelope = await readDashboardView({ context: { harnessDir }, view: "sync-binding" });
  const fetchImpl = (async () => new Response(JSON.stringify(envelope), { status: 200 })) as unknown as typeof fetch;
  return syncBindingOutcome(await readSyncBinding(fetchImpl));
}

describe("the binding destination mounts from its route and paints its read", () => {
  test("the nav entry and the hash both resolve to the destination's route", () => {
    expect(navRoute("sync-binding")).toEqual({ name: "sync-binding" });
    expect(parseRoute("#sync-binding").route).toEqual({ name: "sync-binding" });
  });

  test("that route mounts the destination, and no other route does", () => {
    expect(syncBindingDestination({ name: "sync-binding" })).not.toBeNull();
    for (const route of [{ name: "overview" }, { name: "issues" }] as const) {
      expect(syncBindingDestination(route)).toBeNull();
    }
  });

  test("the screen paints the read's answer, not just its frame", async () => {
    const outcome = await engineRead();
    expect(outcome.kind).toBe("ready");
    const html = renderToStaticMarkup(createElement(SyncBindingScreen, { outcome, copy: copyFor("en") }));
    expect(html).toContain('data-ms-screen="sync-binding"');
    // The fixture root declares no `.mstarc`, so the identity block prints the
    // engine's refusal verbatim — the same engine-owned string the browser gate
    // looks for. A screen that stopped painting its read paints none of it.
    expect(html).toContain("linear.binding-absent");
  });
});
