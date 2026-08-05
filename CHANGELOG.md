[CHANGELOG.md#6B26]
1:# Changelog
2:
3:Chinese summary: [CHANGELOG_CN.md](CHANGELOG_CN.md).
4:
5:All notable changes to this repository are documented here. Published harness surfaces are at **1.8.3** unless noted:
6:
7:| Surface | Package / manifest | Version |
8:| --- | --- | --- |
9:| Monorepo root | `morning-star` (`package.json`) | **1.8.3** |
10:| CLI | `@mstar-harness/cli` (`packages/cli`) | **1.8.3** |
11:| OpenCode plugin | `@mstar-harness/opencode` (`packages/opencode`) | **1.8.3** |
12:| Cursor plugin | `.cursor-plugin/plugin.json` | **1.8.3** |
13:| Codex plugin | `.codex-plugin/plugin.json` | **1.8.3** |
14:| Kimi plugin | `.kimi-plugin/plugin.json` | **1.8.3** |
15:| ZCode plugin | `.zcode-plugin/plugin.json` | **1.8.3** |
16:| omp plugin | `.omp-plugin/plugin.json` / `.claude-plugin/plugin.json` | **1.8.3** |
17:
18:Package-specific histories: [`packages/cli/CHANGELOG.md`](packages/cli/CHANGELOG.md), [`packages/opencode/CHANGELOG.md`](packages/opencode/CHANGELOG.md).
19:
20:## [Unreleased]
21:
22:## [1.8.3] - 2026-08-05
23:
24:### Harness (omp role-agent dispatch)
25:
26:- **omp C5 corrected**: after plugin install/link, discovered `agents/*.md` role ids (`product-manager`, `architect`, `fullstack-dev`, `qc-specialist*`, …) are valid live `task.agent` values. Prefer **`agent: "<Execute as role-id>"`**; use generic `task` / `scout` / … only as fallback when the role is absent from the live schema. Using `agent: "task"` while the matching role agent is listed is an anti-pattern.
27:- **C5b retained**: even when `agent` already matches the role id, Assignment still requires **Act as + skill load** (agent shell ≠ full Morning Star role prompt).
28:- Updated `skills/mstar-host/references/omp.md`, `_shared/host-role-binding-core.md` (Kimi/ZCode vs omp host classes), `parallel-dispatch.md`, and `mstar-host` skill description; aligned INSTALL / `docs/cli.md`. Dropped the README “Host notes / 宿主说明” aside so the Use section stays entry-only.
29:
30:### Version alignment
31:
32:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.3**.
33:
34:## [1.8.2] - 2026-08-05
35:
36:### Docs (README + host detection)
37:
38:- **README** (`README.md` + `README_CN.md`): reorder all host tables to the recommended host order (`omp > OpenCode > Cursor > Kimi = ZCode > Codex`); reorganize **Use** section into General (without iteration) → Iteration → Codebase audit.
39:- **`mstar-host`**: rewrite the host detection table to use **session tool shapes / available commands only** — `*-plugin/plugin.json` files cannot identify the host (they coexist in this source repo and in any multi-host install). Merge the duplicate Cursor detection rows into one keyed on `subagent_type`.
40:- **Host references**: strip the same plugin-marker clauses from the `Load when` trigger lines of `codex.md` / `kimi.md` / `zcode.md` / `omp.md`; keep tool-shape / observable-command signals only. Path-reference context lines and bridge `plugin is installed` prerequisites are left as documentation (not detection triggers).
41:- **omp**: document native internal URL schemes (`skill://`, `local://`, `agent://`, `artifact://`, `history://`) in `references/omp.md`.
42:
43:### CLI
44:
45:- `zcode` adapter no longer hardcodes a `PLUGIN_VERSION` constant (it had drifted to `1.6.0`). Marketplace entry generation and `doctor`'s ZCode version check now derive the version from `packages/cli/package.json` via a shared `readHarnessVersion()` helper in `utils.ts` (same helper `index.ts` now uses for `--version`). Fixed stale `1.5.6`/`1.6.0` version strings in `INSTALL.md` and the ZCode adapter.
46:
47:### Version alignment
48:
49:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.2**.
50:
51:## [1.8.1] - 2026-08-05
52:
53:### Harness (skills + commands optimization)
54:
55:- **Lossless optimization** of `skills/` and `commands/` per SkillsBench principles (compact bodies, progressive disclosure, dedup to SSOT). No rule, gate, field name, or NEVER bullet altered or dropped — rules move or compress, never disappear.
56:- **Extract to `references/`**: `mstar-iteration` Phase 3 → `phase-3-iteration-close.md`, Phase 4/5 → `phase-4-5-pr-delivery.md` (body 574 → 384 lines); `mstar-compound` Q1–Q8 + Phase 1–7 → `compound-workflow.md` (275 → 103).
57:- **Compress**: `mstar-coding-behavior` 216 → 142 (kept The Ladder, `simplify:` marker, minimal-check); `qc-specialist/deep-review-lenses.md` 11 lens checklists → one-liners (155 → 94).
58:- **Dedup**: anti-pattern lists → `mstar-harness-core` index; new `_shared/leaf-executor-core.md` (Completion Report + Git NEVER across 9 leaf roles); new `_shared/host-role-binding-core.md` + `_shared/plan-mode-bridge-core.md` (de-clone kimi/zcode/omp host files + 5 plan-mode bridges).
59:- **Commands → thin orchestrators**: 4 commands 943 → 388 lines (−59%); new `mstar-iteration/references/phase5-helper-discovery.md`.
60:- **Descriptions**: tightened `coding-behavior`, `branch-worktree`, `phase-gates` frontmatter to trigger contracts.
61:- **Docs**: recommended host order added to `README.md` + `README_CN.md` (`omp ≥ OpenCode ≥ Cursor > Kimi = ZCode > Codex`).
62:- **Naming**: `Completion Report v2` → `Completion Report` (template unified; version suffix dropped).
63:
64:### Version alignment
65:
66:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.1**.
67:## [1.8.0] - 2026-08-05
68:
69:### Harness (codebase audit skill)
70:
71:- **New `mstar-audit` skill**: read-only advisory workflow adapted from the [improve](https://github.com/shadcn/improve) skill (MIT, © shadcn). Surveys a repo across 9 categories (correctness, security, performance, tests, tech debt, dependencies, DX, docs, direction), vets findings, prioritizes by leverage, and writes self-contained improvement plans to `{PLAN_DIR}/audit-<date>/`. The `improve` `execute`/`reconcile`/`--issues` variants are not imported — mstar's SDD, `status.json`, and residual tracking replace them.
72:- **New `plan-quality-bar` reference** (`mstar-plan-artifacts/references/plan-quality-bar.md`): shared standard for self-contained plans — verification gates, STOP conditions, drift check, machine-checkable done criteria. Applies to SDD task-briefs, Prepare plans, and audit plans.
73:- **New `/codebase-audit` command** (`commands/codebase-audit.md`): standalone entry point. Named with `codebase-` prefix to avoid host command conflicts (follows the `iteration-*` convention). Wiring: `mstar-harness-core` Task category `audit` + skill index; `mstar-phase-gates` Plan quality gate; `mstar-sdd` references; `mstar-roles` architect load entry; `pm` skill entry; `iteration-start` §1 Research optional source.
74:- **Attribution**: improve (MIT, © shadcn) credited in `mstar-audit/SKILL.md` and `plan-quality-bar.md`.
75:
76:### CLI (`@mstar-harness/cli`)
77:
78:- **Codex adapter**: `CODEX_PROJECT_COMMAND_NAMES` (renamed from `CODEX_ITERATION_SKILL_NAMES`) now includes `codebase-audit`; project-scoped install materializes it as `.agents/skills/codebase-audit/SKILL.md`.
79:- **omp adapter**: smoke test and install notes include `codebase-audit`.
80:
81:### Version alignment
82:
83:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.8.0**.
84:
85:## [1.7.1] - 2026-08-05
86:
87:### CLI (`@mstar-harness/cli`)
88:
89:- **omp doctor**: parse `omp plugin list --json` shape `{ npm, marketplace }` (omp 17.x) instead of only array/`plugins`, and match `manifest.name`.
90:
91:### Version alignment
92:
93:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.7.1**.
94:
95:## [1.7.0] - 2026-08-05
96:
97:### Harness (omp host surface)
98:
99:- **omp as sixth host surface**: markers `.omp-plugin/plugin.json` + `.claude-plugin/plugin.json` (plugin root = repo root; mounts `./skills/`, `./commands/`, `./agents/`). New `skills/mstar-host/references/omp.md` covering `task`/`ask`/`hub`, filename slash commands (`/iteration-*`), and C5/C5b built-in `task.agent` + role-in-prompt binding. `omp-plan-mode-bridge.md` for `/plan` dual-write. `mstar-host` detect table + `pm` entry + `parallel-dispatch` updated.
100:- Install: `omp plugin install github:btspoony/mstar-harness` or `omp plugin link` of the local harness checkout; package list name is root `morning-star`.
101:
102:### CLI (`@mstar-harness/cli`)
103:
104:- **`omp` install target**: `npx @mstar-harness/cli init --target omp` ensures `~/.mstar/harness` and runs `omp plugin link` (falls back to `omp plugin install github:btspoony/mstar-harness`). `doctor --target omp` checks markers, smoke skills/commands, and `omp plugin list`. `shared-install` `HARNESS_MARKERS` accepts `.omp-plugin/plugin.json`.
105:
106:### Version alignment
107:
108:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode/omp plugin manifests: **→ 1.7.0**.
109:
110:## [1.6.1] - 2026-08-04
111:
112:### Harness (QC = code reviewer, not test runner)
113:
114:- **L3 Plan QC clarified as diff/logic review**: `mstar-review-qc` boundaries + `qc-specialist*` workflow/shared NEVER — parallel tri-review on a shared `Review cwd` must **not** run test/build/install/lint/typecheck (peer QC `Blocked` from toolchain contention). Coverage is judged from the **diff**, not by re-running suites.
115:- **L1 / L4 own runtime evidence**: QA `acceptance-only` reuses implementer/CI/prior-QA logs; QC reports are findings, not the test log. PM Assignment anti-patterns and `qa-trigger-matrix` updated accordingly.
116:- **OpenCode `qc-specialist*` agents**: bash allowlist trimmed to git + lightweight read-only analysis (removed eslint/tsc/ruff/clippy/etc.).
117:
118:### Version alignment
119:
120:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode plugin manifests: **→ 1.6.1**.
121:
122:## [1.6.0] - 2026-08-03
123:
124:### Harness (ZCode host surface)
125:
126:- **ZCode as fifth host surface**: plugin root = repo root via `.zcode-plugin/plugin.json` (mounts `./skills/`, `./commands/`, `./agents/`); no `sessionStart` (ZCode lacks it — PM entry is manual `/morning-star-harness:pm`). New `skills/mstar-host/references/zcode.md` with tool map written against the real ZCode session tools (`Agent` / `AskUserQuestion` / `EnterPlanMode`·`ExitPlanMode` / `TodoWrite` / `Bash` / `Read` / `Edit` / `Write` / `WebSearch` / `WebFetch` / `TaskOutput`·`TaskStop`), reusing Kimi **C5b role-in-prompt binding** (ZCode ships built-in `subagent_type` profiles only). `zcode-plan-mode-bridge.md` for Enter/Exit dual-write.
127:- **`mstar-host` SKILL.md**: description, detect-host table, and fallback row now include ZCode.
128:
129:### CLI (`@mstar-harness/cli`)
130:
131:- **`zcode` install target**: `npx @mstar-harness/cli init --target zcode` registers a `mstar-local` marketplace in `~/.zcode/cli/plugins/known_marketplaces.json` + `marketplaces/mstar-local/marketplace.json`, both pointing at the **`github:btspoony/mstar-harness`** repo source (matches ZCode's built-in marketplace source shape). Project scope also keeps a local `.zcode/plugin-checkout` for agent-file smoke checks. `doctor --target zcode` validates both JSON files + checkout + gitignore. `shared-install` `HARNESS_MARKERS` now also accepts `.zcode-plugin/plugin.json`.
132:
133:### Version alignment
134:
135:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi/ZCode plugin manifests: **→ 1.6.0**.
136:
137:## [1.5.6] - 2026-07-28
138:
139:### Harness (residuals)
140:
141:- **`Findings cleanup: zero-residual | allow-residual`**: plan-level mode to clear QC/QA findings in-session when possible. Formal **iteration Phase 2** defaults to **`zero-residual`** (fix-now + re-review; open R# only for true blocker-defer + Durable Roadmap). Standalone `/pm`, hotfix, and `inline` keep **`allow-residual`**.
142:- Assignment field + optional `plans[].metadata.findings_cleanup`; SSOT in `mstar-plan-artifacts` Findings cleanup modes; wired through `mstar-review-qc`, PM NEVER / Assignment template, iteration close checklist, QA trigger note, and routing-eval cases.
143:
144:### Version alignment
145:
146:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.6**.
147:
148:## [1.5.5] - 2026-07-27
149:
150:### Harness (worktree / L1)
151:
152:- **Control-path harness under default gitignore**: process artifacts (`plans/`, `iterations/`, `status.json`, `sdd/`, …) stay local; read/write them via absolute **control worktree** paths. Feature worktrees keep product/source edits only — do **not** waive worktree because feature checkouts lack plans, and do **not** treat “no flock” as a worktree waiver (serial plan parallelism only).
153:- Assignment fields: absolute **`Control harness root`**, control **`Plan Path`** / **`SDD dir`**, feature **`Worktree path`**.
154:- **`sdd-workspace`**: `MSTAR_CONTROL_ROOT` / optional control-root arg; fail-closed on linked worktrees without `status.json`.
155:- Routing-eval cases for no-flock serial + gitignore control-path harness.
156:
157:### Version alignment
158:
159:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.5**.
160:
161:## [1.5.4] - 2026-07-27
162:
163:### Harness (Cursor host)
164:
165:- **`mstar-host` Cursor Task invoke schema**: document flat sibling fields (`prompt` + `subagent_type` + `description`) with examples, anti-patterns (nested/stringified JSON, OpenCode `subagent`, MCP wrap, missing `subagent_type`), and a send-time self-check — reduces first-attempt Task parameter-format failures. Pointer from `parallel-dispatch.md`.
166:
167:### Version alignment
168:
169:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.4**.
170:
171:## [1.5.3] - 2026-07-25
172:
173:### Harness (commands / frontmatter)
174:
175:- **Frontmatter YAML**: quote `description` fields that contain `: ` so Cursor/plugin discovery does not drop commands/skills (`iteration-loop`, `mstar-branch-worktree`, `mstar-phase-gates`, `mstar-plan-artifacts`, `mstar-review-qc`, `mstar-sdd`).
176:- **`/iteration-loop` scale**: add **`XL`** = **>4** business plans (`S`/`M`/`L`/`XL`; default still `M`). SSOT: `mstar-iteration` §1.2 + `references/autonomous-direction-lock.md`.
177:
178:### Version alignment
179:
180:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.3**.
181:
182:## [1.5.2] - 2026-07-23
183:
184:### Harness (git policy + SPECS_DIR)
185:
186:- **Process vs results git policy**: default tracked under `{HARNESS_DIR}` — `AGENTS.md`, `knowledge/`, `specs/`; default gitignored — `plans/`, `iterations/`, `status.json`, `sdd/`, `archived/`, `notes.json`. Cross-clone handoff = tracked results + root `CONCEPTS.md` / `STRATEGY.md`; promote residuals via compound instead of default `git add` for `status.json` / `plans/`.
187:- **`{SPECS_DIR}` resolve order**: `{HARNESS_DIR}/specs/` → `docs/specs/` → repo-root `specs/` (skip empty dirs; greenfield creates `{HARNESS_DIR}/specs/`). Legacy read-compat: non-empty `designs/` paths.
188:- Aligned: `mstar-plan-conventions`, `mstar-plan-artifacts`, `mstar-sdd` file-handoffs, host Plan-mode bridges, bilingual README, `.cursor/LOCAL-VALIDATION.md`.
189:- **CLI**: `init`/`doctor` append/check the full process gitignore set (see `packages/cli/CHANGELOG.md`).
190:
191:### Version alignment
192:
193:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.2**.
194:
195:## [1.5.1] - 2026-07-22
196:
197:### Harness (Phase 5 push cadence)
198:
199:- **Phase 5 push cadence (HARD)**: CI/review findings may be fixed **locally early**, but **`git push` only after** the previous CI **and** review wave on the current head have **fully completed**. After CI settles, new reviews may continue to be fixed locally; **never push while CI is still running** (cancels/orphans AI reviews — wasted tokens, incomplete results). SSOT: `mstar-iteration` §5.1a; aligned `iteration-drive` / `iteration-loop`; core anti-pattern row.
200:
201:### Version alignment
202:
203:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.1**.
204:
205:## [1.5.0] - 2026-07-22
206:
207:### Harness (iteration Phase 2 worktree + lease)
208:
209:- **Phase 2 control worktree** on `spec_integration_branch` plus per-plan **feature worktree** with `execution_lease` / `integration_merge_lease` (same-host exclusive write lock; serial integration merge; `Done` only after successful merge).
210:- Multi-session cross-plan parallel implement under leases; `Worktree mode: waived` does **not** bypass the cross-plan parallel safety gate; `Plan parallelism: serial` is scheduling-only.
211:- Routing-eval updates for lease-gated multi-plan parallel and failure modes; bilingual README Phase 2 defaults.
212:
213:### Harness (Phase 5 helpers)
214:
215:- **Phase 5 merge-ready helpers**: prefer `babysit` or any `*-babysit` skill; `greploop` is **optional** only when the repo has Greptile/`greploop`. When both apply, run babysit/`*-babysit` first, then optional greploop. Updated `mstar-iteration` §5 pointer + `commands/iteration-drive` / `iteration-loop`.
216:
217:### Version alignment
218:
219:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.5.0**.
220:
221:## [1.4.0] - 2026-07-17
222:
223:### Harness (Kimi Code host)
224:
225:- **Kimi host support**: `.kimi-plugin/plugin.json` (host-folder layout aligned with Cursor/Codex; `sessionStart.skill: pm`); `mstar-host` Kimi reference / Plan-mode bridge; role binding in Agent prompts (built-in `coder` / `explore` / `plan` only).
226:- **Install**: primary path is Kimi TUI `/plugins install https://github.com/btspoony/mstar-harness` then `/plugins reload` (no CLI `--target kimi`).
227:- Plugin commands: `/morning-star-harness:iteration-start` · `iteration-drive` · `iteration-loop`.
228:
229:### Version alignment
230:
231:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex/Kimi plugin manifests: **→ 1.4.0**.
232:
233:## [1.3.2] - 2026-07-15
234:
235:### Harness (Cursor Plan Phase 1 feedback-driven)
236:
237:- **`/iteration-start` Cursor Plan path**: feedback-driven loop — user gives direction/opinions only; agent explores, recommends, and updates the plan. `grill-me` is deferred until feedback-close and only if blocking gaps remain.
238:- **Single CreatePlan URI (HARD)**: CreatePlan once per Phase 1 Plan session; subsequent updates edit that same file in place; merge and delete accidental duplicates.
239:- **`mstar-host` / rule / `mstar-iteration` §1.2**: Phase 1 Plan UX documents feedback-driven updates and recommended branch policy (no silent `main`/`master`).
240:- **Routing eval v20**: `iteration-phase1-cursor-plan-feedback-driven`.
241:
242:### Version alignment
243:
244:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.3.2**.
245:
246:## [1.3.1] - 2026-07-13
247:
248:### Harness (iteration package layout)
249:
250:- **`iterations/<id>/` directory-first**: compass moves to `{ITERATION_DIR}/<iteration-id>/delivery-compass.md` with sibling `guides/` / `specs/` / optional package `README.md`. Root `{ITERATION_DIR}/README.md` indexes **one row per iteration** (no compass + workspace double entries).
251:- **Legacy read compat**: flat `{ITERATION_DIR}/<id>-delivery-compass.md` remains readable; new writes must use the package path.
252:- Touches: `mstar-iteration` (+ references), `mstar-compound` package promotion, `mstar-plan-conventions` / `mstar-plan-artifacts` path docs, role shells, `/iteration-start` · `/iteration-drive` · `/iteration-loop`.
253:
254:### Version alignment
255:
256:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.3.1**.
257:
258:## [1.3.0] - 2026-07-11
259:
260:### Harness (bootstrap absorb)
261:
262:- **Retire `/mstar-bootstrap` command**: the 7-phase project knowledge bootstrap procedure moves to `mstar-compound-refresh/references/project-knowledge-bootstrap.md`; `mstar-compound-refresh` and `mstar-harness-core` carry short pointers.
263:
264:### CLI (Codex iteration skills)
265:
266:- **Project-scoped Codex install**: materializes `iteration-start`, `iteration-drive`, and `iteration-loop` as `.agents/skills/*/SKILL.md` symlinks from bundled harness commands; `doctor` validates links; global install skips with an explicit warning.
267:
268:### Docs
269:
270:- **Root `INSTALL.md`**: machine-readable install steps extracted from READMEs.
271:- **Slim bilingual READMEs**: CLI-first Quick Start; clarify `/iteration-start` → `/iteration-drive` vs `/iteration-loop` usage paths.
272:
273:### Version alignment
274:
275:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.3.0**.
276:
277:## [1.2.1] - 2026-07-10
278:
279:### Harness (Cursor Plan mode × Phase 1 staged direction lock)
280:
281:- **`/iteration-start` Cursor Plan path**: after Boot, Plan mode creates a blank Phase 1 CreatePlan scaffold first, then runs dynamic staged `grill-me` that updates the plan each stage; Review & Edit / lock / integration branch run only after **Build**. Agent / OpenCode keep Research → Explore → grill-me → Write → Review.
282:- **`mstar-host` Cursor bridge / rule**: document `mstar-iteration` Phase 1 in Plan mode (no command-name reverse refs in skills).
283:- **`mstar-iteration` §1.2**: host Plan UX may scaffold then converge interactively; non-Plan hosts unchanged.
284:- **Routing eval v19**: `iteration-phase1-cursor-plan-staged-grill`.
285:
286:### Version alignment
287:
288:- Bump monorepo root, `@mstar-harness/opencode`, `@mstar-harness/cli`, Cursor/Codex plugin manifests: **→ 1.2.1**.
289:
290:## [1.2.0] - 2026-07-10
291:
292:### Harness (`/iteration-loop` + autonomous direction lock)
293:
294:- **`/iteration-loop`**: new PM command for autonomous full Phase 1→5 (cloud-agent friendly). Optional args `direction` + `scale` (`S`\|`M`\|`L`, default `M`); code-first auto direction lock (no grill-me); sequential Review & Edit chain retained; Continuous execution through Phase 5 merge-ready. Distinct from `/iteration-start` (Phase 1 + grill-me) and `/iteration-drive` (Phase 2→5 only).
295:- **`mstar-iteration` §1.2**: direction lock modes `interactive` | `autonomous`; scale budget counts **business plans only** (harness process excluded); autonomous branch resolve order. Detail → `references/autonomous-direction-lock.md` (skills remain capability providers — no command-name reverse refs).
296:- **Docs**: README / README_CN / OpenCode package README command tables distinguish start / drive / loop.
297:- **Routing eval v18**: `iteration-loop-autonomous-direction-lock` — no routine direction yes/no; no grill-me; no silent `main` default; no process plans in scale budget.
298:
299:### CLI / CI / release
300:
…
304:
…
308:
…
923:See [`packages/cli/CHANGELOG.md`](packages/cli/CHANGELOG.md) for `@mstar-harness/cli` 0.2.0 notes. OpenCode packaging, postinstall bundle of `skills/` + `agents/`, and related fixes landed in the same era as the 0.2.0 CLI release.

[Showing lines 1-300 of 924. Use :301 to continue]