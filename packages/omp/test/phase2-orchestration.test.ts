/**
 * Phase-2 settings normalization and bounded reminder decision — scoped contract
 * checks for `packages/omp/src/phase2-orchestration.ts` (plan
 * `20260916-omp-phase2-instances` T1, primary spec §B/§C).
 *
 * The decision cases are pure. They pin the once-per-changed-state latch, the
 * owner/phase and unavailable-snapshot inertness, native-delivery suppression,
 * and blocker/user-steering precedence — decision outcomes only, not the claim
 * that a host event adapter calls the decision (that wiring is T3's separately
 * reviewed surface, and no static assertion here can substitute for it). The
 * changed-idle path is exercised through the real latch lifecycle — a running
 * observation that is reminded, then a changed idle one — never by seeding a
 * latch state that lifecycle could not produce.
 *
 * The reader case exercises the real host `getPluginSettings` helper in a child
 * bun process whose `HOME` points at a disposable host root. Each child refuses
 * to run unless the helper still resolves to the seeded disposable root, so a
 * broken redirect fails the test instead of reading or writing the operator's
 * real plugin settings.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  decidePhase2Reminder,
  decodePhase2Settings,
  type Phase2Observation,
  type ReminderContext,
  type ReminderState,
} from "../src/phase2-orchestration";

const PACKAGE_DIR = join(import.meta.dir, "..");
const MODULE_PATH = join(PACKAGE_DIR, "src", "phase2-orchestration.ts");
const PLUGIN_NAME = "@mstar-harness/omp";
/** Sentinel plugin seeded into each disposable root; a child that cannot read it must not run. */
const SENTINEL_PLUGIN = "mstar-phase2-settings-probe";
/** Prefix the child prints its result with, so unrelated host output cannot be mistaken for it. */
const RESULT_MARKER = "MSTAR_PHASE2_PROBE_RESULT ";

/** Observable reader shape this test expects, independent of the module's own types. */
type SettingsResult =
  | { ok: true; value: { phase2PlanInstances: boolean; maxPlanInstances: number } }
  | { ok: false; reason: string; message: string };

/* --- decision fixtures: observations, latch states, a bound coordinator context - */

const RUNNING_STATE_A: Phase2Observation = {
  key: "state-a",
  hasRunningJobs: true,
  nativeDeliveryPending: false,
  recentTerminalIds: [],
};

const IDLE_STATE_B: Phase2Observation = { ...RUNNING_STATE_A, key: "state-b", hasRunningJobs: false };

const FRESH_LATCH: ReminderState = { acknowledgedKey: null, remindedKeys: [], blocked: false };

/** Latch after one real emission: the caller records the key before sending (spec §B). */
const AFTER_REMINDING_A: ReminderState = { acknowledgedKey: null, remindedKeys: ["state-a"], blocked: false };

const BOUND_PHASE2: ReminderContext = {
  boundPhase2: true,
  pendingMessages: false,
  userTurn: false,
  snapshotAvailable: true,
};

/** Decision under the bound Phase-2 context, with one fact overridden per case. */
function evaluate(
  state: ReminderState,
  observation: Phase2Observation,
  overrides: Partial<ReminderContext> = {},
): "silent" | "remind" {
  return decidePhase2Reminder(state, observation, { ...BOUND_PHASE2, ...overrides });
}

