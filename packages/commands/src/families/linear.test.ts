import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLinearCredential, readLinearCredential } from "@mstar-harness/engine";
import { getLinearCommandDefinitions } from "./linear.js";
import type { InvocationContext } from "../types.js";

/** Assembled at run time so a secret scanner reads fixtures as data, not a leak. */
const fake = (name: string): string => ["not", "a", "real", name].join("-");

const command = getLinearCommandDefinitions()[0]!;
let root: string;
const previous = process.env.MSTAR_LINEAR_CREDENTIAL;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mstar-linear-cmd-"));
  process.env.MSTAR_LINEAR_CREDENTIAL = join(root, "credential.json");
});

afterEach(() => {
  if (previous === undefined) delete process.env.MSTAR_LINEAR_CREDENTIAL;
  else process.env.MSTAR_LINEAR_CREDENTIAL = previous;
  rmSync(root, { recursive: true, force: true });
});

function context(effects: Partial<InvocationContext["effects"]> = {}): InvocationContext {
  return { cwd: root, controlRoot: root, effects } as InvocationContext;
}

const tokens = { accessToken: fake("access"), refreshToken: fake("refresh"), expiresAt: Date.now() + 3_600_000, scope: "read", clientId: fake("client") };

/** The success payload of an envelope; the union has no `data` on its other arms. */
function dataOf(result: { status: string }): Record<string, unknown> {
  return (result as { data?: Record<string, unknown> }).data ?? {};
}

describe("mstar linear auth", () => {
  test("status on a machine with no credential says absent, with the path", async () => {
    const result = await command.execute({ operation: "status" }, context());
    expect(result.status).toBe("ok");
    const data = dataOf(result);
    expect(data.authorized).toBe(false);
    expect(String(data.credentialPath)).toBe(process.env.MSTAR_LINEAR_CREDENTIAL!);
  });

  test("login stores what the host returned, and status then reports it", async () => {
    const authorized = await command.execute({ operation: "login" }, context({ linearAuthorize: async () => tokens }));
    expect(authorized.status).toBe("ok");
    expect(dataOf(authorized).scope).toBe("read");

    const status = await command.execute({ operation: "status" }, context());
    const data = dataOf(status);
    expect(data.authorized).toBe(true);
    expect(data.hasRefreshToken).toBe(true);
  });

  test("logout removes the credential and says whether anything was there", async () => {
    await command.execute({ operation: "login" }, context({ linearAuthorize: async () => tokens }));
    const first = await command.execute({ operation: "logout" }, context());
    expect(dataOf(first).removed).toBe(true);
    const second = await command.execute({ operation: "logout" }, context());
    expect(dataOf(second).removed).toBe(false);
  });

  test("a host without the capability refuses and names a host that has it", async () => {
    const result = await command.execute({ operation: "login" }, context());
    expect(result.status).toBe("refused");
    expect(result.code).toBe("linear.auth-unsupported");
    // The recovery is part of the refusal envelope; check the whole thing so the
    // test does not depend on which field carries it.
    expect(JSON.stringify(result)).toMatch(/browser|CLI|MSTAR_LINEAR_CREDENTIAL/);
  });

  test("a host failure becomes a refusal carrying its own code and recovery", async () => {
    const timeout = Object.assign(new Error("no authorization callback arrived"), {
      code: "linear.auth-timeout",
      recovery: "Run `mstar linear auth` again and complete the browser step.",
    });
    const result = await command.execute({ operation: "login" }, context({ linearAuthorize: async () => { throw timeout; } }));
    expect(result.status).toBe("refused");
    expect((result as { code: string }).code).toBe("linear.auth-timeout");
    // The recovery the host supplied survives, instead of the generic fallback an
    // escaped Error would have produced.
    expect(JSON.stringify(result)).toMatch(/complete the browser step/);
    const status = await command.execute({ operation: "status" }, context());
    expect(JSON.stringify(status)).toMatch(/"authorized":false/);
  });

  test("an authorization that did not complete is a refusal, not a stored empty token", async () => {
    const result = await command.execute({ operation: "login" }, context({ linearAuthorize: async () => null }));
    expect(result.code).toBe("linear.auth-denied");
    const status = await command.execute({ operation: "status" }, context());
    expect(dataOf(status).authorized).toBe(false);
  });
});

describe("an expired credential is refreshed before use", () => {
  test("the import path refreshes an expired token and stores the replacement", async () => {
    const { resolveStoredToken } = await import("./issue-sync.js");
    const expired = Date.now() - 60_000;
    writeLinearCredential({ accessToken: fake("expired"), refreshToken: fake("refresh"), expiresAt: expired, scope: "read", clientId: fake("client") });
    let asked: unknown[] = [];
    const token = await resolveStoredToken(context({
      linearRefresh: async (url: string, clientId: string, refresh: string) => {
        asked = [url, clientId, refresh];
        return { accessToken: fake("renewed"), refreshToken: fake("rotated"), expiresAt: Date.now() + 3_600_000, scope: "read", clientId };
      },
    }));
    expect(token).toBe(fake("renewed"));
    expect(asked).toEqual(["https://mcp.linear.app/mcp", fake("client"), fake("refresh")]);
    const state = readLinearCredential();
    expect(state.kind === "present" && state.credential.accessToken).toBe(fake("renewed"));
    expect(state.kind === "present" && state.credential.refreshToken).toBe(fake("rotated"));
  });

  test("a host that cannot refresh refuses with the command to re-run", async () => {
    const { resolveStoredToken } = await import("./issue-sync.js");
    const previousKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    writeLinearCredential({ accessToken: fake("expired"), refreshToken: fake("refresh"), expiresAt: Date.now() - 1, scope: "read", clientId: fake("client") });
    try {
      await expect(resolveStoredToken(context())).rejects.toMatchObject({ code: "linear.reauth-required" });
    } finally {
      if (previousKey !== undefined) process.env.LINEAR_API_KEY = previousKey;
    }
  });

  test("an exported key still works when the stored credential cannot be refreshed", async () => {
    const { resolveStoredToken } = await import("./issue-sync.js");
    const previousKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = fake("env");
    writeLinearCredential({ accessToken: fake("expired"), refreshToken: fake("refresh"), expiresAt: Date.now() - 1, scope: "read", clientId: fake("client") });
    try {
      // Null tells the caller to fall back, which is what a headless deployment
      // holding a stale credential and a working key needs.
      expect(await resolveStoredToken(context())).toBeNull();
    } finally {
      if (previousKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = previousKey;
    }
  });

  test("a live credential is used without a refresh round trip", async () => {
    const { resolveStoredToken } = await import("./issue-sync.js");
    writeLinearCredential({ accessToken: fake("live"), refreshToken: fake("refresh"), expiresAt: Date.now() + 3_600_000, scope: "read", clientId: fake("client") });
    let called = false;
    const token = await resolveStoredToken(context({
      linearRefresh: async () => {
        called = true;
        return null;
      },
    }));
    expect(token).toBe(fake("live"));
    expect(called).toBe(false);
  });
});
