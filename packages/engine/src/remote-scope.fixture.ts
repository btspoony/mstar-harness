/**
 * note: TEST-ONLY fixture: a real remote scope for read-boundary tests.
 *
 * It is not exported from the package index and the build's entry points never
 * import it. It creates a unique canonical origin, publishes the protected
 * selector ref to a local bare repository, and gives tests the exact
 * `ScopeCheck` / `RemoteSnapshot` documents the Host Agent would submit - the
 * same public engine DTOs, never a mocked database or provider.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spyOn } from "bun:test";
import * as nodeOs from "node:os";
import {
  dispatchRemoteIntent,
  readRemoteIntent,
  recordRemoteReceipt,
  remoteEventHead,
  type ProviderProjectScope,
  type RemoteIntentRead,
  type RemoteSnapshot,
  type ScopeCapabilities,
  type ScopeCheck,
} from "./collaboration-remote.js";
import type { StoreContext } from "./store-db.js";

export const REMOTE_SELECTOR_REF = "refs/heads/mstar-collaboration-authority";

export const REMOTE_IDS = {
  projectId: "fixture-project",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  providerProjectId: "33333333-3333-4333-8333-333333333333",
  journalIssueId: "44444444-4444-4444-8444-444444444444",
  writerId: "55555555-5555-4555-8555-555555555555",
  markedIssueId: "66666666-6666-4666-8666-666666666666",
  providerOnlyIssueId: "77777777-7777-4777-8777-777777777777",
  issueRef: "mstar:issue:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  secondIssueRef: "mstar:issue:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

/** note: The second selected project: the target of the fixture issue's cross-project relation. */
export const SECOND_IDS = {
  projectId: "fixture-project-two",
  providerProjectId: "88888888-8888-4888-8888-888888888888",
  journalIssueId: "99999999-9999-4999-8999-999999999999",
  markedIssueId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  issueRef: REMOTE_IDS.secondIssueRef,
} as const;

/** note: The generated selectors the fixture published, for exact assertions. */
export const FIXTURE_AT = "2026-11-20T00:00:00.000Z";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** note: Every remote fixture derives its lane under a private HOME; restore with the returned spy. */
export function isolateLaneHome(): { restore(): void } {
  const home = mkdtempSync(join(tmpdir(), "mstar-remote-home-"));
  const spy = spyOn(nodeOs, "homedir").mockImplementation(() => home);
  return { restore: () => spy.mockRestore() };
}

export type RemoteScopeFixture = {
  repo: string;
  harness: string;
  origin: string;
  /** note: The local bare origin directory, so a case can make the origin unavailable. */
  bare: string;
  repoKey: string;
  context(): StoreContext;
  /** note: Publish (or republish) the selector; returns the checked commit. */
  publish(overrides?: Record<string, unknown>): string;
  /** note: The strict verification batch for the published generation; `extra` covers further selected projects. */
  batch(commit: string, generation?: number, extra?: ScopeCheck[]): { version: 1; selectorCommit: string; generation: number; checks: ScopeCheck[] };
};

/**
 * One isolated remote checkout: unique canonical origin (its own lane path), a
 * bare origin the selector is pushed to, and the checkout that resolves it.
 */
export function createRemoteScope(root: string, name: string): RemoteScopeFixture {
  const slug = `${name}-${Math.random().toString(36).slice(2, 10)}`;
  const origin = `https://github.com/remote-fixture/${slug}.git`;
  const repoKey = `github.com/remote-fixture/${slug}`;
  const bare = join(root, `remote-origin-${slug}.git`);
  git(root, "init", "-q", "--bare", bare);
  const repo = join(root, `remote-repo-${slug}`);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.name", "Remote Store Test");
  git(repo, "config", "user.email", "remote-store@example.test");
  git(repo, "config", "remote.origin.url", origin);
  git(repo, "config", `url.${bare}.insteadOf`, origin);
  writeFileSync(join(repo, ".mstarc"), "[collaboration]\nmode=remote\n");
  const harness = join(repo, ".mstar");
  mkdirSync(harness, { recursive: true });
  const publisher = join(root, `remote-publisher-${slug}`);
  mkdirSync(publisher, { recursive: true });
  git(publisher, "init", "-q");
  git(publisher, "config", "user.name", "Remote Selector Test");
  git(publisher, "config", "user.email", "publisher@example.test");
  const context: StoreContext = { harnessDir: harness, checkoutRoot: repo };
  return {
    repo,
    harness,
    origin,
    bare: bare,
    repoKey,
    context: () => context,
    publish(overrides = {}) {
      const payload = {
        version: 1,
        repoKey,
        generation: 3,
        mode: "remote",
        phase: "active",
        projects: [
          {
            localProjectId: REMOTE_IDS.projectId,
            provider: "linear",
            workspaceId: REMOTE_IDS.workspaceId,
            teamId: REMOTE_IDS.teamId,
            projectId: REMOTE_IDS.providerProjectId,
            journalIssueId: REMOTE_IDS.journalIssueId,
            writerId: REMOTE_IDS.writerId,
          },
        ],
        previous: null,
        cutover: null,
        ...overrides,
      };
      writeFileSync(join(publisher, "authority.json"), `${JSON.stringify(payload, null, 2)}\n`);
      git(publisher, "add", "authority.json");
      git(publisher, "commit", "-q", "-m", "publish selector");
      git(publisher, "push", "-q", "--force", bare, `HEAD:${REMOTE_SELECTOR_REF}`);
      return git(publisher, "rev-parse", "HEAD");
    },
    batch(commit, generation = 3, extra: ScopeCheck[] = []) {
      return { version: 1, selectorCommit: commit, generation, checks: [positiveCheck(), ...extra] };
    },
  };
}

