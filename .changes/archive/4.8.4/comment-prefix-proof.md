---
category: Breaking
packages: root, commands
---

- The comment gate no longer accepts natural-language declared prefixes (`why:`, `invariant:`, `safety:`, `note:`): a declared prefix states no machine-resolvable claim and is not a shape. The surviving shapes are the bounded marker, the contract pointer, `@generated`, and the tracked `TODO`.
- A comment survives only when its claim resolves at HEAD against machine-resolvable external evidence: the only retained pointer forms are a resolvable repo path (`docs/`, `skills/`, `packages/`, `scripts/`; an ADR record is cited by its `docs/adr/...` path) or a URL — `plans/…`, `#<n>`, `issue <n>`, `contract §` and a numeric `ADR-<n>` id are no longer shapes because the linter cannot resolve them — beside a bounded marker with its bound, `@generated`, and a tracked `TODO`; the anchor is what justifies the comment, not the prose.
- Existing `note:` comments, including single-line `/** note: */` blocks, were removed or repointed (the issue-sync module headers now point at `docs/adr/implemented/architecture/2026-11-19-host-owned-linear-io.md`); a natural-language reason worth keeping moves to an ADR or docs page, and the comment keeps only the `see` pointer.

<!-- CN -->
- 注释门不再接受自然语言声明前缀（`why:`、`invariant:`、`safety:`、`note:`）：声明前缀不构成可机器验证的声明，不再算作形状。保留的形状为有界标记、契约指针、`@generated` 与带跟踪引用的 `TODO`。
- 注释只有在其声明能在 HEAD 上解析到可机器验证的外部证据时才保留：唯一保留的指针形式是可解析的仓库路径（`docs/`、`skills/`、`packages/`、`scripts/`；ADR 记录按其 `docs/adr/...` 路径引用）或 URL——`plans/`、`#<n>`、`issue <n>`、`contract §` 与数字编号 `ADR-<n>` 因 linter 无法解析，不再是形状——其余为带边界的标记、`@generated` 与带跟踪引用的 `TODO`；证明注释合理的是锚点本身，而不是那段散文。
- 既有 `note:` 注释（含单行 `/** note: */` 块）一律删除或改挂可解析指针（issue-sync 模块头注释现指向 `docs/adr/implemented/architecture/2026-11-19-host-owned-linear-io.md`）；值得保留的自然语言理由移入 ADR 或 docs 页面，注释只保留 `see` 指针。
