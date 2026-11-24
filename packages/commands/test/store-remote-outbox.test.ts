/**
 * note: The provider-free outbox command surface: `adopt-issue` preparation, the seven recovery
 * verbs, and the domain families' pending-effect propagation.
 *
 * Every case drives real command definitions against a real remote cache lane and a real Git
 * selector ref. No provider exists anywhere in the fixture: the CLI/engine read the selector,
 * freeze intents and record receipts, and the host's provider call is never simulated inside
 * the product code.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  bindRemoteAuthority,
  ingestRemoteObservation,
  remoteEventHead,
  type RemoteEvent,
} from "@mstar-harness/engine";
import { getCommandDefinitions } from "../src/index.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../src/types.js";

const roots: string[] = [];
const HOME = mkdtempSync(join(tmpdir(), "mstar-outbox-home-"));
let homeSpy: { mockRestore(): void } | undefined;
beforeAll(() => {
  // note: The collaboration lane is user-level, so every fixture's homedir is private.
  homeSpy = spyOn(nodeOs, "homedir").mockImplementation(() => HOME);
});
afterAll(() => {
  homeSpy?.mockRestore();
  rmSync(HOME, { recursive: true, force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const IDS = {
  projectId: "fixture-project",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  teamId: "22222222-2222-4222-8222-222222222222",
  providerProjectId: "33333333-3333-4333-8333-333333333333",
  journalIssueId: "44444444-4444-4444-8444-444444444444",
  writerId: "55555555-5555-4555-8555-555555555555",
  providerIssueId: "77777777-7777-4777-8777-777777777777",
} as const;

const OPERATIONS = {
  adopt: "99999999-9999-4999-8999-999999999999",
  capture: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  milestone: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  roadmap: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  catalog: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  resolution: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
} as const;

let sequence = 0;
function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
}

type Fixture = {
  repo: string;
  harness: string;
  commit: string;
  scope: Readonly<Record<string, string>>;
  bind: () => Promise<void>;
  observe: (revision: number) => Promise<void>;
  path: (name: string, value: unknown) => string;
  text: (name: string, content: string) => string;
};

/**
 * note: A real remote checkout: a bare origin carrying the protected selector ref, a `.mstarc`
 * selecting remote, and this checkout's harness directory. Nothing else is created.
 */
function remoteFixture(label: string): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `mstar-outbox-${label}-`)));
  roots.push(root);
  const owner = `outbox-${sequence++}`;
  const origin = `https://github.com/${owner}/fixture.git`;
  const bare = join(root, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const [key, value] of [
    ["user.name", "Outbox Fixture"],
    ["user.email", "outbox@example.test"],
    ["remote.origin.url", origin],
    [`url.${bare}.insteadOf`, origin],
  ] as const) git(repo, ["config", key, value]);
  writeFileSync(join(repo, ".mstarc"), "[collaboration]\nmode=remote\n");
  const harness = join(repo, ".mstar");
  mkdirSync(harness, { recursive: true });
  const repoKey = `github.com/${owner}/fixture`;

  const publisher = join(root, "publisher");
  mkdirSync(publisher, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: publisher });
  git(publisher, ["config", "user.name", "Selector"]);
  git(publisher, ["config", "user.email", "selector@example.test"]);
  writeFileSync(join(publisher, "authority.json"), `${JSON.stringify({
    version: 1,
    repoKey,
    generation: 3,
    mode: "remote",
    phase: "active",
    projects: [{
      localProjectId: IDS.projectId,
      provider: "linear",
      workspaceId: IDS.workspaceId,
      teamId: IDS.teamId,
      projectId: IDS.providerProjectId,
      journalIssueId: IDS.journalIssueId,
      writerId: IDS.writerId,
    }],
    previous: null,
    cutover: null,
  })}\n`);
  git(publisher, ["add", "authority.json"]);
  git(publisher, ["commit", "-q", "-m", "selector"]);
  git(publisher, ["push", "-q", "--force", bare, "HEAD:refs/heads/mstar-collaboration-authority"]);
  const commit = git(publisher, ["rev-parse", "HEAD"]);

  const scope = {
    provider: "linear",
    workspaceId: IDS.workspaceId,
    teamId: IDS.teamId,
    projectId: IDS.providerProjectId,
  };
  const check = {
    projectId: IDS.projectId,
    scope,
    journalIssueId: IDS.journalIssueId,
    checkedAt: new Date(Date.now() - 1_000).toISOString(),
    outcome: {
      kind: "verified",
      readerId: "reader-one",
      writerId: IDS.writerId,
      capabilities: { fullRead: true, appendOnly: true, exactLookup: true, fieldFidelity: true, privateAudience: true },
    },
  };
  const snapshot = () => ({
    asOf: new Date(Date.now() - 5_000).toISOString(),
    coverage: { kind: "complete" },
    project: {
      projectId: IDS.projectId,
      head: ["1".repeat(64)],
      binding: scope,
      milestones: [],
      roadmap: null,
      catalogEntities: [
        { kind: "project", id: IDS.projectId, title: "Fixture", description: null, documentKind: null, lifecycle: "active", revision: 1 },
      ],
      catalogLinks: [],
    },
    issues: [
      {
        identity: { ...scope, issueId: IDS.providerIssueId },
        nativeTitle: "Unmarked native issue",
        nativeStatus: "Todo",
        providerUpdatedAt: new Date(Date.now() - 5_000).toISOString(),
        mstar: null,
      },
    ],
  });
  return {
    repo,
    harness,
    commit,
    scope,
    async bind() {
      await bindRemoteAuthority({ harnessDir: harness }, { version: 1, selectorCommit: commit, generation: 3, checks: [check] });
    },
    async observe(revision: number) {
      await ingestRemoteObservation(
        { harnessDir: harness },
        { version: 1, selectorCommit: commit, generation: 3, check, expectRevision: revision, snapshot: snapshot() },
      );
    },
    path(name: string, value: unknown) {
      const target = join(root, `${name}-${sequence++}.json`);
      writeFileSync(target, JSON.stringify(value));
      return target;
    },
    text(name: string, content: string) {
      const target = join(root, `${name}-${sequence++}.md`);
      writeFileSync(target, content);
      return target;
    },
  };
}

