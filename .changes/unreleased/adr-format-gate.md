---
category: Harness
packages: root
---

- Added **Guard 12** to `bun run validation:drift`: it walks `docs/adr/` and enforces the ADR record contract — `{bucket}/{class}/yyyy-mm-dd-topic.md` membership, the `Status: <bucket> — <why>` line agreeing with the containing bucket, the required and banned sections per lifecycle, and no `INDEX.md`. Sanctioned non-record files (`README.md`, `{bucket}/TEMPLATE.md`, `.gitkeep`) are ignored.
- Every refusal carries one of the seven contract codes (`adr.bucket-unknown`, `adr.class-unknown`, `adr.status-mismatch`, `adr.section-missing`, `adr.section-banned`, `adr.index-forbidden`, `adr.name-shape`), names the offending file, and ships a `recovery` string naming the exact fix — the three legal buckets, the six legal classes, `yyyy-mm-dd-topic.md` with a valid example, the missing heading, the fold/delete for a banned section, the bucket move, or the index deletion.
- The guard reports `Guard 12 ADR format N records, M failures` in the drift footer. It reports zero records until the tree exists — that is the correct reading of an empty corpus, not a reason to disable the guard.
- `scripts/adr-check.test.ts` covers every code plus a well-formed positive control and is listed in the CI `Test scripts` file set, so the semantics cannot silently stop running.

<!-- CN -->
- 在 `bun run validation:drift` 中新增 **Guard 12**：遍历 `docs/adr/`，执行 ADR 记录契约——`{bucket}/{class}/yyyy-mm-dd-topic.md` 归属、`Status: <bucket> — <why>` 行与所在 bucket 一致、各生命周期的必需与禁用小节，以及禁止 `INDEX.md`。被批准的非记录文件（`README.md`、`{bucket}/TEMPLATE.md`、`.gitkeep`）忽略。
- 每条拒绝都携带七个契约码之一（`adr.bucket-unknown`、`adr.class-unknown`、`adr.status-mismatch`、`adr.section-missing`、`adr.section-banned`、`adr.index-forbidden`、`adr.name-shape`），点明出错文件，并附 `recovery` 字符串指明确切修法——三个合法 bucket、六个合法 class、`yyyy-mm-dd-topic.md` 与合法示例、缺失的小节标题、被禁小节的折叠/删除、bucket 移动或索引删除。
- 该守卫在 drift 页脚输出 `Guard 12 ADR format N records, M failures`。在目录树建立之前它报告零条记录——这是空语料的正确读数，不是关闭守卫的理由。
- `scripts/adr-check.test.ts` 覆盖全部错误码加一个格式正确的正例，并已列入 CI `Test scripts` 文件集，语义不会静默停止运行。
