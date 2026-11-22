/**
 * The controlled host and sandbox fixture for the remote collaboration suites.
 *
 * The fixture owns the provider state in memory in the TEST RUNNER and a local
 * bare Git origin that publishes the protected authority ref. A sandbox is a
 * checkout with its OWN workspace and `HOME`, spawned with an allowlisted child
 * environment: only public JSON DTOs (written under that sandbox's own
 * directory) cross into the CLI, and no prior store, filesystem path or
 * provider credential is ever handed to another sandbox.
 *
 * `verify` and `observe` are test-runner operations: they build the documents
 * the Host Agent would submit, and the CLI receives them as files. No provider
 * client, callback, token or in-process object is passed into the CLI.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SRC_ENTRY, type RunResult } from "../harness";

export const AUTHORITY_REF = "refs/heads/mstar-collaboration-authority";

/** note: One selected project: the local id plus the exact provider tuple it binds. */
export type FixtureProject = Readonly<{
  localProjectId: string;
  provider: "linear";
  workspaceId: string;
  teamId: string;
  projectId: string;
  journalIssueId: string;
  writerId: string;
}>;

/** note: The one selected project every fixture sandbox binds. */
export const REMOTE_PROJECT: FixtureProject = {
  localProjectId: "fixture-project",
  provider: "linear",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  projectId: "33333333-3333-4333-8333-333333333333",
  journalIssueId: "44444444-4444-4444-8444-444444444444",
  writerId: "55555555-5555-4555-8555-555555555555",
};

export type FixtureIssue = Readonly<{ issueId: string; title: string; status: string; updatedAt: string }>;

export type ScopeCheckDocument = Readonly<{
  projectId: string;
  scope: Readonly<{ provider: "linear"; workspaceId: string; teamId: string; projectId: string }>;
  journalIssueId: string;
  checkedAt: string;
  outcome: Readonly<{
    kind: "verified";
    readerId: string;
    writerId: string;
    capabilities: Readonly<{
      fullRead: boolean;
      appendOnly: boolean;
      exactLookup: boolean;
      fieldFidelity: boolean;
      privateAudience: boolean;
    }>;
  }>;
}>;

export type ObservationDocument = Readonly<{
  version: 1;
  selectorCommit: string;
  generation: number;
  check: ScopeCheckDocument;
  expectRevision: number;
  snapshot: unknown;
}>;

/** note: One CLI answer: the refusal text a caller recovers from, plus the raw run. */
export type SandboxCommand = Readonly<{
  exitCode: number | null;
  ok: boolean;
  code: unknown;
  message: string;
  recovery: string;
  data: Record<string, unknown>;
  result: RunResult;
}>;

export type RemoteSandbox = Readonly<{
  name: string;
  dir: string;
  repo: string;
  harness: string;
  home: string;
  /** note: The exact allowlisted environment this sandbox's children receive. */
  environment: Readonly<Record<string, string>>;
  run(args: readonly string[]): RunResult;
  runJson(args: readonly string[]): SandboxCommand;
  /** note: Write one host document under THIS sandbox's own directory. */
  writeJson(name: string, value: unknown): string;
  status(): SandboxCommand;
  bind(check: ScopeCheckDocument): SandboxCommand;
  init(): SandboxCommand;
  observe(submission: ObservationDocument): SandboxCommand;
}>;

export type PublishedSelector = Readonly<{ commit: string; generation: number }>;

/**
 * invariant: A sandbox child sees only its own workspace `HOME` and the
 * interpreter path. Ambient harness variables, the invoking session identity
 * and every other sandbox's paths are absent by construction, never scrubbed
 * one by one.
 */
function childEnvironment(home: string): Readonly<Record<string, string>> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    TZ: "UTC",
  };
}

function realGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export class RemoteCollaborationFixture {
  private readonly root: string;
  private readonly origin: string;
  private readonly bare: string;
  private readonly publisher: string;
  private sandboxSequence = 0;
  private published: PublishedSelector | null = null;
  private issues: readonly FixtureIssue[] = [
    {
      issueId: "77777777-7777-4777-8777-777777777777",
      title: "Observed native issue",
      status: "Todo",
      updatedAt: "2026-11-20T00:00:00.000Z",
    },
  ];

  /** note: `repoKey` is derived from the synthetic canonical HTTPS origin. */
  readonly repoKey: string;

  constructor(name: string) {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), `mstar-${name}-`)));
    const slug = `${name}-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`;
    this.repoKey = `github.com/remote-collab/${slug}`;
    this.origin = `https://${this.repoKey}.git`;
    this.bare = join(this.root, "origin.git");
    this.publisher = join(this.root, "publisher");
    mkdirSync(this.bare, { recursive: true });
    realGit(this.root, ["init", "-q", "--bare", this.bare]);
    mkdirSync(this.publisher, { recursive: true });
    realGit(this.publisher, ["init", "-q"]);
    realGit(this.publisher, ["config", "user.name", "Remote Selector"]);
    realGit(this.publisher, ["config", "user.email", "selector@example.test"]);
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  /** note: One fresh checkout with its own workspace, `HOME` and host inputs. */
  sandbox(name: string): RemoteSandbox {
    const dir = join(this.root, `sandbox-${name}-${String(this.sandboxSequence++)}`);
    const repo = join(dir, "repo");
    const home = join(dir, "home");
    mkdirSync(repo, { recursive: true });
    mkdirSync(home, { recursive: true });
    realGit(repo, ["init", "-q"]);
    realGit(repo, ["config", "user.name", `Sandbox ${name}`]);
    realGit(repo, ["config", "user.email", `sandbox-${name}@example.test`]);
    realGit(repo, ["config", "remote.origin.url", this.origin]);
    realGit(repo, ["config", `url.${this.bare}.insteadOf`, this.origin]);
    writeFileSync(join(repo, ".mstarc"), "[collaboration]\nmode=remote\n");
    const harness = join(repo, ".mstar");
    mkdirSync(harness, { recursive: true });
    const hosts = join(dir, "host");
    mkdirSync(hosts, { recursive: true });
    const environment = childEnvironment(home);
    let hostSequence = 0;

    const run = (args: readonly string[]): RunResult => {
      const proc = Bun.spawnSync([process.execPath, "run", process.env.MSTAR_CLI_ENTRY ?? SRC_ENTRY, ...args], {
        cwd: repo,
        env: { ...environment },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    };
    const runJson = (args: readonly string[]): SandboxCommand => {
      const result = run(args);
      let envelope: Record<string, unknown> = {};
      try {
        envelope = asRecord(JSON.parse(result.stdout));
      } catch {
        // note: A non-JSON body stays empty; the raw result carries the failure.
      }
      const details = asRecord(envelope.details);
      return {
        exitCode: result.exitCode,
        ok: envelope.status === "ok",
        code: envelope.code,
        message: typeof envelope.message === "string" ? envelope.message : "",
        recovery: typeof details.recovery === "string" ? details.recovery : "",
        data: asRecord(envelope.data),
        result,
      };
    };
    const writeJson = (name: string, value: unknown): string => {
      const path = join(hosts, `${String(hostSequence++)}-${name}.json`);
      writeFileSync(path, `${JSON.stringify(value)}\n`);
      return path;
    };
    const remote = ["store", "collaboration", "remote"] as const;
    return {
      name,
      dir,
      repo,
      harness,
      home,
      environment,
      run,
      runJson,
      writeJson,
      status: () => runJson([...remote, "status", "--harness", harness]),
      bind: (check) =>
        runJson([
          ...remote,
          "bind",
          "--harness",
          harness,
          "--input",
          writeJson("bind", {
            version: 1,
            selectorCommit: this.requirePublished().commit,
            generation: this.requirePublished().generation,
            checks: [check],
          }),
        ]),
      init: () => runJson(["store", "init", "--harness", harness]),
      observe: (submission) =>
        runJson([...remote, "observe", "--harness", harness, "--input", writeJson("observe", submission)]),
    };
  }

  /**
   * Publish one reviewed `active` selector generation to the bare origin. A
   * successor names the generation it supersedes and its fenced cutover, so the
   * moved-selector case is a real reviewed advance rather than an edited file.
   */
  publish(generation: number, overrides: Readonly<Record<string, unknown>> = {}): PublishedSelector {
    const previous = this.published;
    const payload = {
      version: 1,
      repoKey: this.repoKey,
      generation,
      mode: "remote",
      phase: "active",
      projects: [REMOTE_PROJECT],
      previous:
        previous === null
          ? null
          : { selectorCommit: previous.commit, generation: previous.generation, mode: "remote" },
      cutover:
        previous === null
          ? null
          : {
              operator: "fixture-operator",
              reviewedAt: "2026-11-22T00:00:00Z",
              sourceFenced: true,
              pendingOperationIds: [],
              verifiedTargetDigest: "f".repeat(64),
            },
      ...overrides,
    };
    writeFileSync(join(this.publisher, "authority.json"), `${JSON.stringify(payload, null, 2)}\n`);
    // note: A successor commit must differ even when only its generation number does.
    writeFileSync(join(this.publisher, "generation.txt"), `${String(generation)}-${String(Date.now())}-${String(Math.random())}\n`);
    realGit(this.publisher, ["add", "authority.json", "generation.txt"]);
    realGit(this.publisher, ["commit", "-q", "-m", `publish generation ${String(generation)}`]);
    realGit(this.publisher, ["push", "-q", "--force", this.bare, `HEAD:${AUTHORITY_REF}`]);
    const commit = realGit(this.publisher, ["rev-parse", "HEAD"]);
    this.published = { commit, generation };
    return this.published;
  }

  /** note: Replace the readable provider issues the next observation carries. */
  setIssues(issues: readonly FixtureIssue[]): void {
    this.issues = issues;
  }

  /**
   * The Host Agent's live scope check for one selected project. Everything is
   * current at submission time, which is what a positive check must prove.
   */
  verify(project: FixtureProject = REMOTE_PROJECT): ScopeCheckDocument {
    return {
      projectId: project.localProjectId,
      scope: {
        provider: "linear",
        workspaceId: project.workspaceId,
        teamId: project.teamId,
        projectId: project.projectId,
      },
      journalIssueId: project.journalIssueId,
      checkedAt: new Date(Date.now() - 1_000).toISOString(),
      outcome: {
        kind: "verified",
        readerId: "fixture-reader",
        writerId: project.writerId,
        capabilities: {
          fullRead: true,
          appendOnly: true,
          exactLookup: true,
          fieldFidelity: true,
          privateAudience: true,
        },
      },
    };
  }

  /** note: One complete provider traversal for the selected project. */
  observe(project: FixtureProject = REMOTE_PROJECT, expectRevision = 0): ObservationDocument {
    const published = this.requirePublished();
    const check = this.verify(project);
    return {
      version: 1,
      selectorCommit: published.commit,
      generation: published.generation,
      check,
      expectRevision,
      snapshot: {
        asOf: new Date(Date.parse(check.checkedAt) - 5_000).toISOString(),
        coverage: { kind: "complete" },
        project: {
          projectId: project.localProjectId,
          head: ["1".repeat(64)],
          binding: check.scope,
          milestones: [],
          roadmap: null,
          catalogEntities: [
            {
              kind: "project",
              id: project.localProjectId,
              title: "Fixture project",
              description: null,
              documentKind: null,
              lifecycle: "active",
              revision: 1,
            },
          ],
          catalogLinks: [],
        },
        issues: this.issues.map((issue) => ({
          identity: {
            provider: "linear",
            workspaceId: project.workspaceId,
            teamId: project.teamId,
            projectId: project.projectId,
            issueId: issue.issueId,
          },
          nativeTitle: issue.title,
          nativeStatus: issue.status,
          providerUpdatedAt: issue.updatedAt,
          mstar: null,
        })),
      },
    };
  }

  /**
   * note: The cache lane this sandbox's `HOME` resolves for the fixture repository.
   * It is found, never assumed: a missing lane is exactly what the absent-data
   * case asserts.
   */
  cachePath(sandbox: RemoteSandbox): string {
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name === "collaboration.db") found.push(path);
      }
    };
    walk(join(sandbox.home, ".mstar"));
    if (found.length !== 1) throw new Error(`fixture: expected one remote cache for ${sandbox.name}, found ${String(found.length)}`);
    return found[0]!;
  }

  private requirePublished(): PublishedSelector {
    if (this.published === null) throw new Error("fixture: no selector has been published");
    return this.published;
  }
}
