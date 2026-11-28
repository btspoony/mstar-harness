import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { CollaborationIdentityError, resolveCollaborationLocation } from "./collaboration-identity.js";
import {
  assertControlCheckoutScope,
  initializeCollaborationStore,
  openCollaborationStore,
  readCollaborationBinding,
} from "./collaboration-store.js";
import { parseMstarc } from "./mstarc.js";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mstar-collab-identity-")));
const HOME = join(ROOT, "home");
mkdirSync(HOME);

let homeSpy: { mockRestore(): void } | undefined;

beforeAll(() => {
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

const EMPTY_ORIGIN = join(ROOT, `empty-origin-${sequence++}.git`);
git(ROOT, "init", "-q", "--bare", EMPTY_ORIGIN);

function makeRepo(origin?: string | readonly string[], mstarc?: string, routed = true): string {
  const dir = join(ROOT, `repo-${sequence++}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Collaboration Identity Test");
  git(dir, "config", "user.email", "identity@example.test");
  if (origin !== undefined) {
    for (const url of typeof origin === "string" ? [origin] : origin) {
      git(dir, "config", "--add", "remote.origin.url", url);
      if (routed) git(dir, "config", `url.${EMPTY_ORIGIN}.insteadOf`, url);
    }
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

  test("an absent mode defaults to local while empty, invalid and remote selections are checked", () => {
    const origin = "https://github.com/acme/widgets.git";
    const absent = resolveAt(makeRepo(origin));
    expect(absent.mode).toBe("local");
    expect(absent.dbPath).toBe(join(HOME, ".mstar", "repos", "github.com", "acme", "widgets", "collaboration.db"));
    expect(resolveAt(makeRepo(origin, "[collaboration]\n")).mode).toBe("local");

    const empty = refusal(() => resolveAt(makeRepo(origin, "[collaboration]\nmode=\n")));
    expect(empty.code).toBe("collaboration.mode-required");

    const invalid = refusal(() => resolveAt(makeRepo(origin, "[collaboration]\nmode=server\n")));
    expect(invalid.code).toBe("collaboration.mode-invalid");

    const unreachable = refusal(() =>
      resolveAt(makeRepo("ssh://git@127.0.0.1:1/acme/widgets.git", "[collaboration]\nmode=remote\n")),
    );
    expect(unreachable.code).toBe("remote.selector-unavailable");
    const originless = refusal(() => resolveAt(makeRepo(undefined, "[collaboration]\nmode=remote\nrepo_id=fixture\n")));
    expect(originless.code).toBe("remote.selector-unavailable");

    expect(resolveAt(makeRepo(origin, "[collaboration]\nmode=local\n")).mode).toBe("local");
    expect(resolveAt(makeRepo(origin, "[collaboration]\nmode=mirror\n")).mode).toBe("mirror");
  });

  test("scp hosts must be safe DNS names and leave the port delimiter to URLs", () => {
    for (const origin of ["git@..:team/repo.git", "git@team..:repo.git", "git@git.example.com~2222:team/repo.git"]) {
      const result = refusal(() => resolveAt(makeRepo(origin, "[collaboration]\nmode=local\n")));
      expect(result.code).toBe("collaboration.repo-identity-unresolved");
    }
    const dotted = resolveAt(makeRepo("git@Git.Example.com.:team/repo.git", "[collaboration]\nmode=local\n"));
    expect(dotted.repoKey).toBe("git.example.com/team/repo");
    const ported = resolveAt(makeRepo("ssh://git@git.example.com:2222/team/repo.git", "[collaboration]\nmode=local\n"));
    expect(ported.repoKey).toBe("git.example.com~2222/team/repo");
  });

  test("dot segments are refused before URL normalization", () => {
    for (const origin of [
      "https://git.example.com/a/../team/repo.git",
      "https://git.example.com/a/%2e%2e/team/repo.git",
      "https://git.example.com/%2E/team/repo.git",
      "git@git.example.com:a/../team/repo.git",
      "https://git.example.com/a\\..\\team/repo.git",
      "https://git.example.com\\..\\team/repo.git",
    ]) {
      const result = refusal(() => resolveAt(makeRepo(origin, "[collaboration]\nmode=local\n")));
      expect(result.code).toBe("collaboration.repo-identity-unresolved");
    }
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

    const dangling = makeRepo("https://github.com/acme/widgets.git");
    symlinkSync(join(dangling, "missing-config"), join(dangling, ".mstarc"));
    const danglingResult = refusal(() => resolveAt(dangling));
    expect(danglingResult.code).toBe("collaboration.config-unreadable");
    expect(danglingResult.message).toContain("symbolic link");

    const linked = makeRepo("https://github.com/acme/widgets.git");
    writeFileSync(join(linked, "real-config"), "[collaboration]\nmode=local\n");
    symlinkSync(join(linked, "real-config"), join(linked, ".mstarc"));
    expect(refusal(() => resolveAt(linked)).code).toBe("collaboration.config-unreadable");

    const absent = makeRepo("https://github.com/acme/widgets.git");
    expect(resolveAt(absent).mode).toBe("local");
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

    await initializeCollaborationStore(resolveAt(parentRepo));
    await initializeCollaborationStore(resolveAt(nestedRepo));
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
    const invalidMode = "synthetic-invalid-9f3a";
    const result = refusal(() =>
      resolveAt(makeRepo("https://github.com/acme/widgets.git", `[collaboration]\nmode=${invalidMode}\n`)),
    );
    expect(result.code).toBe("collaboration.mode-invalid");
    expect(result.message).toContain("mode");
    expect(result.message).toContain("mode=local");
    expect(result.message).not.toContain(invalidMode);
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
    expect(parseMstarc("[collaboration]\nmode=local\nmode=\n").collaboration).toEqual({ mode: "" });
    expect(parseMstarc("[collaboration]\nmode=local\nmode=mirror\n").collaboration).toEqual({ mode: "mirror" });
    expect(parseMstarc("[collaboration]\nrepo_id=first\nrepo_id=second\n").collaboration).toEqual({ repoId: "second" });
  });
});

const CANONICAL_ORIGIN = "https://github.com/acme/widgets.git";
const CANONICAL_REPO_KEY = "github.com/acme/widgets";
const SELECTOR_REF = "refs/heads/mstar-collaboration-authority";

const SELECTED_PROJECT = {
  localProjectId: "fixture-project",
  provider: "linear",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  journalIssueId: "44444444-4444-4444-8444-444444444444",
  writerId: "55555555-5555-4555-8555-555555555555",
} as const;

function makeSelectorOrigin(): { bare: string; publish(payload: unknown | string): string } {
  const bare = join(ROOT, `selector-origin-${sequence++}.git`);
  git(ROOT, "init", "-q", "--bare", bare);
  let publisher: string | undefined;
  return {
    bare,
    publish(payload) {
      if (publisher === undefined) {
        publisher = join(ROOT, `selector-publisher-${sequence++}`);
        mkdirSync(publisher, { recursive: true });
        git(publisher, "init", "-q");
        git(publisher, "config", "user.name", "Selector Test");
        git(publisher, "config", "user.email", "selector@example.test");
      }
      writeFileSync(
        join(publisher, "authority.json"),
        typeof payload === "string" ? payload : `${JSON.stringify(payload, null, 2)}\n`,
      );
      git(publisher, "add", "authority.json");
      git(publisher, "commit", "-q", "-m", "publish selector");
      git(publisher, "push", "-q", "--force", bare, `HEAD:${SELECTOR_REF}`);
      return git(publisher, "rev-parse", "HEAD");
    },
  };
}

function selectorPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    repoKey: CANONICAL_REPO_KEY,
    generation: 3,
    mode: "remote",
    phase: "active",
    projects: [SELECTED_PROJECT],
    previous: null,
    cutover: null,
    ...overrides,
  };
}

function remoteRepo(bare: string, mode: "local" | "mirror" | "remote" = "remote"): string {
  const repo = makeRepo(CANONICAL_ORIGIN, `[collaboration]\nmode=${mode}\n`, false);
  git(repo, "config", `url.${bare}.insteadOf`, CANONICAL_ORIGIN);
  return repo;
}

function writeRemoteBinding(root: string, commit: string, generation: number): void {
  const harness = join(root, ".mstar");
  mkdirSync(harness, { recursive: true });
  writeFileSync(
    join(harness, "collaboration-binding.json"),
    `${JSON.stringify(
      {
        version: 3,
        state: "active",
        repoKey: CANONICAL_REPO_KEY,
        mode: "remote",
        selectorCommit: commit,
        generation,
        storeId: "fixture-remote-store",
        epoch: 1,
        boundAt: "2026-11-22T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
  );
}

describe("remote selector resolution", () => {
  test("a remote selection with no published selector refuses instead of selecting local authority", () => {
    const origin = makeSelectorOrigin();
    const result = refusal(() => resolveAt(remoteRepo(origin.bare)));
    expect(result.code).toBe("remote.selector-unavailable");
    expect(result.message).toContain("mstar-collaboration-authority");
  });

  test("a published selector is read from its checked commit, never the checkout copy", () => {
    const origin = makeSelectorOrigin();
    const commit = origin.publish(selectorPayload({ generation: 4 }));
    const repo = remoteRepo(origin.bare);
    writeFileSync(join(repo, "authority.json"), JSON.stringify(selectorPayload({ generation: 99 })));

    const location = resolveAt(repo);
    expect(location.mode).toBe("remote");
    expect(location.selection).toEqual({
      commit,
      generation: 4,
      phase: "active",
      projects: [SELECTED_PROJECT],
      previous: null,
      cutover: null,
    });
    const observed = JSON.parse(
      readFileSync(join(repo, ".mstar", "collaboration-selector-observation.json"), "utf8"),
    ) as { selectorCommit: string; generation: number };
    expect(observed).toMatchObject({ selectorCommit: commit, generation: 4 });
  });

  test("an unavailable origin refuses remote selection, never reads it as absence", () => {
    const unreachable = refusal(() =>
      resolveAt(makeRepo("ssh://git@127.0.0.1:1/acme/widgets.git", "[collaboration]\nmode=remote\n", false)),
    );
    expect(unreachable.code).toBe("remote.selector-unavailable");
    expect(unreachable.message).toContain("could not check");

    const originless = refusal(() => resolveAt(makeRepo(undefined, "[collaboration]\nmode=remote\nrepo_id=fixture\n")));
    expect(originless.code).toBe("remote.selector-unavailable");
    expect(originless.message).toContain("origin");
  });

  test("a selector that disagrees with this checkout is a stale binding", () => {
    const origin = makeSelectorOrigin();
    const repo = remoteRepo(origin.bare);

    origin.publish(selectorPayload({ mode: "local", projects: [] }));
    expect(refusal(() => resolveAt(repo)).code).toBe("collaboration.stale-binding");

    origin.publish(selectorPayload({ repoKey: "github.com/other/repo" }));
    const foreign = refusal(() => resolveAt(repo));
    expect(foreign.code).toBe("collaboration.stale-binding");
    expect(foreign.message).toContain("github.com/other/repo");
  });

  test("an absent mode beside a published remote selector refuses and writes nothing", () => {
    const origin = makeSelectorOrigin();
    origin.publish(selectorPayload());
    const repo = makeRepo(CANONICAL_ORIGIN, undefined, false);
    git(repo, "config", `url.${origin.bare}.insteadOf`, CANONICAL_ORIGIN);

    const result = refusal(() => resolveAt(repo));
    expect(result.code).toBe("collaboration.stale-binding");
    expect(result.message).toContain("declares no mode");
    expect(result.message).toContain("mode=remote");
    expect(existsSync(join(repo, ".mstar", "collaboration-selector-observation.json"))).toBe(false);
  });

  test("a malformed published selector refuses remote selection", () => {
    const origin = makeSelectorOrigin();
    const repo = remoteRepo(origin.bare);
    const cases: unknown[] = [
      selectorPayload({ version: 2 }),
      selectorPayload({ generation: 0 }),
      selectorPayload({ projects: [] }),
      selectorPayload({ projects: [{ ...SELECTED_PROJECT, projectId: "ENG-42" }] }),
      selectorPayload({ projects: [{ ...SELECTED_PROJECT, teamId: "Engineering" }] }),
      selectorPayload({ projects: [{ ...SELECTED_PROJECT, workspaceId: "eng-42" }] }),
      selectorPayload({ projects: [{ ...SELECTED_PROJECT, writerId: "writer-one" }] }),
      selectorPayload({ projects: [SELECTED_PROJECT, SELECTED_PROJECT] }),
      selectorPayload({ projects: [{ ...SELECTED_PROJECT, journalIssueId: "https://linear.app/issue" }] }),
      selectorPayload({ previous: { selectorCommit: "a".repeat(40), generation: 4, mode: "local" } }),
      selectorPayload({ phase: "pending" }),
    ];
    for (const payload of cases) {
      origin.publish(payload);
      expect(refusal(() => resolveAt(repo)).code).toBe("remote.selector-unavailable");
    }
    origin.publish("{not json");
    expect(refusal(() => resolveAt(repo)).code).toBe("remote.selector-unavailable");

    const transition = (digest: string, fenced = true) => ({
      previous: { selectorCommit: "a".repeat(40), generation: 2, mode: "local" },
      cutover: {
        operator: "ops-engineer",
        reviewedAt: "2026-11-21T00:00:00Z",
        sourceFenced: fenced,
        pendingOperationIds: [],
        verifiedTargetDigest: digest,
      },
    });
    for (const digest of ["x", "D".repeat(64), "d".repeat(63), "d".repeat(65)]) {
      origin.publish(selectorPayload(transition(digest)));
      expect(refusal(() => resolveAt(repo)).code).toBe("remote.selector-unavailable");
    }
    origin.publish(selectorPayload(transition("d".repeat(64), false)));
    expect(refusal(() => resolveAt(repo)).code).toBe("collaboration.stale-binding");
  }, 30_000);

  test("a recorded remote binding makes selector absence a stale binding", () => {
    const origin = makeSelectorOrigin();
    const repo = remoteRepo(origin.bare);
    writeRemoteBinding(repo, "c".repeat(40), 2);
    const result = refusal(() => resolveAt(repo));
    expect(result.code).toBe("collaboration.stale-binding");
    expect(result.message).toContain("mstar-collaboration-authority");
  });

  test("a remote binding must name the current selector generation", async () => {
    const origin = makeSelectorOrigin();
    const commit = origin.publish(selectorPayload({ generation: 5 }));
    const repo = remoteRepo(origin.bare);
    writeRemoteBinding(repo, commit, 5);
    const context = contextAt(repo);
    const location = resolveAt(repo);
    expect(location.selection?.commit).toBe(commit);
    await assertControlCheckoutScope(context, location);
    expect(readCollaborationBinding(context)).toMatchObject({
      version: 3,
      mode: "remote",
      selectorCommit: commit,
      generation: 5,
    });

    writeRemoteBinding(repo, commit, 4);
    await expect(assertControlCheckoutScope(context, location)).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });

    writeRemoteBinding(repo, "b".repeat(40), 5);
    await expect(assertControlCheckoutScope(context, location)).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });
  });

  test("a remote selection never opens or creates the local lane", async () => {
    const origin = makeSelectorOrigin();
    const commit = origin.publish(selectorPayload({ generation: 2 }));

    const bound = remoteRepo(origin.bare);
    writeRemoteBinding(bound, commit, 2);
    const location = resolveAt(bound);
    await expect(openCollaborationStore(contextAt(bound), "read")).rejects.toMatchObject({
      code: "collaboration.mode-unavailable",
    });
    await expect(initializeCollaborationStore(location)).rejects.toMatchObject({
      code: "collaboration.mode-unavailable",
    });
    expect(existsSync(location.dbPath)).toBe(false);

    const unbound = remoteRepo(origin.bare);
    await expect(openCollaborationStore(contextAt(unbound), "read")).rejects.toMatchObject({
      code: "collaboration.stale-binding",
    });
  });

  test("a failed fetch refuses even when the selector object is already present", () => {
    const origin = makeSelectorOrigin();
    const commit = origin.publish(selectorPayload({ generation: 2 }));
    const repo = remoteRepo(origin.bare);
    expect(resolveAt(repo).selection?.commit).toBe(commit);
    git(repo, "cat-file", "-e", `${commit}^{commit}`);
    git(repo, "config", "fetch.parallel", "bogus");
    const result = refusal(() => resolveAt(repo));
    expect(result.code).toBe("remote.selector-unavailable");
    expect(result.message).toContain("fetch");
  });

  test("a draining selection retains its validated predecessor and cutover", () => {
    const origin = makeSelectorOrigin();
    const previous = { selectorCommit: "a".repeat(40), generation: 6, mode: "remote" } as const;
    const cutover = {
      operator: "ops-engineer",
      reviewedAt: "2026-11-21T00:00:00Z",
      sourceFenced: false,
      pendingOperationIds: ["operation-one"],
      verifiedTargetDigest: "d".repeat(64),
    } as const;
    const commit = origin.publish(selectorPayload({ generation: 7, phase: "draining", previous, cutover }));
    const location = resolveAt(remoteRepo(origin.bare));
    expect(location.selection).toEqual({
      commit,
      generation: 7,
      phase: "draining",
      projects: [SELECTED_PROJECT],
      previous,
      cutover,
    });
  });

  test("an origin-backed local or mirror checkout refuses a published remote or draining selector", () => {
    const origin = makeSelectorOrigin();
    origin.publish(selectorPayload({ generation: 7 }));
    for (const mode of ["local", "mirror"] as const) {
      expect(refusal(() => resolveAt(remoteRepo(origin.bare, mode))).code).toBe("collaboration.stale-binding");
    }

    origin.publish(
      selectorPayload({
        generation: 8,
        mode: "local",
        projects: [],
        phase: "draining",
        previous: { selectorCommit: "a".repeat(40), generation: 7, mode: "local" },
        cutover: {
          operator: "ops-engineer",
          reviewedAt: "2026-11-21T00:00:00Z",
          sourceFenced: false,
          pendingOperationIds: ["operation-one"],
          verifiedTargetDigest: "d".repeat(64),
        },
      }),
    );
    expect(refusal(() => resolveAt(remoteRepo(origin.bare, "local"))).code).toBe("collaboration.stale-binding");
  });

  test("an origin-backed local or mirror lane continues only after a live lookup confirms absence", () => {
    const origin = makeSelectorOrigin();
    for (const mode of ["local", "mirror"] as const) {
      const location = resolveAt(remoteRepo(origin.bare, mode));
      expect(location.mode).toBe(mode);
      expect("selection" in location).toBe(false);
    }

    const unreachable = refusal(() =>
      resolveAt(makeRepo("ssh://git@127.0.0.1:1/acme/widgets.git", "[collaboration]\nmode=local\n", false)),
    );
    expect(unreachable.code).toBe("remote.selector-unavailable");
  });

  test("a selector deleted after this checkout observed it is never a fresh absence", () => {
    for (const mode of ["local", "mirror"] as const) {
      const origin = makeSelectorOrigin();
      const commit = origin.publish(selectorPayload({ mode, projects: [], generation: 3 }));
      const observed = remoteRepo(origin.bare, mode);
      expect(resolveAt(observed).mode).toBe(mode);
      expect(
        JSON.parse(readFileSync(join(observed, ".mstar", "collaboration-selector-observation.json"), "utf8")),
      ).toMatchObject({ repoKey: CANONICAL_REPO_KEY, selectorCommit: commit, generation: 3 });

      git(origin.bare, "update-ref", "-d", SELECTOR_REF);
      const gone = refusal(() => resolveAt(observed));
      expect(gone.code).toBe("collaboration.stale-binding");
      expect(gone.message).toContain(commit);

      expect(resolveAt(remoteRepo(origin.bare, mode)).mode).toBe(mode);
    }
  });

  test("a selector observed by live lookup stays evidence when its payload cannot be read", () => {
    const fetchOrigin = makeSelectorOrigin();
    const fetchCommit = fetchOrigin.publish(selectorPayload({ mode: "local", projects: [], generation: 3 }));
    const fetchRepo = remoteRepo(fetchOrigin.bare, "local");
    git(fetchRepo, "config", "fetch.parallel", "bogus");
    const failedFetch = refusal(() => resolveAt(fetchRepo));
    expect(failedFetch.code).toBe("remote.selector-unavailable");
    expect(failedFetch.message).toContain("fetch");
    expect(
      JSON.parse(
        readFileSync(join(fetchRepo, ".mstar", "collaboration-selector-observation.json"), "utf8"),
      ),
    ).toMatchObject({ repoKey: CANONICAL_REPO_KEY, selectorCommit: fetchCommit });

    const payloadOrigin = makeSelectorOrigin();
    const payloadCommit = payloadOrigin.publish("{not json");
    const payloadRepo = remoteRepo(payloadOrigin.bare, "mirror");
    expect(refusal(() => resolveAt(payloadRepo)).code).toBe("remote.selector-unavailable");
    expect(
      JSON.parse(
        readFileSync(join(payloadRepo, ".mstar", "collaboration-selector-observation.json"), "utf8"),
      ),
    ).toMatchObject({ repoKey: CANONICAL_REPO_KEY, selectorCommit: payloadCommit });

    for (const [origin, repo, commit] of [
      [fetchOrigin, fetchRepo, fetchCommit],
      [payloadOrigin, payloadRepo, payloadCommit],
    ] as const) {
      git(origin.bare, "update-ref", "-d", SELECTOR_REF);
      const gone = refusal(() => resolveAt(repo));
      expect(gone.code).toBe("collaboration.stale-binding");
      expect(gone.message).toContain(commit);
    }

    expect(resolveAt(remoteRepo(fetchOrigin.bare, "local")).mode).toBe("local");
    expect(resolveAt(remoteRepo(payloadOrigin.bare, "mirror")).mode).toBe("mirror");
  });
});