describe("phase2 settings normalization", () => {
  test("launch opt-in does not gate reminders", () => {
    // Default (disabled) opt-in: install/update leaves extra primaries off.
    expect(decodePhase2Settings({})).toEqual({
      ok: true,
      value: { phase2PlanInstances: false, maxPlanInstances: 2 },
    });

    // The decision surface has no settings channel at all: an eligible
    // observation is reminded regardless of the launch opt-in.
    expect(evaluate(FRESH_LATCH, RUNNING_STATE_A)).toBe("remind");

    // The opt-in is launch-only and never rewrites the saved capacity.
    expect(decodePhase2Settings({ phase2PlanInstances: false, maxPlanInstances: 5 })).toEqual({
      ok: true,
      value: { phase2PlanInstances: false, maxPlanInstances: 5 },
    });
  });

  test("malformed capacity refuses instead of coercing", () => {
    for (const malformed of [0, -1, 2.5, NaN, Infinity, "3", null, true, Number.MAX_SAFE_INTEGER + 1]) {
      expect(decodePhase2Settings({ maxPlanInstances: malformed })).toMatchObject({
        ok: false,
        reason: "invalid-settings",
        message: expect.stringContaining("maxPlanInstances"),
      });
    }

    // A present non-boolean opt-in is refused too — never read as "enabled".
    expect(decodePhase2Settings({ phase2PlanInstances: "true" })).toMatchObject({
      ok: false,
      reason: "invalid-settings",
      message: expect.stringContaining("phase2PlanInstances"),
    });

    // Present `undefined` is a malformed present value, not a missing key: the
    // refusal yields no usable value, so nothing can enter launch admission as
    // a valid capacity or a valid opt-in.
    const undefinedCapacity = decodePhase2Settings({ maxPlanInstances: undefined });
    expect(undefinedCapacity).toMatchObject({
      ok: false,
      reason: "invalid-settings",
      message: expect.stringContaining("maxPlanInstances"),
    });
    expect("value" in undefinedCapacity).toBe(false);

    const undefinedOptIn = decodePhase2Settings({ phase2PlanInstances: undefined });
    expect(undefinedOptIn).toMatchObject({
      ok: false,
      reason: "invalid-settings",
      message: expect.stringContaining("phase2PlanInstances"),
    });
    expect("value" in undefinedOptIn).toBe(false);

    // Configurable, not a ceiling of 2: the minimum is accepted and larger
    // values pass through unchanged.
    for (const valid of [1, 3, 64]) {
      expect(decodePhase2Settings({ maxPlanInstances: valid })).toEqual({
        ok: true,
        value: { phase2PlanInstances: false, maxPlanInstances: valid },
      });
    }
  });

  test("absent keys use the schema defaults per key", () => {
    expect(decodePhase2Settings({ phase2PlanInstances: true })).toEqual({
      ok: true,
      value: { phase2PlanInstances: true, maxPlanInstances: 2 },
    });
    expect(decodePhase2Settings({ maxPlanInstances: 4 })).toEqual({
      ok: true,
      value: { phase2PlanInstances: false, maxPlanInstances: 4 },
    });
    // Another feature's keys in the same record are ignored, not rejected.
    expect(decodePhase2Settings({ modelHandoff: true, handoffTarget: "@smol" })).toEqual({
      ok: true,
      value: { phase2PlanInstances: false, maxPlanInstances: 2 },
    });
  });
});

/* --- native reader: real host helper against a disposable host root ---------- */

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function makeScratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** Native user-scope settings file of a host root using the default (non-XDG) layout. */
function userSettingsPath(hostRoot: string): string {
  return join(hostRoot, ".omp", "plugins", "omp-plugins.lock.json");
}

/** Disposable host root, pre-seeded so a child can prove it reads this root. */
function disposableHostRoot(): { root: string; settingsPath: string } {
  const root = makeScratch("omp-phase2-host-");
  const settingsPath = userSettingsPath(root);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({ plugins: {}, settings: { [SENTINEL_PLUGIN]: { disposableRoot: true } } }, null, 2),
  );
  return { root, settingsPath };
}

/**
 * Run `body` in a child bun process whose `HOME`, user-scope plugin settings and
 * project root are all disposable, with `project`, `lockPath`, `pluginName` and
 * the module under test's `readPhase2Settings` already in scope.
 */
