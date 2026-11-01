import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeLinearCredential, readLinearCredential } from "@mstar-harness/engine";
import { getLinearCommandDefinitions } from "./linear.js";
import type { InvocationContext } from "../types.js";

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

const tokens = { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000, scope: "read", clientId: "cid" };

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
    writeLinearCredential({ accessToken: "old", refreshToken: "r1", expiresAt: expired, scope: "read", clientId: "cid" });
    let asked: unknown[] = [];
    const token = await resolveStoredToken(context({
      linearRefresh: async (url: string, clientId: string, refresh: string) => {
        asked = [url, clientId, refresh];
        return { accessToken: "new", refreshToken: "r2", expiresAt: Date.now() + 3_600_000, scope: "read", clientId };
      },
    }));
    expect(token).toBe("new");
    expect(asked).toEqual(["https://mcp.linear.app/mcp", "cid", "r1"]);
    const state = readLinearCredential();
    expect(state.kind === "present" && state.credential.accessToken).toBe("new");
    expect(state.kind === "present" && state.credential.refreshToken).toBe("r2");
  });

  test("a host that cannot refresh refuses with the command to re-run", async () => {
    const { resolveStoredToken } = await import("./issue-sync.js");
    writeLinearCredential({ accessToken: "old", refreshToken: "r1", expiresAt: Date.now() - 1, scope: "read", clientId: "cid" });
    await expect(resolveStoredToken(context())).rejects.toThrow(/linear\.reauth-required/);
  });

  test("a live credential is used without a refresh round trip", async () => {
    const { resolveStoredToken } = await import("./issue-sync.js");
    writeLinearCredential({ accessToken: "live", refreshToken: "r1", expiresAt: Date.now() + 3_600_000, scope: "read", clientId: "cid" });
    let called = false;
    const token = await resolveStoredToken(context({
      linearRefresh: async () => {
        called = true;
        return null;
      },
    }));
    expect(token).toBe("live");
    expect(called).toBe(false);
  });
});
