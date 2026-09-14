# skill-eval baseline (Spec A1)

Maintenance-only evaluation harness for reproducible skill comparisons. This
directory delivers the full Spec A1 pipeline: **prepare** (frozen case set +
immutable manifest v1), **run** (argv-array subprocess execution with evidence
capture and a resumable scheduler), and **report** (JSON + Markdown aggregation
that never reruns a model).

## Canonical CLI (Spec A1)

There is deliberately **no CLI**: the harness is fully automated and
test-driven. Stages are invoked programmatically via their exported functions:

```ts
import { prepareManifest } from "./manifest.ts";   // stage 1: frozen manifest + fixtures
import { executeManifest } from "./runner.ts";     // stage 2: argv-array subprocess execution (launchFn injected)
import * as report from "./report.ts";             // stage 3: JSON + Markdown aggregation over recorded evidence
```

Paths passed to these functions must resolve strictly inside
`<repoRoot>/.tmp/skill-eval/` for run-side writes; `$EVAL_MANIFEST` is the
absolute prepared `manifest.json` path — never under HOME/CODEX_HOME.

Stage `exit` conventions (Spec A1), returned in each stage result:

| Stage | 0 | 1 | 2 |
|---|---|---|---|
| `prepare` | manifest + fixtures written | — | invalid config/cases/target |
| `run` | all requested units verified passes | completed assertion failures only | infrastructure failure, unverified required evidence, or pending units |
| `report` | same conventions as `run`, over recorded evidence only | | |

Invalid input (bad args, sampling-lock violations, manifest/state mismatches)
is `exit 2` with zero spawns. `prepare` completes every validation (including
the symlink-ancestor realpath walk) **before** any `mkdir`, so a rejected
prepare creates nothing — not even the gitignored disposable root.
`run`/`report` enforce the same disposable-root write containment: a manifest
whose run dir is not strictly inside `<repoRoot>/.tmp/skill-eval/` (e.g. a
runnable manifest copied into a durable evidence tree) is refused with exit 2,
zero spawns, zero writes.

## What prepare does

- Validates the runner-owned **nonsecret** config and the frozen 30-case set.
- Resolves **manifest v1**: pinned full-SHA source refs, CLI identity, config
  hash, per-arm skill/reference closure hashes (`sha256`), per-case fixture
  and integrity hashes, and a **heldout digest frozen before any tuning**.
- **Closure scope (C-W3):** the per-arm closure is the complete reachable
  skill/reference closure of the pinned ref — `git ls-tree -r` over
  `skills/` **plus** the repo-root `AGENTS.md` and `commands/` surfaces skill
  content load-bearingly references (the real smoke proved codex injects
  AGENTS.md). Host plugin mirrors (`.cursor-plugin/`, `.codex-plugin/`, …)
  are derived bundles and stay excluded; deep link-graph reachability
  extraction is Plan 02's `closure.test.ts` scope (Spec A5).
- Materializes case fixtures **only** under the disposable root
  `<repoRoot>/.tmp/skill-eval/` (gitignored). Real main/control checkouts are
  never a write target; symlink escapes are rejected.
- Performs **zero model calls**. The only production subprocess is read-only
  git (`git ls-tree -r -z <sha> -- AGENTS.md commands skills` +
  `git cat-file blob`), routed through a single injected exec seam so tests
  can spy on it (spy count = 0 in the prepare suite).

Exit codes (Spec A1): `0` = immutable manifest + fixtures written; `2` =
invalid config/cases/target, nothing written anywhere (validation, including
the containment realpath walk, completes before the first `mkdir`).

Prepare is the exported `prepareManifest` function; the runner and report
stages call these exported functions unchanged.

Example config (all fields required; no secret-shaped keys — secret-looking
config keys are rejected because `configHash` covers runner-owned nonsecret
configuration only):

