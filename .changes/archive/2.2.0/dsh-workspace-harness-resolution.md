---
packages: root
---

- **dsh plugin**: `{HARNESS_DIR}` now resolves per session workspace — the probe starts from the session cwd (never the launch/process cwd), so the engine-status watermark and the gates follow the workspace the session actually works in; an explicit `harnessDir` config still wins outright.
