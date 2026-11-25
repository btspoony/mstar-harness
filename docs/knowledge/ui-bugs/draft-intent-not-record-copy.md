---
module: packages/ui milestone editor and create form, dsh panel write channel
date: 2026-11-26
problem_type: ui_bug
category: ui-bugs
severity: high
symptoms:
  - "A refused milestone write closed the editor and cleared the create form, so every other field had to be retyped"
  - "After the reload was suppressed for refusals, a stale revision made every retry fail until the operator navigated away and back"
  - "After the draft was restored wholesale, retrying a rename reverted another writer's updated estimate"
root_cause: "The form draft was treated as a snapshot of the record instead of the operator's intent: it was seeded with every field, restored wholesale across a refresh, and compared against the refreshed record, so untouched stale values were sent as edits while the fields that needed a fresh read were not refreshed."
resolution_type: code_fix
tags:
  - draft-state
  - refresh
  - revision-conflict
  - operator-intent
  - panel-writes
related_components:
  - packages/engine milestone CAS writes
  - dsh once-reader
---

# A form draft is the operator's intent, not a copy of the record

## Problem

The milestone editor and create form live under a read that a write can refresh. Keeping the operator's typed
values across that refresh took three successive fixes, and each fix created the next defect: the draft was
destroyed by the unmount, then the refreshed revision was never picked up, then a retry silently reverted a
value another writer had changed.

## Symptoms

- A refused write closed the editor and cleared the create form, so the operator retyped every other field.
- After the reload was suppressed, a stale revision made every retry fail forever until the operator
  navigated away and back.
- After the draft was restored wholesale, retrying a rename reverted another writer's updated estimate.

## What Didn't Work

- **Keep the component mounted by not reloading on any refusal**: correct for an input refusal (nothing was
  written, nothing to refresh) but wrong for a revision conflict, which NEEDS a fresh read — the retry
  otherwise sends the same stale expectedStoreRevision forever.
- **Restore the whole stored snapshot after the refresh**: the draft was seeded with every field, so fields
  nobody touched carried stale values; the patch compared them against the refreshed record and sent them,
  overwriting a concurrent change.
- **Restore only the values, not the intent**: showing a stale untouched status makes selecting that same
  option a no-op (no change event fires), so the operator's choice never travels.

## Solution

Separate three facts: which fields the operator edited (touched), the values they typed, and the record the
refresh just read.

```ts
// The draft carries what the operator changed, not just what the form shows.
export type MilestoneDraft = {
  name: string;
  effort: string;
  status: string;
  touched: ReadonlySet<"name" | "effort" | "status">;
};

// Only a touched field can travel, and only while it still differs from the fresh record.
export function milestonePatch(milestone, draft) {
  const touched = draft.touched;
  return {
    ...(touched.has("name") && draft.name.trim() !== milestone.name ? { name: draft.name.trim() } : {}),
    ...(touched.has("effort") ? effortPatch(milestone, draft.effort) : {}),
    ...(touched.has("status") && draft.status !== milestone.status ? { status: draft.status } : {}),
  };
}

// A re-mounted editor shows the FRESH record for untouched fields and the typed value for touched ones.
const touched = new Set(kept.touched ?? []);
const fresh = milestoneDraft(milestone);
const seeded = {
  name: touched.has("name") ? kept.name : fresh.name,
  effort: touched.has("effort") ? kept.effort : fresh.effort,
  status: touched.has("status") ? (kept.status ?? fresh.status) : fresh.status,
  touched,
};
```

The reload rule follows from the same classification: refresh after an ACCEPTED write and after a revision
conflict; do not refresh after an input refusal. An empty patch never reaches the channel — if nothing the
operator edited still differs, close the editor instead of submitting a write the engine must refuse.

The draft store itself must be owned above the read subtree (the panel seat), keyed by the identity the form
was opened over plus its target, or the unmount destroys it before the refusal is even shown.

## Why This Works

A refresh replaces the record; the operator's intent is the only state a refresh cannot reconstruct. Storing
intent (touched) makes every other behaviour fall out: untouched fields always show and send nothing, concurrent
changes survive, and a cleared field stays expressible because clearing is an edit.

## Prevention

- When a form must survive a reload, store **which fields were edited**, not a snapshot of the values.
- Classify refusals before deciding to refresh: an input refusal wrote nothing; a conflict needs the new read.
- Never submit an empty patch — a write with nothing to send is a refusal the operator reads as failure.
- Prove it at the channel: advance the store between the read and the submission, then assert the retry carries
  the new revision and only the edited field.
