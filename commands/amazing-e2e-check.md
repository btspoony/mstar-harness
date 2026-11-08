---
name: amazing-e2e-check
description: Run explicitly requested E2E, browser, device, or installed-deployment scenarios in an independent verification workflow.
agent: project-manager
input: "[environment/device] [scenarios]"
---

# Independent E2E Check

Load `mstar-harness-core`, then `mstar-e2e`. Pass the user's environment/device, scenario scope and authorization to that workflow. PM orchestrates; the assigned `ops-engineer` executes. The skill owns registration, evidence, scope boundaries and closure. Routine development acceptance does not authorize E2E or insert it into an iteration.
