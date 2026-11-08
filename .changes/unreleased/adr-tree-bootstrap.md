---
category: Harness
packages: root
---

- Added the **`docs/adr/` decision-record tree**: three buckets (`proposed`, `implemented`, `rejected`) × six classes (`feature`, `bug-fix`, `simplification`, `architecture`, `process`, `testing`), with `docs/adr/README.md` stating the durable-decision test, the three exemptions, the directory shape, the lifecycle transitions, and the named absences (`archived/`, `INDEX.md`, bilingual siblings).
- Added the two skeletons: `proposed/TEMPLATE.md` (`Problem` → `Proposal` → `Alternatives considered` → `Acceptance criteria` → `Risks`) and `implemented/TEMPLATE.md` (`Problem` → `Decision` → `Alternatives considered` → `Consequences`). `rejected/` has no third template — it reuses the proposed skeleton with a frozen body, so the rejected reason lives in the status line instead of a new section.
- Migrated the one existing record to `docs/adr/implemented/architecture/2026-10-19-dsh-native-identity-channels.md`: `Context` became `Problem`, `Superseded rationale: /mstar-execution` became `Alternatives considered`, and a present-tense `Decision` states the native-identity design the body already established. Its status is a bare `Status: implemented — …` line and its self-path points at the new location.
- Updated every inbound reference to the old path — the dsh package README pair plus its i18n record, the leaf-seat gate comment, and the dsh reference-extraction fragment that cited the old section name.

<!-- CN -->
- 新增 **`docs/adr/` 决策记录树**：三个 bucket（`proposed`、`implemented`、`rejected`）× 六个 class（`feature`、`bug-fix`、`simplification`、`architecture`、`process`、`testing`）；`docs/adr/README.md` 写明持久决策三问、三类豁免、目录形状、生命周期迁移与被明确排除的结构（`archived/`、`INDEX.md`、双语副本）。
- 新增两套骨架：`proposed/TEMPLATE.md`（`Problem` → `Proposal` → `Alternatives considered` → `Acceptance criteria` → `Risks`）与 `implemented/TEMPLATE.md`（`Problem` → `Decision` → `Alternatives considered` → `Consequences`）。`rejected/` 不设第三套模板——它复用 proposed 骨架并冻结正文，因此否决理由落在 status 行而不是新增小节。
- 迁移唯一一条既有记录至 `docs/adr/implemented/architecture/2026-10-19-dsh-native-identity-channels.md`：`Context` 改为 `Problem`，`Superseded rationale: /mstar-execution` 改为 `Alternatives considered`，并以现在时 `Decision` 陈述正文早已确立的原生身份设计。其状态改为裸 `Status: implemented — …` 行，自述路径指向新位置。
- 同步旧路径的全部入站引用——dsh 包 README 双语对及其 i18n 记录、leaf-seat 门禁注释，以及引用旧小节名的 dsh reference-extraction 片段。
