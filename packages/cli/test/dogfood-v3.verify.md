# Dogfood v3.0.0 — `mstar migrate` v1→v2 on this repo's control `.mstar/`

> Evidence checklist for plan `20260819-workflow-migrate-cli` Task 3 (dogfood).
> CLI under test: worktree dist `packages/cli/dist/mstar-harness.js` (BASE `8df5e1c`).
> Migration target: control `/Users/bibi/workspace/ai/mstar-harness/.mstar/` (gitignored local FS; v1 backup `/tmp/status-v1-backup-204817.json` byte-identical to pre-run `status.json`).

## 1. Dry-run (zero writes)

Command: `node packages/cli/dist/mstar-harness.js migrate --dry-run --path /Users/bibi/workspace/ai/mstar-harness/.mstar`

- [x] Prints `39 steps planned (source → destination), zero writes`
- [x] Step kinds: 1 `archive-status-v1` + 28 `write-snapshot` + 8 `write-notes` + 1 `write-roadmap` + 1 `replace-root-v2`
- [x] No `workflows/`, `projects/`, or `archived/status.v1.json` created by dry-run (verified: dirs absent after dry-run)

### Spot-checks (3 lifecycles)

1. **Standalone row with legacy `plan_id` key** — `20260717-kimi-host`
   - [x] Planned snapshot: `workflows/20260717-kimi-host/snapshot.json`, type `plan`, status `completed`, source `status.json plans[] row`
   - [x] Plan row keeps legacy `plan_id` key verbatim (`plan_id: "20260717-kimi-host"`, `status: "Done"`)
2. **Compass snapshot** — `iter-20260817-dsh-cli-roles`
   - [x] Planned snapshot: `workflows/iter-20260817-dsh-cli-roles/snapshot.json`, type `iteration`, status `completed`, `compass_ref: iterations/iter-20260817-dsh-cli-roles/delivery-compass.md`
   - [x] Compass registers 2 plans (`20260817-cli-dsh-install`, `20260817-dsh-roles-e2e`) — both lifted into the snapshot (brief's "zero-plan" note did not match the actual compass; 9 other compasses are genuinely zero-plan and still produce empty terminal snapshots)
3. **Active lifecycle** — `v3.0.0`
   - [x] Planned snapshot: `workflows/v3.0.0/snapshot.json`, type `iteration`, status `running`
   - [x] 4 plan rows lifted; `20260819-workflow-migrate-cli` row `InProgress` with `execution_lease` **verbatim** (holder `omp-pm-v3.0.0`, claimed_at `2026-08-19T12:06:43Z`, worktree_path, working_branch `feature/20260819-workflow-migrate-cli`, session_label `v3.0.0 Phase 2 P2`)

## 2. Real run

Command: `node packages/cli/dist/mstar-harness.js migrate --path /Users/bibi/workspace/ai/mstar-harness/.mstar`

- [x] Exit 0: `migrate: migrated 28 lifecycles into workflows/, project layer seeded, root status.json replaced (v1 archived to archived/status.v1.json)`
- [x] `archived/status.v1.json` written; byte-identical to PM's `/tmp/status-v1-backup-204817.json` (`cmp` clean)
- [x] `archived/residuals/*.json` preserved untouched
- [x] Root `status.json` → v2 (`version: 2`, `updated_at: 2026-08-19`, `workflows: []` — migration commit point; active-workflow registration is a separate harness step)

## 3. Post-run verification (all green)

| Check | Command | Result |
|---|---|---|
| v2 root validate | `mstar status validate` | `OK` (exit 0) |
| v3.0.0 snapshot validate | `mstar status validate .mstar/workflows/v3.0.0/snapshot.json` | `OK` (exit 0) |
| Lease preserved | `mstar lease verify --workflow v3.0.0 --plan 20260819-workflow-migrate-cli` | `OK plan 20260819-workflow-migrate-cli — execution_lease valid (holder omp-pm-v3.0.0)` (exit 0) |
| Lease verbatim diff | v1 row vs snapshot row `execution_lease` | `diff` clean |
| Iteration gate | `mstar iteration gate --workflow v3.0.0 --compass .mstar/iterations/v3.0.0/delivery-compass.md` | `transition: phase-2-execute`; close §3.1/§3.5 FAIL entries are the expected active-lifecycle state (3 plans not Done, compass `locked`, no end_date) — exit 0 |
| Worktree L1 | `mstar worktree check --workflow v3.0.0 --plan 20260819-workflow-migrate-cli` | `worktree L1 check: OK` (exit 0) |
| Path resolve | `mstar path resolve` | harness/specs/**workflow**/**project** dirs all resolved (exit 0) |
| Workflows count | `ls .mstar/workflows` | **28** snapshot dirs (18 iteration + 10 standalone) |
| Register entries | `mstar status tech-debt` | `total_open: 0` (empty `residual_findings` → no `projects/_default/residuals.json` written; register shape covered by fixture tests) |
| Roadmap seed | `projects/_default/roadmap.md` | written from `metadata.program_roadmap` (title, milestones, residuals_ref) |
| Notes ledgers | `find .mstar/workflows -name notes.jsonl` | 8 files |
| Idempotent re-run | `mstar migrate --path …/.mstar` (real + `--dry-run`) | `no-op: … already at schema version 2 (migrated) — nothing to do` (exit 0) |

## 4. Tree summary (post-migration)

- `workflows/`: 28 `snapshot.json` (18 iteration: 17 terminal + 1 running `v3.0.0`; 10 standalone plan) + 8 `notes.jsonl`
- `projects/_default/`: `roadmap.md` only (register absent — 0 open residuals)
- `archived/`: `status.v1.json` + `residuals/` (6 legacy files, untouched)
- `compact_missing`: 0 across all snapshots (every compass-registered plan id has a v1 row)
- Root `status.json`: v2, `workflows: []`

## 5. Notes

- `--path` is the **harness root** (`.mstar`), not the repo root; `--path <repo-root>` fails closed with `no v1 status.json found` (correct engine behavior).
- `lease verify` takes `--workflow` + optional `--plan`; a stray positional plan id is rejected (`too many arguments`) — use `--plan`.
- Actual snapshot count 28 vs brief estimate ~30: 10 standalone (brief said 12) and 18 iteration (brief said 17 terminal + 1 running); migration is data-driven and matches the live tree.
