/**
 * The controlled host and sandbox fixture for the remote collaboration suites.
 *
 * The fixture owns the provider state in memory in the TEST RUNNER and a local
 * bare Git origin that publishes the protected authority ref plus a tracked
 * checkout branch. A sandbox is a fresh clone of that branch, with its OWN
 * workspace and `HOME`, spawned with an allowlisted child environment: only
 * public JSON DTOs (written under that sandbox's own directory) cross into the
 * CLI, and no prior store, filesystem path or provider credential is ever
 * handed to another sandbox. Children run the locally built CLI entry.
 *
 * `verify` and `observe` are test-runner operations: they build the documents
 * the Host Agent would submit, and the CLI receives them as files. No provider
 * client, callback, token or in-process object is passed into the CLI.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { remoteEventHead, type RemoteEvent } from "@mstar-harness/engine";
import { CLI_ROOT, type RunResult } from "../harness";

export const AUTHORITY_REF = "refs/heads/mstar-collaboration-authority";
/** note: The tracked branch a sandbox clones; its `.mstarc` is Git content, never fixture-written checkout state. */
export const TRACKED_BRANCH = "fixture-main";
/** note: The verification subject is the built artifact; the TS source entry would not prove it. */
export const BUILT_CLI_ENTRY: string = join(CLI_ROOT, "dist/mstar-harness.js");

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

/** note: The unmarked native issue every fixture observation carries by default. */
export const FIXTURE_ISSUE_ID = "77777777-7777-4777-8777-777777777777";

