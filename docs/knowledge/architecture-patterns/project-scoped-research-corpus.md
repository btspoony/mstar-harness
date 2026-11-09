---
module: engine
date: 2026-08-20
last_updated: 2026-08-20
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: "<plan-id>"
tags:
  - project
  - references
  - research-corpus
  - PROJECT_DIR
applies_when:
  - storing theme-scoped surveys or epic notes
  - listing files under a project dir
  - deciding dump vs project-home for research
---

# Project-scoped research lives under `{PROJECT_DIR}/<id>/references/`

## Context

v3.0.0 shipped projects as `roadmap.md` + `residuals.json` only. Theme-scoped research sat in a harness-root dump `{HARNESS_DIR}/references/`. User lock (v3.1.0): surveyed references belong under the **project** that owns the theme — not `{SPECS_DIR}`, `{KNOWLEDGE_DIR}`, or harness-root dump.

## Guidance

- Canonical tree: `{PROJECT_DIR}/<id>/references/` (one-level files + one-level subdir files).
- Engine: `PROJECT_REFERENCES_DIR = "references"` and `listProjectReferenceFiles(projectDir)` — **filenames only**, never markdown schema, never throws; missing dir → `[]`; skip `roadmap.md` / `residuals.json` at the references **root**.
- Dual-home is forbidden after dogfood: dump directory **absent** or a **one-line README redirect**. This repo dogfood: `{HARNESS_DIR}/projects/_default/references/` with no harness-root dump (the redirect was removed).
- Distinct from specs/knowledge/iteration package guides.

## What Didn't Work

Putting research in `{KNOWLEDGE_DIR}` or `{SPECS_DIR}` mixes operator surveys with harness-reusable knowledge / locked specs. A second live dump next to `_default` silently forks the corpus.

## Why This Matters

Future agents searching `{HARNESS_DIR}/references/` for write/read home are wrong. List via engine helper; do not parse research bodies.

## When to Apply

Any new survey, EPIC notes, or third-party dump attached to a project id.
