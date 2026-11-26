/**
 * Dashboard loopback server.
 *
 * Every case drives an actual temporary loopback server (`startDashboard`)
 * over a real temporary `node:sqlite` store: the DTO envelopes, the refusal
 * statuses, the boundary protections (Host/Origin, read-only, traversal,
 * no-CORS headers), lifecycle (port conflict, staged store, shutdown) and the
 * inlined-artifact proof (the built CLI artifact serves its assets from the
 * generated module with no source asset directory in its packaging context).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { captureIssue, closeIssue, createExecutionWorkflow, initializeCollaborationStore, initializeStore, listIssues, openStore, readExecutionAuthority, refreshProjections, registerCatalogEntity, resolveCollaborationLocation, writeCollaborationBinding, type CaptureInput, type StoreContext } from "@mstar-harness/engine";
import { startDashboard, type RunningDashboard } from "@mstar-harness/commands/dashboard";
import { dashboardCss, dashboardHtml, dashboardJs } from "../../commands/src/dashboard/assets.generated";

const ROOT = mkdtempSync(join(tmpdir(), "mstar-dashboard-server-"));
/** invariant: The user-level collaboration root this suite owns: the real `$HOME` is never read or written. */
const TEST_HOME = join(ROOT, "home");
mkdirSync(TEST_HOME, { recursive: true });
let homeSpy: { mockRestore(): void } | undefined;
const RECORDED_AT = "2026-09-18T02:00:00.000Z";
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";

beforeAll(() => {
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => TEST_HOME);
});

afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

async function workspace(name: string): Promise<{ dir: string; context: StoreContext }> {
  const dir = mkdtempSync(join(ROOT, name));
  // why: A spawned CLI derives the fixed `<git main worktree>/.mstar` root from its
  // cwd, so the fixture is a genuine checkout rather than a bare directory.
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=f@f", "-c", "user.name=f", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  // invariant: The origin and `.mstarc` select the collaboration lane; a fresh checkout with
  // neither cannot resolve a repository authority.
  spawnSync("git", ["remote", "add", "origin", `https://github.com/acme/${name.replace(/[^a-z0-9._-]/gi, "-")}.git`], { cwd: dir });
  // note: The live selector lookup is real Git I/O; route the synthetic origin to this fixture's
  // own repository, which never publishes the selector ref.
  spawnSync(
    "git",
    ["config", `url.${dir}.insteadOf`, `https://github.com/acme/${name.replace(/[^a-z0-9._-]/gi, "-")}.git`],
    { cwd: dir },
  );
  writeFileSync(join(dir, ".mstarc"), "[collaboration]\nmode=local\n");
  mkdirSync(join(dir, ".mstar"), { recursive: true });
  const context: StoreContext = { harnessDir: join(dir, ".mstar") };
  const handle = await initializeStore(context);
  handle.close();
  await initializeCollaborationStore(resolveCollaborationLocation(context));
  activateCollaboration(context);
  // invariant: Normalize the WAL side files: a read-only open right after the initializing
  // writer closed can refuse while the -wal/-shm pair is still on disk, and every
  // server read opens the store read-only.
  const probe = await openStore(context, "read");
  probe.close();
  return { dir, context };
}

/**
 * invariant: Publish the staged collaboration lane AND this checkout's binding -- the two
 * records the real activation writes. An ACTIVE authority is never usable from
 * an unbound checkout, so a fixture that flips only the lane is refused.
 */
function activateCollaboration(context: StoreContext): void {
  const location = resolveCollaborationLocation(context);
  const lane = new DatabaseSync(location.dbPath);
  let storeId = "";
  let epoch = 0;
  try {
    lane
      .prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1")
      .run(new Date().toISOString());
    const row = lane.prepare("select store_id, authority_epoch from collaboration_meta where id = 1").get() as
      | { store_id?: unknown; authority_epoch?: unknown }
      | undefined;
    if (typeof row?.store_id === "string") storeId = row.store_id;
    if (typeof row?.authority_epoch === "number") epoch = row.authority_epoch;
  } finally {
    lane.close();
  }
  writeCollaborationBinding(context, { repoKey: location.repoKey, mode: location.mode, storeId, epoch, binding: "active" });
}

async function seedIssue(context: StoreContext, title: string, severity: CaptureInput["severity"], resolved = false): Promise<void> {
  const captured = await captureIssue(context, {
    projectId: "proj-a", title, severity, kind: "bug",
    impact: "Dashboard consumer observes this issue", acceptance: "Dashboard returns its stored disposition",
    sourceIdentity: title, rootCauseKey: title, acceptanceKey: title, occurrenceKey: title,
    sourceKind: "test", location: "dashboard-server.test.ts", observedBehavior: title,
    evidence: ["isolated fixture"], discoveredAt: RECORDED_AT,
  }, { actor: "project-manager", operationId: `capture-${title}` });
  if (resolved) {
    await closeIssue(context, captured.issueId, "resolved", {
      reason: "Fixture acceptance met", references: ["fixture"], alignmentRef: "QA gate: Approve — fixture",
    }, { actor: "project-manager", operationId: `close-${title}`, expectedRevision: captured.revision });
  }
}

