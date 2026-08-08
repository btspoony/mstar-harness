---
iteration_id: v2.1.0
# boot-time steering compass (comment lines are skipped)
start_date: 2026-08-08

end_date: 2026-08-14
status: active
iteration_base_branch: main
target_branch: main
owner: "some one"
plans:
  - plan-20260808-dsh-seams-bundle
  - plan-20260808-other
---

# v2.1.0 Delivery Compass

Golden fixture for the flat-frontmatter parsers: scalar keys (dates, bare
strings, quoted values), blank/comment lines, and the `plans:` block list
(optionally indented `- item` lines). The expected parsed doc lives in
`golden.json` under the same key — both the CLI parser and the dsh mirror
assert against it.
