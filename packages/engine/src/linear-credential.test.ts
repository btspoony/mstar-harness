import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearLinearCredential,
  commitLinearCredential,
  linearCredentialLockPath,
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
 * A pid no process holds: spawn a short-lived child and wait for it to exit, so
 * its pid is real and definitely gone. A fixed literal could collide with a
 * live process on a busy machine, which would make the stale takeover test lie.
 */
const DEAD_PID = ((): number => {
  const probe = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  if (probe.pid === undefined) throw new Error("could not obtain a dead pid fixture");
  return probe.pid;
})();

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

describe("the commit is one cross-process critical section", () => {
  /** Busy-wait the exact milliseconds a real unlink needs to find its window. */
  function holdFor(ms: number): void {
    const until = Date.now() + ms;
    while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }

  /**
   * A second process runs the real `mstar linear logout`: its own module
   * instance and its own `clearLinearCredential`, against this credential path.
   * It announces itself immediately before attempting the delete.
   */
  function logoutInAnotherProcess(ready: string): Promise<string> {
    const moduleUrl = new URL("./linear-credential.ts", import.meta.url).href;
    const source = `
      const { writeFileSync } = await import("node:fs");
      const { clearLinearCredential } = await import(process.env.MSTAR_IMPORT);
      writeFileSync(process.env.MSTAR_LOGOUT_READY, "");
      process.stdout.write(JSON.stringify(clearLinearCredential()));
    `;
    const child = spawn(process.execPath, ["-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MSTAR_IMPORT: moduleUrl, MSTAR_LOGOUT_READY: ready },
    });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    return new Promise<string>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`logout exit ${code}: ${out}`))));
    });
  }

  test("a logout landing between the final read and the commit leaves the file absent", async () => {
    writeLinearCredential(credential());
    const ready = join(root, "logout-ready");
    // The decision callback runs AFTER the re-read and BEFORE the rename — the
    // exact instant this finding names. This is where the sign-out lands.
    let logout!: Promise<string>;
    const written = commitLinearCredential((state) => {
      expect(state.kind).toBe("present");
      logout = logoutInAnotherProcess(ready);
      // Wait until the other process is at the unlink, then hold: a writer
      // sharing no lock with it would see the delete land in this gap.
      for (let waited = 0; !existsSync(ready) && waited < 5_000; waited += 5) holdFor(5);
      holdFor(200);
      return credential({ accessToken: fake("ours") });
    });
    expect(JSON.parse(await logout)).toBe(true);

    // Deletion is the newest intent. The lock only orders the two writes; it
    // must never let this refresh's grant outlive the delete.
    expect(written).not.toBeNull();
    expect(readLinearCredential()).toEqual({ kind: "absent" });
    expect(existsSync(process.env.MSTAR_LINEAR_CREDENTIAL!)).toBe(false);
  });

  test("a lock that is there but cannot be read fails with its path instead of spinning", async () => {
    writeLinearCredential(credential());
    const lock = linearCredentialLockPath();
    // The lock is present and every read of it fails (EISDIR). Before the fix
    // every read error meant "not there", so the acquisition loop retried its
    // `wx` forever at full CPU with no message and no way out.
    mkdirSync(lock);
    const moduleUrl = new URL("./linear-credential.ts", import.meta.url).href;
    const source = `
      const { commitLinearCredential } = await import(process.env.MSTAR_IMPORT);
      try {
        commitLinearCredential(() => null);
        process.stdout.write("RESOLVED");
      } catch (error) {
        process.stdout.write(String(error && error.message) + "\\\\n" + String(error.cause && error.cause.code));
      }
    `;
    const child = spawn(process.execPath, ["-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MSTAR_IMPORT: moduleUrl },
    });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    const started = Date.now();
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    clearTimeout(timer);

    // Pre-fix the child never reaches either branch: it is still polling.
    expect(code === null ? "killed after the timeout" : out).toContain("cannot read the Linear credential lock");
    expect(out).toContain(lock);
    expect(out).toContain("EISDIR");
    expect(out).not.toContain("RESOLVED");
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 15_000);

  test("a lock left by a dead process is taken over instead of blocking forever", () => {
    writeLinearCredential(credential());
    const lock = linearCredentialLockPath();
    writeFileSync(lock, "");
    // Backdate it past the stale bound: the holder is presumed dead.
    utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    expect(commitLinearCredential(() => credential({ accessToken: fake("after-crash") }))).not.toBeNull();
    expect(existsSync(lock)).toBe(false);
  });

  /**
   * A writer in ANOTHER process: its own module instance, its own lock.
   *
   * Inside the critical section it appends `enter`/`exit` to a shared journal
   * and, when `guard` is given, creates a guard file with `wx`: a second writer
   * reaching that line records `overlap`, which is the observable "two inside
   * the one section" failure. It can gate its start (`go`) and hold its section
   * until a `release` file appears, so the parent drives the interleaving
   * instead of guessing sleeps.
   */
  function writerInAnotherProcess(options: {
    journal: string;
    holdMs: number;
    guard?: string;
    go?: string;
    release?: string;
    rounds?: number;
  }): Promise<string> {
    const moduleUrl = new URL("./linear-credential.ts", import.meta.url).href;
    const source = `
      const { existsSync, unlinkSync, writeFileSync, appendFileSync } = await import("node:fs");
      const { withLinearCredentialLock } = await import(process.env.MSTAR_IMPORT);
      const journal = (line) => appendFileSync(process.env.MSTAR_JOURNAL, line + "\\n");
      const spin = (ms) => {
        const until = Date.now() + ms;
        while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      };
      if (process.env.MSTAR_GO) while (!existsSync(process.env.MSTAR_GO)) spin(2);
      for (let round = 0; round < Number(process.env.MSTAR_ROUNDS); round += 1) {
        withLinearCredentialLock(() => {
          const guard = process.env.MSTAR_GUARD;
          if (guard) {
            try {
              writeFileSync(guard, String(process.pid), { flag: "wx" });
            } catch {
              journal("overlap " + process.pid);
            }
          }
          journal("enter " + process.pid);
          if (process.env.MSTAR_RELEASE) {
            const until = Date.now() + 10_000;
            while (!existsSync(process.env.MSTAR_RELEASE) && Date.now() < until) spin(2);
          }
          spin(Number(process.env.MSTAR_HOLD_MS));
          journal("exit " + process.pid);
          if (guard && existsSync(guard)) unlinkSync(guard);
        });
      }
      process.stdout.write("done");
    `;
    const child = spawn(process.execPath, ["-e", source], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MSTAR_IMPORT: moduleUrl,
        MSTAR_JOURNAL: options.journal,
        MSTAR_GUARD: options.guard ?? "",
        MSTAR_GO: options.go ?? "",
        MSTAR_RELEASE: options.release ?? "",
        MSTAR_HOLD_MS: String(options.holdMs),
        MSTAR_ROUNDS: String(options.rounds ?? 1),
      },
    });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    return new Promise<string>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`writer exit ${code}: ${out}`))));
    });
  }

  /** Wait for a path to appear, failing the test rather than hanging. */
  function awaitPath(path: string): void {
    for (let waited = 0; !existsSync(path); waited += 5) {
      if (waited > 5_000) throw new Error(`timed out waiting for ${path}`);
      holdFor(5);
    }
  }

  test("two processes racing to take over one stale lock are never inside together", async () => {
    writeLinearCredential(credential());
    const lock = linearCredentialLockPath();
    // Every trial starts from a fresh stale lock — the one a crashed writer
    // left: an age past the bound and a pid no process holds — and releases both
    // writers at the same instant, so their takeovers of that one lock overlap.
    // A single overlap is the cascade: pre-fix the compare and the `rmSync` were
    // two statements, so the loser of the `wx` race deleted the winner's fresh
    // lock and both entered the "one" section. That window is microseconds wide,
    // which is why this runs many trials rather than one: the pre-fix rate here
    // is roughly one trial in six, so the fixture fails reliably on broken code.
    const trials = 25;
    const overlaps: string[] = [];
    for (let trial = 0; trial < trials; trial += 1) {
      const journal = join(root, `journal-${trial}`);
      const guard = join(root, `guard-${trial}`);
      const go = join(root, `go-${trial}`);
      writeFileSync(lock, JSON.stringify({ pid: DEAD_PID, token: `stale-${trial}` }));
      utimesSync(lock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
      const writers = [1, 2].map(() => writerInAnotherProcess({ journal, go, guard, holdMs: 20 }));
      writeFileSync(go, "");
      expect(await Promise.all(writers)).toEqual(["done", "done"]);

      const lines = readFileSync(journal, "utf8").trim().split("\n");
      overlaps.push(...lines.filter((line) => line.startsWith("overlap")));
      // Both got in: the stale lock was taken over, and no takeover cascaded the
      // mutex away from the second writer.
      expect(lines.filter((line) => line.startsWith("enter"))).toHaveLength(2);
      expect(lines.filter((line) => line.startsWith("exit"))).toHaveLength(2);
      expect(existsSync(guard)).toBe(false);
      expect(existsSync(lock)).toBe(false);
    }
    // Neither writer was ever inside the "one" section with the other.
    expect(overlaps).toEqual([]);
    // A takeover moves the observed lock aside before dropping it; a claim that
    // is never cleaned up would leave its scratch file beside the lock.
    expect(readdirSync(dirname(lock)).filter((name) => name.endsWith(".takeover"))).toEqual([]);
  });

  test("a live holder stalled past the stale bound is not taken over", async () => {
    writeLinearCredential(credential());
    const lock = linearCredentialLockPath();
    const journal = join(root, "journal");
    const guard = join(root, "guard");
    const holderRelease = join(root, "holder-release");

    // A is a real holder inside the section, and stays there until released.
    const holder = writerInAnotherProcess({ journal, guard, release: holderRelease, holdMs: 0 });
    awaitPath(guard);
    const lockOfHolder = readFileSync(lock, "utf8");
    // A laptop sleep or SIGSTOP from a waiter's point of view: the lock is old,
    // but the pid stamped in it is still running.
    utimesSync(lock, new Date(Date.now() - 6_000), new Date(Date.now() - 6_000));

    // The waiter polls the stale-looking lock. It must not displace a live
    // holder, so after a few hundred polls it is still outside the section.
    const waiter = writerInAnotherProcess({ journal, guard, holdMs: 0 });
    holdFor(300);
    expect(readFileSync(lock, "utf8")).toBe(lockOfHolder);
    expect(readFileSync(journal, "utf8")).not.toContain("overlap");
    expect(readFileSync(journal, "utf8").trim().split("\n")).toHaveLength(1);

    writeFileSync(holderRelease, "");
    expect(await holder).toBe("done");
    expect(await waiter).toBe("done");

    const lines = readFileSync(journal, "utf8").trim().split("\n");
    // The waiter entered only after the live holder exited; pre-fix it deleted
    // the live holder's lock and ran beside it (recorded as `overlap`).
    expect(lines.filter((line) => line.startsWith("overlap"))).toEqual([]);
    expect(lines.filter((line) => line.startsWith("enter"))).toHaveLength(2);
    expect(lines.filter((line) => line.startsWith("exit"))).toHaveLength(2);
    expect(existsSync(lock)).toBe(false);
  });

  test("a woken holder releases only its own lock, never the one that replaced it", async () => {
    writeLinearCredential(credential());
    const lock = linearCredentialLockPath();
    const journal = join(root, "journal");
    const holderRelease = join(root, "holder-release");
    const successorRelease = join(root, "successor-release");

    // A is wedged: alive, inside its section, and its lock is far past the point
    // where waiting is still rational, so a successor may take over.
    const wedged = writerInAnotherProcess({ journal, release: holderRelease, holdMs: 0 });
    awaitPath(join(root, "journal"));
    for (let waited = 0; readFileSync(journal, "utf8") === "" && waited < 5_000; waited += 5) holdFor(5);
    const lockOfWedged = readFileSync(lock, "utf8");
    utimesSync(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));

    // The successor takes the wedged lock over and holds its own section.
    const successor = writerInAnotherProcess({ journal, release: successorRelease, holdMs: 0 });
    for (let waited = 0; waited < 5_000 && readFileSync(lock, "utf8") === lockOfWedged; waited += 5) holdFor(5);
    const lockOfSuccessor = readFileSync(lock, "utf8");
    expect(lockOfSuccessor).not.toBe(lockOfWedged);

    // The wedged holder now wakes and runs its `finally`. Pre-fix that removed
    // the file by path, which is the successor's lock: a third writer would walk
    // straight into a section the successor still holds.
    writeFileSync(holderRelease, "");
    expect(await wedged).toBe("done");
    expect(readFileSync(lock, "utf8")).toBe(lockOfSuccessor);

    writeFileSync(successorRelease, "");
    expect(await successor).toBe("done");
    expect(existsSync(lock)).toBe(false);
  });

  test("every exit path releases the lock", () => {
    writeLinearCredential(credential());
    const lock = linearCredentialLockPath();
    // A throwing decision must not leave the mutex behind for the next writer.
    expect(() => commitLinearCredential(() => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(lock)).toBe(false);
    expect(clearLinearCredential()).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });
});