export function providerScope(): ProviderProjectScope {
  return {
    provider: "linear",
    workspaceId: REMOTE_IDS.workspaceId,
    teamId: REMOTE_IDS.teamId,
    projectId: REMOTE_IDS.providerProjectId,
  };
}

const CAPABILITIES: ScopeCapabilities = {
  fullRead: true,
  appendOnly: true,
  exactLookup: true,
  fieldFidelity: true,
  privateAudience: true,
};

/** note: A positive check, current unless the caller overrides `checkedAt`. */
export function positiveCheck(overrides: Partial<ScopeCheck> = {}): ScopeCheck {
  return {
    projectId: REMOTE_IDS.projectId,
    scope: providerScope(),
    journalIssueId: REMOTE_IDS.journalIssueId,
    checkedAt: new Date(Date.now() - 1_000).toISOString(),
    outcome: { kind: "verified", readerId: "reader-one", writerId: REMOTE_IDS.writerId, capabilities: CAPABILITIES },
    ...overrides,
  };
}

export function negativeCheck(overrides: Partial<ScopeCheck> = {}): ScopeCheck {
  return {
    ...positiveCheck(),
    ...overrides,
    outcome: { kind: "denied" },
  };
}

function mstarIssue(check: ScopeCheck, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    identity: { ...check.scope, issueId: REMOTE_IDS.markedIssueId },
    nativeTitle: "Native title one",
    nativeStatus: "Todo",
    providerUpdatedAt: FIXTURE_AT,
    mstar: {
      issueRef: REMOTE_IDS.issueRef,
      head: ["2".repeat(64)],
      fields: {
        title: "Adopted title",
        kind: "bug",
        severity: "high",
        disposition: "open",
        impact: "Users cannot ingest the project journal.",
        acceptance: "A complete observation is stored and served.",
        owner: "fullstack-dev",
        registeredAt: FIXTURE_AT,
        closedAt: null,
        closureNote: null,
        createdAt: FIXTURE_AT,
        updatedAt: FIXTURE_AT,
        revision: 1,
        milestoneId: "milestone-1",
      },
      occurrences: [
        {
          eventId: "11111111-1111-4111-8111-111111111111",
          occurrenceKey: "occurrence-one",
          sourceKind: "review",
          sourceIdentity: "review:fixture",
          rootCauseKey: "remote.observation",
          acceptanceKey: "remote.observation.stored",
          location: "packages/engine/src/collaboration-remote.ts",
          observedBehavior: "The store refused a complete scope.",
          evidence: ["review-fixture"],
          discoveredAt: FIXTURE_AT,
          recordedAt: FIXTURE_AT,
          imported: false,
        },
      ],
      transitions: [],
      relations: [{ relation: "related", target: REMOTE_IDS.secondIssueRef }],
      provenance: [
        {
          eventId: "33333333-3333-4333-8333-333333333333",
          kind: "plan",
          target: "20261122-remote-authority",
          sourceHash: "3".repeat(64),
          origin: "scoped",
          legacyProject: null,
          legacyBucket: null,
          legacyEntryId: null,
          legacyRecord: null,
          importedAt: null,
        },
      ],
      projectMoves: [],
      ...((overrides.mstar as Record<string, unknown> | undefined) ?? {}),
    },
  };
}

