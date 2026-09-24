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