function invocation(cwd: string, input?: string): InvocationContext {
  return {
    cwd,
    controlRoot: cwd,
    versions: { engine: null, cli: null, plugin: null, host: null, platform: null },
    signal: new AbortController().signal,
    effects: {
      async readInput() {
        return input ?? "";
      },
      async spawn() {
        return { exitCode: 1, signal: null, stdout: "", stderr: "" };
      },
      async startDashboard() {
        throw new Error("not available in this command family");
      },
      async openBrowser() {
        throw new Error("not available in this command family");
      },
    },
  };
}

function definition(id: string): CommandDefinition {
  const found = getCommandDefinitions().find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`missing command definition: ${id}`);
  return found;
}

async function invoke(id: string, input: Record<string, unknown>, cwd: string, stdin?: string): Promise<CommandEnvelope> {
  return definition(id).execute(definition(id).input.parse(input), invocation(cwd, stdin));
}

function dataOf(result: CommandEnvelope): Record<string, unknown> {
  if (result.status !== "ok" || result.data === null || typeof result.data !== "object" || Array.isArray(result.data)) {
    throw new Error(`expected a successful object result, got ${JSON.stringify(result)}`);
  }
  return result.data as Record<string, unknown>;
}

/** note: Read one member of a published JSON Schema document; every step is checked, nothing is assumed. */
function atPath(value: unknown, ...keys: string[]): unknown {
  let cursor: unknown = value;
  for (const key of keys) {
    if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) return undefined;
    cursor = Reflect.get(cursor, key);
  }
  return cursor;
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const adoption = {
  version: 1,
  kind: "new",
  capture: {
    kind: "bug",
    severity: "high",
    impact: "The outbox surface is unimplemented.",
    acceptance: "The outbox commands settle a durable intent.",
    sourceIdentity: "review:outbox-commands",
    rootCauseKey: "remote.outbox.commands",
    acceptanceKey: "remote.outbox.commands.stored",
    occurrenceKey: "outbox-commands-occurrence",
    sourceKind: "review",
    location: "packages/commands",
    observedBehavior: "The provider-free loop cannot be finished.",
    evidence: ["fixture"],
    discoveredAt: new Date(Date.now() - 10_000).toISOString(),
  },
};

const capturePayload = {
  projectId: IDS.projectId,
  title: "A captured finding",
  kind: "bug",
  severity: "high",
  impact: "impact body",
  acceptance: "acceptance body",
  sourceIdentity: "review:outbox-capture",
  rootCauseKey: "remote.outbox.capture",
  acceptanceKey: "remote.outbox.capture.stored",
  occurrenceKey: "outbox-capture-occurrence",
  sourceKind: "review",
  location: "packages/commands",
  observedBehavior: "A queued capture reported success.",
  evidence: ["fixture"],
  discoveredAt: new Date(Date.now() - 10_000).toISOString(),
};

const RECEIPT_SCOPE = {
  selectorCommit: "",
  generation: 3,
  projectId: IDS.projectId,
};

/** note: A prepared fixture with one enqueued adoption, its dispatch permit and the frozen event. */
async function adoptAndDispatch(label: string) {
  const fixture = remoteFixture(label);
  await fixture.bind();
  await fixture.observe(0);
  const adoptInput = fixture.path("adopt", adoption);
  const adopted = await invoke("store.collaboration.remote.adopt-issue", {
    harness: fixture.harness,
    project: IDS.projectId,
    issue: IDS.providerIssueId,
    operation: OPERATIONS.adopt,
    input: adoptInput,
  }, fixture.repo);
  const intent = dataOf(adopted);
  const dispatched = await invoke("store.collaboration.remote.outbox-dispatch", {
    harness: fixture.harness,
    operation: OPERATIONS.adopt,
  }, fixture.repo);
  const result = dataOf(dispatched) as { kind: string; permit: Record<string, any> };
  return { fixture, intent, permit: result.permit };
}

function receiptOf(permit: Record<string, any>, outcome: unknown, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    ...RECEIPT_SCOPE,
    selectorCommit: permit.binding.selectorCommit,
    operationId: permit.operationId,
    attemptId: permit.attemptId,
    requestHash: permit.requestHash,
    observedAt: new Date().toISOString(),
    outcome,
    ...overrides,
  };
}