/** note: A complete fixture scope: project binding, milestone, roadmap, portable catalog and both issues. */
export function completeSnapshot(check: ScopeCheck = positiveCheck()): RemoteSnapshot {
  return {
    asOf: new Date(Date.parse(check.checkedAt) - 5_000).toISOString(),
    coverage: { kind: "complete" },
    project: {
      projectId: check.projectId,
      head: ["1".repeat(64)],
      binding: check.scope,
      milestones: [
        {
          milestoneId: "milestone-1",
          name: "First delivery",
          target: "2026-12-01",
          status: "active",
          ordinal: 0,
          revision: 1,
          createdAt: FIXTURE_AT,
          updatedAt: FIXTURE_AT,
        },
      ],
      roadmap: {
        contentMarkdown: [
          "---",
          "project_id: fixture-project",
          "title: Fixture roadmap",
          "status: active",
          "created_at: 2026-11-20",
          "---",
          "",
          "# Roadmap",
          "",
          "## Direction",
          "",
          "One verified remote scope.",
          "",
        ].join("\n"),
        revision: 2,
        updatedAt: FIXTURE_AT,
      },
      catalogEntities: [
        { kind: "project", id: REMOTE_IDS.projectId, title: "Fixture project", description: null, documentKind: null, lifecycle: "active", revision: 1 },
        { kind: "plan", id: "plan-1", title: "Plan one", description: "d", documentKind: null, lifecycle: "active", revision: 1 },
      ],
      catalogLinks: [
        { fromKind: "plan", fromId: "plan-1", relation: "belongs-to", toKind: "project", toId: REMOTE_IDS.projectId, ordinal: 0 },
      ],
    },
    issues: [
      mstarIssue(check) as never,
      {
        identity: { ...check.scope, issueId: REMOTE_IDS.providerOnlyIssueId },
        nativeTitle: "Unmarked native issue",
        nativeStatus: "Done",
        providerUpdatedAt: FIXTURE_AT,
        mstar: null,
      },
    ],
  };
}

/** note: The same project with ONE declared stream gap: issues only up to a cursor. */
export function partialSnapshot(check: ScopeCheck = positiveCheck()): RemoteSnapshot {
  return {
    ...completeSnapshot(check),
    coverage: { kind: "partial", stream: "issues", nextCursor: "cursor-2", code: "remote.observation.partial" },
  };
}

export function secondScope(): ProviderProjectScope {
  return {
    provider: "linear",
    workspaceId: REMOTE_IDS.workspaceId,
    teamId: REMOTE_IDS.teamId,
    projectId: SECOND_IDS.providerProjectId,
  };
}

export function secondCheck(overrides: Partial<ScopeCheck> = {}): ScopeCheck {
  return {
    ...positiveCheck(),
    projectId: SECOND_IDS.projectId,
    scope: secondScope(),
    journalIssueId: SECOND_IDS.journalIssueId,
    ...overrides,
  };
}

/** note: The second project's scope carrying the relation target the first project references. */
export function secondSnapshot(check: ScopeCheck, coverage: "complete" | "partial" = "complete"): RemoteSnapshot {
  const base = completeSnapshot(check);
  const marked = base.issues[0];
  if (marked === undefined || marked.mstar === null) throw new Error("fixture: the base snapshot carries no marked issue");
  return {
    ...base,
    coverage: coverage === "complete" ? { kind: "complete" } : { kind: "partial", stream: "issues", nextCursor: "cursor-2", code: "remote.observation.partial" },
    project: {
      ...base.project,
      milestones: [],
      roadmap: null,
      catalogEntities: [
        { kind: "project", id: check.projectId, title: "Fixture project two", description: null, documentKind: null, lifecycle: "active", revision: 1 },
      ],
      catalogLinks: [],
    },
    issues: [
      {
        ...marked,
        identity: { ...marked.identity, issueId: SECOND_IDS.markedIssueId },
        nativeTitle: "Second project native",
        mstar: {
          ...marked.mstar,
          issueRef: SECOND_IDS.issueRef,
          relations: [],
          fields: { ...marked.mstar.fields, title: "Second project subject", milestoneId: null },
        },
      },
    ],
  };
}

/** note: A second complete scope for one different project id, for aggregate-refusal tests. */
export function completeSnapshotFor(projectId: string, check: ScopeCheck): RemoteSnapshot {
  const snapshot = completeSnapshot(check);
  return {
    ...snapshot,
    project: { ...snapshot.project, projectId },
    issues: snapshot.issues.map((issue) => ({ ...issue, identity: { ...issue.identity, projectId } })),
  };
}

/** note: The observation submission the Host Agent posts for one snapshot. */
export function submission(commit: string, check: ScopeCheck, snapshot: RemoteSnapshot | null, expectRevision: number) {
  return { version: 1 as const, selectorCommit: commit, generation: 3, check, expectRevision, snapshot };
}

/* ------------------------------------------------------------------------ *
 * note: Outbox settlement: the host's own evidence for one frozen intent
 * ------------------------------------------------------------------------ */

