---
module: packages/cli
date: 2026-10-21
last_updated: 2026-10-21
severity: medium
track: knowledge
problem_type: architecture_pattern
category: architecture-patterns
tags:
  - mcp
  - tool-surface
  - context-budget
  - coordinator-seat
  - published-peer
related:
  - dsh-delegation-channel-contract
---


## Context

The mstar MCP server published one tool per command (113 tools, 189k chars of `tools/list` — 81% of a session's tool surface). Folding it to one tool per family cut that to 33 tools / 31k chars. The same cut removed 12 dsh-native duplicate tools. Both changes have repeatable rules worth reusing.

## Rules that held

1. **Fold at the publication layer, never at the validation layer.** One tool per family (`mstar_<family>` + required `action` enum + union of member properties), but every call resolves `action` back to the real command definition and runs the *unchanged* admission path. The published shape shrinks; the validating shape does not move. Anything that makes the published union the validating shape silently loosens every action.
2. **A union schema lies in two directions and both must be handled.** Advertised-but-ignored: refuse a supplied key the selected action does not accept (a dropped *filter* returns an unfiltered page that reads as filtered). Advertised-but-refused: withhold a shared field whose declarations disagree on type/enum instead of publishing the first declaration (`issue.disposition` published `open` while `close` refused it). `oneOf` per action is the faithful shape but costs budget — withholding plus a description pointer is the cheaper honest option.
3. **Aggregate every refusal before admission.** A pre-admission guard that returns on the first bad key recreates the one-field-per-attempt loop the CLI contract forbids. Collect selectors, undeclared keys and the action's own admission diagnostics, drop the rejected keys, admit once, return one envelope. Sanitize caller-supplied keys on the way out (a key name is caller text).
4. **A guard list is a defect; derive the set.** Two hand-maintained leaf-refusal lists drifted (three commands vs two) and the missing members were live escapes (`workflow.evidence`, `session.run`). The fix is one derivation over the command corpus consumed by both layers, plus a parity test that iterates every definition — and a mounted-connection test, because a host pre-execute guard and a server `--seat` filter fail independently.
5. **A seat is not only "bind".** Anything that builds `{role: "coordinator"}` from a caller-supplied session mints or replaces a seat: `plan.bind`, `plan.complete`, `session.recover`, `session.run` (it mints an identity for a child the caller chooses to launch), `status.workflow-close`, the whole `workflow` family, `workflow-note.append`, `iteration.register`. Operations that merely *exercise* an existing binding (`plan.prepare`, `plan.progress`, `plan.issue-*`) stay leaf-reachable on purpose.
6. **Never add a peer symbol to a package the release never publishes.** `@mstar-harness/commands` is `private: true` and excluded by `scripts/release-preflight.test.ts`; a dsh import of a new export from it fails at ESM instantiation in an installed deployment, before `apply` runs. Consumption must rely only on exports present in the supported published peer, or the derivation must live in a module the consumer bundles. `bun run build` alone does not catch this — check the built bundle's import set against the published tarball.

## Cost of getting these wrong

Each of the six was found by a reviewer, not by the test suite: the local suites were green through two of the escapes. The cheap insurance is a product-behaviour test per guard (mounted connection + real stdio) rather than wiring assertions, and an explicit peer-surface check in the build.
