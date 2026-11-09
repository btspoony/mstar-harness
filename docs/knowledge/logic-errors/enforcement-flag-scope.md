---
module: engine-enforcement
date: 2026-08-08
problem_type: logic_error
category: logic-errors
severity: high
plan_id: <plan-id>
symptoms:
  - "an example line '**Enforcement**: hard' quoted in an Assignment body false-hardened the dispatch"
  - "a COMPLETED iteration's delivery-compass with enforcement: hard kept the repo hardened forever"
  - "unsetting the flag in the active iteration's compass did not roll back hard mode while an older completed compass still declared hard"
root_cause: "flag scanning was region-unaware (whole-text regex read the Assignment flag from anywhere in the prompt) and lifecycle-unaware (compass scanning considered every iteration directory, including status: completed, with first-hard-wins)"
resolution_type: code_fix
tags: [enforcement, flag-scope, compass, header-region, rollback, hard-gate]
---

# Scoping enforcement flags: header-region parsing + active-compass scanning

## Problem

Hard-gate enforcement (`Enforcement: hard` / compass `enforcement: hard`) is opt-in per Assignment or per iteration, never global, with "rollback = unset the flag" as the advertised contract. Two scanning bugs broke that contract: the Assignment flag was parsed from the **entire prompt** (so an example/template line in the body false-hardened a dispatch), and the compass scan considered **every iteration directory** (so a completed iteration's hard flag kept the repo hardened across iterations, making rollback require auditing all historical compasses).

## Symptoms

- Dispatch logs show `hardBlocked: true` (and error-level lines) for a dispatch whose Assignment header never declared the flag — because the task body quoted the exact line `**Enforcement**: hard` as an example.
- A repo whose current iteration compass has no hard flag still behaves hard, because an older `status: completed` compass still declares `enforcement: hard`.
- Operators cannot roll back by unsetting the active compass; the documented D2 rollback ("unset the flag") silently fails.

## What Didn't Work

- **Whole-text multiline regexes** (`/^[ \t]*(?:[-*][ \t]+)?\*\*\s*Enforcement\s*\*\*\s*:/m` on the full prompt): correct for the header, wrong for the body — any quoted example anywhere in the prompt matches.
- **Scanning every `{ITERATION_DIR}/<id>/delivery-compass.md` with first-hard-wins and no status filter**: makes hard mode sticky across iterations; the test "any compass declaring hard → hard" codified the wrong behavior (qc1 F-001 / qc2 F-002).
- **Rejecting quoted-comma flow arrays as a workaround** (compass `plans` parsing): necessary for correct YAML-ish parsing but unrelated to scope — scope is a region/status question, not a syntax question.

## Solution

1. **Header-region scoping for the Assignment flag.** Slice the Assignment text at the first body marker — a `# Task`-style heading (any level), a `---` horizontal rule, or a single-`#` heading (`# Target` / `# Goal` / `# Change`). The `## Assignment` heading itself is NOT a boundary. Parse `Enforcement:` / `**Enforcement**:` against this region only:

```ts
const ASSIGNMENT_BODY_START_RE = /^(?:#{1,6}[ \t]+Task\b|-{3,}[ \t]*$|#[ \t])/m;

export function assignmentHeaderRegion(assignmentText: string): string {
  const marker = assignmentText.match(ASSIGNMENT_BODY_START_RE);
  return marker !== null ? assignmentText.slice(0, marker.index) : assignmentText;
}
```

2. **Lifecycle-scoped compass scanning.** `resolveCompassEnforcement` iterates iteration dirs but skips any compass whose frontmatter `status` is not `active` or `locked`; only the FIRST active/locked compass declaring `enforcement: hard` hardens the gate. Completed (and status-less/archived) compasses NEVER harden:

```ts
// status: active|locked only — completed iterations cannot keep the repo hard
if (!/^status[ \t]*:[ \t]*(?:active|locked)[ \t]*$/m.test(fm)) continue;
const flag = parseEnforcementFlag(fm);
if (flag.hard) return flag;
```

3. **Rollback semantics restored.** Unsetting the flag in the active compass (or removing `Enforcement: hard` from the Assignment header) is now sufficient — completed historical compasses are inert.

## Why This Works

- The header region is where an Assignment's declared contract lives; anything after `# Task` / `# Target` / `---` is instructions or examples, not declaration. Region-scoped parsing makes the flag match what a human reader of the header would conclude.
- Compass lifecycle status (`active` / `locked` vs `completed`) is the repository's own signal for "this iteration is still steering the repo". Filtering on it makes hard mode per-current-iteration by construction, so the D2 "rollback = unset" invariant holds across iterations and multiple historical compasses.
- Both fixes are fail-soft: a body-only example yields `hard: false` (warn-only), and an unreadable/status-less compass yields `none` — never an accidental hard stop.

## Prevention

- **Any flag parsed from prompt text must be region-scoped** — define where the declaration region ends and test that body examples do not match (fixture: assignment with `**Enforcement**: hard` quoted in the task body → no hardening).
- **Any cross-directory config scan must filter by lifecycle state** — for iteration compasses: `status: active|locked` only; add regression fixtures for `completed+hard + active+unset → soft` and `completed-only hard → none`.
- Keep the enforcement ladder honest: warn-only by default, hard only behind an explicit flag, and every hard-mode test must assert the *unset* case still warns (rollback coverage).
- When adding a YAML-ish frontmatter parser (flow arrays, quoted values), prefer quote-aware scans that fail closed on ambiguity (nested arrays, comma-inside-quotes) over naive splits — but keep scope fixes (region/status) separate from syntax fixes.
