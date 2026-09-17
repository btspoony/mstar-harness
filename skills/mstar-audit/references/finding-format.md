# Finding Format

The structured shape every audit finding must take — whether produced by a subagent or by a direct audit pass. Extracted from `audit-playbook.md` for quick reference and subagent dispatch.

## Why structure matters

Findings flow into a prioritization table and then into self-contained plans. Without structure, the auditor cannot compare leverage across categories, and the plan author cannot judge effort honestly. The format forces evidence before opinion.

## Template

```markdown
### [CATEGORY-NN] Short imperative title

- **Evidence**: `path/file.ts:123` — one-sentence description of what's there.
  (Repeat per location; 2–5 strongest locations, note "and ~N similar sites" if widespread.)
- **Impact**: What goes wrong / what's being paid because of this.
  Concrete: "every order-list render issues 1+N queries", not "suboptimal".
- **Effort**: XS | S | M | L | XL — for the *fix*, including tests.
  (Morning Star agent-oriented effort scale.)
- **Risk**: What the fix could break; LOW/MED/HIGH plus one line why.
- **Confidence**: HIGH (read the code, certain) / MED (strong signal, needs verification) /
  LOW (smell, needs investigation). LOW-confidence findings may be reported but get an
  "investigate" plan, not a "fix" plan.
- **Fix sketch**: 1–3 sentences, enough to judge effort honestly; when the finding is structural, the sketch names the restructuring move (per the `## Structural remedies` list). Not the plan — just enough to judge effort honestly.
```

## Structural remedies

When the finding is structural, the Fix sketch names the restructuring move — e.g. replace a conditional chain with a typed dispatcher · collapse duplicate branches · separate orchestration from business logic · move feature logic to its owning layer · reuse the canonical helper · make the type boundary explicit · delete the pass-through wrapper · extract/split the oversized file. Prefer the remedy that removes moving pieces over one that relocates the same complexity.

## Category codes

| Code | Category |
|------|----------|
| `BUG` | Correctness / bugs |
| `SEC` | Security |
| `PERF` | Performance |
| `TEST` | Test coverage |
| `DEBT` | Tech debt & architecture |
| `DEP` | Dependencies & migrations |
| `DX` | DX & tooling |
| `DOCS` | Documentation |
| `DIR` | Direction (features & roadmap) |

## Machine-readable findings file (`mstar audit scaffold`)

The scaffold command `mstar audit scaffold <findings-file> [--dir <out-dir>]` turns a findings file into the numbered plan directory. The file is either a bare JSON array of finding objects or an object `{findings, needsVerification?, hardeningChecked?}`. This section is the contract for the finding objects; what the engine enforces is **carrier acceptance only** — deciding whether a finding is reportable, choosing its severity wording, grouping one root cause, and keeping a claim out of Needs-verification stay reviewer judgement.

### Field mapping and defaults

| JSON field | Engine field | Present-value contract | Absent-field behavior |
|---|---|---|---|
| `title` | `title` | String, trimmed; visible nonempty content | Usage error, exit 2 |
| `description` | `impact` | String, trimmed; visible nonempty content. No `impact` JSON alias | Usage error, exit 2 |
| `priority` | `priority` | `P1` \| `P2` \| `P3` | Usage error, exit 2 |
| `effort` | `effort` | `XS` \| `S` \| `M` \| `L` \| `XL` | Usage error, exit 2 |
| `risk` | `risk` | `LOW` \| `MED` \| `HIGH` | Usage error, exit 2 |
| `category` | `category` | `bug` \| `security` \| `perf` \| `tests` \| `tech-debt` \| `migration` \| `dx` \| `docs` \| `direction` | Usage error, exit 2 |
| `confidence` | `confidence` | `HIGH` \| `MED` \| `LOW`; explicit value is preserved (previously discarded) | Defaults to `MED` |
| `evidence` | `evidence` | Array of non-empty strings (legacy free text, rendered as-is) or `{file, line?, description}` location objects; item order preserved; `[]` valid | Defaults to `[]` |
| `evidence[i].file` | `AuditEvidence.file` | Required safe repository-relative POSIX path | Usage error, exit 2 |
| `evidence[i].line` | `AuditEvidence.line` | Positive integer when present | Omitted; rendered without a colon or invented line |
| `evidence[i].description` | `AuditEvidence.description` | Required non-empty string | Usage error, exit 2 |
| `fingerprint` | `fingerprint` | Non-empty string; passed through untrimmed/unnormalized | Omitted; the engine never invents one |
| `trace` | `trace` | Array of `{kind, file, line, scope, description}`; all five members required | Omitted |
| `severity` | `severity` | Object with all of `likelihood`, `impact`, `overall`, each `informational` \| `low` \| `medium` \| `high` \| `critical` | Omitted; never inferred from priority, risk or confidence |
| `dependsOn` | `dependsOn` | `none`, `plans/NNN-*.md`, or a plan number `NNN` (normalized to `plans/NNN-*.md`); case-insensitive | Omitted; plan renders `none` |
| `fixSketch` | `fixSketch` | Optional non-empty string | Plan block omitted |
| `verification` | `verification` | Optional non-empty string | Plan block omitted |

A finding is a finding only with non-empty `title` and `description` and valid enums; in `title`, `description`, `priority`, `effort`, `risk`, `category`, `confidence`, `evidence`, `fingerprint`, `trace`, and `severity`, a supplied `null`, wrong type, malformed object, or invalid enum value is a usage error (exit 2, diagnostics name the field path without echoing submitted values), never silent omission or default. `dependsOn` is the one exception: a supplied `null`, non-string, or empty value is treated as absent (the plan renders `Depends on: none`); only a non-empty invalid string is a usage error. Omitting `confidence`, `evidence`, or any optional field is a valid choice, not an error. Authoring guidance such as "2–5 strongest locations" is advice, not an array gate — an accepted carrier is not automatically a reportable finding.

### Deterministic gates the engine runs

`validateAuditFindingGates(findings)` (from `@mstar-harness/engine`) runs inside `scaffoldAuditPlan` before any file is written, so invalid findings exit 2 with no partial output. It checks, deterministically and only these:

- **Fingerprint** (when supplied): grammar `^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$`, credential rejection (a value redaction would alter is rejected, never rewritten into a different identity), exact case-sensitive uniqueness in the batch, and strict ASCII ordering of the supplied subsequence. Absent fingerprints are skipped; out-of-order input is rejected, never sorted — positions control plan numbers and `dependsOn`. Mixed legacy/enriched batches are accepted. Choosing a stable root-cause identity, grouping one cause, and cross-run matching remain reviewer duties.
- **Severity**: every rank must be a valid enum value, and `severity.overall` must not exceed `severity.impact`. Nothing else is computed — the gate never infers severity and never proves the claimed impact.
- **Trace**: non-empty; a single step must be `entrypoint` or `sink`, longer traces must run `entrypoint` → `propagation…` → `sink`. Each step needs a positive-integer `line`, a safe typed path, and visible `scope`/`description`. Topology validation proves format, never reachability — the trace still means what the author claims: where data enters, how it travels, where it lands.
- **Evidence locations**: object evidence `file` and trace `file` must be repository-relative POSIX paths (no absolute/drive/UNC paths, backslashes, control characters, lone surrogates, empty/`.`/`..` segments, segments ending in a dot or space), and object evidence `line` must be a positive safe integer when present (`audit.finding.evidence.line`). Unsafe paths are never normalized into acceptance, and the engine never checks filesystem existence. Legacy string evidence is free text and is not path-checked.
- **Text**: `title`, `impact`, supplied `fixSketch`/`verification`, string evidence, structured evidence `description`s, and trace `scope`/`description` must contain visible content (at least one code point outside Unicode whitespace and default-ignorable code points; lone surrogates invalid). Multilingual content is never stripped.

Gate diagnostics use stable codes (`audit.finding.fingerprint.*`, `audit.finding.severity.*`, `audit.finding.trace.*`, `audit.finding.path.*`, `audit.finding.evidence.*`, `audit.finding.text.*`) and `findings[index].field` paths only — never raw submitted values, so credential material cannot leak through error output.

### Rendering consequences

Structured evidence renders `file:line — description` (or `file — description` when `line` is omitted); string evidence keeps its existing rendering. Supplied `fingerprint`, `severity`, and `confidence` persist into both the plan and the README index (index columns appear when any displayed row carries them, appended after the Evidence column: `# | Finding | Category | Impact | Effort | Risk | Confidence | Evidence [| Fingerprint][| Likelihood | Severity impact | Severity]`). In the plan Status block the `- **Confidence**:` line is emitted for any enriched finding — non-default confidence always persists, and an enriched finding (fingerprint, severity, trace, or object evidence present) keeps even the default `MED`; only a legacy finding without enriched metadata omits the line. When the finding carries evidence, the Status block also includes `- **Evidence**: <first evidence item>` (the first item, rendered like the Evidence bullets); this line feeds the README index Evidence column so the cell survives a no-new-findings rebuild. Supplied `trace` persists into the plan only, as the `## Trace` section — it has no index column. A scaffold re-run with no new findings rebuilds the README index from existing plan files without rewriting them, so persisted metadata survives. The engine neither enforces finding/lead mutual exclusion (a claim is either a finding or a Needs-verification lead by reviewer judgement — the lead carrier `{lead, how, evidence?}` has no fingerprint field) nor validates coverage; both stay with the auditor.

## Direction findings — adaptations

Direction findings (`DIR-NN`) use the same format with two field changes:

- **Impact** = product/user value (who wants this and why now), not "what's broken."
- **Confidence** = how grounded the evidence is (not certainty it's the right call).

Plans for selected direction findings are usually *design/spike plans* (investigate, prototype, define the API, list open questions), not build-everything plans.

## What disqualifies a finding

- **No evidence**: "probably has N+1 queries" without a `file:line` is not a finding.
- **By-design behavior**: standard platform conventions (honoring `https_proxy`, reading `~/.netrc`) or tradeoffs explicitly recorded in an ADR. Flag only when the implementation adds risk beyond the convention.
- **Secret value reproduced**: never. Reference `file:line` and credential type only.
- **Could apply to any project**: direction suggestions without repo-specific grounding ("add dark mode", "add AI") are noise.

## Prioritization

Order by **leverage = impact ÷ effort, discounted by confidence and fix-risk**.

Tiebreakers:
1. Findings that unblock others (verification baseline, characterization tests) float up.
2. HIGH-confidence security findings float above equivalent-leverage non-security findings.
3. Prefer findings with a clean verification story.
4. "Not worth doing" is valid — record with one line of reasoning in the "considered and rejected" index section.
