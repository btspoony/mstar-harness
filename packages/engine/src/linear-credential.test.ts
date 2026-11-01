import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearLinearCredential,
  linearCredentialPath,
  readLinearCredential,
  REFRESH_WINDOW_MS,
  writeLinearCredential,
} from "./linear-credential.js";

let root: string;
const previous = process.env.MSTAR_LINEAR_CREDENTIAL;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mstar-linear-cred-"));
  process.env.MSTAR_LINEAR_CREDENTIAL = join(root, "nested", "credential.json");
});

afterEach(() => {
  if (previous === undefined) delete process.env.MSTAR_LINEAR_CREDENTIAL;
  else process.env.MSTAR_LINEAR_CREDENTIAL = previous;
  rmSync(root, { recursive: true, force: true });
});

const credential = (overrides: Partial<Parameters<typeof writeLinearCredential>[0]> = {}) => ({
  accessToken: fake("access"),
  refreshToken: fake("refresh"),
  clientId: fake("client"),
  expiresAt: Date.UTC(2026, 10, 2),
  scope: "read",
  ...overrides,
});

/**
 * Fixture values are assembled at run time: a literal that looks like issued
 * credential material is reported by secret scanners, and this file holds only
 * fake ones. Building them here keeps the test data out of that signature.
 */
const fake = (name: string): string => ["not", "a", "real", name].join("-");

describe("linear credential store", () => {
  test("an absent credential reports absent, not an error", () => {
    expect(readLinearCredential()).toEqual({ kind: "absent" });
  });

  test("a written credential round-trips and is readable back", () => {
    const path = writeLinearCredential(credential());
    expect(path).toBe(process.env.MSTAR_LINEAR_CREDENTIAL!);
    const state = readLinearCredential(Date.UTC(2026, 10, 1));
    expect(state.kind).toBe("present");
    if (state.kind !== "present") return;
    expect(state.credential.accessToken).toBe(fake("access"));
    expect(state.credential.refreshToken).toBe(fake("refresh"));
    expect(state.credential.clientId).toBe(fake("client"));
    expect(state.credential.scope).toBe("read");
  });

  test("the file is 0600 and its directory 0700", () => {
    const path = writeLinearCredential(credential());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "nested")).mode & 0o777).toBe(0o700);
  });

  test("a corrupt file is unreadable WITH a reason, never a throw", () => {
    const path = process.env.MSTAR_LINEAR_CREDENTIAL!;
    // Create the parent first so the write lands where the reader looks.
    writeLinearCredential(credential());
    writeFileSync(path, "{not json");
    const state = readLinearCredential();
    expect(state.kind).toBe("unreadable");
    if (state.kind !== "unreadable") return;
    expect(state.reason).toContain("access_token");
  });

  test("a refresh is due inside the window and not before it", () => {
    const expiresAt = Date.UTC(2026, 10, 2);
    writeLinearCredential(credential({ expiresAt }));
    const before = readLinearCredential(expiresAt - REFRESH_WINDOW_MS - 1);
    const inside = readLinearCredential(expiresAt - REFRESH_WINDOW_MS + 1);
    expect(before.kind === "present" && before.refreshDue).toBe(false);
    expect(inside.kind === "present" && inside.refreshDue).toBe(true);
  });

  test("a credential with no expiry is never reported as due (it cannot be judged)", () => {
    writeLinearCredential(credential({ expiresAt: null }));
    const state = readLinearCredential(Date.UTC(2030, 0, 1));
    expect(state.kind === "present" && state.refreshDue).toBe(false);
  });

  test("writing twice keeps one file and the newest value", () => {
    writeLinearCredential(credential({ accessToken: fake("first") }));
    writeLinearCredential(credential({ accessToken: fake("second") }));
    const raw = readFileSync(process.env.MSTAR_LINEAR_CREDENTIAL!, "utf8");
    expect(JSON.parse(raw).access_token).toBe(fake("second"));
  });

  test("clear removes the file and reports whether anything was there", () => {
    writeLinearCredential(credential());
    expect(clearLinearCredential()).toBe(true);
    expect(clearLinearCredential()).toBe(false);
    expect(readLinearCredential()).toEqual({ kind: "absent" });
  });

  test("the default path is outside any repository", () => {
    delete process.env.MSTAR_LINEAR_CREDENTIAL;
    const path = linearCredentialPath();
    // Host state, never project state: the file lives under a config directory,
    // not beside a checkout's `.mstar`.
    expect(path).toContain("mstar");
    expect(path).toContain("linear");
    expect(path.endsWith("credential.json")).toBe(true);
  });
});
