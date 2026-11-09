---
module: packages/engine store runtime floors and the activation attestation
date: 2026-09-23
problem_type: tooling_decision
category: tooling-decisions
severity: medium
plan_id: "<plan-id>"
last_updated: 2026-11-09
applies_when:
  - "Comparing a version string that arrives from an operator, an attestation or a transport"
  - "Designing a floor or minimum-version check whose input is not machine-generated"
  - "Diagnosing a below-the-floor refusal that looks wrong for the reported version"
tags:
  - version-compare
  - runtime-floor
  - attestation
  - misleading-refusal
  - input-normalization
---

# A tolerant version compare turns a malformed version into a "below the floor" refusal

## Context

The engine's dotted-version compare is deliberately tolerant about *shape*:

```ts
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => Number.parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => Number.parseInt(s, 10) || 0);
  // ...element-wise compare with missing segments as 0
}
```

`Number.parseInt` returns `NaN` for a segment that does not start with a digit, and `|| 0` folds that to zero. So `"v24.21.0"` compares as `0.21.0` — older than every real floor. During the execution-store activation barrier, the operator-supplied attestation field `runtimeVersion` was given in that prefixed form, and the barrier refused with the below-the-floor message ("an old binary is not a compatible consumer") even though the runtime was current. The engine's own callers are not exposed: runtime detection returns a bare version (`Bun.version`, `process.versions.node`). The exposure is every path where a version arrives as **text from outside** — an attestation, a transport field, a CLI argument.

## Guidance

- **Decide the input contract at the boundary, not inside the comparator.** A helper whose job is ordering must stay total (it must not throw on a stray token), so it cannot also be the thing that validates the input shape. Validate or normalize where the human/transport input enters:
  - require the bare version in the attestation field and say so next to the field, **or**
  - strip the prefix (`.replace(/^v/, "")`) before comparing, as `probePathNodeRuntime` does with `node --version` output (`packages/commands/src/host-health/mcp.ts`).
- **Keep the refusal honest.** A check that only knows "less than the floor" cannot distinguish *genuinely older* from *unparseable*, and it reports the wrong cause. Where the input can be malformed, assert a version shape first (the repo's shape guard is `PLUGIN_VERSION_SHAPE_RE` in `packages/commands/src/host-health/plugin-version-alignment.ts:10`: `/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/`) so a failed or malformed read fails loudly as a shape error instead of silently comparing as zero.
- **Mind the direction of the coercion.** The same tolerance applied to the *floor* operand would make a floor check vacuously pass (`0.0.0` is below nothing). Malformed input on either side is a correctness problem, not a formatting nicety.
- **Name the transport in the diagnostic.** Fail-closed is not enough: an operator hitting a barrier on a live authority needs the refusal to point at the field and the expected form, since the failure mode otherwise reads as "the deployed runtime is too old" — the most alarming possible interpretation, and the wrong one.

## Why This Matters

The activation barrier is the most consequential operation in the store lifecycle, and it is gated on operator-supplied text. A fail-closed-but-misleading refusal costs a round trip at exactly the moment the operator is least willing to experiment, and it teaches them that the barrier's messages cannot be trusted — the opposite of what a gate needs. The same class is latent in every minimum-version check fed by anything other than a runtime call: the comparison succeeds, the verdict is arithmetically correct for the coerced input, and only a human reading both the input and the message can tell that the input never meant what it was coerced into meaning.

## When to Apply

- Adding or reviewing a floor / minimum-version / feature-gate check whose input is text (attestations, manifests, plugin metadata, CLI flags, environment variables).
- Any caller of a tolerant comparator where the value could be operator-supplied.
- When a version refusal contradicts the version the operator reports: check the coercion path before assuming the runtime is old.
- When writing the attestation or transport schema for a version field — state the expected bare form where the operator will read it.

## Examples

### Before

`attestation.consumers[i].runtimeVersion = "v24.21.0"` → `compareVersions("v24.21.0", readDeclaredNodeFloor()) < 0` → barrier blocked with "an old binary is not a compatible consumer".

### After

The same field supplied as the bare runtime version compares as intended and the barrier proceeds. For machine-produced callers nothing changes — which is precisely why the trap survived until an operator hit it.

## Source

Iteration `iter-<plan-id>`: the refusal was observed while executing the store activation barrier recorded in the iteration compass closure record, and the framing rules live in the execution/store specs of the same iteration package. Source anchors: `packages/engine/src/store-db.ts` (`compareVersions` at :133 and the runtime support check), `packages/engine/src/store-activation.ts:1080-1097` (the attestation consumer check: `runtimeVersion` → `compareVersions(runtimeVersion, readDeclaredNodeFloor())`), `packages/cli/test/issue.test.ts:563` (below-floor refusal asserting the manifest-declared floor), `packages/commands/src/host-health/mcp.ts:65` (the strip-the-`v` probe). Related: `tooling-decisions/dsh-llm-fallbacks-version-ssot.md` (version pins that must stay in lockstep).
