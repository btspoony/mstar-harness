/**
 * collaboration identity -- canonical Git origin to repository key, explicit
 * collaboration mode and user-level database path.
 *
 * Every case builds a synthetic checkout under the temp root; no case reads the
 * real user home or opens a database.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { CollaborationIdentityError, resolveCollaborationLocation } from "./collaboration-identity.js";
import { initializeCollaborationStore, openCollaborationStore } from "./collaboration-store.js";
import { parseMstarc } from "./mstarc.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mstar-collab-identity-")));
const HOME = join(ROOT, "home");
mkdirSync(HOME);

let homeSpy: { mockRestore(): void } | undefined;

beforeAll(() => {
  // The store entry points keep their locked signatures (no userHome option),
  // so the isolated home is installed at the runtime boundary they call.
  homeSpy = spyOn(nodeOs, "homedir").mockReturnValue(HOME);
});

afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(ROOT, { recursive: true, force: true });
});

let sequence = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo(origin?: string | readonly string[], mstarc?: string): string {
  const dir = join(ROOT, `repo-${sequence++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Collaboration Identity Test");
  git(dir, "config", "user.email", "identity@example.test");
  if (origin !== undefined) {
    for (const url of typeof origin === "string" ? [origin] : origin) git(dir, "config", "--add", "remote.origin.url", url);
  }
  if (mstarc !== undefined) writeFileSync(join(dir, ".mstarc"), mstarc);
  return dir;
}

function contextAt(root: string) {
  return { harnessDir: join(root, ".mstar"), checkoutRoot: root };
}

function resolveAt(root: string) {
  return resolveCollaborationLocation(contextAt(root), { userHome: HOME });
}

/** Flip a staged record to active: this plan ships no public activator. */
function activateStaged(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare("update collaboration_meta set authority_state = 'active', activated_at = ? where id = 1").run(
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
}

function refusal(run: () => unknown): { code: string; message: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof CollaborationIdentityError) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error("expected a collaboration identity refusal");
}

