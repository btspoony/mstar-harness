---
category: Changed
packages: engine
---

- Migration archive, notes and roadmap targets are now **raw-byte ownership-guarded**: identical targets converge untouched, divergent targets refuse with `coordination.version-conflict` (root stays v1, earlier additive outputs recoverable), and absent targets are created exclusively without overwriting.

