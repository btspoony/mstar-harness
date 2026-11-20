/**
 * collaboration identity -- canonical Git origin to repository key, explicit
 * collaboration mode and user-level database path.
 *
 * Every case builds a synthetic checkout under the temp root; no case reads the
 * real user home or opens a database.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { CollaborationIdentityError, resolveCollaborationLocation } from "./collaboration-identity.js";
import { parseMstarc } from "./mstarc.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mstar-collab-identity-")));
const HOME = join(ROOT, "home");
mkdirSync(HOME);

afterAll(() => {
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

function resolveAt(root: string) {
  return resolveCollaborationLocation({ harnessDir: join(root, ".mstar"), checkoutRoot: root }, { userHome: HOME });
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

  test("resolution is side-effect free", () => {
    const location = resolveAt(makeRepo("https://github.com/acme/widgets.git", "[collaboration]\nmode=local\n"));
    expect(location.dbPath.startsWith(join(HOME, ".mstar", "repos"))).toBe(true);
    expect(existsSync(join(HOME, ".mstar"))).toBe(false);
  });

  test("parseMstarc keeps the collaboration section", () => {
    const config = parseMstarc("[collaboration]\nmode=mirror\nrepo_id=team-repo\n\n[config]\nenforcement=hard\n");
    expect(config.collaboration).toEqual({ mode: "mirror", repoId: "team-repo" });
    expect(config.enforcement).toBe("hard");
    expect(parseMstarc("[collaboration]\nmode=local\n").collaboration).toEqual({ mode: "local" });
  });
});