describe("collaboration identity", () => {
  test("equivalent ssh scp https and default-port origins resolve to one repository", () => {
    const spellings = [
      "https://github.com/Octocat/Hello-World.git",
      "https://github.com/Octocat/Hello-World",
      "https://github.com:443/Octocat/Hello-World.git/",
      "git@github.com:Octocat/Hello-World.git",
      "ssh://git@github.com/Octocat/Hello-World.git",
      "ssh://git@github.com:22/Octocat/Hello-World",
      "http://github.com:80/Octocat/Hello-World.git",
    ];
    const locations = spellings.map((origin) => resolveAt(makeRepo(origin, "[collaboration]\nmode=local\n")));
    for (const location of locations) {
      expect(location.repoKey).toBe("github.com/octocat/hello-world");
      expect(location.mode).toBe("local");
      expect(location.dbPath).toBe(join(HOME, ".mstar", "repos", "github.com", "octocat", "hello-world", "collaboration.db"));
    }
  });

  test("nondefault port host fork and path case stay isolated", () => {
    const port = resolveAt(makeRepo("ssh://git@git.example.com:2222/team/repo.git", "[collaboration]\nmode=local\n"));
    const noPort = resolveAt(makeRepo("ssh://git@git.example.com/team/repo.git", "[collaboration]\nmode=local\n"));
    const otherHost = resolveAt(makeRepo("https://gitlab.example.com/team/repo.git", "[collaboration]\nmode=local\n"));
    const fork = resolveAt(makeRepo("https://git.example.com/fork/repo.git", "[collaboration]\nmode=local\n"));
    const upper = resolveAt(makeRepo("https://git.example.com/Team/Repo.git", "[collaboration]\nmode=local\n"));

    expect(port.repoKey).toContain("git.example.com~2222");
    for (const location of [noPort, otherHost, fork, upper]) {
      expect(location.repoKey).not.toBe(port.repoKey);
      expect(location.dbPath).not.toBe(port.dbPath);
    }
    expect(new Set([noPort.dbPath, otherHost.dbPath, fork.dbPath]).size).toBe(3);
  });

  test("nested owner segments are preserved", () => {
    const location = resolveAt(makeRepo("https://gitlab.example.com/group/sub/repo.git", "[collaboration]\nmode=mirror\n"));
    expect(location.repoKey).toBe("gitlab.example.com/group/sub/repo");
    expect(location.dbPath).toBe(
      join(HOME, ".mstar", "repos", "gitlab.example.com", "group", "sub", "repo", "collaboration.db"),
    );
    expect(location.mode).toBe("mirror");
  });

  test("filesystem keys stay case-safe on case-insensitive filesystems", () => {
    const upper = resolveAt(makeRepo("https://git.example.com/Team/Repo.git", "[collaboration]\nmode=local\n"));
    const lower = resolveAt(makeRepo("https://git.example.com/team/repo.git", "[collaboration]\nmode=local\n"));
    expect(upper.repoKey).toBe("git.example.com/Team/Repo");
    expect(lower.repoKey).toBe("git.example.com/team/repo");
    expect(upper.dbPath).not.toBe(lower.dbPath);
    const relative = upper.dbPath.slice(join(HOME, ".mstar", "repos").length);
    expect(relative).not.toMatch(/[A-Z]/);
  });

  test("a linked worktree reads the main checkout config and origin", () => {
    // `.mstarc` stays untracked so the linked worktree has none of its own.
    const main = makeRepo("git@github.com:acme/widgets.git", "[collaboration]\nmode=mirror\n");
    git(main, "commit", "-qm", "empty", "--allow-empty");
    const worktree = join(ROOT, `worktree-${sequence++}`);
    git(main, "worktree", "add", worktree, "-b", `side-${sequence}`);
    expect(existsSync(join(worktree, ".mstarc"))).toBe(false);

    const location = resolveAt(worktree);
    expect(location.repoKey).toBe("github.com/acme/widgets");
    expect(location.mode).toBe("mirror");
    expect(location.dbPath).toBe(resolveAt(main).dbPath);
  });

  test("an origin-less repository needs an explicit repo id", () => {
    const missing = refusal(() => resolveAt(makeRepo(undefined, "[collaboration]\nmode=local\n")));
    expect(missing.code).toBe("collaboration.repo-identity-unresolved");
    expect(missing.message).toContain("repo_id");

    const location = resolveAt(makeRepo(undefined, "[collaboration]\nmode=local\nrepo_id=team-repo\n"));
    expect(location.repoKey).toBe("id:team-repo");
    expect(location.dbPath).toBe(join(HOME, ".mstar", "repos", "_id", "team-repo", "collaboration.db"));
  });

  test("a valid origin takes precedence over a valid repo id", () => {
    const location = resolveAt(makeRepo("https://github.com/acme/widgets.git", "[collaboration]\nmode=local\nrepo_id=other\n"));
    expect(location.repoKey).toBe("github.com/acme/widgets");
  });

  test("unsafe origins and ids are named refusals", () => {
    const unsafe = [
      "https://github.com/acme/widgets.git?ref=main",
      "https://github.com/acme/widgets.git#readme",
      "https://github.com/acme%2Fwidgets/nested.git",
      "/local/path/to/repo",
      "file:///local/path/to/repo",
      "https://github.com/onlyone",
    ];
    for (const origin of unsafe) {
      const result = refusal(() => resolveAt(makeRepo(origin, "[collaboration]\nmode=local\n")));
      expect(result.code).toBe("collaboration.repo-identity-unresolved");
    }

    // A present but invalid origin never masquerades as an origin-less checkout.
    const withId = refusal(() => resolveAt(makeRepo("/local/path/to/repo", "[collaboration]\nmode=local\nrepo_id=team-repo\n")));
    expect(withId.code).toBe("collaboration.repo-identity-unresolved");

    for (const repoId of ["Team_Repo", "-leading", "a/b", "x".repeat(129)]) {
      const result = refusal(() => resolveAt(makeRepo(undefined, `[collaboration]\nmode=local\nrepo_id=${repoId}\n`)));
      expect(result.code).toBe("collaboration.repo-identity-unresolved");
      expect(result.message).toContain("repo_id");
    }
  });

  test("credentials are never emitted", () => {
    const location = resolveAt(makeRepo("https://user:secret-token@github.com/acme/widgets.git", "[collaboration]\nmode=local\n"));
    expect(location.repoKey).toBe("github.com/acme/widgets");
    expect(location.dbPath).not.toContain("secret-token");
    expect(location.dbPath).not.toContain("user");
  });

  test("ambiguous and unreadable git are refusals", () => {
    const ambiguous = refusal(() =>
      resolveAt(
        makeRepo(["https://github.com/acme/widgets.git", "https://github.com/acme/other.git"], "[collaboration]\nmode=local\n"),
      ),
    );
    expect(ambiguous.code).toBe("collaboration.repo-identity-unresolved");
    expect(ambiguous.message.toLowerCase()).toContain("origin");

    const broken = join(ROOT, `broken-${sequence++}`);
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, ".git"), "garbage\n");
    const unreadable = refusal(() => resolveAt(broken));
    expect(unreadable.code).toBe("collaboration.repo-identity-unresolved");

    const plain = join(ROOT, `plain-${sequence++}`);
    mkdirSync(plain, { recursive: true });
    expect(refusal(() => resolveAt(plain)).code).toBe("collaboration.repo-identity-unresolved");
  });

  test("missing invalid and remote modes refuse while local and mirror are accepted", () => {
    const origin = "https://github.com/acme/widgets.git";
    const absent = refusal(() => resolveAt(makeRepo(origin)));
    expect(absent.code).toBe("collaboration.mode-required");
    expect(absent.message).toContain("mode");

    const empty = refusal(() => resolveAt(makeRepo(origin, "[collaboration]\n")));
    expect(empty.code).toBe("collaboration.mode-required");

    const invalid = refusal(() => resolveAt(makeRepo(origin, "[collaboration]\nmode=server\n")));
    expect(invalid.code).toBe("collaboration.mode-invalid");

    const remote = refusal(() => resolveAt(makeRepo(origin, "[collaboration]\nmode=remote\n")));
    expect(remote.code).toBe("collaboration.mode-unavailable");

    expect(resolveAt(makeRepo(origin, "[collaboration]\nmode=local\n")).mode).toBe("local");
    expect(resolveAt(makeRepo(origin, "[collaboration]\nmode=mirror\n")).mode).toBe("mirror");
  });

  test("scp hosts must be safe DNS names and leave the port delimiter to URLs", () => {
    for (const origin of ["git@..:team/repo.git", "git@team..:repo.git", "git@git.example.com~2222:team/repo.git"]) {
      const result = refusal(() => resolveAt(makeRepo(origin, "[collaboration]\nmode=local\n")));
      expect(result.code).toBe("collaboration.repo-identity-unresolved");
    }
    // DNS terminal-dot spelling is the same host, not a second namespace.
    const dotted = resolveAt(makeRepo("git@Git.Example.com.:team/repo.git", "[collaboration]\nmode=local\n"));
    expect(dotted.repoKey).toBe("git.example.com/team/repo");
    // Only a URL port may qualify a host.
    const ported = resolveAt(makeRepo("ssh://git@git.example.com:2222/team/repo.git", "[collaboration]\nmode=local\n"));
    expect(ported.repoKey).toBe("git.example.com~2222/team/repo");
  });

  test("dot segments are refused before URL normalization", () => {
    for (const origin of [
      "https://git.example.com/a/../team/repo.git",
      "https://git.example.com/a/%2e%2e/team/repo.git",
      "https://git.example.com/%2E/team/repo.git",
      "git@git.example.com:a/../team/repo.git",
      // A backslash is a URL path separator, so it must not hide `..` from the
      // raw check; this one used to resolve to git.example.com/team/repo.
      "https://git.example.com/a\\..\\team/repo.git",
      "https://git.example.com\\..\\team/repo.git",
    ]) {
      const result = refusal(() => resolveAt(makeRepo(origin, "[collaboration]\nmode=local\n")));
      expect(result.code).toBe("collaboration.repo-identity-unresolved");
    }
    // A dot inside a name is not a dot segment.
    const dotted = resolveAt(makeRepo("https://git.example.com/team/my.repo.git", "[collaboration]\nmode=local\n"));
    expect(dotted.repoKey).toBe("git.example.com/team/my.repo");
  });

  test("a configured empty origin is refused, never treated as origin-less", () => {
    const blank = makeRepo(undefined, "[collaboration]\nmode=local\n");
    git(blank, "config", "remote.origin.url", "");
    const empty = refusal(() => resolveAt(blank));
    expect(empty.code).toBe("collaboration.repo-identity-unresolved");
    expect(empty.message.toLowerCase()).toContain("empty");

    const blankWithId = makeRepo(undefined, "[collaboration]\nmode=local\nrepo_id=team-repo\n");
    git(blankWithId, "config", "remote.origin.url", "");
    expect(refusal(() => resolveAt(blankWithId)).code).toBe("collaboration.repo-identity-unresolved");

    const mixed = makeRepo(["https://github.com/acme/widgets.git", ""], "[collaboration]\nmode=local\n");
    expect(refusal(() => resolveAt(mixed)).code).toBe("collaboration.repo-identity-unresolved");
  });

  test("a repeated collaboration key is authoritative at its last occurrence", () => {
    const origin = "https://github.com/acme/widgets.git";
    const clearedMode = refusal(() => resolveAt(makeRepo(origin, "[collaboration]\nmode=local\nmode=\n")));
    expect(clearedMode.code).toBe("collaboration.mode-required");
    expect(resolveAt(makeRepo(origin, "[collaboration]\nmode=local\nmode=mirror\n")).mode).toBe("mirror");

    const clearedId = refusal(() =>
      resolveAt(makeRepo(undefined, "[collaboration]\nmode=local\nrepo_id=team-repo\nrepo_id=\n")),
    );
    expect(clearedId.code).toBe("collaboration.repo-identity-unresolved");
    expect(clearedId.message).toContain("repo_id");
    const last = resolveAt(makeRepo(undefined, "[collaboration]\nmode=local\nrepo_id=first\nrepo_id=second\n"));
    expect(last.repoKey).toBe("id:second");
  });

  test("an unreadable configuration is a named diagnostic, not a missing mode", () => {
    const repo = makeRepo("https://github.com/acme/widgets.git");
    mkdirSync(join(repo, ".mstarc"));
    const result = refusal(() => resolveAt(repo));
    expect(result.code).toBe("collaboration.config-unreadable");
    expect(result.message).toContain(join(repo, ".mstarc"));
    expect(result.message).toContain("remove");

    // A dangling symlink is a present but unreadable entry, never "absent".
    const dangling = makeRepo("https://github.com/acme/widgets.git");
    symlinkSync(join(dangling, "missing-config"), join(dangling, ".mstarc"));
    const danglingResult = refusal(() => resolveAt(dangling));
    expect(danglingResult.code).toBe("collaboration.config-unreadable");
    expect(danglingResult.message).toContain("symbolic link");

    // A symlink is refused even when its target is readable: the file that
    // supplies trusted selection must be the tracked file itself.
    const linked = makeRepo("https://github.com/acme/widgets.git");
    writeFileSync(join(linked, "real-config"), "[collaboration]\nmode=local\n");
    symlinkSync(join(linked, "real-config"), join(linked, ".mstarc"));
    expect(refusal(() => resolveAt(linked)).code).toBe("collaboration.config-unreadable");

    // A genuinely absent file keeps its own missing-mode refusal.
    const absent = makeRepo("https://github.com/acme/widgets.git");
    expect(refusal(() => resolveAt(absent)).code).toBe("collaboration.mode-required");
  });

  test("reserved authority basenames cannot occupy a repository directory", async () => {
    const nested = "https://git.example.com/order-one/a/collaboration.db/b.git";
    const parent = "https://git.example.com/order-one/a.git";
    const nestedFirst = "https://git.example.com/order-two/a/collaboration.db/b.git";
    const parentSecond = "https://git.example.com/order-two/a.git";
    const mstarc = "[collaboration]\nmode=local\n";
    const parentRepo = makeRepo(parent, mstarc);
    const nestedRepo = makeRepo(nested, mstarc);
    const nestedFirstRepo = makeRepo(nestedFirst, mstarc);
    const parentSecondRepo = makeRepo(parentSecond, mstarc);

    // Database file first, then the repository whose directory used to spell it.
    await initializeCollaborationStore(resolveAt(parentRepo));
    await initializeCollaborationStore(resolveAt(nestedRepo));
    // Reverse creation order.
    await initializeCollaborationStore(resolveAt(nestedFirstRepo));
    await initializeCollaborationStore(resolveAt(parentSecondRepo));

    const nestedLocation = resolveAt(nestedRepo);
    expect(nestedLocation.repoKey).toBe("git.example.com/order-one/a/collaboration.db/b");
    expect(nestedLocation.dbPath).toBe(
      join(HOME, ".mstar", "repos", "git.example.com", "order-one", "a", "%63ollaboration.db", "b", "collaboration.db"),
    );

    for (const repo of [parentRepo, nestedRepo, nestedFirstRepo, parentSecondRepo]) {
      activateStaged(resolveAt(repo).dbPath);
      const handle = await openCollaborationStore(contextAt(repo), "read");
      expect(handle.authority.state).toBe("active");
      handle.close();
    }
  });

  test("raw query fragment and control characters are refused before normalization", () => {
    for (const origin of [
      "https://github.com/acme/widgets.git?",
      "https://github.com/acme/widgets.git#",
      "https://github.com/acme/widgets.git\u0001",
      "https://github.com/acme/te\tam/repo.git",
    ]) {
      const result = refusal(() => resolveAt(makeRepo(origin, "[collaboration]\nmode=local\n")));
      expect(result.code).toBe("collaboration.repo-identity-unresolved");
    }
  });

  test("an invalid mode never echoes the submitted value", () => {
    const secret = "synthetic-secret-9f3a";
    const result = refusal(() =>
      resolveAt(makeRepo("https://github.com/acme/widgets.git", `[collaboration]\nmode=${secret}\n`)),
    );
    expect(result.code).toBe("collaboration.mode-invalid");
    expect(result.message).toContain("mode");
    expect(result.message).toContain("mode=local");
    expect(result.message).not.toContain(secret);
  });

  test("resolution is side-effect free", () => {
    const untouched = join(ROOT, `untouched-home-${sequence++}`);
    mkdirSync(untouched);
    const location = resolveCollaborationLocation(
      contextAt(makeRepo("https://github.com/acme/widgets.git", "[collaboration]\nmode=local\n")),
      { userHome: untouched },
    );
    expect(location.dbPath.startsWith(join(untouched, ".mstar", "repos"))).toBe(true);
    expect(existsSync(join(untouched, ".mstar"))).toBe(false);
  });

  test("parseMstarc keeps the collaboration section", () => {
    const config = parseMstarc("[collaboration]\nmode=mirror\nrepo_id=team-repo\n\n[config]\nenforcement=hard\n");
    expect(config.collaboration).toEqual({ mode: "mirror", repoId: "team-repo" });
    expect(config.enforcement).toBe("hard");
    expect(parseMstarc("[collaboration]\nmode=local\n").collaboration).toEqual({ mode: "local" });
    // The last occurrence wins, an explicit empty later value included.
    expect(parseMstarc("[collaboration]\nmode=local\nmode=\n").collaboration).toEqual({ mode: "" });
    expect(parseMstarc("[collaboration]\nmode=local\nmode=mirror\n").collaboration).toEqual({ mode: "mirror" });
    expect(parseMstarc("[collaboration]\nrepo_id=first\nrepo_id=second\n").collaboration).toEqual({ repoId: "second" });
  });
});
