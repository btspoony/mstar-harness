import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const tokens = { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000, scope: "read" };

describe("mstar linear auth", () => {
  test("status on a machine with no credential says absent, with the path", async () => {
    const result = await command.execute({ action: "status" }, context());
    expect(result.status).toBe("ok");
    const data = result.data as Record<string, unknown>;
    expect(data.authorized).toBe(false);
    expect(String(data.credentialPath)).toBe(process.env.MSTAR_LINEAR_CREDENTIAL!);
  });

  test("login stores what the host returned, and status then reports it", async () => {
    const authorized = await command.execute({ action: "login" }, context({ linearAuthorize: async () => tokens }));
    expect(authorized.status).toBe("ok");
    expect((authorized.data as Record<string, unknown>).scope).toBe("read");

    const status = await command.execute({ action: "status" }, context());
    const data = status.data as Record<string, unknown>;
    expect(data.authorized).toBe(true);
    expect(data.hasRefreshToken).toBe(true);
  });

  test("logout removes the credential and says whether anything was there", async () => {
    await command.execute({ action: "login" }, context({ linearAuthorize: async () => tokens }));
    const first = await command.execute({ action: "logout" }, context());
    expect((first.data as Record<string, unknown>).removed).toBe(true);
    const second = await command.execute({ action: "logout" }, context());
    expect((second.data as Record<string, unknown>).removed).toBe(false);
  });

  test("a host without the capability refuses and names a host that has it", async () => {
    const result = await command.execute({ action: "login" }, context());
    expect(result.status).toBe("refused");
    expect(result.code).toBe("linear.auth-unsupported");
    // The recovery is part of the refusal envelope; check the whole thing so the
    // test does not depend on which field carries it.
    expect(JSON.stringify(result)).toMatch(/browser|CLI|MSTAR_LINEAR_CREDENTIAL/);
  });

  test("an authorization that did not complete is a refusal, not a stored empty token", async () => {
    const result = await command.execute({ action: "login" }, context({ linearAuthorize: async () => null }));
    expect(result.code).toBe("linear.auth-denied");
    const status = await command.execute({ action: "status" }, context());
    expect((status.data as Record<string, unknown>).authorized).toBe(false);
  });
});
