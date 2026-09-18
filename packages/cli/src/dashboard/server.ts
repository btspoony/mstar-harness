/**
 * Dashboard loopback server (plan 20260918-dashboard D2).
 *
 * The ONE HTTP boundary in front of the P6 read transport
 * (`packages/cli/src/store-read.ts`): fixed static routes serving the D1
 * inlined assets, the fixed `/api/...` route table mapped exactly to the
 * engine's `ReadEnvelope` DTOs, and the boundary protections the plan fixes --
 * loopback binding only, Host/Origin checks, no CORS, the exact CSP, JSON
 * `no-store` + `nosniff`, and structured errors that never leak a stack or a
 * credential.
 *
 * Lifecycle: the store itself is opened per request by the engine read
 * boundary (contract §6); this server serializes requests so at most one read
 * transaction runs at a time, and `close()` stops new work and drains
 * in-flight work once, bounded.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  dashboardFailure,
  readDashboardView,
  resolveDashboardRoute,
} from "../store-read";
import type { DashboardView } from "@mstar-harness/engine";
import { dashboardCss, dashboardHtml, dashboardJs } from "./assets.generated";

/** The exact CSP the plan fixes; identical on every response. */
export const DASHBOARD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";

/** Bounded drain for in-flight requests during close. */
const CLOSE_DRAIN_MS = 5_000;

/** `startDashboard` options. There is deliberately no host/bind option. */
export type StartDashboardOptions = {
  harnessDir: string;
  /** TCP port; default 0 = OS-selected. */
  port?: number;
  /** Optional project selector validated before the server starts. */
  projectId?: string;
};

/** A running dashboard. `close()` is idempotent and bounded. */
export type RunningDashboard = {
  url: string;
  close(): Promise<void>;
};

/** One structured API failure body: code + message, nothing else. */
type ApiFailure = { error: { code: string; message: string } };

function fail(code: string, message: string): ApiFailure {
  return { error: { code, message } };
}

/** HTTP status for a structured failure, from its stable code. */
function statusForCode(code: string): number {
  if (code === "usage") return 400;
  if (code === "issue.not-found" || code === "not-found") return 404;
  if (code.startsWith("store.") || code.startsWith("projection.")) return 503;
  return 500;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, requestHead: boolean): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": DASHBOARD_CSP,
    "content-length": String(payload.byteLength),
  });
  res.end(requestHead ? undefined : payload);
}

function sendStatic(
  res: http.ServerResponse,
  requestHead: boolean,
  contentType: string,
  body: string,
): void {
  const payload = Buffer.from(body, "utf8");
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": DASHBOARD_CSP,
    "content-length": String(payload.byteLength),
  });
  res.end(requestHead ? undefined : payload);
}

/**
 * Validate an optional project selector against the store before listening.
 * Uses the P6 read boundary so every store refusal class (missing, staged,
 * schema/runtime) refuses before the server starts. Unknown project refuses.
 */
async function assertProjectExists(harnessDir: string, projectId: string): Promise<void> {
  const envelope = await readDashboardView({
    context: { harnessDir },
    view: "roadmap",
    params: { project: projectId },
  });
  if (envelope.data === null) {
    throw new Error(`Unknown project ${JSON.stringify(projectId)}: no catalog project row exists. ` + "Check the id with `mstar catalog list` and retry.");
  }
}

/**
 * Start the dashboard on `127.0.0.1`. Resolves only after the socket listens;
 * the resolved URL carries the actual (possibly OS-selected) port.
 */