export type ScopeCheckDocument = Readonly<{
  projectId: string;
  scope: Readonly<{ provider: "linear"; workspaceId: string; teamId: string; projectId: string }>;
  journalIssueId: string;
  checkedAt: string;
  outcome:
    | Readonly<{
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
      }>
    | Readonly<{ kind: "unavailable" | "scope-mismatch" | "denied" | "revoked" | "unsafe-fidelity" }>;
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
  /** note: The CLI entry this sandbox's children run; it is the built artifact. */
  entry: string;
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

/** note: The one send permit `outbox-dispatch` issued, as its envelope carries it. */
export type OutboxPermit = Readonly<{
  operationId: string;
  attemptId: string;
  requestHash: string;
  binding: Readonly<{
    generation: number;
    projectKey: string;
    selectorCommit: string;
    provider: "linear";
    workspaceId: string;
    teamId: string;
    projectId: string;
    journalIssueId: string;
    writerId: string | null;
  }>;
  frozenRequest: Readonly<{ event: unknown; target: string | null }>;
}>;

/** note: One intent as `outbox-show` discloses it; a lookup runs under that original binding. */
export type OutboxIntent = Readonly<{
  operationId: string;
  projectId: string;
  generation: number;
  attemptId: string;
  requestHash: string;
  binding: OutboxPermit["binding"];
}>;

/** note: A receipt the HOST submits through `outbox-receipt`/`outbox-reconcile`; never produced by the CLI. */
export type OutboxReceiptDocument = Readonly<{
  version: 1;
  selectorCommit: string;
  generation: number;
  projectId: string;
  operationId: string;
  attemptId: string;
  requestHash: string;
  observedAt: string;
  outcome: unknown;
}>;

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

/** note: The deadline every fixture child gets; a wedged CLI or Git process is killed, never waited out. */
const CHILD_TIMEOUT_MS = 120_000;
/** note: The exit code a killed child reports, so a timed-out run fails instead of reading as null. */
const TIMEOUT_EXIT_CODE = 124;
/** note: A shared fixture-only Git home; ambient `HOME` and host Git config never reach a fixture child. */
const FIXTURE_GIT_HOME = join(tmpdir(), "mstar-fixture-git-home");

/**
 * invariant: A fixture Git child sees its own `HOME` and an explicit minimal environment, and
 * no system or global Git config, so a runner-set signing, hook or `insteadOf` setting can
 * neither redirect nor block the fixture's clone, commit or push.
 */
function gitEnvironment(home: string): Record<string, string> {
  mkdirSync(home, { recursive: true });
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** note: One bounded fixture Git child under that environment; `home` is the sandbox's own when cloning. */
export function fixtureGit(cwd: string, args: readonly string[], home: string = FIXTURE_GIT_HOME): string {
  return execFileSync("git", [...args], {
    cwd,
    env: gitEnvironment(home),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  }).trim();
}

/**
 * note: One bounded synchronous child. A child that hits the deadline is reported as a failed
 * run before any caller asserts its exit status, so a hang never reads as a product answer.
 */
export function boundedRun(command: readonly string[], options: { cwd: string; env: Record<string, string> }): RunResult {
  const proc = Bun.spawnSync([...command], {
    cwd: options.cwd,
    env: { ...options.env },
    stdout: "pipe",
    stderr: "pipe",
    timeout: CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const stderr = proc.stderr.toString();
  return {
    exitCode: proc.exitCode ?? TIMEOUT_EXIT_CODE,
    stdout: proc.stdout.toString(),
    stderr:
      proc.exitCode === null
        ? `${stderr}\nfixture: the child was killed after ${String(CHILD_TIMEOUT_MS)}ms without exiting\n`
        : stderr,
  };
}
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** note: One CLI run's envelope, parsed the same way for bun- and node-spawned children. */
export function parseSandboxCommand(result: RunResult): SandboxCommand {
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
}

/**
 * note: The confirmed record the provider holds for one operation: the frozen event's
 * reference and head plus its complete MStar subject. A traversal renders it onto the
 * native issue it names; losing the record leaves that issue visible and unmarked.
 */
export type ProviderIssueRecord = Readonly<{
  issueRef: string;
  head: readonly string[];
  subject: Readonly<Record<string, unknown>>;
}>;

/** note: One provider record: the event the host appended and the identity it landed on. */
type ProviderEffect = Readonly<{
  operationId: string;
  attemptId: string;
  recordId: string;
  identity: Record<string, unknown>;
  event: RemoteEvent;
}>;

/** note: One provider record as a traversal renders it; a project event carries no issue record. */
function providerRecord(effect: ProviderEffect): ProviderIssueRecord | null {
  const { change } = effect.event;
  return change.kind === "project-replace"
    ? null
    : { issueRef: change.issueRef, head: [remoteEventHead(effect.event)], subject: change.mstar };
}

export class RemoteCollaborationFixture {
  private readonly root: string;
  private readonly origin: string;
  private readonly bare: string;
  private readonly publisher: string;
  private sandboxSequence = 0;
  private published: PublishedSelector | null = null;
  /** note: The provider records this host actually holds; only `send` appends, only `lookup` reads. */
  private readonly effects: ProviderEffect[] = [];
  /** note: Every provider call the TEST RUNNER made; the CLI has no channel into this state. */
  readonly providerCalls: Array<Readonly<{ kind: "send" | "lookup"; operationId: string }>> = [];
  private issues: readonly FixtureIssue[] = [
    {
      issueId: FIXTURE_ISSUE_ID,
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
    fixtureGit(this.root, ["init", "-q", "--bare", this.bare]);
    mkdirSync(this.publisher, { recursive: true });
    fixtureGit(this.publisher, ["init", "-q", "-b", TRACKED_BRANCH]);
    fixtureGit(this.publisher, ["config", "user.name", "Remote Selector"]);
    fixtureGit(this.publisher, ["config", "user.email", "selector@example.test"]);
    // invariant: the collaboration declaration is TRACKED; a sandbox obtains it from Git.
    writeFileSync(join(this.publisher, ".mstarc"), "[collaboration]\nmode=remote\n");
    fixtureGit(this.publisher, ["add", ".mstarc"]);
    fixtureGit(this.publisher, ["commit", "-q", "-m", "declare remote collaboration"]);
    fixtureGit(this.publisher, ["push", "-q", this.bare, `HEAD:refs/heads/${TRACKED_BRANCH}`]);
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  /** note: One fresh clone of the tracked branch, with its own workspace, `HOME` and host inputs. */
  sandbox(name: string): RemoteSandbox {
    const dir = join(this.root, `sandbox-${name}-${String(this.sandboxSequence++)}`);
    const repo = join(dir, "repo");
    const home = join(dir, "home");
    mkdirSync(dir, { recursive: true });
    // invariant: The sandbox's own `HOME` exists BEFORE the clone, so clone, commit and push
    // all run under it rather than under the test runner's Git configuration.
    mkdirSync(home, { recursive: true });
    // invariant: a genuine clone through the synthetic canonical URL; the checkout,
    // its origin and `.mstarc` are all canonical Git state, never fixture-written files.
    fixtureGit(this.root, [
      "clone",
      "-q",
      "--branch",
      TRACKED_BRANCH,
      "-c",
      `url.${this.bare}.insteadOf=${this.origin}`,
      this.origin,
      repo,
    ], home);
    fixtureGit(repo, ["config", "user.name", `Sandbox ${name}`], home);
    fixtureGit(repo, ["config", "user.email", `sandbox-${name}@example.test`], home);
    const harness = join(repo, ".mstar");
    mkdirSync(harness, { recursive: true });
    const hosts = join(dir, "host");
    mkdirSync(hosts, { recursive: true });
    const entry = process.env.MSTAR_CLI_ENTRY ?? BUILT_CLI_ENTRY;
    if (!existsSync(entry)) {
      throw new Error(`fixture: the locally built CLI is missing at ${entry}; run bun run --cwd packages/cli build`);
    }
    const environment = childEnvironment(home);
    let hostSequence = 0;

    const run = (args: readonly string[]): RunResult =>
      boundedRun([process.execPath, "run", entry, ...args], { cwd: repo, env: { ...environment } });
    const runJson = (args: readonly string[]): SandboxCommand => parseSandboxCommand(run(args));
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
      entry,
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
    fixtureGit(this.publisher, ["add", "authority.json", "generation.txt"]);
    fixtureGit(this.publisher, ["commit", "-q", "-m", `publish generation ${String(generation)}`]);
    fixtureGit(this.publisher, ["push", "-q", "--force", this.bare, `HEAD:${AUTHORITY_REF}`]);
    const commit = fixtureGit(this.publisher, ["rev-parse", "HEAD"]);
    this.published = { commit, generation };
    return this.published;
  }

  /** note: Replace the readable provider issues the next observation carries. */
  setIssues(issues: readonly FixtureIssue[]): void {
    this.issues = issues;
  }

  /** note: The confirmed issue record the provider holds for one operation; `null` once discarded. */
  confirmedIssue(operationId: string): ProviderIssueRecord | null {
    const effect = this.effects.find((entry) => entry.operationId === operationId);
    return effect === undefined ? null : providerRecord(effect);
  }

  /**
   * note: The provider loses its confirmed record for one operation. The native issue itself
   * stays readable, so the traversal still shows the issue but no marker: its existence is
   * never mistaken for the record's survival.
   */
  discardEffects(operationId: string): void {
    for (let index = this.effects.length - 1; index >= 0; index -= 1) {
      if (this.effects[index]!.operationId === operationId) this.effects.splice(index, 1);
    }
  }

  /** note: The confirmed issue record the provider holds for one native issue, if it holds one. */
  private recordFor(issueId: string): ProviderIssueRecord | null {
    const effect = this.effects.find((entry) => entry.identity.issueId === issueId);
    return effect === undefined ? null : providerRecord(effect);
  }

  /**
   * The host sends one issued permit to the provider and records the effect it actually
   * produced. Called twice for one attempt it records a duplicate effect, which is exactly
   * the cardinality a `lookup` must report as ambiguous.
   */
  send(permit: OutboxPermit): OutboxReceiptDocument {
    this.providerCalls.push({ kind: "send", operationId: permit.operationId });
    const recordId = randomUUID();
    const identity = {
      provider: "linear",
      workspaceId: permit.binding.workspaceId,
      teamId: permit.binding.teamId,
      projectId: permit.binding.projectId,
      issueId: permit.frozenRequest.target ?? recordId,
    };
    this.effects.push({
      operationId: permit.operationId,
      attemptId: permit.attemptId,
      recordId,
      identity,
      // note: The provider stores the frozen event it received; its DTO crosses as opaque JSON.
      event: permit.frozenRequest.event as RemoteEvent,
    });
    return {
      version: 1,
      selectorCommit: permit.binding.selectorCommit,
      generation: permit.binding.generation,
      projectId: permit.binding.projectKey,
      operationId: permit.operationId,
      attemptId: permit.attemptId,
      requestHash: permit.requestHash,
      observedAt: new Date().toISOString(),
      outcome: { kind: "confirmed", identity, recordId, event: permit.frozenRequest.event },
    };
  }

  /**
   * The host looks up what the provider holds for one attempt under its ORIGINAL binding.
   * Exactly one exact record confirms; none is `not-found` and a duplicate is `ambiguous`,
   * so neither is ever reported as a business success.
   */
  lookup(intent: OutboxIntent): OutboxReceiptDocument {
    this.providerCalls.push({ kind: "lookup", operationId: intent.operationId });
    const found = this.effects.filter(
      (effect) => effect.operationId === intent.operationId && effect.attemptId === intent.attemptId,
    );
    const envelope = {
      version: 1 as const,
      selectorCommit: intent.binding.selectorCommit,
      generation: intent.generation,
      projectId: intent.projectId,
      operationId: intent.operationId,
      attemptId: intent.attemptId,
      requestHash: intent.requestHash,
      observedAt: new Date().toISOString(),
    };
    if (found.length === 1) {
      const [only] = found;
      return { ...envelope, outcome: { kind: "confirmed", identity: only!.identity, recordId: only!.recordId, event: only!.event } };
    }
    const reason = found.length === 0 ? ("not-found" as const) : ("ambiguous" as const);
    return { ...envelope, outcome: { kind: "unconfirmed", reason } };
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
        issues: this.issues.map((issue) => {
          const record = this.recordFor(issue.issueId);
          return {
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
            // note: A record the provider no longer holds renders as an unmarked native issue.
            mstar: record === null ? null : { issueRef: record.issueRef, head: record.head, ...record.subject },
          };
        }),
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