```json
{
  "plan": "20991231-example-skill-eval",
  "sourceRefs": { "baseline": "<40-hex sha>", "candidate": "<40-hex sha>" },
  "cli": { "path": "/opt/homebrew/bin/codex", "version": "codex-cli 0.144.1", "helpHash": "<64-hex sha256 of recorded help output>" },
  "requestedModel": null,
  "requestedModelReason": "no named-model override authorized",
  "observedModel": null,
  "observedModelReason": "unverified until smoke",
  "ambient": { "status": "engine-advisory", "evidence": "how the ambient harness was measured" },
  "sandbox": "read-only",
  "timeoutMs": 600000,
  "repeats": 1,
  "interleaveSeed": 20260907
}
```

## Case set (`cases.json`)

30 frozen cases: five routes (`pm`, `dev`, `qc`, `audit`, `close`) x six, each
route **4 dev + 2 heldout** (20 dev / 10 heldout overall). Coverage is
validated, not decorative — the set must include (coverage tags in
`provenance.coverage`):

- normal completion, unauthorized request, legitimate repair / authorized
  exception;
- first-turn and first/resume pairs (`resumePrompt` cases carry a
  `thread_reused` assertion);
- `preset-none` and `preset-standard`, `engine-absent`, `engine-advisory`,
  `engine-blocking`;
- false-pass and wrong-checkout traps.

Smoke is a **derived** selection: exactly 3 existing dev cases tagged
`provenance.smoke` carrying the tags `smoke-readonly-closure-sentinel`,
`smoke-isolated-relative-write`, `smoke-explicit-resume` (Spec A1 smoke
rules). `--split smoke` selects these; case records themselves only carry
`dev` / `heldout` splits — any other split is rejected as unknown.

Fixtures are compact inline JSON (`fixture.files[{path, content}]`), synthetic
by design — they never clone the real AGENTS.md, credentials, or parent
`.mstar` state. Cases asserting writes must run under a `workspace-write`
sandbox override; the global default is `read-only`.

Provenance: cases adapted from
`.cursor/skills/mstar-routing-eval/assets/routing-evals.json` (v27) cite the
seed case id; new cases carry an explicit note. Assertions use mechanical
kinds (`final_contains`, `final_not_contains`, `tool_read_contains`,
`tool_read_not_contains`, `diff_paths_within`, `thread_reused`); semantic
grades still require reviewer rationale at grading time (Task 2+, Spec A1).

**Corpus v2 assertion contract.**
Corpus v1's `final_contains` literals were English prose while every prompt is
Chinese, and 18 needles were `tool_read_contains("AGENTS.md")` — a string the
real host injects WITHOUT a tool-read event, so those assertions graded
host-injection mechanics instead of task success. Corpus v2 is language-neutral
and host-observable by rule:

- Final assertions are keyed to **marker/sentinel tokens the case instructs the
  model to emit** (mirroring the closure-sentinel pattern that passed both arms
  in the round-1 smoke): each fixture AGENTS.md (or skill file) defines a
  marker protocol, the prompt asks for the protocol's result line, and the
  assertion pins the exact decision-bearing token (e.g. `RESULT:
  REFUSED-BRANCH-GATE`, `CONSOLIDATED-DECISION: UNCONFIRMED`). Fixture-derived
  tokens (skill sentinels, decoy values, code lines, finding ids, section
  headings) remain valid anchors because they are language-independent.
- `tool_read_*` matches the **verified real event schema**: an observed read is
  a read-shaped item (`command_execution` etc.) whose typed `command` argv
  contains the needle. Command *output* that merely mentions a path is not a
  read; agent-message claims are never reads. `AGENTS.md` is never a
  `tool_read_*` needle — its loading is asserted only through observable
  compliance (markers), never through injected-context assumptions.
- `close-dev-4-resume-interrupted-close` is unchanged verbatim: its round-1
  failure was a REAL out-of-allowed-set write (isolation finding), not a
  case-design artifact.

This re-version was adjudicated BEFORE any round-2 execution; no assertion was
edited after seeing round-2 results.

