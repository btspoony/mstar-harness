---
module: engine gates / omp hooks / opencode / dsh gates
date: 2026-08-20
last_updated: 2026-11-09
problem_type: config_error
category: config-errors
severity: high
plan_id: <plan-id>
symptoms:
  - "default .mstar root layout: coordination-document writes silently ungated (fail-open) despite a hard compass"
  - "harnessDocKindOfTarget resolved the NESTED {HARNESS_DIR}/plans subdir as the harness root"
  - "pathological double harness: an inner sparse harness below an outer full-marker root left inner docs ungated"
root_cause: "harness root for doc classification came from resolveHarnessDir's rung-3 plans/ probe, which matches the nested {HARNESS_DIR}/plans subdir of the default .mstar layout and returns it as the root — coordination docs then fall outside the canonical harness-relative set, classification returns null, and the write passes silently (fail-open)"
resolution_type: code_fix
tags:
  - fail-open
  - harness-root
  - classification
  - marker-probe
  - default-layout
  - gate
---

# Harness doc-kind classification fail-open (default .mstar layout)

## Problem

The v3 write-gate classifies a target path as one of the three coordination documents — root `status.json`, `workflows/<id>/snapshot.json`, `projects/<id>/residuals.json` — and validates it with the matching engine validator; everything else is not a gated write (silent pass). Under the DEFAULT `.mstar` layout (where `plans/` lives INSIDE the harness root), classification resolved the harness root via `resolveHarnessDir`'s rung-3 `plans/` probe. The probe matched the NESTED `{HARNESS_DIR}/plans` subdir and returned it as the root, so all three coordination docs fell outside the canonical harness-relative set, classification returned `null`, and every write passed silently — the gate failed OPEN exactly when the layout was the most common one. A second defect (W-REV-3) surfaced in the same fix wave: with a nested SPARSE harness (a `{HARNESS_DIR}/` missing one of the three full markers) below an outer FULL-marker root, the probe returned the outer root and the inner docs were silently ungated.

## Symptoms

- Invalid `status.json` / `snapshot.json` / `residuals.json` writes pass the omp hook and tools on a default-layout repo, even with a hard compass (silent pass — no error, no warning).
- The classification probe returns `{HARNESS_DIR}/plans` (a directory that contains no coordination documents) as the harness root.
- Inner-harness coordination docs under a double-harness tree are never validated.

## What Didn't Work

- **`resolveHarnessDir`'s rung-3 `plans/` probe as the classification root**: inside a default `.mstar` root the probe matched the NESTED `{HARNESS_DIR}/plans` subdir — the root mis-resolution that caused the fail-open. The probe was designed for root DISCOVERY (name candidates), not for classifying a specific document against an already-known root.
- **Single-path fallback without a rebuild**: when the marker probe hit an ancestor root but the document's relative path was non-canonical, giving up left inner sparse-harness docs ungated. The fix had to REBUILD the relation against the declared-root resolution before returning null.
- **Silent pass as the classification default**: returning `null` (ungated) for anything outside the canonical set is correct for non-coordination files but must never apply to a document that IS a coordination document under a mis-resolved root — the fail-open made the whole gate advisory on default layouts.

## Solution

1. **Marker probe FIRST (`resolveHarnessRootOf`)**: walk from the target's dirname upward; the nearest ancestor holding ALL THREE markers — a `status.json` root file plus `workflows/` and `projects/` directories — IS the harness root. Unlike the rung-3 `plans/` probe, this never mistakes the nested `{HARNESS_DIR}/plans` subdir for the root.
2. **Declared-root fallback**: when no ancestor carries the three markers, fall back to `resolveHarnessDir` (`.mstarc` `harness_dir` / `MSTAR_HARNESS_DIR` declared roots that are not yet populated with all three markers).
3. **W-REV-3 rebuild**: if the probe root hit but the relation is non-canonical (pathological double harness), re-classify against the `resolveHarnessDir` result before returning null — the inner sparse-harness docs stay gated; the outer root still gates its own docs.
4. **Canonical shape is strict — one path component each**: `status.json` at the root, `snapshot.json` under `workflows/<id>/`, `residuals.json` under `projects/<id>/` (regex `^workflows/[^/]+/snapshot\.json$` etc.). Non-canonical layouts (e.g. `workflows/snapshot.json`) stay ungated — the fix must not over-gate.
5. **Parity across the classification surfaces** (same fix-wave): `packages/omp/src/hooks/pre/mstar-gates.ts` and the tracked `hooks/src/mstar-write-gate.ts` (omp), `packages/opencode/src/mstar.ts`, `packages/opencode-v2/src/gates/write.ts`, and the dsh gates (`packages/dsh/src/gates/status.ts` / `adapter.ts`). The standalone `tools/*` validators moved into the CLI MCP server and their arms were deleted with `packages/omp/src/tools/`. The dsh gates document an intentional divergence: they already resolve `{HARNESS_DIR}` per calling-session workspace through the shared `HarnessResolver` BEFORE the intent slot, so classification is against that resolved root — no second probe, no W-REV-3 rebuild.

```ts
// Paraphrased — engine packages/engine/src/gates.ts harnessDocKindOfTarget
// (omp/opencode/opencode-v2/dsh gates consume this same classifier)
const name = basename(resolved);
if (name !== STATUS_FILE && name !== SNAPSHOT_FILE && name !== REGISTER_FILE) return null;
const probeRoot = resolveHarnessRootOf(dirname(resolved));   // marker probe: status.json + workflows/ + projects/
const harnessDir = probeRoot ?? resolveHarnessDir(dirname(resolved)); // declared-root fallback
const classified = classify(harnessDir, resolved);
if (classified !== null) return classified;
if (probeRoot === null) return null;                          // no probe hit — nothing gated
const fallbackDir = resolveHarnessDir(dirname(resolved));     // W-REV-3: rebuild against declared root
return fallbackDir === null || fallbackDir === probeRoot ? null : classify(fallbackDir, resolved);
```

## Why This Works

- The marker probe identifies the root by the v2 coordination-document markers THEMSELVES, so a default-layout root (whose `plans/` is a content subdir, not a marker) resolves correctly by construction — the mis-resolution mode cannot recur.
- The declared-root fallback covers legitimately non-populated roots, and the W-REV-3 rebuild covers nested sparse harnesses, so the classification never silently drops a coordination document that a declared root would gate.
- The strict canonical set prevents over-gating: stray same-named files outside the canonical relative shapes remain ungated (regression-tested).

## Prevention

- Classification of a coordination document must never depend on a root probe that can match a NESTED content subdir. Marker probes (or an already-resolved per-session root) are the two sanctioned forms.
- Keep the "must not over-gate" direction tested: canonical shapes only, one path component each; the W-REV-2 (default `.mstar` layout) and W-REV-3 (double harness) fixtures pin both directions in `packages/cli/test/tools-v2-smoke.test.ts` (tool + omp hook + opencode surfaces).
- When a fix adds a fallback path, also add the case where the fallback must NOT apply (fallbackDir equals probeRoot → null), so the rebuild doesn't become a second silent pass.
- Related harness-root resolution defects: `config-errors/harness-root-discovery-override.md` (non-default root names + fail-closed worktree guard) and `architecture-patterns/dsh-harness-root-boundary.md` (workspace-root stop boundary) — same probe-family, different failure modes; changes to any one must re-check the other two surfaces.
