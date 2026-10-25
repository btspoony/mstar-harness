import { describe, expect, test } from "bun:test";

import { detailReturnTarget, initialAddress } from "./route";

describe("P1: the launch project scope reaches the first page", () => {
  test("`mstar dashboard --project` seeds the initial filter", () => {
    // The server puts `?project=<id>` on the served URL; the shell read only the
    // hash, so the selector was dropped and the list opened store-wide.
    const address = initialAddress("#issues", "?token=abc&project=engine");
    expect(address.route).toEqual({ name: "issues" });
    expect(address.query).toContain("project=engine");
  });

  test("no selector means no filter", () => {
    const address = initialAddress("#issues", "?token=abc");
    expect(address.query).toBe("");
  });

  test("an address that already scopes itself wins", () => {
    const address = initialAddress("#project/ui/issues", "?project=engine");
    expect(address.route).toEqual({ name: "project", id: "ui", feature: "issues" });
  });

  test("an empty hash still lands on Overview, seeded with the scope", () => {
    const address = initialAddress("", "?project=engine");
    expect(address.route).toEqual({ name: "overview" });
    expect(address.query).toContain("project=engine");
  });
});

describe("P2: a record opened from a project returns to that project", () => {
  test("the project in the query names the way back", () => {
    // `#issue/<id>?project=engine` is the only surviving trace of the project page it
    // was opened from; without it the breadcrumb and Escape landed store-wide.
    const target = detailReturnTarget({ route: { name: "issue", id: "I-1" }, query: "project=engine&severity=high" });
    expect(target?.route).toEqual({ name: "project", id: "engine", feature: "issues" });
    expect(target?.query).toBe("severity=high");
  });

  test("a record with no project falls back to its list, as before", () => {
    const target = detailReturnTarget({ route: { name: "issue", id: "I-1" }, query: "severity=high" });
    expect(target?.route).toEqual({ name: "issues" });
    expect(target?.query).toBe("severity=high");
  });
});
