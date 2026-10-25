/**
 * The URL contract (compass D27). Every route the product can address, and the
 * three behaviours that make it a contract rather than a parser: the removed
 * `#roadmap` destination, the query string the filters live in, and the parent a
 * detail returns to with that query intact.
 */
import { describe, expect, test } from "bun:test";

import { issueQuery, parseIssueQuery } from "@mstar-harness/ui";

import { parentAddress, parentOf, parseRoute, routeFilters, routeHash } from "./route";

describe("every destination in the table", () => {
  test("#overview is the landing destination", () => {
    expect(parseRoute("#overview").route).toEqual({ name: "overview" });
  });

  test("the four list destinations keep their plural segments", () => {
    expect(parseRoute("#issues").route).toEqual({ name: "issues" });
    expect(parseRoute("#workflows").route).toEqual({ name: "workflows" });
    expect(parseRoute("#iterations").route).toEqual({ name: "iterations" });
    expect(parseRoute("#projects").route).toEqual({ name: "projects" });
  });

  test("details keep a singular resource segment and an id", () => {
    expect(parseRoute("#issue/I-000870").route).toEqual({ name: "issue", id: "I-000870" });
    expect(parseRoute("#workflow/issue-project-move").route).toEqual({ name: "workflow", id: "issue-project-move" });
    expect(parseRoute("#iteration/iter-1").route).toEqual({ name: "iteration", id: "iter-1" });
  });

  test("an id is percent-decoded, and a malformed one lands on the default", () => {
    expect(parseRoute("#issue/I%2D000870").route).toEqual({ name: "issue", id: "I-000870" });
    expect(parseRoute("#issue/%E0%A4%A").route).toEqual({ name: "overview" });
  });
});

describe("the project feature segment", () => {
  test("#project/<id> is the Roadmap feature", () => {
    expect(parseRoute("#project/engine").route).toEqual({ name: "project", id: "engine", feature: "roadmap" });
  });

  test("each named feature resolves", () => {
    expect(parseRoute("#project/engine/roadmap").route).toEqual({ name: "project", id: "engine", feature: "roadmap" });
    expect(parseRoute("#project/engine/issues").route).toEqual({ name: "project", id: "engine", feature: "issues" });
    expect(parseRoute("#project/engine/iterations").route).toEqual({ name: "project", id: "engine", feature: "iterations" });
  });

  test("an unknown feature resolves to roadmap, never to a fourth feature", () => {
    expect(parseRoute("#project/engine/workflows").route).toEqual({ name: "project", id: "engine", feature: "roadmap" });
    expect(parseRoute("#project/engine/ROADMAP").route).toEqual({ name: "project", id: "engine", feature: "roadmap" });
  });
});

describe("unknown input lands on the documented default", () => {
  test("empty, bare and unrecognised hashes are the landing destination", () => {
    // `#issues/extra/segments` is a list route: extra path segments are ignored
    // rather than demoting a known destination to the landing page.
    for (const hash of ["", "#", "#/", "#nope", "issues"]) {
      expect(parseRoute(hash).route).toEqual({ name: "overview" });
    }
    expect(parseRoute("#issues/extra/segments").route).toEqual({ name: "issues" });
  });
});

describe("#roadmap is removed, not aliased", () => {
  test("it resolves to the landing destination", () => {
    // The roadmap is a project feature now (D8). A compatibility alias would keep
    // a dead vocabulary alive, so the route is simply not in the table.
    expect(parseRoute("#roadmap").route).toEqual({ name: "overview" });
  });

  test("no route in the model can produce a roadmap destination", () => {
    // A stronger statement than the one above: the union has no such member, so
    // round-tripping every reachable destination never emits a bare `#roadmap`.
    for (const hash of ["#overview", "#issues", "#workflows", "#iterations", "#projects", "#issue/I-1"]) {
      expect(routeHash(parseRoute(hash).route)).not.toBe("#roadmap");
    }
    // A project's roadmap feature is a different, nested address and must not be
    // confused with the removed destination.
    expect(routeHash(parseRoute("#project/engine").route)).toBe("#project/engine/roadmap");
  });
});

