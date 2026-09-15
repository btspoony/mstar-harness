---
category: Changed
packages: engine
---

- Plan-session coordination scope resolution no longer re-derives the harness root through Git when the session already carries a validated root, so a Git-less environment surfaces `coordination.git-unavailable` from the Git read instead of a misleading scope mismatch; added subprocess regression coverage classifying nonzero, timeout and missing-git failures.