function runProbe<T>(body: string, hostRoot: { root: string }, projectDir: string): T {
  const script = `
import { writeFileSync } from "node:fs";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { readPhase2Settings } from ${JSON.stringify(MODULE_PATH)};

const project = process.env.MSTAR_PROBE_PROJECT;
const lockPath = process.env.MSTAR_PROBE_LOCK;
const pluginName = ${JSON.stringify(PLUGIN_NAME)};
const seed = await getPluginSettings(${JSON.stringify(SENTINEL_PLUGIN)}, project);
if (seed.disposableRoot !== true) {
  throw new Error("native plugin settings did not resolve to the disposable host root; refusing to run");
}
console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify(await (async () => { ${body} })()));
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: PACKAGE_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: hostRoot.root,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      LANG: process.env.LANG ?? "C.UTF-8",
      MSTAR_PROBE_PROJECT: projectDir,
      MSTAR_PROBE_LOCK: userSettingsPath(hostRoot.root),
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`phase2 settings probe failed (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  const reported = result.stdout
    .split("\n")
    .filter((line) => line.startsWith(RESULT_MARKER))
    .pop();
  if (reported === undefined) {
    throw new Error(`phase2 settings probe reported no result:\n${result.stdout}`);
  }
  return JSON.parse(reported.slice(RESULT_MARKER.length)) as T;
}

describe("native phase2 settings reader", () => {
  test("rereads the saved preference and refuses a malformed persisted capacity", () => {
    const hostRoot = disposableHostRoot();
    const projectDir = makeScratch("omp-phase2-project-");

    const observed = runProbe<{
      unreadable: SettingsResult;
      malformedCapacity: SettingsResult;
      saved: SettingsResult;
    }>(
      `
    writeFileSync(lockPath, "{ this is not json");
    const unreadable = await readPhase2Settings(project);
    writeFileSync(lockPath, JSON.stringify({ plugins: {}, settings: { [pluginName]: { phase2PlanInstances: true, maxPlanInstances: 0 } } }));
    const malformedCapacity = await readPhase2Settings(project);
    writeFileSync(lockPath, JSON.stringify({ plugins: {}, settings: { [pluginName]: { phase2PlanInstances: true, maxPlanInstances: 4 } } }));
    const saved = await readPhase2Settings(project);
    return { unreadable, malformedCapacity, saved };
    `,
      hostRoot,
      projectDir,
    );

    // An unreadable settings store is reported, never read as "defaults".
    expect(observed.unreadable).toMatchObject({ ok: false, reason: "settings-read-failed" });
    // A persisted malformed capacity refuses visibly: it is neither coerced to
    // the default 2 nor accepted as an unbounded mode.
    expect(observed.malformedCapacity).toMatchObject({
      ok: false,
      reason: "invalid-settings",
      message: expect.stringContaining("maxPlanInstances"),
    });
    // Both values persisted by the host are observed on the next read of the
    // same process — no cached effective-settings snapshot.
    expect(observed.saved).toEqual({
      ok: true,
      value: { phase2PlanInstances: true, maxPlanInstances: 4 },
    });
  });
});

describe("bounded reminder decision", () => {
  test("owner and phase scope stays inert", () => {
    // Not the bound Phase-2 coordinator of the active iteration: leaf, scoped
    // plan PM, other workflow and Phase 1/3-6 sessions all arrive as `false`.
    expect(evaluate(FRESH_LATCH, RUNNING_STATE_A, { boundPhase2: false })).toBe("silent");
    // A null (unavailable) native snapshot is not "no jobs".
    expect(evaluate(FRESH_LATCH, RUNNING_STATE_A, { snapshotAvailable: false })).toBe("silent");
    // Unavailable wins over a would-be eligible observation even once a latch exists.
    expect(
      evaluate(
        { acknowledgedKey: "state-a", remindedKeys: ["state-a"], blocked: false },
        IDLE_STATE_B,
        { snapshotAvailable: false },
      ),
    ).toBe("silent");
  });

  test("unavailable snapshot stays silent instead of reporting idle", () => {
    expect(evaluate(FRESH_LATCH, { ...IDLE_STATE_B, key: "state-idle" }, { snapshotAvailable: false })).toBe(
      "silent",
    );
    expect(evaluate(AFTER_REMINDING_A, IDLE_STATE_B, { snapshotAvailable: false })).toBe("silent");
  });

  test("first idle sample with no latch stays silent by design", () => {
    // Spec §B requires "running work or a changed engine/transport
    // observation". With no latched key there is nothing this sample can differ
    // from, so an idle, unchanged Phase-2 entry is not an overlooked
    // opportunity. This is designed semantics, not a defect — and it is why the
    // caller's real latch (an emission or a checkpoint) is the baseline.
    expect(evaluate(FRESH_LATCH, IDLE_STATE_B)).toBe("silent");
  });

  test("one reminder per changed observation state", () => {
    // Real lifecycle step 1: a running observation gets its single advisory,
    // and the caller records that key before sending.
    expect(evaluate(FRESH_LATCH, RUNNING_STATE_A)).toBe("remind");
    // Same opportunity state again: an unchanged state never re-fires.
    expect(evaluate(AFTER_REMINDING_A, RUNNING_STATE_A)).toBe("silent");
    // Real lifecycle step 2: the opportunity then changes to an idle one
    // (freed capacity, dependency/ownership change) with nothing running. The
    // latch established by that real emission is enough to let it through.
    expect(evaluate(AFTER_REMINDING_A, IDLE_STATE_B)).toBe("remind");
    // And once reminded, that changed state is latched too.
    expect(evaluate({ acknowledgedKey: null, remindedKeys: ["state-a", "state-b"], blocked: false }, IDLE_STATE_B))
      .toBe("silent");
  });

  test("acknowledged opportunity state stays silent", () => {
    // `acknowledgedKey` is written by a real `checkpoint` (PM ran the shared
    // scheduling checkpoint against that sampled state), so the same state is
    // not re-advertised. This asserts acknowledgement suppression only; the
    // change-detection baseline is proven by the real lifecycle case above.
    expect(evaluate({ acknowledgedKey: "state-a", remindedKeys: [], blocked: false }, RUNNING_STATE_A)).toBe(
      "silent",
    );
    // A real checkpoint latches the state it acknowledged, not the future: a
    // later changed state is still eligible.
    expect(evaluate({ acknowledgedKey: "state-a", remindedKeys: [], blocked: false }, IDLE_STATE_B)).toBe("remind");
  });

  test("replayed observation never repeats", () => {
    // Both keys were recorded by real decisions/checkpoints earlier in the session.
    const replayed: ReminderState = { acknowledgedKey: null, remindedKeys: ["state-a", "state-b"], blocked: false };
    expect(evaluate(replayed, RUNNING_STATE_A)).toBe("silent");
    expect(evaluate(replayed, IDLE_STATE_B)).toBe("silent");
    // A -> B -> A after a session rebuild: the replayed A key is still latched.
    expect(evaluate(replayed, RUNNING_STATE_A)).toBe("silent");
    // Only a genuinely new state is eligible again.
    expect(evaluate(replayed, { ...RUNNING_STATE_A, key: "state-c" })).toBe("remind");
  });

  test("native delivery suppresses reminder", () => {
    expect(evaluate(FRESH_LATCH, { ...RUNNING_STATE_A, nativeDeliveryPending: true })).toBe("silent");
    // A settled job the host delivery already owns: no plugin notice, no reproduced text.
    expect(evaluate(FRESH_LATCH, { ...RUNNING_STATE_A, key: "state-settled", recentTerminalIds: ["job-9"] })).toBe(
      "silent",
    );
  });

  test("blocker and user steering win", () => {
    // A real blocker outranks a brand-new eligible state.
    expect(evaluate({ ...FRESH_LATCH, blocked: true }, { ...RUNNING_STATE_A, key: "state-new" })).toBe("silent");
    // Explicit user steering: the user's own turn is the continuation.
    expect(evaluate(FRESH_LATCH, { ...RUNNING_STATE_A, key: "state-new" }, { userTurn: true })).toBe("silent");
    // A queued message already continues the session.
    expect(evaluate(FRESH_LATCH, { ...RUNNING_STATE_A, key: "state-new" }, { pendingMessages: true })).toBe("silent");
  });

  test("uncomputable observation key stays silent", () => {
    // An empty key means the caller could not build the canonical projection;
    // it is never latched as if it were a real observation.
    expect(evaluate(FRESH_LATCH, { ...RUNNING_STATE_A, key: "" })).toBe("silent");
  });
});
