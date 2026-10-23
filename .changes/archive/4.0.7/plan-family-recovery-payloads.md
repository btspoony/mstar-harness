---
category: Changed
packages: commands, cli
---

- **The `plan progress` / `plan issue-add` / `plan issue-close` recoveries now name argument shapes their decoder accepts.** Payload values are advertised as inline JSON strings (`--progress '<json-progress-object>'`, `--entries '<json-array>'`), and the `issue-close` route names its required `--expect-issue` revision together with the evidence `--file`; the previous `--entries <issues-file>` named a file where an inline array is decoded, and `issue-close` omitted the CAS member the verb refuses without.
- **The regression is the replayed invocation, not its wording.** `packages/cli/test/plan-coordination.test.ts` reads each verb's own refusal, extracts the advertised `mstar …` sentence, binds its placeholders against the fixture and runs exactly that; all three succeed in one invocation.

<!-- CN -->
- **`plan progress` / `plan issue-add` / `plan issue-close` 的恢复文案现在指名解码器真正接受的参数形态。** payload 值以行内 JSON 字符串广告（`--progress '<json-progress-object>'`、`--entries '<json-array>'`），`issue-close` 路径同时点名必需的 `--expect-issue` revision 与证据 `--file`；此前的 `--entries <issues-file>` 在解码器按行内数组解析的位置写成了文件，`issue-close` 则漏掉了该动词缺失即拒绝的 CAS 成员。
- **回归证据是被重放的调用，而不是文案本身。** `packages/cli/test/plan-coordination.test.ts` 读取每个动词自身的拒绝，从中提取广告的 `mstar …` 句子，对 fixture 绑定占位符后原样执行；三者都在一次调用内成功。