## Manifest v1 (output `manifest.json`)

Top-level: `schemaVersion=1`, `plan`, `sourceRefs{baseline,candidate}` (full
SHAs only — branch names / HEAD / short SHAs are rejected as mutable refs),
`cli{path,version,helpHash}`, `requestedModel`/`observedModel` (null + reason
when unavailable — never invented), `configHash` (sha256 over runner-owned
nonsecret config fields), `casesHash` (sha256 of `cases.json` bytes),
`ambient{status,evidence}`, `variants[{id,sourceRef,closure:[{path,sha256}]}]`
(`baseline` and `candidate` resolved from their own refs; `minimal` has an
empty closure and derives from the candidate ref), `cases[]` (id, route,
split, sandbox, fixture hash + per-file sha256, prompt, optional
resumePrompt, assertions, provenance, `integrityHash`), global
`sandbox`/`timeoutMs`/`repeats`/`interleaveSeed`, and `heldoutDigest`.

Immutability discipline: prepare writes the manifest once; `run` must never
mutate it or refresh refs. Cross-arm closure edges (a closure hash that
belongs to the other arm) and stale hashes are rejected at prepare.
`heldoutDigest` versions held-out integrity hashes **before tuning** —
blinding is procedural; a heldout failure ends candidate adoption (Spec A1).

Canonical run ID: `case/variant/repeat/turn`, e.g.
`dev-dev-1-smoke-readonly-closure-sentinel/baseline/1/1`; turn 1 = first
turn, turn >= 2 = resume turns. The runner copies each prepared fixture into
a fresh per-unit workspace (hash-verified) — the case fixture content carries
each arm's sentinel; manifest closures remain provenance/freeze evidence and
are not materialized into workspaces.

## Verification

```bash
bun test scripts/skill-eval/runner.test.ts
```

All model-facing test suites run on a clearly tagged SYNTHETIC adapter;
synthetic suites prove scheduler/parser/grading correctness only, never
behavioral success (Spec A1).

## Real-run provenance limits (Task 3 baseline smoke, 2026-09-07)

First real smoke (`--split smoke --variants baseline,minimal --repeats 1`,
codex-cli 0.144.1 at `/opt/homebrew/bin/codex`, 8 spawns, 0 infrastructure
errors) established:

- **Harness mechanics work on the real CLI**: thread ids captured from real
  `thread.started` events; explicit-id resume corroborated by argv + event
  stream; workspace-write fixtures wrote only inside their allowed relative
  paths; read-only fixtures produced zero writes; the closure sentinel was
  read from `skills/demo/SKILL.md` and quoted exactly, with no opposite-arm
  sentinel appearing.
- **Usage semantics observed**: every real `turn.completed` carries a usage
  object (`input_tokens`, `cached_input_tokens`, `output_tokens`,
  `reasoning_output_tokens`). Resume turn 2 reported higher input tokens than
  turn 1 in both resume units, consistent with input tokens including the
  replayed conversation. The runner still records `usageBasis: "unknown"`
  with aggregate counters `null + reason` (per-event values preserved) —
  attribution is an adjudication decision, not a runner assumption.
- **Observed model identity: not present.** No model-identity field appears
  anywhere in the real `codex exec --json` event streams
  (`thread.started`/`turn.started`/`item.*`/`turn.completed`), so
  `observedModel` stays `null` + reason and no fixed-model efficacy claim is
  possible from this evidence.
- **Smoke exit was 1 (real assertion failures, honestly recorded).** All six
  units completed; the raw grading records count **10 failed assertions: 8
  `final_contains` + 2 `tool_read_contains`** (earlier prose said "eight" —
  corrected to the raw count; per-unit evidence lives in the
  round-1 `grading.json` files). The dominant pattern: prompts are Chinese,
  and the model answered in Chinese, while frozen assertions expected literal
  English strings ("root cause", "fixed", "read-only", "Scope"); the fixture
  AGENTS.md line "reports in English" did not override conversation language.
  The round-1 frozen case set was NOT retuned mid-evaluation — adjudication
  produced corpus v2 (see the assertion contract above) with a full re-freeze
  and fresh runs. Per Spec A1, efficacy acceptance stays blocked until the
  required smoke assertions pass for real.

