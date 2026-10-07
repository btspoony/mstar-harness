# @mstar-harness/engine

Morning Star harness engine — deterministic library for harness checks (version, path, status, lease, validation), shared by the installer CLI and the OpenCode plugin.

## Install

```bash
npm install @mstar-harness/engine
```

## Usage

```ts
import { readHarnessVersion } from "@mstar-harness/engine";

const version = readHarnessVersion(); // "1.8.8" — monorepo root package.json
```

## Scope

- Importable library only — **no `bin`**; the CLI (`@mstar-harness/cli`) wraps engine functions as thin `mstar …` subcommands.
- Dependencies: `node:*` only (zero external runtime deps — all validators hand-rolled; ajv and zod were pruned as phantom dependencies).
- Skill prose stays authoritative; engine exports are the machine-checkable mirror of the rules the `mstar-*` skills state.

Plan rows use one workflow primary coordinator and ordinary prepare/progress/complete actions. Configuration/source metadata are revisable (mandatory QA and allow-residual cleanup by default); neither sealed Assignments nor per-row identities/claims are admission requirements. Completion preserves QC/QA, transaction/CAS/receipts, actual iteration merge proof, standalone development delivery and report-only policy fulfilment.

## License

MIT — see [LICENSE](https://github.com/btspoony/mstar-harness/blob/main/LICENSE).
