# L1 refusal diagnostics across hosts

> **Load when:** diagnosing `worktree.l1.*` refusal codes from CLI / dsh / omp, or comparing host fail-closed behavior with engine SDD governing-row discovery.

CLI, dsh, and omp share `worktree.l1.lifecycle-register-unreadable` when the active register cannot be enumerated and `worktree.l1.lifecycle-snapshot-unreadable` when a registered sibling cannot be read/validated. They fail closed; an absent register contributes no siblings. Engine SDD governing-row discovery remains lenient for unreadable siblings (only readable active snapshots contribute), but a governing active snapshot carrying both integration/control path keys refuses instead of becoming standalone. This is an intentional engine-versus-host seam distinction, not equivalent evidence coverage.

`worktree.l1.integration-missing` covers required integration inputs not supplied and a supplied integration path absent on disk; an existing unusable checkout is reported by branch/checkout probe failures. A standalone plan with both integration fields omitted has no integration requirement and does not emit this code.
