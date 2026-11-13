---
category: Harness
packages: root
---

- **The packaging manifest is now enforced by CI, not just declared.** `pack-consumers` builds the two consumers it was still missing (omp, then dsh as the last writer of its recorded inputs) and runs `bun scripts/execution-consumer-manifest.ts --repo . --check` over the fully built tree. A recorded digest or copied mirror that no longer describes the bytes fails the job and names the drifted entry with its aggregate and file list.
- **The CLI packaging test stops claiming enforcement it never had.** Its header and manifest-path comments said CI ran the `--check` as its own step; no job did. They now state the guard's real scope — entrypoint existence, the declared runtime floor, and digest staleness for the consumers that pin one — and name `pack-consumers` as the check's home.

<!-- CN -->
- **打包 manifest 现在由 CI 强制，而不只是声明。** `pack-consumers` 补齐它此前缺失的两个 consumer 构建（omp，随后 dsh 作为其记录输入的最后写入者），并在完整构建后的树上运行 `bun scripts/execution-consumer-manifest.ts --repo . --check`。记录摘要或复制镜像与磁盘字节不再相符时，作业失败并点名漂移条目及其聚合与文件清单。
- **CLI 打包测试不再声称它从未拥有的强制力。** 其头注释与 manifest 路径注释称 CI 以独立步骤运行 `--check`，而实际没有任何作业运行它。现在改为陈述该校验的真实范围 —— entrypoint 存在性、声明运行时下限，以及会钉摘要的 consumer 的摘要陈旧性 —— 并指明其归属为 `pack-consumers`。
