import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearLinearCredential,
  commitLinearCredential,
  linearCredentialPath,
  readLinearCredential,
  REFRESH_WINDOW_MS,
  supersededBy,
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

  test("a failed rename removes its temp copy instead of leaving a second credential", () => {
    // A first write lands, then the rename is made to fail the way an unusual
    // mount does (EXDEV) — after the temp file is a complete, valid copy of the
    // token. `clearLinearCredential` only knows the real path, so a leftover
    // `.tmp` would survive sign-out with a live bearer in it.
    const path = writeLinearCredential(credential({ accessToken: fake("first") }));
    const dir = join(root, "nested");
    const tempNames = () => readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    expect(tempNames()).toEqual([]);

    // A non-empty DIRECTORY at the credential path: the rename cannot replace
    // it, which is the failure this test is about (a file already occupies the
    // temp name below, so nothing else can be blamed).
    const blocked = join(dir, "blocked");
    mkdirSync(blocked);
    writeFileSync(join(blocked, "held"), "");
    process.env.MSTAR_LINEAR_CREDENTIAL = blocked;
    expect(() => writeLinearCredential(credential({ accessToken: fake("second") }))).toThrow();
    // The temp copy is gone; only the directory this test created remains.
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    // The previous credential is untouched, as the function promises.
    process.env.MSTAR_LINEAR_CREDENTIAL = path;
    const state = readLinearCredential(Date.UTC(2026, 10, 1));
    expect(state.kind === "present" && state.credential.accessToken).toBe(fake("first"));
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

describe("a superseded refresh never overwrites newer intent", () => {
  /** The credential a refresh attempt started from, read before its round trip. */
  function baseCredential() {
    const state = readLinearCredential();
    if (state.kind !== "present") throw new Error(`fixture is not present: ${state.kind}`);
    return state.credential;
  }

  test("a newer grant stored during the round trip is adopted, not replaced", () => {
    writeLinearCredential(credential({ accessToken: fake("base") }));
    const base = baseCredential();
    // `mstar linear auth` in another process re-authorized while this attempt
    // waited on the provider: a later lineage than the one it started from.
    writeLinearCredential(credential({ accessToken: fake("reauthorized"), expiresAt: Date.UTC(2026, 10, 3) }));

    // The lineage guard is what makes that change win; the commit seam only
    // re-reads the file before writing.
    expect(supersededBy(readLinearCredential(), base)).toBe(true);
    const written = commitLinearCredential((state) =>
      supersededBy(state, base) ? null : credential({ accessToken: fake("ours") }),
    );

    expect(written).toBeNull();
    const state = readLinearCredential();
    expect(state.kind === "present" && state.credential.accessToken).toBe(fake("reauthorized"));
  });

  test("a sign-out during the round trip is not undone", () => {
    writeLinearCredential(credential({ accessToken: fake("base") }));
    const base = baseCredential();
    // `mstar linear logout` removes the file mid-refresh.
    expect(clearLinearCredential()).toBe(true);

    expect(supersededBy(readLinearCredential(), base)).toBe(true);
    const written = commitLinearCredential((state) =>
      supersededBy(state, base) ? null : credential({ accessToken: fake("ours") }),
    );

    expect(written).toBeNull();
    expect(readLinearCredential()).toEqual({ kind: "absent" });
  });

  test("an unchanged file still accepts the refresh", () => {
    // The control: a guard that always declined would pass both tests above
    // while breaking every ordinary refresh.
    writeLinearCredential(credential({ accessToken: fake("base") }));
    const base = baseCredential();
    const written = commitLinearCredential((state) =>
      supersededBy(state, base) ? null : credential({ accessToken: fake("rotated") }),
    );

    expect(written).toBe(process.env.MSTAR_LINEAR_CREDENTIAL!);
    const state = readLinearCredential();
    expect(state.kind === "present" && state.credential.accessToken).toBe(fake("rotated"));
    expect(state.kind === "present" && state.credential.refreshToken).toBe(fake("refresh"));
  });

  test("a throwing decision writes nothing and leaves the previous credential", () => {
    writeLinearCredential(credential({ accessToken: fake("base") }));
    expect(() =>
      commitLinearCredential(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const state = readLinearCredential();
    expect(state.kind === "present" && state.credential.accessToken).toBe(fake("base"));
  });
});