describe("remote outbox commands", () => {
  test("adopt-issue freezes one durable intent and outbox-pending|show disclose it without a permit", async () => {
    const { fixture, intent, permit } = await adoptAndDispatch("lifecycle");
    expect(intent).toMatchObject({ operationId: OPERATIONS.adopt, state: "enqueued", replayed: false, projectId: IDS.projectId });

    // invariant: A replay of the identical adoption returns the stored intent, never a second row.
    const replay = await invoke("store.collaboration.remote.adopt-issue", {
      harness: fixture.harness,
      project: IDS.projectId,
      issue: IDS.providerIssueId,
      operation: OPERATIONS.adopt,
      input: fixture.path("adopt-replay", adoption),
    }, fixture.repo);
    expect(dataOf(replay)).toMatchObject({ operationId: OPERATIONS.adopt, replayed: true, state: "unconfirmed" });

    const shown = dataOf(await invoke("store.collaboration.remote.outbox-show", {
      harness: fixture.harness,
      operation: OPERATIONS.adopt,
    }, fixture.repo));
    expect(shown).toMatchObject({
      operationId: OPERATIONS.adopt,
      state: "unconfirmed",
      attemptId: permit.attemptId,
      disclosure: "full",
      target: IDS.providerIssueId,
    });
    expect((shown.event as Record<string, unknown>).change).toMatchObject({ kind: "issue-adopt" });

    // note: The listing reports only current-binding enqueued intents; a dispatched one is absent.
    const pending = dataOf(await invoke("store.collaboration.remote.outbox-pending", {
      harness: fixture.harness,
      project: IDS.projectId,
    }, fixture.repo));
    expect(pending).toMatchObject({ version: 1, projectId: IDS.projectId, intents: [] });

    const unknown = await invoke("store.collaboration.remote.outbox-show", {
      harness: fixture.harness,
      operation: "12121212-1212-4212-8212-121212121212",
    }, fixture.repo);
    expect(unknown).toMatchObject({ status: "refused", code: "remote.intent-not-found", exitCode: 1 });
    expect(unknown.details?.recovery).toContain("outbox-pending");
  });

  test("a malformed or stale document refuses without mutating the recorded intent", async () => {
    const { fixture, permit } = await adoptAndDispatch("malformed");
    const before = dataOf(await invoke("store.collaboration.remote.outbox-show", {
      harness: fixture.harness,
      operation: OPERATIONS.adopt,
    }, fixture.repo));
    const malformed = await invoke("store.collaboration.remote.outbox-receipt", {
      harness: fixture.harness,
      input: "-",
    }, fixture.repo, "{not json");
    expect(malformed).toMatchObject({ status: "usage", code: "usage", exitCode: 2 });
    const stale = await invoke("store.collaboration.remote.outbox-receipt", {
      harness: fixture.harness,
      input: fixture.path("receipt-stale", receiptOf(permit, { kind: "unconfirmed", reason: "no-response" }, { requestHash: "0".repeat(64) })),
    }, fixture.repo);
    expect(stale).toMatchObject({ status: "refused", code: "remote.operation-conflict", exitCode: 1 });
    const after = dataOf(await invoke("store.collaboration.remote.outbox-show", {
      harness: fixture.harness,
      operation: OPERATIONS.adopt,
    }, fixture.repo));
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.state).toBe("unconfirmed");
  });

  test("--input reads a relative file path as well as stdin", async () => {
    const { fixture, permit } = await adoptAndDispatch("relative-input");
    const absolute = fixture.path("relative-receipt", receiptOf(permit, { kind: "unconfirmed", reason: "no-response" }));
    // invariant: The documented file input is a PATH, not an absolute path: it resolves against
    // the caller's working directory exactly like the observation lane's reader.
    const recorded = await invoke("store.collaboration.remote.outbox-receipt", {
      harness: fixture.harness,
      input: relative(process.cwd(), absolute),
    }, fixture.repo);
    expect(recorded).toMatchObject({ status: "ok", exitCode: 0 });
    expect(dataOf(recorded)).toMatchObject({ state: "unconfirmed" });
  });

  test("a refused document names the verb that reads that document, not another DTO's verb", async () => {
    const { fixture } = await adoptAndDispatch("recovery-routing");
    // note: Valid JSON that is not the document the verb reads reaches the engine's own
    // narrow validation; the recovery must resubmit it to THIS verb.
    const reconcile = await invoke("store.collaboration.remote.outbox-reconcile", {
      harness: fixture.harness,
      input: fixture.path("bad-reconcile", { version: 1 }),
    }, fixture.repo);
    expect(reconcile).toMatchObject({ status: "refused", code: "remote.input-invalid", exitCode: 1 });
    expect(reconcile.details?.recovery).toContain("outbox-reconcile");
    expect(reconcile.details?.recovery).not.toContain("outbox-receipt");

    const resolve = await invoke("store.collaboration.remote.outbox-resolve", {
      harness: fixture.harness,
      operation: OPERATIONS.adopt,
      input: fixture.path("bad-resolution", { version: 1 }),
    }, fixture.repo);
    expect(resolve).toMatchObject({ status: "refused", code: "remote.input-invalid", exitCode: 1 });
    expect(resolve.details?.recovery).toContain("outbox-resolve");
    expect(resolve.details?.recovery).not.toContain("outbox-receipt");

    const receipt = await invoke("store.collaboration.remote.outbox-receipt", {
      harness: fixture.harness,
      input: fixture.path("bad-receipt", { version: 1 }),
    }, fixture.repo);
    expect(receipt).toMatchObject({ status: "refused", code: "remote.input-invalid", exitCode: 1 });
    expect(receipt.details?.recovery).toContain("outbox-receipt");
  });

  test("a receipt records evidence while the outbox state, not the command, says whether the effect landed", async () => {
    const { fixture, permit } = await adoptAndDispatch("receipt");
    const unconfirmed = await invoke("store.collaboration.remote.outbox-receipt", {
      harness: fixture.harness,
      input: fixture.path("receipt", receiptOf(permit, { kind: "unconfirmed", reason: "no-response" })),
    }, fixture.repo);
    // note: Exit 0 acknowledges the recorded evidence only; the state is the durable outcome.
    expect(unconfirmed).toMatchObject({ status: "ok", exitCode: 0 });
    expect(dataOf(unconfirmed)).toMatchObject({ state: "unconfirmed" });

    const reconciled = await invoke("store.collaboration.remote.outbox-reconcile", {
      harness: fixture.harness,
      input: fixture.path("reconcile", receiptOf(permit, { kind: "unconfirmed", reason: "ambiguous" })),
    }, fixture.repo);
    expect(reconciled).toMatchObject({ status: "ok", exitCode: 0 });
    expect(dataOf(reconciled)).toMatchObject({ state: "unconfirmed" });

    const confirmed = await invoke("store.collaboration.remote.outbox-receipt", {
      harness: fixture.harness,
      input: fixture.path("confirmed", receiptOf(permit, {
        kind: "confirmed",
        identity: { ...fixture.scope, issueId: IDS.providerIssueId },
        recordId: "abababab-abab-4bab-8bab-abababababab",
        event: permit.frozenRequest.event,
      })),
    }, fixture.repo);
    expect(dataOf(confirmed)).toMatchObject({ state: "confirmed" });
  });

  test("an unconfirmed send blocks the next dispatch and is abandoned only with recorded proof", async () => {
    const { fixture, permit } = await adoptAndDispatch("blocking");
    // note: A second intent of the same project waits behind the first unconfirmed send.
    const queued = await invoke("store.collaboration.remote.adopt-issue", {
      harness: fixture.harness,
      project: IDS.projectId,
      issue: IDS.providerIssueId,
      operation: "13131313-1313-4313-8313-131313131313",
      input: fixture.path("adopt-second", adoption),
    }, fixture.repo);
    expect(queued).toMatchObject({ status: "ok" });

    // invariant: The public recovery for a refused receipt names the cache rebuild for the cause
    // the laundering guard refuses, never a resubmission of that same receipt.
    const waiting = dataOf(await invoke("store.collaboration.remote.outbox-show", {
      harness: fixture.harness,
      operation: "13131313-1313-4313-8313-131313131313",
    }, fixture.repo)) as { projectId: string; generation: number; requestHash: string; binding: { selectorCommit: string } };
    const unsent = await invoke("store.collaboration.remote.outbox-receipt", {
      harness: fixture.harness,
      input: fixture.path("unsent-receipt", {
        version: 1,
        generation: waiting.generation,
        projectId: waiting.projectId,
        selectorCommit: waiting.binding.selectorCommit,
        operationId: "13131313-1313-4313-8313-131313131313",
        attemptId: "18181818-1818-4818-8818-181818181818",
        requestHash: waiting.requestHash,
        observedAt: new Date().toISOString(),
        outcome: { kind: "unconfirmed", reason: "no-response" },
      }),
    }, fixture.repo);
    expect(unsent).toMatchObject({ status: "refused", code: "remote.dispatch-refused", exitCode: 1 });
    const recovery = String(unsent.details?.recovery ?? "");
    expect(recovery).toContain("already holds a recorded conflict receipt never accepts a confirmation");
    expect(recovery).toContain("only the cache rebuild settles it");
    expect(recovery).toContain("settle every other unsettled intent that cache holds");
    expect(recovery).toContain("keep the cache file as evidence under a retained name instead of deleting it");
    expect(recovery).toContain("confirm the checked selector and this checkout's binding satisfy a fresh reviewed bind");
    expect(recovery).toContain("mstar store collaboration remote status --harness <abs>");
    expect(recovery).toContain("perform a fresh reviewed remote bind");
    expect(recovery).not.toContain("then resubmit the receipt");
    // the guard's own sequence: settle, retain, prove the rebind, and only then remove the name.
    const steps = [
      "settle every other unsettled intent",
      "keep the cache file as evidence",
      "confirm the checked selector",
      "remove the name the checkout reads",
      "mstar store collaboration remote status",
    ].map((step) => recovery.indexOf(step));
    for (const at of steps) expect(at).toBeGreaterThan(-1);
    expect([...steps].sort((left, right) => left - right)).toEqual(steps);

    const refused = await invoke("store.collaboration.remote.outbox-abandon", {
      harness: fixture.harness,
      operation: OPERATIONS.adopt,
      reason: "operator lost the response",
    }, fixture.repo);
    expect(refused).toMatchObject({ status: "refused", code: "remote.dispatch-refused", exitCode: 1 });

    const notSent = await invoke("store.collaboration.remote.outbox-receipt", {
      harness: fixture.harness,
      input: fixture.path("not-sent", receiptOf(permit, { kind: "not-sent", code: "host-pre-send-refusal" })),
    }, fixture.repo);
    expect(dataOf(notSent)).toMatchObject({ state: "unconfirmed" });

    const abandoned = await invoke("store.collaboration.remote.outbox-abandon", {
      harness: fixture.harness,
      operation: OPERATIONS.adopt,
      reason: "host refused before send",
    }, fixture.repo);
    expect(dataOf(abandoned)).toMatchObject({ state: "abandoned" });
    const shown = dataOf(await invoke("store.collaboration.remote.outbox-show", {
      harness: fixture.harness,
      operation: OPERATIONS.adopt,
    }, fixture.repo));
    expect(shown).toMatchObject({ state: "abandoned", abandonReason: "host refused before send" });
  });

  test("a conflict is surfaced, resolved under a new id, and dispatched only with fresh fork evidence", async () => {
    const { fixture, permit } = await adoptAndDispatch("conflict");
    const frozen = permit.frozenRequest.event as RemoteEvent;
    const competing = { ...frozen, operationId: "14141414-1414-4414-8414-141414141414" } as RemoteEvent;
    const head = remoteEventHead(competing);
    const recordId = "15151515-1515-4515-8515-151515151515";

    const conflicted = await invoke("store.collaboration.remote.outbox-receipt", {
      harness: fixture.harness,
      input: fixture.path("conflict", receiptOf(permit, {
        kind: "conflict",
        expectedHeads: permit.frozenRequest.expectedHeads,
        observedHeads: [head],
        observedRecords: [{ identity: { ...fixture.scope, issueId: IDS.providerIssueId }, recordId, event: competing }],
      })),
    }, fixture.repo);
    expect(dataOf(conflicted)).toMatchObject({ state: "conflict" });

    // invariant: The original conflicted intent is never rewritten or resent.
    const resend = await invoke("store.collaboration.remote.outbox-dispatch", {
      harness: fixture.harness,
      operation: OPERATIONS.adopt,
    }, fixture.repo);
    expect(resend).toMatchObject({ status: "refused", code: "remote.dispatch-refused" });

    // note: The fixture adopts an issue, so its reviewed repair is an issue-replace that keeps the
    // adopted portable reference and the history both branches carry.
    const adopted = frozen.change;
    if (adopted.kind === "project-replace") throw new Error("the fixture adoption freezes an issue event");
    const reviewedRepair = (operationId: string) => ({
      ...frozen,
      operationId,
      parents: [head],
      change: { kind: "issue-replace" as const, issueRef: adopted.issueRef, mstar: adopted.mstar },
    });
    const resolved = dataOf(await invoke("store.collaboration.remote.outbox-resolve", {
      harness: fixture.harness,
      operation: OPERATIONS.adopt,
      input: fixture.path("resolution", {
        version: 1,
        operationId: OPERATIONS.resolution,
        operator: "ops",
        reason: "the reviewed replacement cites both branches",
        event: reviewedRepair(OPERATIONS.resolution),
      }),
    }, fixture.repo));
    expect(resolved).toMatchObject({ operationId: OPERATIONS.resolution, state: "enqueued" });
    // invariant: One reviewed resolution per fork, and the original intent keeps its conflict.
    const twice = await invoke("store.collaboration.remote.outbox-resolve", {
      harness: fixture.harness,
      operation: OPERATIONS.adopt,
      input: fixture.path("resolution-twice", {
        version: 1,
        operationId: "16161616-1616-4616-8616-161616161616",
        operator: "ops",
        reason: "duplicate review",
        event: reviewedRepair("16161616-1616-4616-8616-161616161616"),
      }),
    }, fixture.repo);
    expect(twice).toMatchObject({ status: "refused", exitCode: 1 });
    expect(dataOf(await invoke("store.collaboration.remote.outbox-show", {
      harness: fixture.harness,
      operation: OPERATIONS.adopt,
    }, fixture.repo))).toMatchObject({ state: "conflict", resolvedBy: OPERATIONS.resolution });

    const bare = await invoke("store.collaboration.remote.outbox-dispatch", {
      harness: fixture.harness,
      operation: OPERATIONS.resolution,
    }, fixture.repo);
    expect(bare).toMatchObject({ status: "refused", code: "remote.dispatch-refused" });
    // invariant: An enqueued resolution missing its fork evidence is recovered by supplying that
    // evidence to the dispatch verb, not by reconciling a send that never happened.
    expect(bare.details?.recovery).toContain("outbox-dispatch");
    expect(bare.details?.recovery).toContain("--input");

    const permitted = dataOf(await invoke("store.collaboration.remote.outbox-dispatch", {
      harness: fixture.harness,
      operation: OPERATIONS.resolution,
      input: fixture.path("fork", {
        version: 1,
        selectorCommit: permit.binding.selectorCommit,
        generation: 3,
        projectId: IDS.projectId,
        conflictOperationId: OPERATIONS.adopt,
        asOf: new Date(Date.now() + 2_000).toISOString(),
        coverage: "complete",
        heads: [{
          recordId,
          issueRef: competing.change.kind === "project-replace" ? "mstar:issue:00000000-0000-4000-8000-000000000000" : competing.change.issueRef,
          head,
        }],
      }),
    }, fixture.repo));
    expect(permitted).toMatchObject({ kind: "permit" });
  });

  test("the domain families report the durable outbox state instead of a queued business success", async () => {
    const fixture = remoteFixture("domains");
    await fixture.bind();
    await fixture.observe(0);

    const cases: Array<[string, Record<string, unknown>]> = [
      ["issue.add", { harness: fixture.harness, operationId: OPERATIONS.capture, actor: "project-manager", payload: capturePayload }],
      ["milestone.add", { harness: fixture.harness, project: IDS.projectId, name: "Outbox milestone", ordinal: 1, expectStore: 1, operation: OPERATIONS.milestone }],
      ["roadmap.replace", {
        harness: fixture.harness,
        project: IDS.projectId,
        file: fixture.text("roadmap-candidate", `---\nproject_id: ${IDS.projectId}\ntitle: Fixture roadmap\nstatus: active\ncreated_at: 2026-01-01\n---\n\n# Fixture roadmap\n\n- one\n`),
        expectProject: 1,
        expectRoadmap: "absent",
        operation: OPERATIONS.roadmap,
      }],
      ["catalog.register", {
        harness: fixture.harness,
        kind: "document",
        id: "fixture-spec",
        title: "Fixture spec",
        rootKind: "specs",
        path: "specs/fixture.md",
        documentKind: "spec",
        expect: 1,
        operationId: OPERATIONS.catalog,
        actor: "project-manager",
        project: IDS.projectId,
      }],
    ];
    for (const [id, input] of cases) {
      const result = await invoke(id, input, fixture.repo);
      // invariant: A durable enqueue is a pending refusal carrying the operation id and state.
      expect(result).toMatchObject({ status: "refused", code: "remote.effect-pending", exitCode: 1 });
      expect(result.status === "refused" ? result.details : {}).toMatchObject({ operationId: expect.any(String), state: "enqueued" });
      expect(result.details?.recovery).toContain("outbox-show");
    }

    // note: The mirror keeps its own command surface and its own inputs: a remote lane holds no
    // mirror ledger, so this verb refuses before recording anything into the cache or a local row.
    const sync = await invoke("issue-sync.pending", { harness: fixture.harness, project: IDS.projectId }, fixture.repo);
    expect(sync).toMatchObject({ status: "refused", exitCode: 1 });
    expect(String(sync.code)).toMatch(/^(linear|collaboration)\./);
    // invariant: That refusal records nothing: all four domain writes stay durably pending.
    const stillPending = dataOf(await invoke("store.collaboration.remote.outbox-pending", {
      harness: fixture.harness,
      project: IDS.projectId,
    }, fixture.repo));
    const intents = stillPending.intents;
    expect(Array.isArray(intents) ? intents.length : -1).toBe(cases.length);
  });

  test("the advertised catalog correction runs through the command surface with its project", async () => {
    const fixture = remoteFixture("catalog-correction");
    await fixture.bind();
    await fixture.observe(0);
    const correction = {
      harness: fixture.harness,
      kind: "project",
      id: IDS.projectId,
      title: "Fixture renamed",
      expect: 1,
      operationId: "00000000-0000-4000-8000-0000000000c1",
      actor: "project-manager",
    };
    // invariant: A remote catalog write appends to ONE project journal. The execution
    // registration's advertised correction therefore carries --project; without it the CLI
    // forwards no project and the engine refuses before enqueuing anything.
    expect(await invoke("catalog.update", correction, fixture.repo)).toMatchObject({
      status: "refused",
      code: "catalog.invalid-entity",
    });
    const corrected = await invoke("catalog.update", { ...correction, project: IDS.projectId }, fixture.repo);
    expect(corrected).toMatchObject({ status: "refused", code: "remote.effect-pending" });
    expect(corrected.details).toMatchObject({ operationId: correction.operationId, state: "enqueued" });
  });

  test("each remote/outbox verb publishes its --input document through the real schema command", async () => {
    const byId = new Map(getCommandDefinitions().map((entry) => [entry.id, entry]));
    const publish = async (command: string) => {
      const schemaCommand = definition("schema");
      const result = await schemaCommand.execute(schemaCommand.input.parse({ command }), invocation(process.cwd()));
      if (result.status !== "ok") throw new Error(`schema ${command} refused: ${JSON.stringify(result)}`);
      const published = atPath(result.data, "descriptor", "payloadSchemas", "inputDocument");
      return published === undefined ? undefined : (published as Record<string, unknown>);
    };
    const withDocument = [
      "store.collaboration.remote.bind",
      "store.collaboration.remote.observe",
      "store.collaboration.remote.adopt-issue",
      "store.collaboration.remote.outbox-dispatch",
      "store.collaboration.remote.outbox-receipt",
      "store.collaboration.remote.outbox-reconcile",
      "store.collaboration.remote.outbox-resolve",
    ];
    for (const id of withDocument) {
      const json = await publish(id);
      expect(json, id).toBeDefined();
      // note: Each document carries its own marker field; the resolution envelope has no
      // version member and the adoption publishes its arms, so the assertion reads
      // the published schema instead of assuming one shape.
      const marker = id.endsWith("adopt-issue") ? "sourceIssue"
        : id.endsWith("outbox-resolve") ? "operator"
          : id.endsWith("outbox-dispatch") ? "conflictOperationId"
            : "version";
      expect(JSON.stringify(json), id).toContain(marker);
      // invariant: The option help names the document by the verb's OWN registered id, so an
      // author can copy the command out of --help and run it.
      const help = String(byId.get(id)?.cli.options.find((option) => option.key === "input")?.help);
      expect(help).toContain(`mstar schema --command ${id}`);
      expect(help).not.toContain("<verb>");
    }
    // note: The observation's own strict document: every envelope field is required.
    const observe = await publish("store.collaboration.remote.observe") as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(observe.properties ?? {})).toEqual([
      "version",
      "selectorCommit",
      "generation",
      "check",
      "expectRevision",
      "snapshot",
    ]);
    for (const id of ["store.collaboration.remote.status", "store.collaboration.remote.outbox-pending", "store.collaboration.remote.outbox-show", "store.collaboration.remote.outbox-abandon"]) {
      expect(byId.get(id)?.payloads, id).toBeUndefined();
      expect(await publish(id), id).toBeUndefined();
    }
  });

  test("receipt and reconciliation publish different documents, and the engine enforces the published shape", async () => {
    const { fixture, permit } = await adoptAndDispatch("published-documents");
    const RECEIPT = "store.collaboration.remote.outbox-receipt";
    const RECONCILE = "store.collaboration.remote.outbox-reconcile";
    const documentOf = (id: string) => {
      const published = definition(id).payloads?.inputDocument?.schema;
      if (published === undefined) throw new Error(`missing published document: ${id}`);
      return published;
    };
    const outcomeKinds = (id: string) =>
      listOf(atPath(documentOf(id).toJSONSchema(), "properties", "outcome", "anyOf"))
        .map((arm) => atPath(arm, "properties", "kind", "const"));

    // invariant: The two verbs publish DIFFERENT outcome documents: a reconciliation reports what
    // a lookup saw, so `not-sent` is absent from the document it advertises.
    expect(outcomeKinds(RECEIPT)).toEqual(["confirmed", "unconfirmed", "conflict", "not-sent"]);
    expect(outcomeKinds(RECONCILE)).toEqual(["confirmed", "unconfirmed", "conflict"]);

    // invariant: The published event is a closed, typed document: the issue arm carries the six
    // typed subject members and every history row closes its own fields, so discovery never
    // advertises a loose map the engine would then reject field by field.
    const issueChange = listOf(atPath(documentOf(RECEIPT).toJSONSchema(), "properties", "outcome", "anyOf"))
      .flatMap((arm) => listOf(atPath(arm, "properties", "event", "properties", "change", "anyOf")))
      .find((arm) => atPath(arm, "properties", "mstar") !== undefined);
    expect(issueChange).toBeDefined();
    for (const member of ["fields", "occurrences", "transitions", "relations", "provenance", "projectMoves"]) {
      expect(atPath(issueChange, "properties", "mstar", "properties", member), member).toBeDefined();
    }
    expect(atPath(issueChange, "properties", "mstar", "additionalProperties")).toBe(false);
    expect(atPath(issueChange, "properties", "mstar", "properties", "occurrences", "items", "additionalProperties")).toBe(false);
    expect(listOf(atPath(issueChange, "properties", "mstar", "properties", "occurrences", "items", "required"))).toContain("eventId");
    expect(listOf(atPath(issueChange, "properties", "mstar", "properties", "transitions", "items", "required"))).toContain("evidence");
    expect(String(atPath(issueChange, "properties", "mstar", "properties", "fields", "properties", "kind", "enum"))).toContain("bug");

    const frozen = permit.frozenRequest.event as RemoteEvent;
    if (frozen.change.kind === "project-replace") throw new Error("the fixture adoption freezes an issue event");
    const accepted = receiptOf(permit, {
      kind: "confirmed",
      identity: { ...fixture.scope, issueId: IDS.providerIssueId },
      recordId: "abababab-abab-4bab-8bab-abababababab",
      event: frozen,
    });
    // invariant: A representative accepted document parses against the published contract...
    expect(documentOf(RECEIPT).safeParse(accepted).success).toBe(true);
    // note: one document with an extra nested event member does not parse, exactly as the engine refuses it.
    const nested = {
      ...accepted,
      outcome: { ...accepted.outcome, event: { ...frozen, change: { ...frozen.change, unsupportedMember: [] } } },
    };
    expect(documentOf(RECEIPT).safeParse(nested).success).toBe(false);

    // invariant: The real engine applies the same split the documents advertise instead of
    // accepting `not-sent` at this verb and rejecting it later.
    const notSent = receiptOf(permit, { kind: "not-sent", code: "host-pre-send-refusal" });
    expect(documentOf(RECEIPT).safeParse(notSent).success).toBe(true);
    expect(documentOf(RECONCILE).safeParse(notSent).success).toBe(false);
    const refused = await invoke(RECONCILE, {
      harness: fixture.harness,
      input: fixture.path("reconcile-not-sent", notSent),
    }, fixture.repo);
    expect(refused).toMatchObject({ status: "refused", code: "remote.input-invalid", exitCode: 1 });
    expect(String(refused.message)).toContain("outbox-receipt");
    expect(refused.details?.recovery).toContain("outbox-reconcile");
  });

  test("one structural refusal answers top-level, unknown and nested defects together", async () => {
    const fixture = remoteFixture("aggregate-structure");
    const result = await invoke("store.collaboration.remote.outbox-receipt", {
      harness: fixture.harness,
      input: fixture.path("bad-structure", {
        version: 2,
        selectorCommit: "not-a-git-object",
        generation: -1,
        projectId: 7,
        operationId: "not-a-uuid",
        attemptId: "also-not",
        requestHash: "short",
        observedAt: "not-a-time",
        outcome: {
          kind: "confirmed",
          recordId: "also-not-a-uuid",
          event: {},
          notAnOutcomeMember: true,
        },
        notAnEnvelopeMember: "surplus",
      }),
    }, fixture.repo);
    expect(result).toMatchObject({ status: "refused", code: "remote.input-invalid", exitCode: 1 });
    const message = String(result.message);
    // invariant: ONE refusal answers the whole document - every invalid envelope field, a surplus
    // top-level member, a surplus outcome member and each nested member the engine cannot read.
    for (const diagnostic of [
      "receipt.version",
      "receipt.selectorCommit",
      "receipt.generation",
      "receipt.projectId",
      "receipt.operationId",
      "receipt.attemptId",
      "receipt.requestHash",
      "receipt.observedAt",
      "receipt.notAnEnvelopeMember",
      "receipt.outcome.notAnOutcomeMember",
      "receipt.outcome.identity",
      "receipt.outcome.recordId",
      "receipt.outcome.event",
    ]) {
      expect(message).toContain(diagnostic);
    }
    // invariant: The refusal names the published document to consult and the correction to resubmit.
    expect(message).toContain("mstar schema --command store.collaboration.remote.outbox-receipt");
    expect(message).toContain("resubmit the corrected --input");
    expect(result.details?.recovery).toContain("outbox-receipt");
  });

  test("a known-good marked observation passes the published observe document and the runtime", async () => {
    const fixture = remoteFixture("published-marked-observation");
    await fixture.bind();
    const check = {
      projectId: IDS.projectId,
      scope: fixture.scope,
      journalIssueId: IDS.journalIssueId,
      checkedAt: new Date(Date.now() - 1_000).toISOString(),
      outcome: {
        kind: "verified",
        readerId: "reader-one",
        writerId: IDS.writerId,
        capabilities: { fullRead: true, appendOnly: true, exactLookup: true, fieldFidelity: true, privateAudience: true },
      },
    };
    const markedIssueRef = "mstar:issue:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const observedAt = new Date(Date.now() - 5_000).toISOString();
    const document = {
      version: 1,
      selectorCommit: fixture.commit,
      generation: 3,
      check,
      expectRevision: 0,
      snapshot: {
        asOf: observedAt,
        coverage: { kind: "complete" },
        project: {
          projectId: IDS.projectId,
          head: ["1".repeat(64)],
          binding: fixture.scope,
          milestones: [],
          roadmap: null,
          catalogEntities: [
            { kind: "project", id: IDS.projectId, title: "Fixture", description: null, documentKind: null, lifecycle: "active", revision: 1 },
          ],
          catalogLinks: [],
        },
        issues: [
          {
            identity: { ...fixture.scope, issueId: IDS.providerIssueId },
            nativeTitle: "Marked native issue",
            nativeStatus: "Todo",
            providerUpdatedAt: observedAt,
            mstar: {
              issueRef: markedIssueRef,
              head: ["2".repeat(64)],
              fields: {
                title: "Marked finding",
                kind: "bug",
                severity: "high",
                disposition: "open",
                impact: "the published schema must accept a marked observation",
                acceptance: "the engine and the descriptor agree",
                owner: null,
                registeredAt: observedAt,
                closedAt: null,
                closureNote: null,
                createdAt: observedAt,
                updatedAt: observedAt,
                revision: 1,
                milestoneId: null,
              },
              occurrences: [],
              transitions: [],
              relations: [],
              provenance: [],
              projectMoves: [],
            },
          },
        ],
      },
    };
    // invariant: The published document accepts the marked observation shape the engine itself
    // requires — `fields` included — so discovery never refuses a document the runtime accepts.
    const schema = definition("store.collaboration.remote.observe").payloads?.inputDocument?.schema;
    expect(schema).toBeDefined();
    expect(schema!.safeParse(document).success).toBe(true);
    // invariant: The same document through the real command: accepted end to end.
    const result = await invoke("store.collaboration.remote.observe", {
      harness: fixture.harness,
      input: fixture.path("marked-observe", document),
    }, fixture.repo);
    expect(result).toMatchObject({ status: "ok", exitCode: 0 });
  });

  test("one refusal aggregates unknown keys and every nested defect of a receipt", async () => {
    const fixture = remoteFixture("aggregate-nested-defects");
    const result = await invoke("store.collaboration.remote.outbox-receipt", {
      harness: fixture.harness,
      input: fixture.path("bad-nested", {
        version: 1,
        selectorCommit: fixture.commit,
        generation: 3,
        projectId: IDS.projectId,
        operationId: "00000000-0000-4000-8000-0000000000d1",
        attemptId: "00000000-0000-4000-8000-0000000000d2",
        requestHash: "a".repeat(64),
        observedAt: new Date().toISOString(),
        outcome: {
          kind: "confirmed",
          identity: { ...fixture.scope, issueId: "not-a-uuid", workspaceId: "not-a-uuid", teamId: "also-not", surplusKey: true },
          recordId: "00000000-0000-4000-8000-0000000000d3",
          event: {
            version: 1,
            repoKey: 7,
            projectId: "",
            operationId: "also-not",
            parents: "not-a-list",
            change: { kind: "issue-create", issueRef: "not-a-reference", mstar: {} },
          },
        },
      }),
    }, fixture.repo);
    expect(result).toMatchObject({ status: "refused", code: "remote.input-invalid", exitCode: 1 });
    const message = String(result.message);
    // invariant: ONE refusal answers every structural defect — the unknown identity key, BOTH bad
    // scope ids, the bad issue id, and each bad event member — instead of one defect per attempt.
    for (const diagnostic of [
      "receipt.outcome.identity.surplusKey",
      "receipt.outcome.identity.workspaceId",
      "receipt.outcome.identity.teamId",
      "receipt.outcome.identity.issueId",
      "receipt.outcome.event.repoKey",
      "receipt.outcome.event.projectId",
      "receipt.outcome.event.operationId",
      "receipt.outcome.event.parents",
      "receipt.outcome.event.change.issueRef",
      "receipt.outcome.event.change.mstar",
    ]) {
      expect(message).toContain(diagnostic);
    }
    expect(message).toContain("mstar schema --command store.collaboration.remote.outbox-receipt");
  });

  test("one receipt refusal aggregates the subject's field and history defects through the published command", async () => {
    const fixture = remoteFixture("aggregate-subject-defects");
    const document = {
      version: 1,
      selectorCommit: fixture.commit,
      generation: 3,
      projectId: IDS.projectId,
      operationId: "00000000-0000-4000-8000-0000000000d4",
      attemptId: "00000000-0000-4000-8000-0000000000d5",
      requestHash: "b".repeat(64),
      observedAt: new Date().toISOString(),
      outcome: {
        kind: "confirmed",
        identity: { ...fixture.scope, issueId: IDS.providerIssueId },
        recordId: "00000000-0000-4000-8000-0000000000d6",
        event: {
          version: 1,
          repoKey: "fixture-repo",
          projectId: IDS.projectId,
          operationId: "00000000-0000-4000-8000-0000000000d7",
          parents: ["c".repeat(64)],
          change: {
            kind: "issue-replace",
            issueRef: "mstar:issue:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            mstar: {
              fields: {
                title: 7,
                kind: "bug",
                severity: "high",
                disposition: "open",
                impact: "i",
                acceptance: "a",
                owner: null,
                registeredAt: null,
                closedAt: null,
                closureNote: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                revision: -1,
                milestoneId: null,
              },
              occurrences: [
                null,
                {
                  eventId: "not-a-uuid",
                  occurrenceKey: "k",
                  sourceKind: "review",
                  sourceIdentity: "review:x",
                  rootCauseKey: "x.cause",
                  acceptanceKey: "x.acceptance",
                  location: "l",
                  observedBehavior: "b",
                  evidence: [],
                  discoveredAt: null,
                  recordedAt: new Date().toISOString(),
                  imported: false,
                },
              ],
              transitions: [],
              relations: [],
              provenance: [],
              projectMoves: [],
            },
          },
        },
      },
    };
    // invariant: The published document — engine-owned since the convergence — reports all
    // three defects of the known event arm together, exactly as the runtime refusal does.
    const schema = definition("store.collaboration.remote.outbox-receipt").payloads?.inputDocument?.schema;
    expect(schema).toBeDefined();
    const parsed = schema!.safeParse(document);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // note: The outcome and its `change` are unions of arms, so zod v4 nests each arm's issues
      // under the union issue's `errors`; every level is walked for the together-report assertion.
      const paths: string[] = [];
      const pending = [...parsed.error.issues];
      while (pending.length > 0) {
        const issue = pending.shift() as { path: PropertyKey[]; errors?: unknown };
        paths.push(issue.path.join("."));
        if (Array.isArray(issue.errors)) pending.push(...(issue.errors as unknown[]).flat() as { path: PropertyKey[] }[]);
      }
      const joined = paths.join("\n");
      // note: Inside a union arm zod v4 reports the path relative to the union value, so the
      // subject defects appear under their `mstar.` prefix; the together-report assertion reads
      // those.
      for (const defect of [
        "mstar.fields.title",
        "mstar.fields.revision",
        "mstar.occurrences.0",
        "mstar.occurrences.1.eventId",
      ]) {
        expect(joined).toContain(defect);
      }
    }
    const result = await invoke("store.collaboration.remote.outbox-receipt", {
      harness: fixture.harness,
      input: fixture.path("bad-subject", document),
    }, fixture.repo);
    expect(result).toMatchObject({ status: "refused", code: "remote.input-invalid", exitCode: 1 });
    const message = String(result.message);
    // invariant: ONE runtime refusal answers the whole known event arm — both bad subject fields
    // and BOTH malformed history entries, the second after the first — so the caller corrects the
    // document in one pass instead of discovering one sibling per submission.
    for (const diagnostic of [
      "receipt.outcome.event.change.mstar.fields.title",
      "receipt.outcome.event.change.mstar.fields.revision",
      "receipt.outcome.event.change.mstar.occurrences[0]: must be an object",
      "receipt.outcome.event.change.mstar.occurrences[1].eventId",
    ]) {
      expect(message).toContain(diagnostic);
    }
  });

  test("one receipt refusal lists every invalid envelope field at once", async () => {
    const fixture = remoteFixture("aggregate-refusal");
    const result = await invoke("store.collaboration.remote.outbox-receipt", {
      harness: fixture.harness,
      input: fixture.path("bad-envelope", {
        version: 2,
        selectorCommit: "not-a-git-object",
        generation: -1,
        projectId: 7,
        operationId: "not-a-uuid",
        attemptId: "also-not",
        requestHash: "short",
        observedAt: "not-a-time",
        outcome: { kind: "confirmed" },
      }),
    }, fixture.repo);
    expect(result).toMatchObject({ status: "refused", code: "remote.input-invalid", exitCode: 1 });
    const message = String(result.message);
    // invariant: EVERY invalid envelope field is named by the ONE refusal, so the caller
    // fixes the whole document per attempt instead of discovering one field per submission.
    for (const field of [
      "receipt.version",
      "receipt.selectorCommit",
      "receipt.generation",
      "receipt.projectId",
      "receipt.operationId",
      "receipt.attemptId",
      "receipt.requestHash",
      "receipt.observedAt",
    ]) {
      expect(message).toContain(field);
    }
  });
});
