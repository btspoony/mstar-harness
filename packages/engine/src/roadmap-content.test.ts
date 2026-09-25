import { describe, expect, test } from "bun:test";
import { parseRoadmapContent, validateRoadmapContent } from "./roadmap-content.js";

const ROADMAP = `---
project_id: roadmap-fixture
title: Lossless roadmap fixture
status: active
created_at: 2026-09-25
milestones:
  - Foundation
  - "Release & review"
residuals_ref: projects/_default/residuals.json
custom_note: preserved metadata
---

Opening context: caf\u00e9, \u6771\u4eac, and **Unicode** stay unchanged.

## Direction

Deliver a useful roadmap without discarding narrative.

### Operating principles

Keep nested explanatory content.

## Goals

- [ ] Same title
  - Supporting detail remains in the parent body.
  - [x] Same title
    - A nested non-task bullet remains attached to the child.
    - [ ] Same title
- [x] Independent completion

## Goals

A repeated section is retained independently.

## Sync Notes

Review coordination stays prose, not workflow state.

Issue R-17 is high severity prose, not an issue record. Workflow complete is only a sentence.

## Delivery Log

- 2026-09-25 \u2014 candidate release noted.


a fenced task example remains prose:

\`\`\`markdown
- [ ] This is not a roadmap goal
\`\`\`
`;

describe("roadmap-content", () => {
  test("retains exact Markdown while deriving nested task memberships and repeated sections", () => {
    const content = parseRoadmapContent(ROADMAP);
    expect(content.contentMarkdown).toBe(ROADMAP);
    expect(content.frontmatter).toMatchObject({
      project_id: "roadmap-fixture",
      title: "Lossless roadmap fixture",
      status: "active",
      created_at: "2026-09-25",
      milestones: ["Foundation", "Release & review"],
      residuals_ref: "projects/_default/residuals.json",
      custom_note: "preserved metadata",
    });
    expect(content.milestones).toEqual(["Foundation", "Release & review"]);
    expect(content.direction).toContain("Deliver a useful roadmap");
    expect(content.direction).toContain("Keep nested explanatory content.");
    expect(content.sections.filter((section) => section.heading === "Goals")).toHaveLength(2);
    expect(content.sections.find((section) => section.level === 0)?.body).toContain("Opening context: caf\u00e9, \u6771\u4eac");
    expect(content.sections.find((section) => section.heading === "Sync Notes")?.body).toContain("Issue R-17 is high severity prose");
    expect(content.sections.find((section) => section.heading === "Delivery Log")?.body).toContain("candidate release noted");

    expect(content.goals).toEqual([
      {
        ordinal: 0,
        parentOrdinal: null,
        checked: false,
        title: "Same title",
        body: expect.stringContaining("Supporting detail remains in the parent body."),
      },
      {
        ordinal: 1,
        parentOrdinal: 0,
        checked: true,
        title: "Same title",
        body: expect.stringContaining("A nested non-task bullet remains attached to the child."),
      },
      {
        ordinal: 2,
        parentOrdinal: 1,
        checked: false,
        title: "Same title",
        body: expect.stringContaining("Same title"),
      },
      {
        ordinal: 3,
        parentOrdinal: null,
        checked: true,
        title: "Independent completion",
        body: expect.stringContaining("Independent completion"),
      },
    ]);
    expect(content.goals.some((goal) => goal.title.includes("fenced task example"))).toBe(false);
  });

  test("accepts zero goals and returns missing body conventions as warnings", () => {
    const emptyGoals = `---\nproject_id: empty\ntitle: Empty goals\nstatus: paused\ncreated_at: 2026-09-25\n---\n\n## Direction\n\nNo goals yet.\n`;
    expect(validateRoadmapContent(emptyGoals, "memory document")).toMatchObject({
      ok: true,
      violations: [],
      warnings: [{ code: "project.roadmap.body.no-goal-items" }],
    });
    const parsed = parseRoadmapContent(emptyGoals);
    expect(parsed.goals).toEqual([]);
    expect(parsed.contentMarkdown).toBe(emptyGoals);
  });
});
