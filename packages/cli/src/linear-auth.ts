/**
 * The OAuth flow for Linear's hosted MCP server, end to end.
 *
 * Why this exists: enabling the bundled `linear-mcp` row without a credential
 * leaves an operator with a 401 and no in-product way forward. Every step below
 * is one that has to happen anyway — discovery, dynamic client registration,
 * PKCE, the code exchange, and refresh — so it lives here instead of in a
 * README the operator has to follow by hand.
 *
 * The observable contract: nothing prints a token, and the only thing written to
 * disk is the credential file (mode 0600) that `linear-credential` owns.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

/** The hosted endpoint; a deployment may point at its own. */
export const LINEAR_MCP_URL = "https://mcp.linear.app/mcp";

export type AuthorizationServer = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
};

export type RegisteredClient = { clientId: string; redirectUri: string };

/**
 * Read the authorization-server coordinates the endpoint advertises. The
 * protected-resource document names the issuer; the issuer names the endpoints.
 * Neither is assumed — a hard-coded endpoint would break silently the day it
 * moves.
 */
/**
 * Authorization failures carry their code and recovery on the error itself: a
 * plain Error reaches the envelope as `internal-error`, which tells an operator
 * nothing they can act on.
 */
function authFailure(code: string, message: string, recovery: string): Error {
  return Object.assign(new Error(message), { code, recovery });
}

/**
 * Every call here is a network round trip inside an interactive login; without a
 * deadline a black-holed endpoint leaves the operator watching a spinner forever.
 */
const NETWORK_TIMEOUT_MS = 30_000;
const DEADLINE = (): { signal: AbortSignal } => ({ signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });

export async function discoverAuthorizationServer(
  mcpUrl: string = LINEAR_MCP_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthorizationServer> {
  const origin = new URL(mcpUrl);
  // Unauthenticated probe: the 401 names where the resource metadata lives.
  let metadataUrl = `${origin.origin}/.well-known/oauth-protected-resource`;
  const probe = await fetchImpl(mcpUrl, {
    ...DEADLINE(),
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "mstar", version: "1" } },
    }),
  });
  const challenge = probe.headers.get("www-authenticate") ?? "";
  const named = /resource_metadata="([^"]+)"/.exec(challenge);
  if (named !== null) metadataUrl = named[1]!;
  const resource = (await (await fetchImpl(metadataUrl, { ...DEADLINE(), headers: { accept: "application/json" } })).json()) as {
    authorization_servers?: unknown;
  };
  const issuers = Array.isArray(resource.authorization_servers) ? resource.authorization_servers : [];
  const issuer = typeof issuers[0] === "string" ? issuers[0] : origin.origin;
  const as = (await (
    await fetchImpl(`${issuer}/.well-known/oauth-authorization-server`, { ...DEADLINE(), headers: { accept: "application/json" } })
  ).json()) as Record<string, unknown>;
  const authorizationEndpoint = typeof as.authorization_endpoint === "string" ? as.authorization_endpoint : null;
  const tokenEndpoint = typeof as.token_endpoint === "string" ? as.token_endpoint : null;
  if (authorizationEndpoint === null || tokenEndpoint === null) {
    throw new Error(`[linear.auth-unavailable] ${issuer} does not advertise an authorization and token endpoint`);
  }
  const registrationEndpoint = typeof as.registration_endpoint === "string" ? as.registration_endpoint : null;
  // The code and its PKCE verifier travel to these endpoints. A plaintext one
  // would hand both to anyone on the path, so metadata cannot downgrade the
  // flow: loopback is the only transport allowed to be insecure, and only
  // because it never leaves the machine.
  for (const endpoint of [authorizationEndpoint, tokenEndpoint, registrationEndpoint]) {
    if (endpoint !== null) requireSecureEndpoint(endpoint, issuer);
  }
  return { issuer, authorizationEndpoint, tokenEndpoint, registrationEndpoint };
}

/** Refuse an endpoint that would carry the authorization material in the clear. */
function requireSecureEndpoint(endpoint: string, issuer: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`[linear.auth-unavailable] ${issuer} advertises an endpoint that is not a URL: ${endpoint}`);
  }
  // URL.hostname keeps the brackets on an IPv6 literal, so both forms are listed.
  const loopback =
    parsed.hostname === "127.0.0.1" || parsed.hostname === "::1" || parsed.hostname === "[::1]" || parsed.hostname === "localhost";
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback)) return;
  throw new Error(
    `[linear.auth-unavailable] ${issuer} advertises a non-TLS endpoint (${endpoint}); refusing to send an authorization code there`,
  );
}

