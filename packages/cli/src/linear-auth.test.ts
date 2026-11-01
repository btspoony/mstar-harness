import { describe, expect, test } from "bun:test";
import { beginAuthorization, discoverAuthorizationServer, exchangeCode, refreshToken, registerClient } from "./linear-auth.js";

const AS = {
  issuer: "https://as.example",
  authorizationEndpoint: "https://as.example/authorize",
  tokenEndpoint: "https://as.example/token",
  registrationEndpoint: "https://as.example/register",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("authorization-server discovery", () => {
  test("the 401 challenge names where the metadata lives; the issuer names the endpoints", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url === "https://mcp.example/mcp") {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": 'Bearer realm="OAuth", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"',
          },
        });
      }
      if (url.endsWith("/oauth-protected-resource/mcp")) return json({ authorization_servers: ["https://as.example"] });
      return json({
        issuer: "https://as.example",
        authorization_endpoint: "https://as.example/authorize",
        token_endpoint: "https://as.example/token",
        registration_endpoint: "https://as.example/register",
      });
    }) as unknown as typeof fetch;

    const as = await discoverAuthorizationServer("https://mcp.example/mcp", fetchImpl);
    expect(as).toEqual(AS);
    // The challenge URL was used, not a guessed well-known path.
    expect(calls[1]).toBe("https://mcp.example/.well-known/oauth-protected-resource/mcp");
  });

  test("an issuer that advertises no endpoints refuses by name", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) return json({ authorization_servers: ["https://as.example"] });
      if (url.includes("oauth-authorization-server")) return json({ issuer: "https://as.example" });
      return new Response(null, { status: 401 });
    }) as unknown as typeof fetch;
    await expect(discoverAuthorizationServer("https://mcp.example/mcp", fetchImpl)).rejects.toThrow(/linear\.auth-unavailable/);
  });
});

describe("client registration", () => {
  test("a registration endpoint that refuses surfaces as auth-unavailable", async () => {
    const fetchImpl = (async () => json({}, 400)) as unknown as typeof fetch;
    await expect(registerClient(AS, "http://localhost:1/callback", fetchImpl)).rejects.toThrow(/linear\.auth-unavailable/);
  });

  test("an issuer with no registration endpoint says so instead of guessing a client id", async () => {
    await expect(
      registerClient({ ...AS, registrationEndpoint: null }, "http://localhost:1/callback", fetch),
    ).rejects.toThrow(/no registration endpoint/);
  });
});

describe("the callback leg", () => {
  test("a state mismatch is refused rather than accepted", async () => {
    const pending = await beginAuthorization(AS, async (redirectUri) => ({ clientId: "cid", redirectUri }));
    // Simulate the browser returning a forged state on the callback path.
    const url = new URL(pending.url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("response_type")).toBe("code");
    pending.close();

    const forged = await beginAuthorization(AS, async (redirectUri) => ({ clientId: "cid", redirectUri }));
    const callback = new URL(forged.redirectUri);
    callback.searchParams.set("code", "abc");
    callback.searchParams.set("state", "not-the-state");
    const request = fetch(callback.toString()).catch(() => null);
    await expect(forged.wait(2000)).rejects.toThrow(/state did not match/);
    forged.close();
    await request;
  });

  test("a registration bound to a different redirect is refused before the browser opens", async () => {
    await expect(beginAuthorization(AS, async () => ({ clientId: "cid", redirectUri: "http://localhost:9/callback" }))).rejects.toThrow(
      /does not match the callback/,
    );
  });

  test("the authorization URL carries the PKCE challenge and a state", async () => {
    const pending = await beginAuthorization(AS, async (redirectUri) => ({ clientId: "cid", redirectUri }));
    const url = new URL(pending.url);
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("code_challenge")).not.toBeNull();
    expect(url.searchParams.get("state")).toBe(pending.state);
    expect(url.origin + url.pathname).toBe(AS.authorizationEndpoint);
    pending.close();
  });
});

describe("token exchange and refresh", () => {
  test("an exchange carries the verifier and the registered redirect", async () => {
    let body: URLSearchParams | null = null;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = new URLSearchParams(String(init?.body));
      return json({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "read" });
    }) as unknown as typeof fetch;
    const tokens = await exchangeCode(AS, { clientId: "cid", redirectUri: "http://localhost:1/callback" }, "code-1", "verifier-1", fetchImpl);
    expect(tokens.accessToken).toBe("a");
    expect(tokens.refreshToken).toBe("r");
    expect(tokens.expiresAt).not.toBeNull();
    expect(body!.get("code_verifier")).toBe("verifier-1");
    expect(body!.get("redirect_uri")).toBe("http://localhost:1/callback");
  });

  test("a rejected refresh names re-authorization, not a bare 401", async () => {
    const fetchImpl = (async () => json({}, 400)) as unknown as typeof fetch;
    await expect(refreshToken(AS, { clientId: "cid", redirectUri: "http://localhost:1/callback" }, "r", fetchImpl)).rejects.toThrow(
      /linear\.reauth-required/,
    );
  });

  test("a token response without an access_token is refused", async () => {
    const fetchImpl = (async () => json({ refresh_token: "r" })) as unknown as typeof fetch;
    await expect(exchangeCode(AS, { clientId: "cid", redirectUri: "http://localhost:1/callback" }, "c", "v", fetchImpl)).rejects.toThrow(
      /no access_token/,
    );
  });
});

describe("endpoint transport", () => {
  test("a plaintext token endpoint is refused before any code is sent", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) return json({ authorization_servers: ["https://as.example"] });
      if (url.includes("oauth-authorization-server")) {
        return json({
          issuer: "https://as.example",
          authorization_endpoint: "https://as.example/authorize",
          token_endpoint: "http://as.example/token",
        });
      }
      return new Response(null, { status: 401 });
    }) as unknown as typeof fetch;
    await expect(discoverAuthorizationServer("https://mcp.example/mcp", fetchImpl)).rejects.toThrow(/non-TLS endpoint/);
  });

  test("a loopback endpoint stays acceptable, because it never leaves the machine", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) return json({ authorization_servers: ["https://as.example"] });
      if (url.includes("oauth-authorization-server")) {
        return json({
          issuer: "https://as.example",
          authorization_endpoint: "http://127.0.0.1:8080/authorize",
          token_endpoint: "http://127.0.0.1:8080/token",
        });
      }
      return new Response(null, { status: 401 });
    }) as unknown as typeof fetch;
    const as = await discoverAuthorizationServer("https://mcp.example/mcp", fetchImpl);
    expect(as.tokenEndpoint).toBe("http://127.0.0.1:8080/token");
  });
});
