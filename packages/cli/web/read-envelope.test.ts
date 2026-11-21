/**
 * Joining a list's pages into one snapshot.
 *
 * A list is read page by page, and an offset only addresses rows inside one store
 * state. These tests move the store between two pages and assert the read never
 * presents the concatenation as one list: it restarts against the new state, and
 * refuses when the state will not hold still.
 */
import { describe, expect, test } from "bun:test";

import { readAllListPages } from "./read-envelope";

const PAGE = 2;
const COUNT = 5;

type Move = "none" | "always" | "store" | "catalog" | "projection";

/**
 * A list server whose store state can move between requests.
 *
 * `store`/`catalog`/`projection` move once, on the second request — that is the page
 * boundary a registration or capture lands on. `always` moves them on every request.
 */
function server(move: Move) {
  let requests = 0;
  const versions = { store: 1, catalog: 1, projection: 1 };
  const fetchImpl = (async (url: string) => {
    requests += 1;
    if (move === "always" ? requests > 1 : move !== "none" && requests === 2) {
      const member = move === "always" ? "store" : move;
      versions[member] += 1;
    }
    const offset = Number(new URL(url, "http://dashboard.local").searchParams.get("offset"));
    const items = Array.from({ length: COUNT }, (_, index) => ({ id: `I-${index}` })).slice(offset, offset + PAGE);
    const envelope = {
      data: { items, total: COUNT },
      storeRevision: versions.store,
      catalogRevision: versions.catalog,
      projection: { generation: versions.projection, freshness: "fresh" },
    };
    return new Response(JSON.stringify(envelope), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests: () => requests };
}

const path = (offset: number): string => `/api/list?offset=${offset}&limit=${PAGE}`;

describe("a list read is one snapshot", () => {
  test("a stable store is joined into one list", async () => {
    const { fetchImpl, requests } = server("none");
    const result = await readAllListPages(fetchImpl, path);
    if (result.status !== "ready") throw new Error(`expected ready, got ${result.message}`);
    expect(result.envelope.data.total).toBe(COUNT);
    expect(result.envelope.data.items.map((row) => (row as { id: string }).id)).toEqual(["I-0", "I-1", "I-2", "I-3", "I-4"]);
    expect(requests()).toBe(3);
  });

  for (const move of ["store", "catalog", "projection"] as const) {
    test(`a \`${move}\` change between pages restarts the read`, async () => {
      const { fetchImpl, requests } = server(move);
      const result = await readAllListPages(fetchImpl, path);
      if (result.status !== "ready") throw new Error(`expected ready, got ${result.message}`);
      // The first pass stopped at the page boundary; the second read the same state
      // from offset 0, so the rows are not a splice of two states.
      expect(result.envelope.data.items).toHaveLength(COUNT);
      expect(requests()).toBe(5);
    });
  }

  test("a store that keeps moving is refused, not joined", async () => {
    const { fetchImpl } = server("always");
    const result = await readAllListPages(fetchImpl, path);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected an error");
    expect(result.message).toContain("not one snapshot");
  });

  test("pages from a replaced authority are refused even when the counters match", async () => {
    // Both pages report the same numeric revisions; only the collaboration
    // authority identity changed, which the old counter comparison could not see.
    let requests = 0;
    const fetchImpl = (async (url: string) => {
      requests += 1;
      const offset = Number(new URL(url, "http://dashboard.local").searchParams.get("offset"));
      const items = Array.from({ length: COUNT }, (_, index) => ({ id: `I-${index}` })).slice(offset, offset + PAGE);
      const envelope = {
        data: { items, total: COUNT },
        storeRevision: 1,
        catalogRevision: 1,
        projection: { observed: true, generation: 1, freshness: "current" },
        collaboration: {
          scope: { kind: "query", key: "issues:*:open:*:*:2:0" },
          completeness: "complete",
          asOf: "2026-11-21T00:00:00.000Z",
          authority: { repoKey: "github.com/acme/repo", mode: "local", storeId: requests === 1 ? "store-a" : "store-b", epoch: 1 },
          revision: 1,
          catalogRevision: 1,
        },
        execution: null,
      };
      return new Response(JSON.stringify(envelope), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const result = await readAllListPages(fetchImpl, path);
    // The pass that straddled two authorities was discarded and the list was
    // read again: the rows are one delivery, not a splice.
    if (result.status !== "ready") throw new Error(`expected ready, got ${result.message}`);
    expect(result.envelope.data.items).toHaveLength(COUNT);
    expect(requests).toBe(5);
  });

  test("a partial snapshot page is refused instead of assembled", async () => {
    const fetchImpl = (async (url: string) => {
      const offset = Number(new URL(url, "http://dashboard.local").searchParams.get("offset"));
      const items = Array.from({ length: COUNT }, (_, index) => ({ id: `I-${index}` })).slice(offset, offset + PAGE);
      const envelope = {
        data: { items, total: COUNT },
        storeRevision: 1,
        catalogRevision: 1,
        projection: { observed: false, generation: null, freshness: "unavailable" },
        collaboration: {
          scope: { kind: "query", key: "issues:*:open:*:*:2:0" },
          completeness: "partial",
          asOf: "2026-11-21T00:00:00.000Z",
          authority: { repoKey: "github.com/acme/repo", mode: "local", storeId: "store-a", epoch: 1 },
          revision: 1,
          catalogRevision: 1,
          code: "catalog.discovery.missing-plan",
        },
        execution: null,
      };
      return new Response(JSON.stringify(envelope), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const result = await readAllListPages(fetchImpl, path);
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("expected an error");
    expect(result.message).toContain("catalog.discovery.missing-plan");
  });

  test("an assembled list states its own scope instead of the first page's bounds", async () => {
    const fetchImpl = (async (url: string) => {
      const offset = Number(new URL(url, "http://dashboard.local").searchParams.get("offset"));
      const items = Array.from({ length: COUNT }, (_, index) => ({ id: `I-${index}` })).slice(offset, offset + PAGE);
      const envelope = {
        data: { items, total: COUNT },
        storeRevision: 1,
        catalogRevision: 1,
        projection: { observed: false, generation: null, freshness: "unavailable" },
        collaboration: {
          scope: { kind: "query", key: "issues:*:open:*:*:2:0" },
          completeness: "complete",
          asOf: "2026-11-21T00:00:00.000Z",
          authority: { repoKey: "github.com/acme/repo", mode: "local", storeId: "store-a", epoch: 1 },
          revision: 1,
          catalogRevision: 1,
        },
        execution: null,
      };
      return new Response(JSON.stringify(envelope), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const result = await readAllListPages(fetchImpl, path);
    if (result.status !== "ready") throw new Error(`expected ready, got ${result.message}`);
    expect(result.envelope.collaboration?.scope).toEqual({
      kind: "query",
      key: "assembled:issues:*:open:*:*:2:0",
    });
    expect(result.envelope.data.items).toHaveLength(COUNT);
  });
});