/** A real active workflow, created through the public execution boundary. */
async function declareWorkflow(context: StoreContext, id: string): Promise<void> {
  const authority = await readExecutionAuthority(context);
  await createExecutionWorkflow({
    ...context, caller: { role: "coordinator", sessionId: "dashboard-fixture", workflowId: id },
  }, {
    expected: authority.token, operationId: "create-dashboard-workflow",
    entry: { id, type: "plan", started_at: RECORDED_AT, dir: `workflows/${id}` },
    snapshot: {
      schema_version: 1, id, type: "plan", status: "running",
      started_at: RECORDED_AT, updated_at: RECORDED_AT, plans: [],
    },
  });
}

const tokensByPort = new Map<string, string>();

function remember(server: RunningDashboard): RunningDashboard {
  const url = new URL(server.url);
  tokensByPort.set(url.port, url.searchParams.get("token")!);
  return server;
}

/** The shell minus the one attribute the server injects: the browser entry's harness root. */
function withoutHarnessDirectory(body: string): string {
  return body.replace(/<html data-harness-dir="[^"]*" /, "<html ");
}

function raw(

  input: string,
  options: { method?: string; headers?: Record<string, string>; authenticated?: boolean } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const url = new URL(input);
  const suppliedToken = url.searchParams.get("token");
  if (suppliedToken !== null) tokensByPort.set(url.port, suppliedToken);
  if (options.authenticated !== false && suppliedToken === null) {
    const token = tokensByPort.get(url.port);
    if (token !== undefined) url.searchParams.set("token", token);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method ?? "GET", headers: options.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.once("error", reject);
    req.end();
  });
}

