---
category: Harness
packages: root,engine,commands,omp
---

- **Attestations are generated, not authored.** `mstar session recover`, `mstar store upgrade` and `mstar store activate` no longer require an operator-authored `--attestation <path>` document: each consuming verb now generates the operator attestation inside its own transaction from live, recorded facts — the invoking operator, the operation's durable record, the transaction clock, and exactly the session rows that transaction disposes (for the activation barrier, the executing consumer's own process facts; a Bun-driven run refuses and names the installed Node CLI as the recovery). `--attestation <absolute-json>` remains a 1:1 explicit override; the engine validators are unchanged and stay the acceptance authority. `store activate` gains a required `--operator`; the omp `recover` tool makes its attestation input optional.

<!-- CN -->
- **Attestation 自动生成，不再要求人工撰写。** `mstar session recover`、`mstar store upgrade` 与 `mstar store activate` 不再要求 `--attestation <path>` 操作者文档：各消费动词在自己的事务内以实时、已记录的事实自动生成 operator attestation——调用 operator、操作自身的持久记录、事务时钟，以及恰好被该事务处置的会话行（激活屏障额外取执行进程事实；Bun 运行时直接拒绝并指向已安装 Node CLI）。`--attestation <absolute-json>` 保留为 1:1 显式覆盖；引擎校验器不变，仍是唯一验收权威。`store activate` 新增必填 `--operator`；omp `recover` 工具的 attestation 输入改为可选。
