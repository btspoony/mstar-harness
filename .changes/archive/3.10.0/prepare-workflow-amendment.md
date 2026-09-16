---
category: Changed
packages: engine, cli
---

- Added the guarded **Prepare workflow amendment** (`showPrepareWorkflow` / `amendPrepareWorkflow`; CLI `mstar workflow show-prepare` / `amend-prepare`) — a coordinator-only entry that appends approved unique Todo plan rows and records the reviewed integration checkout plus the sole editable `execution_policy.plan_parallelism`. Both raw-byte CAS tokens (snapshot and reviewed compass) are required even on the first amendment, refusals are mutation-free with `coordination.prepare-amendment.{stale,invalid-patch,not-prepare,execution-started,duplicate-plan,invalid-plan,compass-mismatch,invalid-worktree}`, every existing row and unknown field is preserved by value, and there is no force or replacement-snapshot path.
- Documented the entry in `docs/cli.md` (flags, patch payload, refusal codes, exit codes, stop conditions) with pointers from `mstar-artifacts` and `mstar-iteration`.

<!-- CN -->
- 新增受守卫的 **Prepare workflow 修订入口**（`showPrepareWorkflow` / `amendPrepareWorkflow`；CLI `mstar workflow show-prepare` / `amend-prepare`）——仅 coordinator 可用：追加已批准的**唯一** Todo plan 行，并登记已 review 的 integration checkout 与唯一可改的 `execution_policy.plan_parallelism`。首次修订也**必须**同时提供两个原始字节 CAS token（snapshot 与已 review 的 compass）；拒绝一律零变更并返回 `coordination.prepare-amendment.{stale,invalid-patch,not-prepare,execution-started,duplicate-plan,invalid-plan,compass-mismatch,invalid-worktree}`；既有行与未知字段**逐值保留**；不存在 force 或替换快照通道。
- 在 `docs/cli.md` 记录该入口（flags、patch 载荷、拒绝码、退出码、停止条件），并由 `mstar-artifacts`、`mstar-iteration` 指向。