export async function startDashboard(options: StartDashboardOptions): Promise<RunningDashboard> {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be an integer between 0 and 65535 — got ${JSON.stringify(String(port))}`);
  }
  const context = { harnessDir: options.harnessDir };
  if (options.projectId !== undefined) await assertProjectExists(options.harnessDir, options.projectId);

  // Serialized request execution: at most one read transaction runs at a time
  // (plan D2 "serialized request transactions"); new work after close is
  // refused. simplify: FIFO chain — the store's own read transactions are the
  // bottleneck, so per-route concurrency would not add throughput.
  let closed = false;
  let tail: Promise<void> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error("dashboard is shutting down"));
    const run = tail.then(work, work);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const server = http.createServer((req, res) => {
    void enqueue(() => handleRequest(req, res)).catch(() => {
      /* handled in handleRequest; a post-close race just ends the response */
      if (!res.headersSent) res.destroy();
    });
  });

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const requestHead = req.method === "HEAD";
    const method = requestHead ? "GET" : req.method ?? "";
    const host = req.headers.host ?? "";
    const expectedHost = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    // DNS-rebinding guard: the Host header must be the actual loopback origin.
    if (host !== expectedHost) {
      sendJson(res, 403, fail("forbidden", `Host header must be ${expectedHost}`), requestHead);
      return;
    }
    const origin = req.headers.origin;
    // No CORS ever: a cross-origin browser context is refused outright; an
    // absent Origin (direct navigation, curl) is the same-origin case.
    if (origin !== undefined && origin !== `http://${expectedHost}`) {
      sendJson(res, 403, fail("forbidden", `Origin ${JSON.stringify(origin)} is not the dashboard origin`), requestHead);
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${expectedHost}`);
    } catch {
      sendJson(res, 400, fail("usage", "the request path is not a valid URL"), requestHead);
      return;
    }
    const pathname = url.pathname;

    // Fixed static routes only: no filesystem serving, no traversal, no
    // arbitrary Markdown/HTML rendering.
    if (pathname === "/" || pathname === "/assets/app.js" || pathname === "/assets/app.css") {
      if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, fail("method-not-allowed", "only GET and HEAD are accepted for static resources"), requestHead);
        return;
      }
      if (pathname === "/") sendStatic(res, requestHead, "text/html; charset=utf-8", dashboardHtml);
      else if (pathname === "/assets/app.js") sendStatic(res, requestHead, "text/javascript; charset=utf-8", dashboardJs);
      else sendStatic(res, requestHead, "text/css; charset=utf-8", dashboardCss);
      return;
    }

    // Route resolution (including the encoded-traversal id refusal) happens
    // before any store access, and its usage throws become structured 400s.
    try {
      const route = resolveDashboardRoute(pathname);
      if (route === null) {
        sendJson(res, 404, fail("not-found", `no dashboard route matches ${JSON.stringify(pathname)}`), requestHead);
        return;
      }
      // HEAD is accepted for static resources only; the API is GET-only and a
      // HEAD request must not reach the store read.
      if (req.method !== "GET") {
        sendJson(res, 405, fail("method-not-allowed", "the dashboard API is read-only: only GET is accepted"), requestHead);
        return;
      }

      const params: Record<string, string> = {};
      for (const key of new Set(url.searchParams.keys())) {
        params[key] = url.searchParams.get(key) ?? "";
      }
      const envelope = await readDashboardView({ context, view: route.view as DashboardView, params, id: route.id });
      if (envelope.data === null) {
        // A workflow row lives in the execution projection alone: with no valid
        // generation it cannot be read at all, so the honest answer is the
        // envelope itself (its projection block carries the disclosure the view
        // renders) rather than a 404 claiming the record does not exist. A null
        // payload alongside a published generation is a genuinely absent record.
        if (route.view === "workflow-detail" && envelope.projection.generation === null) {
          sendJson(res, 200, envelope, requestHead);
          return;
        }
        sendJson(res, 404, fail("not-found", "no such record"), requestHead);
        return;
      }
      sendJson(res, 200, envelope, requestHead);
    } catch (error) {
      // Structured code/message only; never a stack or a local filesystem
      // path: store refusals embed the database location, so scrub it.
      const failure = dashboardFailure(error);
      const message = failure.message.split(options.harnessDir).join("{HARNESS_DIR}");
      sendJson(res, statusForCode(failure.code), fail(failure.code, message), requestHead);
    }
  }

  return await new Promise<RunningDashboard>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use on 127.0.0.1. Choose another --port or omit it for an OS-selected port.`));
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      const actualPort = (server.address() as AddressInfo).port;
      // The selector belongs in the served URL: the shell reads
      // `location.search` as its initial Issues filter, and `--open` opens
      // exactly this URL, so both the list and the flow panel are scoped.
      const query =
        options.projectId === undefined ? "" : `?${new URLSearchParams({ project: options.projectId }).toString()}`;
      const url = `http://127.0.0.1:${actualPort}/${query}`;
      let closePromise: Promise<void> | null = null;
      resolve({
        url,
        close(): Promise<void> {
          if (closePromise !== null) return closePromise;
          closed = true;
          closePromise = new Promise<void>((resolveClose) => {
            const timer = setTimeout(() => server.closeAllConnections(), CLOSE_DRAIN_MS);
            server.close(() => {
              clearTimeout(timer);
              resolveClose();
            });
            // An idle keep-alive socket (an open browser tab) must not hold the
            // drain: close those now and keep the timer as the backstop for
            // requests that are genuinely in flight.
            server.closeIdleConnections();
          });
          return closePromise;
        },
      });
    });
  });
}
