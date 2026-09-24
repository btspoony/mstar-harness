# Judgment review advice

The `mstar-harness judgment review-advice` command requests bounded, non-authoritative review advice through the local evaluator mailbox. It does not alter findings, decisions, rankings, scores, or tally calculations.

Judgment is **off by default**. Without an explicit `[config]` `jev_mode=shadow` and `jev_transport=typesafe` in `.mstarc`, the command returns a `disabled` result without opening the pack or pilot, creating a mailbox, or contacting an evaluator. Invalid or unsupported configuration fails closed. The command never uses assist or a host-provided judgment fallback.

When enabled, invoke with exactly one pack input and an explicit pilot:

```sh
mstar-harness judgment review-advice \
  --file .jev/review-pack.json \
  --pilot .jev/synthetic-pilot.json \
  --workspace .
```

Use `--stdin` instead of `--file` to read the pack from standard input. The pilot must explicitly grant `synthetic-only` permission and declare the supported bounded native TypeSafe transport. Pack, pilot, and workspace inputs are constrained to the workspace; the pilot and pack are validated before the request is submitted. Deadlines, revocation, and cancellation are enforced by the judgment runtime. `SIGINT` and `SIGTERM` cancel the pending optional request and exit with 130 and 143 respectively.

The command writes one JSON result to stdout with schema `mstar.judgment-cli/v1`; `advice` is always `null`. Exit status is 0 for `disabled` or `recorded`, 1 for unavailable or invalid runtime outcomes, 2 for usage errors, 130 for `SIGINT`, and 143 for `SIGTERM`. Invalid flags and mutually exclusive input options produce a single structured `jev.usage` result and exit 2.

If the evaluator channel or isolation boundary is unavailable, the result is unavailable. There is no direct provider fallback, salvage, or assist path. This package-level check does not qualify a native endpoint or an installed host; live native success must be evidenced separately against the exact executable digest.

The trusted shadow supervisor script is intentionally excluded from the root package index; `runShadowCommand` is exposed through the dedicated typed subpath `@mstar-harness/judgment/shadow`.

## Optional Stage 3 shadow exercise

The audit review's optional synthesis step is specified in `mstar-audit` → `references/pr-review.md` § Optional finite A05 shadow step. It is **not** wired into `mstar pr-review` automatically. The main agent continues its original-domain collection, cited-code vet, semantic dedupe, rejected-candidate record, linked-issue AC, issue capture, tally, verdict, report and posting even when judgment is off or fails. A matching fingerprint or explicit relation is only a deterministic pair suggestion: it cannot merge findings. Only an explicitly source-authorized, synthetic-only pack may be submitted by the present executable path; real-source egress is not authorized.

For an account-free **component** run, construct a fresh private absolute run root outside the reviewer mount, with `source/` (synthetic only), `output/`, `requests/`, `scratch/`, `evaluator/`, and a regular `status.json`. Populate `study-manifest.json` with schema `mstar.shadow-study/v1`, a common valid `runId`, `evidenceClass: "component"`, a validated review `pack` and matching `pilot` (`mode: "shadow"`, `transport: "native-typesafe"`, `permission.dataClass: "synthetic-only"`, manifest-bound canonical pack hash), a pinned approved `child` (local executable SHA-256, Docker binary SHA-256 and image digest, nonroot UID/GID, `/worker/...` executable, finite elapsed/output caps), a `mountPlan` naming those five exact root-local paths plus `evaluatorData: [<absolute evaluator directory>]`, empty `evaluatorCredentialEnv`, and the enforced read-only/nonroot/capability/PID/socket flags. `baseline` contains the original work inventory, actual seat outputs, original consumption and final report; a unit is complete only when its original output was consumed and that output appears in seat outputs. Obtain a vetted component worker and pinned image from a prior confinement proof, or run that proof first; launch arguments alone do not establish isolation. Never put source, evaluator data or credentials in a worker-readable mount, Docker environment, status or report. Fresh runs need fresh roots because baseline, receipts and assessment are write-once artifacts.

From the repository worktree, exercise the actual finite supervisor (replace the example path with that fresh **absolute** root):

```sh
bun run packages/judgment/scripts/shadow.ts exercise --root /absolute/synthetic-component-root
bun run packages/judgment/scripts/shadow.ts assess --root /absolute/synthetic-component-root
```

`exercise` runs the approved Docker child, freezes and seals `baseline.json` before its request lifecycle, records `probe-events.json`, `study-result.json`, `receipts.json` and `assessment.json`, and prints bounded status/metrics. `assess` rechecks identity, completed-study status, original consumption, receipts and child lifecycle; it refuses an incomplete/failed study rather than upgrading it. Both paths reject `evidenceClass: "named-host"`. Check every receipt's `owner: "original"`, `jevWorkCredit: 0`, the assessment's `evidenceClass: "component"`, `qualification: "component-only"`, `w5: false`, and any actual failure codes; do not call an unavailable result a success. A probe may exercise the child lifecycle and confinement **without making an attributed provider call**; it is not proof of any of the six quality buckets. Those require separately authorized, measured evaluator responses. A controlled stub/fixture can test classification mechanics but never serves as calibration, holdout or actual TypeSafe evidence.

An actual host/tool-path and real W5 assessment require separate source and account authorization and remain an open verification obligation. Do not log in, search for accounts, copy credentials, switch `evidenceClass`, claim saved work, infer a 30/40 savings result, or close that obligation from component/synthetic output. Optional cancellation, deadline, missing permission or failure leave the ordinary review and all original work owned by their original seats; no hints or raw result leave the evaluator boundary.
