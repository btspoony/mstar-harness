# ADR: The three corpora default to `.agents/`, and `.mstarc` alone decides where they live

Status: implemented — one stated default per corpus, and a writing step resolves the symbol instead of composing a path
Date: 2026-11-11

## Problem

The three tracked corpora — knowledge (`{KNOWLEDGE_DIR}`), specs (`{SPECS_DIR}`) and ADRs (`{ADR_DIR}`) — carried two competing defaults. The resolver chain answered `{HARNESS_DIR}/<kind>/` first and fell back to creating that directory, while `scaffoldHarness` wrote `.mstarc` declarations pointing at `.agents/<kind>` (issue #714). The prose followed the code, so `mstar-doc-corpus`, `mstar-knowledge`, `mstar-conventions` and the storage tables each described the harness root as a corpus home.

Two failure modes followed. An agent that read a default and composed the path itself wrote into a directory `mstar path resolve` would never have returned — the gitignored `.mstar/`, where the document is invisible to every clone. And a repository whose `.mstarc` declared a layout was described by the docs as if it did not, so the stated layout and the resolved layout disagreed for every reader who did not run the resolver.

The default is a claim about all repositories. It must be the one place that survives a fully gitignored harness root, and it must not be restated as an alternative to a declaration.

## Decision

A `.mstarc` directory key is the only authority: `specs_dir`, `knowledge_dir` and `adr_dir` resolve against the config file's directory and are returned even when the directory does not exist. Every other statement about these three layers is a **default**, not a layout.

Without a declaration the chain is:

1. `<repoRoot>/.agents/<kind>/` — the preferred default, outside the harness root.
2. Kind-specific secondaries: specs keep `docs/specs/`, repo-root `specs/`, then legacy `{HARNESS_DIR}/designs/` and repo-root `designs/`; ADRs keep `docs/adr/`; knowledge has none.
3. `{HARNESS_DIR}/<kind>/` last, read only.
4. Nothing non-empty: create `<repoRoot>/.agents/<kind>/` unless the caller passes `create: false`.

Every candidate keeps the empty-dir-as-absent rule, and the candidate list is deduped so a `.agents` harness root cannot test one directory twice. The legacy rung is a read source: it is never created, never the fallback, and no document presents it as a place a corpus lives.

A writing step resolves the symbol before it writes — read `.mstarc`, or run `mstar path resolve` — and never composes a default path. This is the rule that closes the issue: the disagreement between two defaults disappears once nobody is allowed to pick one.

## Alternatives considered

**Keep the harness-first default and fix the prose.** Rejected: it preserves the actual defect. The harness root is gitignored by the canonical snippet, so a corpus created there is unshareable by construction, and `mstar path check` would keep reporting it as a `path.result-ignored` warning forever. It also leaves two defaults standing, so the next reader repeats the mistake.

**Gitignore `{KNOWLEDGE_DIR}` instead, and keep corpora under the harness root.** Rejected: it inverts the project's stated rule that process stays local and results are shared. It would also push every tracked corpus into an ignore exception in every repository — a rule the harness would have to police rather than one the layout gets right for free.

**Make `.mstarc` required so no default exists.** Rejected: it breaks the standalone corpus case. A project that wants governed documentation and no harness has no reason to learn a config format before writing its first knowledge page, and `mstar-doc-corpus` explicitly serves that case. It also converts every existing repository without a declaration into a hard failure instead of a well-defined default.

## Consequences

- A repository without a declaration now gets `.agents/knowledge|specs|adr` and a tracked corpus that survives a gitignored `.mstar/`. Repositories that already declare keys — including this one, on `docs/knowledge`, `docs/specs` and `docs/adr` — are unchanged: the declared value wins before any candidate is examined.
- The legacy `{HARNESS_DIR}/<kind>/` rung stays readable so a repository that carried corpora there does not lose sight of them on upgrade. It can be deleted once no repository is expected to carry pre-move content, which is the cost of keeping it: one extra stat per resolution until then.
- Any writer that composes a path instead of resolving the symbol is now wrong by rule, not merely by preference; the rule is stated in `mstar-conventions` (symbol table preamble and resolution chains), `mstar-doc-corpus` § Layout defaults, `mstar-knowledge` § Storage, `mstar-artifacts` § Workflow, and `docs/specs/architecture/document-corpus.md`.
- `scaffoldHarness` writes `.agents/{knowledge,specs,adr}` into `.mstarc` and creates the resolver-returned directories, so a scaffolded project is explicit from its first commit and never depends on the default.