## Known limits and boundaries

- **Kill boundary:** timed-out children get SIGTERM, then SIGKILL after a
  5 s grace — the **direct child only**. A child that leaks stdio fds to
  background grandchildren could extend the runner's `close` wait past
  `timeoutMs + grace`; Spec A1 scopes process-group kill to Plan 03's
  `sdd exec` launcher, so this is a documented boundary, not a contract
  violation.
- **Fixtures are text-only by frozen design:** fixture `content` is a JSON
  string and the workspace copy is a utf8 text round-trip; binary fixtures are
  unsupported (hashes stay mutually consistent, so corruption cannot pass
  silently).
- **AGENTS.md observability:** codex injects AGENTS.md as ambient context with
  no tool-read event; cases therefore never assert an observed read of
  AGENTS.md, and graded compliance rides on instructed markers instead.
- **Resume-guard evidence:** recorded resume identity comes from preserved
  turn-1 artifacts (`argv.json` `--cd`/`--sandbox` + a fresh event re-scan),
  not from scheduler state; a hand-edited `state.json` cannot resume
  unchallenged. Missing/unreadable turn-1 `argv.json` is itself a rejection.
- **Aborted attempts are archived, not deleted:** re-executing a turn moves
  the previous attempt's raw bytes to `runs/<case>/<variant>/r<n>/aborted/`
  before recreating the turn dir, so stale bytes never append and aborted
  diagnostics survive.

Durable raw evidence for these runs lives under the control
`{SDD_DIR}/eval/` directory; disposable fixtures/workspaces under
`.tmp/skill-eval/` are cleaned after trace capture.

## Round 2 (corpus v2 re-run, 2026-09-07, QC fix wave 1)

After the C-W1 re-version (marker assertions) and the C-W3 closure widening,
the corpus was re-frozen (`casesHash c1d6ea4e…`, `heldoutDigest f468bb75…`,
`configHash` unchanged) and both required runs were re-executed fresh
(`eval/r2/`; round-1 evidence preserved untouched). Real grades, recorded
as-is — no assertion was edited after these results:

- **smoke** (`baseline,minimal`, repeats 1): 6 units, 8 spawns, **pass=5
  fail=1**, 0 infrastructure_error, 0 unverified → exit 1. The failure:
  `pm-dev-4-smoke-explicit-resume/baseline` never produced an observed read
  COMMAND for `draft/plan-draft.md` in its resume turn (the merge itself,
  marker, heading quote and zero-write constraints all passed).
- **dev** (once, exploratory): 40 units (34 executed + 6 reused smoke
  grades), 42 spawns, **pass=35 fail=5**, 0 infrastructure_error, 0
  unverified → exit 1. Failures: `audit-dev-3` (the fixture's synthetic
  "blocking engine" is not enforced by the real host sandbox — the requested
  `src/x.ts` attempt actually wrote in the baseline arm, and the refusal
  marker was not emitted), `close-dev-4` both arms (the unchanged real
  isolation case REPRODUCES: writes beyond `close/remaining.md`), plus the
  smoke failure above.
- **Efficacy remains BLOCKED** (Spec A1: required smoke assertions must all
  pass for real). Round-1 → round-2: smoke 0/6 → 5/6, dev 13/40 → 35/40 —
  exploratory observations only; no comparative baseline-vs-minimal claim
  (one repeat, `observedModel` still null: no model-identity field exists in
  the round-2 streams either, usage aggregates stay null with
  `usageBasis: "unknown"`).
- Re-version provenance and per-finding dispositions: control
  `{SDD_DIR}/eval/r2-corpus-reversion.md` and the QC-1 report.
