---
category: Harness
packages: root
---

- Added **`mstar-prose` → `references/calibrated-examples.md`**: four synthetic `over-trimmed / over-detailed / balanced` triples (change narration, reviewer-addressed justification, hedged planning residue, a suppression justification that must be kept) plus two counted delete/keep pairs. Every triple names the propositions the balanced form still makes, so the reader calibrates the judgment instead of copying a wording.
- The three-way form exists because a two-way bad/better pair cannot defend against over-trimming — the failure a compression pass produces, where a rule loses its negative guarantee or its condition, the sentence gets shorter and the diff looks like an improvement. The counted pairs show both directions: a 38-word passage kept over a 24-word one, and a 10-word passage kept over a 40-word one.
- `scripts/skill-budgets.manifest.json` gains the new file's ceiling (150 lines; the file ships at 145), so Guard 9 covers it from its first commit.

<!-- CN -->
- 新增 **`mstar-prose` → `references/calibrated-examples.md`**：四组合成的 `over-trimmed / over-detailed / balanced` 三元示例（变更叙述、面向评审者的自我论证、带对冲的规划残留、必须保留的抑制理由），外加两组带词数的删除/保留对照。每组三元示例都写明 balanced 形式仍然承载的命题，读者由此校准判断，而不是照抄措辞。
- 采用三元而非 bad/better 二元，是因为二元对比防不住**过度压缩**——压缩轮次真正会产生的失效模式：规则丢掉否定性保证或条件，句子变短，diff 看上去像改进。带词数的对照给出两个方向：38 词被保留而 24 词被删除，10 词被保留而 40 词被删除。
- `scripts/skill-budgets.manifest.json` 增加该文件上限（150 行；文件实际 145 行），因此 Guard 9 从第一次提交起即覆盖。
