# Attributions

Third-party provenance for Morning Star harness assets. Runtime skill files stay link-free; this file is the single place for external-source attribution.

## `mstar-audit`

- Workflow, audit playbook, and finding format adapted from the [improve](https://github.com/shadcn/improve) skill (MIT, © shadcn).
- Security deep-dive methodology (`skills/mstar-audit/references/security-review.md`) synthesized from public security-review skills — [getsentry/skills](https://github.com/getsentry/skills), [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill), [openai/skills](https://github.com/openai/skills), [github/awesome-copilot](https://github.com/github/awesome-copilot), [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) — informed by OWASP guidance. OWASP Cheat Sheet Series is CC BY-SA 4.0; concepts synthesized, not copied.
- Review-process hardening (`pr-review.md` input modes, sizing, and evidence rules; `audit-playbook.md` simplify and dependency discipline; `codebase-audit.md` behavior-preservation gates; `finding-format.md` structural remedies) synthesized from public code-review skills — [mattpocock/skills](https://github.com/mattpocock/skills) code review (originating-spec discovery, standards lens, smell baseline; MIT), [getsentry/skills](https://github.com/getsentry/skills) code review (change-shape escalation; Apache-2.0), [vercel-labs/open-agents](https://github.com/vercel-labs/open-agents) code review (input modes, sizing, certainty/style guards, tone; MIT), [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) code-review-and-quality (sizing, structural remedies, presumptive classes, dependency discipline) and code-simplification (Chesterton's Fence, over-simplification guards; MIT).

## `mstar-harness-core`

- The "核心研发守则" (core engineering rules) — seven global engineering invariants: no backward-compatibility layers, simplest implementation, layered growth on a working product, modularity with separated concerns, established well-maintained libraries over reimplementation, existing project dependencies before new packages, and long-term architectural decisions — adapted from a post by Marcos Hernanz ([@MarcosHernanz](https://x.com/MarcosHernanz/status/2083954734487212511) on X).
