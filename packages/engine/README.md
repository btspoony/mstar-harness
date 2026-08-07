# @mstar-harness/engine

Morning Star (启明星) harness engine — deterministic library for harness checks (version, path, status, lease, validation), shared by the installer CLI and the OpenCode plugin.

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
- Dependencies locked to `zod` + `ajv` + `node:*`.
- Skill prose stays authoritative; engine exports are the machine-checkable mirror of the rules the `mstar-*` skills state.

## License

MIT — see [LICENSE](https://github.com/btspoony/mstar-harness/blob/main/LICENSE).
