# skills/ — dsh skill mount (single canonical mount)

This directory is the **packaged skill mount target** for `@mstar-harness/dsh`
(roadmap D6 — single canonical mount). It intentionally contains **no skill
copies**; skill content lives once in the repo-root `skills/` mirror (19
`mstar-*` + `pm`), and mstar skills stay standalone-usable everywhere.

## How this directory gets populated (at install)

| Path | Mechanism | When |
|---|---|---|
| Dev-time | The plugin Config `skillRoots` points at the mirror `<repo-root>/skills` (absolute path). The plugin registers it with the dsh skill-local provider as a `customSkillDirs` entry. | Local development / tests |
| Published package | A packaging step (P3 profile-bundle layer) copies the repo-root `skills/` mirror into this directory, and the plugin Config `bundledSkillDir` points here. The plugin registers it as the skill-local `bundledSkillDir` entry (the canonical published form — dsh defaults `$DSH_BUNDLED_SKILL_DIR`). | P3 (`20260808-dsh-seams-bundle`) |

Neither path is wired yet at dev time: the real `@deepseek-ai/dsh-skill-local`
runtime ships from the composed dsh app (peer dependency), and the P3 bundle
layer performs the copy. Until then this README is the only file here.

## Canonical skill-root form (frozen, Task 1)

- `resolveSkillRoot('dsh', { skill })` → `$DSH_BUNDLED_SKILL_DIR/<name>` (engine
  `host.ts`, frozen this iteration).
- The engine resolver **does not mount** the directory — it only defines the
  canonical form used by skill-relative path resolvers (`resolveAssetPath`).
  Mounting is the plugin's job: `skillLocalConfig(config)` builds the
  skill-local registration payload (`providerName: 'mstar'`,
  `includeDefaultRoots: false`, `customSkillDirs` / `bundledSkillDir`), and
  `apply` mounts the skill-local plugin with it.
- The mstar provider is **isolated** (`includeDefaultRoots: false`) — it must
  see only its explicit roots, never the host app's own project/user skills.

## No double-loading

- The opencode plugin ships the same skills in its own package (`harness-skills/`);
  dsh must mount them **only** through this single skill-local path. Do not add a
  second skill-local row or another root that re-discovers the mirror.

## Notes

- This `README.md` is intentionally **not** a skill (no frontmatter). A skill
  root that includes this directory will log a discovery warning for it
  (missing frontmatter) and skip it — expected behavior, not a mount failure.