describe("the query string is the filters' home", () => {
  test("a deep link carries the filter keys the shared helpers read", () => {
    const address = parseRoute("#issues?severity=critical&disposition=open&limit=50");
    expect(address.route).toEqual({ name: "issues" });
    expect(address.query).toBe("severity=critical&disposition=open&limit=50");
    // `toMatchObject` on literal expectations: spreading the parsed filters into
    // the expected value made this pass for any parse at all.
    expect(routeFilters(address).filters).toMatchObject({ severity: "critical", disposition: "open" });
  });

  test("every filter key round-trips through the shared pair unchanged", () => {
    const search = "disposition=resolved&project=engine&kind=bug&severity=high&q=tone&limit=50&offset=100";
    expect(issueQuery(parseIssueQuery(search))).toBe(search);
  });

  test("a route hash keeps its query when it is rebuilt", () => {
    const hash = routeHash({ name: "issues" }, "severity=critical");
    expect(hash).toBe("#issues?severity=critical");
    expect(parseRoute(hash).query).toBe("severity=critical");
  });

  test("a detail route emits no query unless one is passed", () => {
    expect(routeHash({ name: "issue", id: "I-1" })).toBe("#issue/I-1");
  });

  test("a project page drops a project key from the address bar (one authority per page)", () => {
    // The host forces `project=<id>` for the API call; a second `project` key in
    // the URL would let the same page be scoped twice.
    const address = parseRoute("#project/engine/issues?project=other&severity=high");
    expect(address.query).toBe("severity=high");
    expect(routeFilters(address).filters.project).toBe("");
    expect(routeFilters(address).filters.severity).toBe("high");
  });
});

describe("parents, for Escape and the breadcrumb", () => {
  test("a detail returns to its list", () => {
    expect(parentOf({ name: "issue", id: "I-1" })).toEqual({ name: "issues" });
    expect(parentOf({ name: "workflow", id: "w" })).toEqual({ name: "workflows" });
    expect(parentOf({ name: "iteration", id: "i" })).toEqual({ name: "iterations" });
  });

  test("a project feature returns to the project's roadmap, then to the list", () => {
    expect(parentOf({ name: "project", id: "engine", feature: "issues" })).toEqual({
      name: "project",
      id: "engine",
      feature: "roadmap",
    });
    expect(parentOf({ name: "project", id: "engine", feature: "roadmap" })).toEqual({ name: "projects" });
  });

  test("a list returns to the landing destination", () => {
    expect(parentOf({ name: "issues" })).toEqual({ name: "overview" });
    expect(parentOf({ name: "projects" })).toEqual({ name: "overview" });
  });

  test("the landing destination has no parent", () => {
    expect(parentOf({ name: "overview" })).toBeNull();
  });

  test("Escape from a detail preserves the reader's filters", () => {
    // Escape must not silently reset the reader's filters.
    const address = parseRoute("#issue/I-1?severity=critical&disposition=open");
    const parent = parentOf(address.route);
    expect(parent).not.toBeNull();
    const target = routeHash(parent!, address.query);
    expect(target).toBe("#issues?severity=critical&disposition=open");
    expect(parseRoute(target).query).toBe("severity=critical&disposition=open");
  });
});

describe("Escape and the breadcrumb are the same move, from two controls", () => {
  test("Escape: a detail goes to its list with the query preserved", () => {
    const address = parseRoute("#issue/I-1?disposition=resolved&severity=high");
    const parent = parentAddress(address);
    expect(parent).not.toBeNull();
    expect(routeHash(parent!.route, parent!.query)).toBe("#issues?disposition=resolved&severity=high");
  });

  test("breadcrumb: a project feature goes to the project's roadmap with the query preserved", () => {
    // The breadcrumb inside a project page steps to the project's default feature
    // before leaving the project, and the filter state comes along.
    const address = parseRoute("#project/engine/issues?severity=high");
    const parent = parentAddress(address);
    expect(parent?.route).toEqual({ name: "project", id: "engine", feature: "roadmap" });
    expect(routeHash(parent!.route, parent!.query)).toBe("#project/engine/roadmap?severity=high");
  });

  test("at the landing destination there is no parent, so Escape does nothing", () => {
    expect(parentAddress(parseRoute("#overview"))).toBeNull();
  });
});