async function start(
  dir: string,
  options: { port?: number; project?: string } = {},
): Promise<RunningDashboard> {
  return remember(await startDashboard({ harnessDir: join(dir, ".mstar"), port: options.port, projectId: options.project }));
}
describe("static shell and inlined assets", () => {
  let server: RunningDashboard;
  beforeAll(async () => {
    server = await start((await workspace("static-")).dir);
  });
  afterAll(() => server.close());

  test("GET / serves the D1 shell with the exact CSP and no CORS header", async () => {
    const res = await raw(server.url);
    expect(res.status).toBe(200);
    // The shell is the generated document plus the one attribute the server injects: the
    // harness root the browser entry reads off `<html>`. Everything else must be untouched,
    // which is what this asserts by putting the attribute back before comparing.
    const withDirectory = res.body.replace(/<html data-harness-dir="[^"]*" /, "<html ");
    expect(withDirectory).toBe(dashboardHtml);
    expect(res.body).toMatch(/<html data-harness-dir="[^"]+" /);
    expect(res.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    expect(res.headers["content-security-policy"]).toBe(CSP);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("requests require the per-launch token and the index cookie authorizes API fetches", async () => {
    const url = new URL(server.url);
    const token = url.searchParams.get("token");
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    const apiUrl = new URL("/api/issues", server.url);
    const authorized = new URL(apiUrl);
    authorized.searchParams.set("token", token!);
    expect((await raw(authorized.href, { authenticated: false })).status).toBe(200);
    const unauthenticated = await raw(apiUrl.href, { authenticated: false });
    expect(unauthenticated.status).toBe(403);
    expect(unauthenticated.body).not.toContain("data");
    const wrong = new URL(apiUrl);
    wrong.searchParams.set("token", "wrong-token");
    const refused = await raw(wrong.href, { authenticated: false });
    expect(refused.status).toBe(403);

    const shell = await raw(server.url);
    const cookie = shell.headers["set-cookie"]?.[0]?.split(";")[0];
    expect(cookie).toMatch(/^mstar-dashboard-token-\d+=/);
    const api = await raw(new URL("/api/issues", server.url).href, {
      authenticated: false,
      headers: { cookie: cookie! },
    });
    expect(api.status).toBe(200);
  });
  test("separate dashboard listeners retain their own cookies in one browser jar", async () => {
    const { dir } = await workspace("shared-cookie-");
    const first = await start(dir);
    const second = await start(dir);
    const jar = new Map<string, string>();
    const visit = async (server: RunningDashboard) => {
      const response = await raw(server.url);
      expect(response.status).toBe(200);
      const pair = response.headers["set-cookie"]?.[0]?.split(";")[0];
      expect(pair).toBeDefined();
      const separator = pair!.indexOf("=");
      jar.set(pair!.slice(0, separator), pair!.slice(separator + 1));
    };
    const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    try {
      await visit(first);
      await visit(second);
      for (const server of [first, second]) {
        const response = await raw(new URL("/api/issues", server.url).href, {
          authenticated: false,
          headers: { cookie: cookie() },
        });
        expect(response.status).toBe(200);
      }
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  test("HEAD works for static resources and returns no body", async () => {
    const res = await raw(server.url, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("");
    expect(res.headers["content-type"]).toContain("text/html");
  });

  test("fixed asset routes serve the bundled strings; other paths never touch the filesystem", async () => {
    const js = await raw(new URL("/assets/app.js", server.url).href);
    expect(js.status).toBe(200);
    expect(js.body).toBe(dashboardJs);
    const css = await raw(new URL("/assets/app.css", server.url).href);
    expect(css.status).toBe(200);
    expect(css.body).toBe(dashboardCss);
    for (const pathname of ["/assets/app.mjs", "/assets/../web/shell.html", "/web/shell.html", "/style.css", "/%2e%2e/etc/passwd"]) {
      const res = await raw(new URL(pathname, server.url).href);
      expect(res.status).toBe(404);
    }
  });

  test("POST to a static route is refused", async () => {
    const res = await raw(server.url, { method: "POST" });
    expect(res.status).toBe(405);
    expect(JSON.parse(res.body).error.code).toBe("method-not-allowed");
  });
});

describe("API over a real store", () => {
  let server: RunningDashboard;
  let dir: string;
  let context: StoreContext;
  beforeAll(async () => {
    ({ dir, context } = await workspace("api-"));
    await seedIssue(context, "critical open", "critical");
    await seedIssue(context, "medium open", "medium");
    await seedIssue(context, "resolved", "high", true);
    server = await start(dir);
  });
  afterAll(() => server.close());

  test("GET /api/projects answers the unpaged project list envelope", async () => {
    await registerCatalogEntity(context, {
      kind: "project", id: "proj-dashboard", title: "Dashboard project", rootKind: "projects", relativePath: "proj-dashboard",
    }, { operationId: "register-dashboard-project", actor: "dashboard-test" });
    const response = await raw(new URL("/api/projects", server.url).href);
    expect(response.status).toBe(200);
    const envelope = JSON.parse(response.body) as {
      data: { items: Array<{ project: { id: string; title: string }; openIssues: number }>; total: number };
      storeRevision: number;
      catalogRevision: number;
      projection: { freshness: string; diagnostics: unknown[] };
    };
    expect(envelope.data.items).toContainEqual(expect.objectContaining({
      project: expect.objectContaining({ id: "proj-dashboard", title: "Dashboard project" }),
      openIssues: 0,
    }));
    expect(envelope.data.total).toBe(envelope.data.items.length);
    expect(typeof envelope.storeRevision).toBe("number");
    expect(typeof envelope.catalogRevision).toBe("number");
    expect(envelope.projection).toEqual(expect.objectContaining({ freshness: expect.any(String), diagnostics: expect.any(Array) }));
  });

  test("GET /api/issues answers the P6 envelope matching the authoritative rows", async () => {
    const before = await listIssues(context, {});
    const res = await raw(new URL("/api/issues", server.url).href);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-security-policy"]).toBe(CSP);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    const envelope = JSON.parse(res.body) as { data: { items: Array<{ id: string }>; total: number }; storeRevision: number; catalogRevision: number; projection: { freshness: string; diagnostics: unknown[] } };
    expect(envelope.data.items.map((row) => row.id)).toEqual(before.items.map((row) => row.id));
    expect(envelope.storeRevision).toBe(before.storeRevision);

    // invariant: Read-only: the authoritative rows and revisions are unchanged after the
    // GET. `asOf` is each read's own observation instant, so it is the one
    // field a before/after comparison must normalize away.
    const after = await listIssues(context, {});
    const evidence = (page: Awaited<ReturnType<typeof listIssues>>): string => {
      const copy = JSON.parse(JSON.stringify(page)) as { collaboration?: { asOf?: unknown } };
      if (copy.collaboration !== undefined) delete copy.collaboration.asOf;
      return JSON.stringify(copy);
    };
    expect(evidence(after)).toBe(evidence(before));
  });

  test("GET /api/issues/:id answers the detail DTO; unknown id is a structured 404", async () => {
    const found = await raw(new URL("/api/issues/I-000001", server.url).href);
    expect(found.status).toBe(200);
    expect((JSON.parse(found.body) as { data: { id: string } }).data.id).toBe("I-000001");
    const missing = await raw(new URL("/api/issues/I-999999", server.url).href);
    expect(missing.status).toBe(404);
    expect((JSON.parse(missing.body) as { error: { code: string } }).error.code).toBe("issue.not-found");
  });

  test("the retired binding API is absent while the local store views still answer", async () => {
    // The binding panel's API was removed with the screen it served. A stale client
    // or a bookmark is the same class of input as any unknown path: the route table
    // answers a structured 404, never a view read and never a 500.
    const retired = await raw(new URL("/api/sync-binding", server.url).href);
    expect(retired.status).toBe(404);
    expect((JSON.parse(retired.body) as { error: { code: string } }).error.code).toBe("not-found");
    // The local `store.db` views the dashboard keeps are untouched by that removal.
    for (const pathname of ["/api/overview", "/api/issues", "/api/projects"]) {
      const res = await raw(new URL(pathname, server.url).href);
      expect([pathname, res.status]).toEqual([pathname, 200]);
    }
  });

  test("HEAD to the API is refused without executing a store read", async () => {
    const head = await raw(new URL("/api/issues", server.url).href, { method: "HEAD" });
    expect(head.status).toBe(405);
    // A HEAD response carries no body by spec; the structured method refusal
    // is observable via the same 405 code on a non-HEAD method (tested below).
    expect(head.body).toBe("");
    // Prove the refusal precedes store access: on a server whose store is
    // missing, a GET reaches the store (503) while HEAD never does (405).
    const dir = mkdtempSync(join(ROOT, "no-store-"));
    mkdirSync(join(dir, ".mstar"), { recursive: true });
    const noStore = remember(await startDashboard({ harnessDir: join(dir, ".mstar") }));
    try {
      const get = await raw(new URL("/api/issues", noStore.url).href);
      expect(get.status).toBe(503);
      const headNoStore = await raw(new URL("/api/issues", noStore.url).href, { method: "HEAD" });
      expect(headNoStore.status).toBe(405);
      expect(headNoStore.body).toBe("");
    } finally {
      await noStore.close();
    }
  });

  test("POST to the API is refused: the dashboard is read-only", async () => {
    for (const pathname of ["/api/issues", "/api/workflows"]) {
      const res = await raw(new URL(pathname, server.url).href, { method: "POST", headers: { "content-type": "application/json" } });
      expect(res.status).toBe(405);
      const body = JSON.parse(res.body) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("method-not-allowed");
      expect(body.error.message).toMatch(/read-only/);
    }
  });

  test("wrong Host and wrong Origin are refused (no CORS header is ever sent)", async () => {
    const wrongHost = await raw(new URL("/api/issues", server.url).href, { headers: { host: "evil.example" } });
    expect(wrongHost.status).toBe(403);
    expect((JSON.parse(wrongHost.body) as { error: { code: string } }).error.code).toBe("forbidden");
    const rebound = await raw(new URL("/api/issues", server.url).href, { headers: { host: "127.0.0.1:1" } });
    expect(rebound.status).toBe(403);
    const wrongOrigin = await raw(new URL("/api/issues", server.url).href, { headers: { origin: "http://evil.example" } });
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.headers["access-control-allow-origin"]).toBeUndefined();
    const sameOrigin = await raw(new URL("/api/issues", server.url).href, {
      headers: { origin: new URL(server.url).origin },
    });
    expect(sameOrigin.status).toBe(200);
  });

  test("traversal and unknown paths are refused without touching the filesystem", async () => {
    for (const pathname of ["/api/issues/../../etc/passwd", "/api/project", "/api/issues/%2e%2e", "/api/issues/a%2Fb", "/api/roadmap/deep/path", "/api/roadmap"]) {
      const res = await raw(new URL(`http://127.0.0.1:${new URL(server.url).port}${pathname}`));
      expect([400, 404]).toContain(res.status);
      const body = JSON.parse(res.body) as { error: { code: string } };
      expect(["usage", "not-found"]).toContain(body.error.code);
    }
    // Malformed percent-escaping is a usage refusal.
    const malformed = await raw(new URL(`http://127.0.0.1:${new URL(server.url).port}/api/issues/%zz`));
    expect(malformed.status).toBe(400);
    expect((JSON.parse(malformed.body) as { error: { code: string } }).error.code).toBe("usage");
  });

  test("query refusals: unknown enum, excessive search and over-limit pagination", async () => {
    const cases: Array<[string, number, string]> = [
      ["/api/issues?disposition=fixed", 400, "disposition must be one of"],
      ["/api/issues?severity=blocker", 400, "severity must be one of"],
      [`/api/issues?q=${"x".repeat(201)}`, 400, "at most 200 characters"],
      ["/api/issues?limit=201", 400, "limit must be an integer between 1 and 200"],
      ["/api/issues?bogus=1", 400, "not a supported issues query parameter"],
    ];
    for (const [pathname, status, message] of cases) {
      const res = await raw(`http://127.0.0.1:${new URL(server.url).port}${pathname}`);
      expect(res.status).toBe(status);
      expect((JSON.parse(res.body) as { error: { message: string } }).error.message).toContain(message);
    }
  });

  test("a refusal never echoes an authorization credential from the request path", async () => {
    // invariant: The detail id reaches a lower-level issue refusal, which the HTTP error body
    // publishes. A conventional authorization value must be redacted with its scheme.
    for (const [scheme, secret] of [
      ["Bearer", "sk-live-bearer"],
      ["Basic", "dXNlcjpwYXNz"],
      ["Token", "tok-live-123"],
      ["bearer", "sk-live-mixed-case"],
      ["bAsIc", "dXNlcjpwYXNzMixlZA=="],
      ["toKeN", "tok-live-mixed"],
    ] as const) {
      const id = `x%20Authorization:%20${scheme}%20${secret}`;
      const res = await raw(new URL(`/api/issues/${id}`, server.url).href);
      expect(res.status).toBe(404);
      const body = JSON.parse(res.body) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("issue.not-found");
      expect(body.error.message).not.toContain(secret);
      expect(body.error.message).toContain("{REDACTED}");
    }
    // note: An UNLABELLED, mixed-case scheme carries a credential too.
    for (const [scheme, secret] of [
      ["bearer", "sk-live-bare"],
      ["toKeN", "tok-live-bare"],
    ] as const) {
      const id = `x%20refused%20${scheme}%20${secret}`;
      const res = await raw(new URL(`/api/issues/${id}`, server.url).href);
      expect(res.status).toBe(404);
      const body = JSON.parse(res.body) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("issue.not-found");
      expect(body.error.message).not.toContain(secret);
      expect(body.error.message).toContain("{REDACTED}");
    }
  });

  test("a Digest authorization value is redacted with all its parameters over HTTP", async () => {
    const header = 'x Authorization: Digest username="Mufasa", realm="test", nonce="abc", response="deadbeef"';
    const res = await raw(new URL(`/api/issues/${encodeURIComponent(header)}`, server.url).href);
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("issue.not-found");
    for (const leaked of ["Mufasa", "test", "abc", "deadbeef"]) expect(body.error.message).not.toContain(leaked);
    expect(body.error.message).toContain("{REDACTED}");
  });

  test("stale projection is disclosed in the envelope, never hidden", async () => {
    const { dir, context } = await workspace("stale-projection-");
    await declareWorkflow(context, "wf-stale-projection");
    const staleServer = await start(dir);
    try {
      // invariant: Publish a generation first, then block the optional catalog input: the
      // last good generation is retained and must be disclosed as stale, with
      // its rows, on the execution-backed read.
      const published = await raw(new URL("/api/workflows", staleServer.url).href);
      expect(published.status).toBe(200);
      unlinkSync(resolveCollaborationLocation(context).dbPath);
      const res = await raw(new URL("/api/workflows", staleServer.url).href);
      expect(res.status).toBe(200);
      const envelope = JSON.parse(res.body) as {
        projection: { freshness: string; diagnostics: Array<{ sourceKey: string }> };
        data: { items: Array<{ id: string }> };
      };
      expect(envelope.projection.freshness).toBe("stale");
      expect(envelope.projection.diagnostics.map((diagnostic) => diagnostic.sourceKey)).toContain("catalog");
      expect(envelope.data.items.map((item) => item.id)).toContain("wf-stale-projection");
    } finally {
      await staleServer.close();
    }
  });
});

describe("dashboard collaboration disclosure", () => {
  test("a missing collaboration authority is a 503, never a 404 or an empty list", async () => {
    const { dir, context } = await workspace("collaboration-missing-");
    unlinkSync(resolveCollaborationLocation(context).dbPath);
    const server = await start(dir);
    try {
      const res = await raw(new URL("/api/issues", server.url).href);
      expect(res.status).toBe(503);
      const body = JSON.parse(res.body) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("collaboration.not-initialized");
      // why: The refusal keeps its recovery and publishes neither HOME nor the store file.
      expect(body.error.message).toContain("mstar store init");
      expect(body.error.message).not.toContain(dir);
      expect(body.error.message).not.toContain(TEST_HOME);
      expect(body.error.message).not.toMatch(/\.db\b/);
    } finally {
      await server.close();
    }
  });

  test("an execution-only list serves its rows and discloses the optional gap", async () => {
    const { dir, context } = await workspace("collaboration-optional-");
    unlinkSync(resolveCollaborationLocation(context).dbPath);
    const server = await start(dir);
    try {
      const res = await raw(new URL("/api/workflows", server.url).href);
      expect(res.status).toBe(200);
      const envelope = JSON.parse(res.body) as {
        data: { items: unknown[]; total: number };
        storeRevision: number | null;
        collaboration: { completeness: string; code: string } | null;
        execution: unknown;
      };
      // note: Execution data is preserved; the unavailable catalog association is
      // disclosed and no collaboration counter is claimed.
      expect(Array.isArray(envelope.data.items)).toBe(true);
      expect(envelope.data.total).toBe(envelope.data.items.length);
      expect(envelope.collaboration).toEqual(
        expect.objectContaining({ completeness: "unavailable", code: "collaboration.not-initialized" }),
      );
      expect(envelope.storeRevision).toBeNull();
      expect(envelope.execution).not.toBeNull();
    } finally {
      await server.close();
    }
  });
});

describe("the retired roadmap route", () => {
  test("answers an unrouted /api/roadmap with the not-found envelope", async () => {
    const { dir } = await workspace("roadmap-route-retired-");
    const server = await start(dir);
    try {
      const response = await raw(new URL("/api/roadmap?project=any", server.url).href);
      expect(response.status).toBe(404);
      expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe("not-found");
    } finally {
      await server.close();
    }
  });
});

describe("workflow detail and the projection generation", () => {
  test("a bookmarked workflow detail answers the published empty generation, never an unavailable record", async () => {
    // ACTIVE disposition: the pre-activation "no published generation"
    // envelope is retired. An ACTIVE authority with no workflows publishes a
    // current empty generation, so a bookmarked id is a structured 404 inside
    // it and the list answers the same fact as an unlisted page.
    const { dir } = await workspace("workflow-unavailable-");
    const server = await start(dir);
    try {
      const res = await raw(new URL("/api/workflows/wf-bookmarked", server.url).href);
      expect(res.status).toBe(404);
      const envelope = JSON.parse(res.body) as { data?: unknown; error?: { code?: string } };
      expect(envelope.data).toBeUndefined();
      expect(envelope.error?.code).toBe("not-found");
      const list = await raw(new URL("/api/workflows", server.url).href);
      expect(list.status).toBe(200);
      expect((JSON.parse(list.body) as { data: { items: unknown[] } }).data.items).toEqual([]);
    } finally {
      await server.close();
    }
  });

  test("with a published generation an unknown id is still a structured 404", async () => {
    const { dir, context } = await workspace("workflow-published-");
    await declareWorkflow(context, "wf-demo");
    const server = await start(dir);
    try {
      const found = await raw(new URL("/api/workflows/wf-demo", server.url).href);
      expect(found.status).toBe(200);
      expect((JSON.parse(found.body) as { data: { id: string } }).data.id).toBe("wf-demo");
      const missing = await raw(new URL("/api/workflows/wf-absent", server.url).href);
      expect(missing.status).toBe(404);
      const body = JSON.parse(missing.body) as { data?: unknown; error?: { code: string } };
      expect(body.data).toBeUndefined();
      expect(body.error?.code).toBe("not-found");
    } finally {
      await server.close();
    }
  });
});

describe("boundary and lifecycle", () => {

  test("a staged collaboration authority refuses reads with collaboration.not-active (never an empty page)", async () => {
    const { dir, context } = await workspace("staged-");
    const lane = new DatabaseSync(resolveCollaborationLocation(context).dbPath);
    try {
      lane.prepare("update collaboration_meta set authority_state = 'staged' where id = 1").run();
    } finally {
      lane.close();
    }
    const server = await start(dir);
    try {
      const res = await raw(new URL("/api/issues", server.url).href);
      expect(res.status).toBe(503);
      const body = JSON.parse(res.body) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("collaboration.not-active");
      // note: No local filesystem path or store file leaks in the refusal.
      expect(body.error.message).not.toContain(dir);
      expect(body.error.message).not.toContain(TEST_HOME);
      expect(body.error.message).not.toMatch(/\.db\b/);
    } finally {
      await server.close();
    }
  });

  test("a missing execution store refuses workflow reads with store.not-initialized", async () => {
    const { dir } = await workspace("missing-");
    for (const name of ["store.db", "store.db-wal", "store.db-shm"]) {
      rmSync(join(dir, ".mstar", name), { force: true });
    }
    const server = await start(dir);
    try {
      const res = await raw(new URL("/api/workflows", server.url).href);
      expect(res.status).toBe(503);
      const body = JSON.parse(res.body) as { error: { code: string } };
      expect(body.error.code).toBe("store.not-initialized");
    } finally {
      await server.close();
    }
  });

  test("an unknown project fails before the server starts", async () => {
    const { dir } = await workspace("project-");
    await expect(startDashboard({ harnessDir: join(dir, ".mstar"), projectId: "no-such-project" })).rejects.toThrow(/Unknown project/);
  });

  test("without --project the served URL carries no selector", async () => {
    const { dir } = await workspace("unscoped-");
    const server = await start(dir);
    try {
      expect(new URL(server.url).searchParams.get("project")).toBeNull();
      expect(new URL(server.url).searchParams.get("token")).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      await server.close();
    }
  });

  test("a known project starts, seeds the served URL and scopes the issue list", async () => {
    const { context } = await workspace("scoped-");
    await registerCatalogEntity(context, {
      kind: "project", id: "proj-a", title: "Project A", rootKind: "projects", relativePath: "proj-a",
    }, { actor: "project-manager", operationId: "register-scoped-project" });
    await seedIssue(context, "scoped", "high");
    const server = remember(await startDashboard({ harnessDir: context.harnessDir, projectId: "proj-a" }));
    try {
      // The selector travels in the served URL: the shell parses
      // `location.search` as its initial Issues filter, and `--open` opens
      // exactly this URL, so the seeded filter is the one the browser applies.
      expect(new URL(server.url).searchParams.get("project")).toBe("proj-a");
      const shell = await raw(server.url);
      expect(shell.status).toBe(200);
      expect(withoutHarnessDirectory(shell.body)).toBe(dashboardHtml);
      const res = await raw(new URL("/api/issues?project=proj-a", server.url).href);
      expect(res.status).toBe(200);
      expect((JSON.parse(res.body) as { data: { total: number } }).data.total).toBe(1);
    } finally {
      await server.close();
    }
  });

  test("a port conflict refuses with an actionable message and leaves the other server running", async () => {
    const { dir } = await workspace("conflict-");
    const first = remember(await startDashboard({ harnessDir: join(dir, ".mstar"), port: 0 }));
    try {
      const usedPort = new URL(first.url).port;
      await expect(startDashboard({ harnessDir: join(dir, ".mstar"), port: Number(usedPort) })).rejects.toThrow(/already in use/);
      const stillUp = await raw(new URL("/api/issues", first.url).href);
      expect(stillUp.status).toBe(200); // the empty store answers: the socket is alive
      expect((JSON.parse(stillUp.body) as { data: { total: number } }).data.total).toBe(0);
    } finally {
      await first.close();
    }
  });

  test("close() is idempotent and the socket stops accepting", async () => {
    const { dir } = await workspace("close-");
    const server = remember(await startDashboard({ harnessDir: join(dir, ".mstar") }));
    const url = server.url;
    await server.close();
    await expect(server.close()).resolves.toBeUndefined();
    await expect(raw(new URL("/api/issues", url).href)).rejects.toThrow();
  });

  test("out-of-range ports refuse before listening", async () => {
    for (const port of [-1, 65536, 1.5]) {
      await expect(startDashboard({ harnessDir: ROOT, port })).rejects.toThrow(/--port/);
    }
  });
});

describe("inlined-artifact serving (built CLI, no source asset directory)", () => {
  test(
    "the built CLI artifact serves the bundled assets from a temp packaging context without any asset directory",
    async () => {
      // Build once, then copy ONLY the bundle into a packaging context that has
      // no web/ sources and no assets directory.
      const cliDir = join(import.meta.dir, "..");
      const build = spawnSync("bun", ["run", "build"], { cwd: cliDir, encoding: "utf8" });
      expect(build.status).toBe(0);
      const bundle = join(cliDir, "dist", "mstar-harness.js");
      expect(existsSync(bundle)).toBe(true);
      const packaging = mkdtempSync(join(ROOT, "packaging-"));
      const packaged = join(packaging, "mstar-harness.js");
      const { copyFileSync } = await import("node:fs");
      copyFileSync(bundle, packaged);

      // A real workspace for the CLI process to serve.
      const { dir, context } = await workspace("artifact-");
      await seedIssue(context, "artifact", "high");

      const child = spawn("bun", [packaged, "dashboard", "--port", "0"], {
        cwd: dir,
        // invariant: The child resolves the collaboration lane from HOME; this suite owns a
        // temporary one, so it must not read the developer's real store.
        env: { ...process.env, HOME: TEST_HOME },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const url = await new Promise<string>((resolve, reject) => {
        let buffer = "";
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          buffer += text;
          output += text;
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            try {
              const envelope = JSON.parse(line) as { command?: string; status?: string; message?: string; data?: { url?: string } };
              if (envelope.command !== "dashboard") continue;
              if (envelope.status !== "ok") {
                reject(new Error(`dashboard failed: ${envelope.message ?? "unknown command failure"}`));
                return;
              }
              if (typeof envelope.data?.url === "string") {
                resolve(envelope.data.url);
                return;
              }
            } catch {
              // Ignore non-envelope output; early exit below reports the captured stream.
            }
          }
        });
        child.once("exit", (code) => {
          reject(new Error(`dashboard exited early (${code}); output:\n${output}`));
        });
      });
      expect(new URL(url).searchParams.get("token")).toMatch(/^[0-9a-f-]{36}$/);

      // This test just ran `bun run build`, which regenerates the inlined assets
      // module. Comparing against the module this file imported at load time would
      // compare the *previous* build's bytes with the new build's server — the
      // mismatch that made the first run after any source change fail with no
      // assertion naming the cause. Read the generated module as it is now.
      const generated = (await import(
        new URL("../../commands/src/dashboard/assets.generated.ts", import.meta.url).href
      )) as typeof import("../../commands/src/dashboard/assets.generated");

      try {
        const shell = await raw(url);
        expect(shell.status).toBe(200);
        expect(withoutHarnessDirectory(shell.body)).toBe(generated.dashboardHtml);
        const js = await raw(new URL("/assets/app.js", url).href);
        expect(js.status).toBe(200);
        expect(js.body).toBe(generated.dashboardJs);
        const css = await raw(new URL("/assets/app.css", url).href);
        expect(css.status).toBe(200);
        expect(css.body).toBe(generated.dashboardCss);
        const issues = await raw(new URL("/api/issues", url).href);
        expect(issues.status).toBe(200);
        expect((JSON.parse(issues.body) as { data: { total: number } }).data.total).toBe(1);
      } finally {
        child.kill("SIGTERM");
        const exited = await new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => resolve("timeout"), 10_000);
          child.once("exit", (code) => {
            clearTimeout(timer);
            resolve(code === null ? "signal" : String(code));
          });
        });
        // SIGTERM closes the server once and the CLI exits with the signal's own
        // status (128+15), never the start receipt's 0.
        expect(exited).toBe("143");
        await expect(raw(url)).rejects.toThrow();
        rmSync(packaging, { recursive: true, force: true });
      }
    },
    { timeout: 120_000 },
  );
});
describe("hostile invocation-cwd dotenv", () => {
  test("the built dashboard CLI ignores projection test controls from cwd .env", async () => {
    const { dir, context } = await workspace("hostile-dotenv-");
    const workflowId = "wf-hostile-dotenv";
    const planId = "plan-hostile-dotenv";
    await registerCatalogEntity(context, {
      kind: "plan", id: planId, title: "Hostile dotenv plan", rootKind: "plans", relativePath: `${planId}.md`,
    }, { actor: "dashboard-test", operationId: "register-hostile-dotenv-plan" });
    const authority = await readExecutionAuthority(context);
    await createExecutionWorkflow({
      ...context, caller: { role: "coordinator", sessionId: "dashboard-hostile-dotenv", workflowId },
    }, {
      expected: authority.token, operationId: "create-hostile-dotenv-workflow",
      entry: { id: workflowId, type: "plan", started_at: RECORDED_AT, dir: `workflows/${workflowId}` },
      snapshot: {
        schema_version: 1, id: workflowId, type: "plan", status: "running",
        started_at: RECORDED_AT, updated_at: RECORDED_AT,
        plans: [{ id: planId, title: "Hostile dotenv plan", file: `${planId}.md`, status: "Todo" }],
      },
    });
    const initial = await refreshProjections(context);
    const beforeHandle = await openStore(context, "read");
    let before: { revision: number; generation: number; planRows: Record<string, unknown>[] };
    try {
      before = {
        revision: (beforeHandle.db.prepare("select revision from store_meta where id = 1").get() as { revision: number }).revision,
        generation: (beforeHandle.db.prepare("select generation from projection_meta where id = 1").get() as { generation: number }).generation,
        planRows: beforeHandle.db.prepare("select * from projection_plans order by plan_id").all() as Record<string, unknown>[],
      };
    } finally { beforeHandle.close(); }
    expect(initial.generation).toBe(before.generation);
    expect(before.planRows.map((row) => row.plan_id)).toEqual([planId]);

    const churn = JSON.stringify({ kind: "update-row", workflowId, planId });
    // why: The hostile `.env` sits in the fixture checkout's own root: the fixed
    // root comes from `<dir>/.mstar` via Git, and a retired `MSTAR_HARNESS_DIR`
    // pin (here a decoy root with no store) must not redirect it.
    const decoy = join(ROOT, "hostile-decoy-root");
    mkdirSync(join(decoy, ".mstar"), { recursive: true });
    writeFileSync(join(dir, ".env"), [
      "MSTAR_STORE_TEST_RUNNER=1",
      `MSTAR_PROJECTION_DB_CHURN='${churn}'`,
      "MSTAR_PROJECTION_TEST_AUTHORITY_READ_ERROR=induced",
      `MSTAR_HARNESS_DIR=${join(decoy, ".mstar")}`,
      "",
    ].join("\n"));
    const env = { ...process.env, HOME: TEST_HOME };
    for (const key of ["MSTAR_STORE_TEST_RUNNER", "MSTAR_PROJECTION_DB_CHURN", "MSTAR_PROJECTION_TEST_AUTHORITY_READ_ERROR", "MSTAR_HARNESS_DIR"]) delete env[key];

    const cliDir = join(import.meta.dir, "..");
    const bundle = join(cliDir, "dist", "mstar-harness.js");
    expect(existsSync(bundle)).toBe(true);
    // why: The child runs from the fixture checkout, so the only root it can serve
    // is `<dir>/.mstar`; the decoy pin in the cwd `.env` must be ignored.
    const child = spawn("bun", [bundle, "dashboard", "--port", "0"], {
      cwd: dir, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let dashboardUrl: string | undefined;
    try {
      dashboardUrl = await new Promise<string>((resolve, reject) => {
        let buffer = "";
        let output = "";
        const timer = setTimeout(() => reject(new Error(`dashboard startup timed out; output: ${output}`)), 10_000);
        child.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            try {
              const envelope = JSON.parse(line) as { command?: string; status?: string; data?: { url?: string }; message?: string };
              if (envelope.command !== "dashboard") continue;
              if (envelope.status !== "ok" || typeof envelope.data?.url !== "string") {
                clearTimeout(timer);
                reject(new Error(`dashboard failed: ${envelope.message ?? "no URL returned"}`));
                return;
              }
              clearTimeout(timer);
              resolve(envelope.data.url);
              return;
            } catch {
              output += `${line}\n`;
            }
          }
        });
        child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`dashboard exited early (${code}); output: ${output}`)); });
      });
      const apiUrl = new URL("/api/workflows", dashboardUrl);
      apiUrl.searchParams.set("token", new URL(dashboardUrl).searchParams.get("token")!);
      // Bound the real HTTP request independently of the process startup and shutdown bounds.
      const response = await fetch(apiUrl, { signal: AbortSignal.timeout(10_000) });
      expect(response.status).toBe(200);
      const envelope = await response.json() as { projection: { freshness: string; generation: number }; data: { items: Array<{ id: string }> } };
      expect(envelope.projection.freshness).toBe("current");
      expect(envelope.projection.generation).toBe(before.generation);
      expect(envelope.data.items.map((item) => item.id)).toEqual([workflowId]);
    } finally {
      child.kill("SIGTERM");
      const exit = await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), 10_000);
        child.once("exit", (code) => { clearTimeout(timer); resolve(code === null ? "signal" : String(code)); });
      });
      if (exit === "timeout") child.kill("SIGKILL");
    }

    const afterHandle = await openStore(context, "read");
    try {
      const after = {
        revision: (afterHandle.db.prepare("select revision from store_meta where id = 1").get() as { revision: number }).revision,
        generation: (afterHandle.db.prepare("select generation from projection_meta where id = 1").get() as { generation: number }).generation,
        planRows: afterHandle.db.prepare("select * from projection_plans order by plan_id").all() as Record<string, unknown>[],
      };
      expect(after).toEqual(before);
    } finally { afterHandle.close(); }
  }, { timeout: 60_000 });
});