/** note: Dispatch one intent and return its single send permit's attempt id. */
async function permitAttempt(context: StoreContext, operationId: string): Promise<string> {
  const read = await readRemoteIntent(context, operationId);
  // invariant: A reviewed resolution's base IS its recorded fork: the permit needs the host's own
  // complete traversal of exactly those heads, started after the conflict evidence was recorded.
  const fork = read.resolves === null ? null : await forkObservationOf(context, read);
  const permit = await dispatchRemoteIntent(context, operationId, fork ?? undefined);
  if (permit.kind !== "permit") {
    throw new Error(`fixture: operation ${operationId} issued no send permit (it is ${permit.state})`);
  }
  return permit.permit.attemptId;
}

/** note: The host-attested fork traversal a resolution's dispatch must carry. */
async function forkObservationOf(context: StoreContext, resolution: RemoteIntentRead): Promise<Record<string, unknown>> {
  const conflictedId = resolution.resolves;
  if (conflictedId === null) throw new Error(`fixture: operation ${resolution.operationId} is not a resolution`);
  const conflicted = await readRemoteIntent(context, conflictedId);
  const evidence = conflicted.receipts.find((entry) => entry.outcome.kind === "conflict");
  if (evidence === undefined || evidence.outcome.kind !== "conflict") {
    throw new Error(`fixture: conflicted operation ${conflicted.operationId} carries no fork evidence`);
  }
  const heads = evidence.outcome.observedRecords
    .map((record) => ({ recordId: record.recordId, issueRef: REMOTE_IDS.issueRef, head: remoteEventHead(record.event) }))
    .sort((left, right) => (left.head < right.head ? -1 : left.head > right.head ? 1 : 0));
  return {
    version: 1,
    selectorCommit: resolution.binding.selectorCommit,
    generation: resolution.generation,
    projectId: resolution.projectId,
    conflictOperationId: conflicted.operationId,
    asOf: new Date(Date.parse(evidence.recordedAt) + 1_000).toISOString(),
    coverage: "complete",
    heads,
  };
}

/** note: The receipt envelope every settlement below submits for one attempt. */
function receiptOf(
  read: RemoteIntentRead,
  attemptId: string,
  outcome: Record<string, unknown>,
): Record<string, unknown> {
  return {
    version: 1,
    selectorCommit: read.binding.selectorCommit,
    generation: read.generation,
    projectId: read.projectId,
    operationId: read.operationId,
    attemptId,
    requestHash: read.requestHash,
    observedAt: new Date().toISOString(),
    outcome,
  };
}

/** note: The provider identity a receipt names for the record its intent addresses. */
function receiptIdentity(read: RemoteIntentRead, issueId: string): Record<string, unknown> {
  return {
    provider: read.binding.provider,
    workspaceId: read.binding.workspaceId,
    teamId: read.binding.teamId,
    projectId: read.binding.projectId,
    issueId,
  };
}

/**
 * note: Confirm one frozen intent with the provider record its own frozen event proves. A create
 * needs the new issue id (its record id IS that issue); every other kind addresses `target`.
 */
export async function confirmFrozenIntent(
  context: StoreContext,
  operationId: string,
  createdIssueId?: string,
): Promise<void> {
  const read = await readRemoteIntent(context, operationId);
  if (read.event === null) throw new Error(`fixture: operation ${operationId} discloses no frozen event`);
  const create = read.event.change.kind === "issue-create";
  const issueId = create ? createdIssueId : read.target;
  if (issueId === undefined || issueId === null) {
    throw new Error(`fixture: operation ${operationId} needs the ${create ? "created issue id" : "addressed target"}`);
  }
  const attemptId = await permitAttempt(context, operationId);
  await recordRemoteReceipt(context, receiptOf(read, attemptId, {
    kind: "confirmed",
    identity: receiptIdentity(read, issueId),
    recordId: create ? issueId : randomUUID(),
    event: read.event,
  }));
}

/**
 * note: Record a complete fork against one dispatched intent: one competing record per observed
 * head, each carrying the same subject as the frozen event under another operation id. Returns the
 * observed heads a reviewed resolution must cite as its parents.
 */
export async function conflictFrozenIntent(context: StoreContext, operationId: string): Promise<string[]> {
  const read = await readRemoteIntent(context, operationId);
  const frozen = read.event;
  const target = read.target;
  if (frozen === null || target === null) {
    throw new Error(`fixture: operation ${operationId} is not a replaceable frozen event`);
  }
  const competing = [8, 9].map((digit) => ({
    ...frozen,
    operationId: randomUUID(),
    parents: [String(digit).repeat(64)],
  }));
  const heads = competing.map(remoteEventHead).sort();
  const attemptId = await permitAttempt(context, operationId);
  await recordRemoteReceipt(context, receiptOf(read, attemptId, {
    kind: "conflict",
    expectedHeads: read.expectedHeads,
    observedHeads: heads,
    observedRecords: competing.map((event) => ({
      identity: receiptIdentity(read, target),
      recordId: randomUUID(),
      event,
    })),
  }));
  return heads;
}