/** Dynamic client registration, so nothing has to be configured by hand. */
export async function registerClient(
  as: AuthorizationServer,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegisteredClient> {
  if (as.registrationEndpoint === null) {
    throw new Error(
      `[linear.auth-unavailable] ${as.issuer} advertises no registration endpoint, so a client id has to be supplied by the deployment`,
    );
  }
  const response = await fetchImpl(as.registrationEndpoint, {
    ...DEADLINE(),
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "mstar-harness",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "read",
    }),
  });
  if (!response.ok) {
    throw new Error(`[linear.auth-unavailable] client registration failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as { client_id?: unknown };
  if (typeof body.client_id !== "string" || body.client_id === "") {
    throw new Error("[linear.auth-unavailable] client registration returned no client_id");
  }
  return { clientId: body.client_id, redirectUri };
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** PKCE verifier/challenge pair (S256). */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  // node:crypto, not a runtime-specific hasher: this module is compiled with the
  // package's TypeScript config, which does not include Bun's globals.
  const digest = createHash("sha256").update(verifier).digest();
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export type PendingAuthorization = {
  url: string;
  state: string;
  redirectUri: string;
  /** PKCE verifier for the exchange; belongs to this authorization only. */
  verifier: string;
  /** The registered client this authorization belongs to. */
  clientId: string;
  /** Resolves with the authorization code, or rejects on timeout/denial. */
  wait: (timeoutMs?: number) => Promise<string>;
  close: () => void;
};

/**
 * Start the browser leg. The listener binds 127.0.0.1 on an ephemeral port, so
 * nothing is exposed beyond the loopback interface and two runs cannot collide.
 */
export async function beginAuthorization(
  as: AuthorizationServer,
  register: (redirectUri: string) => Promise<RegisteredClient>,
  scope = "read",
): Promise<PendingAuthorization> {
  const pkce = createPkce();
  const state = base64url(crypto.getRandomValues(new Uint8Array(12)));
  const pending = Promise.withResolvers<string>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end("not found");
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const returned = url.searchParams.get("state");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      error !== null ? "<h1>Authorization failed</h1>" : "<h1>Authorized</h1><p>You can return to the terminal.</p>",
    );
    if (error !== null) pending.reject(authFailure("linear.auth-denied", `the authorization server returned ${error}`, "Run `mstar linear auth` again; the authorization server declined the request."));
    else if (returned !== state) pending.reject(authFailure("linear.auth-denied", "the callback state did not match", "Run `mstar linear auth` again; a callback whose state does not match is refused rather than trusted."));
    else if (code === null) pending.reject(authFailure("linear.auth-denied", "the callback carried no code", "Run `mstar linear auth` again and complete the browser step."));
    else pending.resolve(code);
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  // The registration is bound to THIS redirect URI, so it happens after the
  // listener exists and before the URL is built.
  const client = await register(redirectUri).catch((error: unknown) => {
    server.close();
    throw error;
  });
  if (client.redirectUri !== redirectUri) {
    server.close();
    throw new Error(
      `[linear.auth-unavailable] the registered redirect (${client.redirectUri}) does not match the callback (${redirectUri})`,
    );
  }
  const url = new URL(as.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return {
    url: url.toString(),
    state,
    redirectUri,
    verifier: pkce.verifier,
    clientId: client.clientId,
    wait: (timeoutMs = 300_000) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(authFailure("linear.auth-timeout", "no authorization callback arrived", "Run `mstar linear auth` again and complete the browser step, or check the authorization server is reachable.")), timeoutMs);
        // The CLI waits on a human, not on work: an unref'd timer cannot be the
        // reason the process stays alive.
        timer.unref?.();
      });
      return Promise.race([pending.promise, expiry]).finally(() => {
        clearTimeout(timer);
        server.close();
      });
    },
    close: () => server.close(),
  };
}

export type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scope: string | null;
  /** The registered client the token was issued to; a refresh must present it. */
  clientId: string | null;
};

function toTokenSet(body: Record<string, unknown>, clientId: string): TokenSet {
  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw authFailure("linear.auth-unavailable", "the token endpoint returned no access token", "Run `mstar linear auth` again; if it repeats, the authorization server is misbehaving.");
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : null;
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : null,
    expiresAt: expiresIn === null ? null : Date.now() + expiresIn * 1000,
    scope: typeof body.scope === "string" ? body.scope : null,
    // Recorded here because the response does not repeat it and a refresh
    // exchange cannot proceed without it.
    clientId,
  };
}

/** Exchange the authorization code (with its PKCE verifier) for a token set. */
export async function exchangeCode(
  as: AuthorizationServer,
  client: RegisteredClient,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const response = await fetchImpl(as.tokenEndpoint, {
    ...DEADLINE(),
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: client.redirectUri,
      client_id: client.clientId,
      code_verifier: verifier,
    }).toString(),
  });
  if (!response.ok) throw new Error(`[linear.auth-unavailable] the token exchange failed with HTTP ${response.status}`);
  return toTokenSet((await response.json()) as Record<string, unknown>, client.clientId);
}

/** Refresh an expired access token without a browser. */
export async function refreshToken(
  as: AuthorizationServer,
  client: RegisteredClient,
  refresh: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const response = await fetchImpl(as.tokenEndpoint, {
    ...DEADLINE(),
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: client.clientId,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(
      `[linear.reauth-required] the refresh was rejected with HTTP ${response.status}; run \`mstar linear auth\` again`,
    );
  }
  return toTokenSet((await response.json()) as Record<string, unknown>, client.clientId);
}
