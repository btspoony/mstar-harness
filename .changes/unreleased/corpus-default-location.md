---
category: Harness
packages: engine, commands, dsh, root
---

- The three tracked corpora — `{KNOWLEDGE_DIR}`, `{SPECS_DIR}`, `{ADR_DIR}` — now default to `<repoRoot>/.agents/<kind>/`. `packages/engine/src/path.ts` drops the harness-first candidate and the `{HARNESS_DIR}/<kind>/` fallback: the chain is `.mstarc` → `.agents/<kind>` → kind-specific secondaries → a **legacy read-only** `{HARNESS_DIR}/<kind>/` tail, and an absent corpus creates `.agents/<kind>/` (skipped by `create: false`). A tracked corpus therefore survives a fully gitignored `.mstar/`.
- `<repoRoot>` is now an explicit anchor rather than an assumption: `resolveSpecsDir` / `resolveKnowledgeDir` / `resolveAdrDir` accept `opts.repoRoot` (defaulting to the harness dir's parent), and the CLI, `scaffoldHarness` and the catalog pass the checkout they know — so a harness configured outside the repository creates the corpus in the checkout that can commit it, not beside itself.
- `.mstarc` stays the only authority: a declared `knowledge_dir` / `specs_dir` / `adr_dir` is returned as declared, ahead of every candidate. Repositories that declare keys, including this one on `docs/{knowledge,specs,adr}`, keep their layout.
- Writers must **resolve the symbol before writing** — read `.mstarc`, or run `mstar path resolve` — and never compose a default path. That rule is now stated in `mstar-conventions` (symbol-table preamble and resolution chains), `mstar-doc-corpus` § Layout defaults, `mstar-knowledge` § Storage, `mstar-artifacts` § Workflow and `docs/specs/architecture/document-corpus.md`; it is the root fix for issue #714, where two competing defaults let an agent write an unshareable document into the harness root.
- The prose moved but two code paths did not, so they now resolve instead of composing: the `compound` write-gate matches the `{KNOWLEDGE_DIR}` the resolver returns (a literal `{HARNESS_DIR}/knowledge` had silently stopped covering `.agents/knowledge/`), and `compoundRefreshScope` takes the already-resolved knowledge root from its caller. `scaffoldHarness` derives its bootstrap `.mstarc` corpus keys from the directories it creates, so a nested harness (`harness_dir=runtime/harness`) declares `../.agents/<kind>` instead of a second corpus beside itself.
- Recorded as `docs/adr/implemented/architecture/2026-11-11-corpus-default-location.md`.

<!-- CN -->
- 三层 tracked 语料 —— `{KNOWLEDGE_DIR}`、`{SPECS_DIR}`、`{ADR_DIR}` —— 默认改为 `<repoRoot>/.agents/<kind>/`。`packages/engine/src/path.ts` 去掉 harness-first 候选与 `{HARNESS_DIR}/<kind>/` 回退：链序为 `.mstarc` → `.agents/<kind>` → 各类别的次级候选 → 链尾的 **legacy 只读** `{HARNESS_DIR}/<kind>/`；全部缺失时创建 `.agents/<kind>/`（`create: false` 时只返回不创建）。因此 `.mstar/` 整体 gitignored 时 tracked 语料仍随仓库提交。
- `<repoRoot>` 现在是显式锚点而非假设：`resolveSpecsDir` / `resolveKnowledgeDir` / `resolveAdrDir` 接受 `opts.repoRoot`（缺省为 harness 目录的父目录），CLI、`scaffoldHarness` 与 catalog 各自传入已知的检出——配置在仓库之外的 harness 会把语料建在能提交的那份检出里，而不是自己旁边。
- `.mstarc` 仍是唯一权威：声明的 `knowledge_dir` / `specs_dir` / `adr_dir` 直接采用，先于所有候选。已声明的仓库（含本仓库的 `docs/{knowledge,specs,adr}`）布局不变。
- 写入方**必须先解析符号**——读 `.mstarc`，或运行 `mstar path resolve`——不得自行拼默认路径。该规则已写入 `mstar-conventions`（符号表前言与解析链）、`mstar-doc-corpus` § Layout defaults、`mstar-knowledge` § Storage、`mstar-artifacts` § Workflow 与 `docs/specs/architecture/document-corpus.md`；这正是 issue #714 的根因修复：两个并存的默认值会让 agent 把不可共享的文档写进 harness 根。
- 散文搬了、两条代码路径没搬，故改为解析而非拼接：`compound` 写入门禁匹配解析器返回的 `{KNOWLEDGE_DIR}`（原先把字面 `{HARNESS_DIR}/knowledge` 拼出来，已静默不再覆盖 `.agents/knowledge/`）；`compoundRefreshScope` 改由调用方传入已解析的知识根。`scaffoldHarness` 的 bootstrap `.mstarc` 语料键改由本次实际创建的目录推导，嵌套 harness（`harness_dir=runtime/harness`）因此声明 `../.agents/<kind>`，而不是在自己旁边再建一份语料。
- 决策记录：`docs/adr/implemented/architecture/2026-11-11-corpus-default-location.md`。
