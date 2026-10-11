# Attributions

Third-party provenance for Morning Star harness assets. Runtime skill files stay link-free; this file is the single place for external-source attribution.

## `mstar-audit`

- Workflow, audit playbook, and finding format adapted from the [improve](https://github.com/shadcn/improve) skill (MIT, © shadcn).
- Security deep-dive methodology (`skills/mstar-audit/references/security-review.md`) synthesized from public security-review skills — [getsentry/skills](https://github.com/getsentry/skills), [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill), [openai/skills](https://github.com/openai/skills), [github/awesome-copilot](https://github.com/github/awesome-copilot), [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) — informed by OWASP guidance. OWASP Cheat Sheet Series is CC BY-SA 4.0; concepts synthesized, not copied.
- Review-process hardening (`pr-review.md` input modes, sizing, and evidence rules; `audit-playbook.md` simplify and dependency discipline; `codebase-audit.md` behavior-preservation gates; `finding-format.md` structural remedies) synthesized from public code-review skills — [mattpocock/skills](https://github.com/mattpocock/skills) code review (originating-spec discovery, standards lens, smell baseline; MIT), [getsentry/skills](https://github.com/getsentry/skills) code review (change-shape escalation; Apache-2.0), [vercel-labs/open-agents](https://github.com/vercel-labs/open-agents) code review (input modes, sizing, certainty/style guards, tone; MIT), [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) code-review-and-quality (sizing, structural remedies, presumptive classes, dependency discipline) and code-simplification (Chesterton's Fence, over-simplification guards; MIT).
- Test-audit methodology (`skills/mstar-audit/references/test-audit.md`) — value bar, authoring gate, junk patterns, retention bar, candidate-evidence fields, campaign lanes — adapted from the [openclaw/openclaw](https://github.com/openclaw/openclaw) `test-audit` skill.

## `mstar-roles`

- The Overdesign Judge Lens (`skills/mstar-roles/references/qc-specialist/overdesign-judge.md`) — frozen two-path/refusal-quality/ordering/fault-tolerance rules, the four judgment criteria (OD-J-*), and the three worked judgments — distilled from this repository's over-design audit program (public issues #340, #341, and #365 with their comment threads, 2026-10). The lens itself is link-free and self-contained; those issues are provenance only, not runtime dependencies.

## `mstar-harness-core`

- The "核心研发守则" (core engineering rules) — seven global engineering invariants: no backward-compatibility layers, simplest implementation, layered growth on a working product, modularity with separated concerns, established well-maintained libraries over reimplementation, existing project dependencies before new packages, and long-term architectural decisions — adapted from a post by Marcos Hernanz ([@MarcosHernanz](https://x.com/MarcosHernanz/status/2083954734487212511) on X).

## Ponytail distillation

Selected decision guidance adapted from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/tree/9b58c1ffb790c075ca32e70a89cf1d80588f4abf), pinned at `9b58c1ffb790c075ca32e70a89cf1d80588f4abf` (MIT, Copyright (c) 2026 DietrichGebert).

| Source skill and sections | Target surfaces | Adaptation |
| --- | --- | --- |
| [`skills/ponytail/SKILL.md`](https://github.com/DietrichGebert/ponytail/blob/9b58c1ffb790c075ca32e70a89cf1d80588f4abf/skills/ponytail/SKILL.md) — Before you write; The smallest complete change; closing disclosure | `skills/mstar-coding-behavior/SKILL.md`; `skills/mstar-roles/references/fullstack-dev-shared.md`, `frontend-dev.md`, `ops-engineer.md` | Affected consumers/tests/fixtures/configuration/exports and data risks; first-working reuse ladder; readable minimal solutions; preserved safeguards on moves; complete integration and concise actual-check/unchecked-risk reporting. Role references apply these decisions to API/data boundaries, house UI components, and operational recovery. |
| [`skills/ponytail-audit/SKILL.md`](https://github.com/DietrichGebert/ponytail/blob/9b58c1ffb790c075ca32e70a89cf1d80588f4abf/skills/ponytail-audit/SKILL.md) — Map first; Look for; Check before you report | `skills/mstar-audit/SKILL.md`; `skills/mstar-audit/references/audit-playbook.md`, `finding-format.md` | Expected-load and entry-to-write/output reasoning, concurrency/growth risks, meaningful missing-test evidence, responsibility-based splits, concrete reachable cases, bounded decisions, and minimal structural remedies. |
| [`skills/ponytail-review/SKILL.md`](https://github.com/DietrichGebert/ponytail/blob/9b58c1ffb790c075ca32e70a89cf1d80588f4abf/skills/ponytail-review/SKILL.md) — Understand first; Look for; Check before you report | `skills/mstar-audit/SKILL.md`; `skills/mstar-audit/references/audit-playbook.md`, `finding-format.md`, `pr-review.md` | Apply connected-flow/caller reasoning and the shared load, evidence, and smallest-fix guidance to changed interfaces within existing review scope. |

This is a distillation into existing rule owners, not an imported runtime skill. Morning Star retains its `simplify:` marker, library policy, role presets, authorization, read-only audit boundaries, and report/severity contracts. Upstream mode switches, command/debt ecosystem, whole-tree search mandates, finding caps, report/verdict formats, and savings metrics are not adopted.

### Upstream MIT notice

The following [upstream LICENSE](https://github.com/DietrichGebert/ponytail/blob/9b58c1ffb790c075ca32e70a89cf1d80588f4abf/LICENSE) notice applies to the adapted material above:

```text
MIT License

Copyright (c) 2026 DietrichGebert

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
