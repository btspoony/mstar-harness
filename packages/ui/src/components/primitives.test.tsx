/**
 * The primitive branches that carry meaning.
 *
 * Rendering assertions run through `react-dom/server`, so they are about markup
 * and structure, never about paint. The two CSS-owned rules (the container
 * collapse and the truncation overlay) are asserted against the module sheet
 * text, because that is where the rule lives — a markup test cannot prove a
 * `@container` query.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { Badge } from "./Badge.tsx";
import { Breadcrumb } from "./Breadcrumb.tsx";
import { Collapsible } from "./Collapsible.tsx";
import { DataTable, type DataTableColumn } from "./DataTable.tsx";
import { EmptyState, listEmptyFamily } from "./EmptyState.tsx";
import { Field } from "./Field.tsx";
import { FieldGroup } from "./FieldGroup.tsx";
import { FilterBar } from "./FilterBar.tsx";
import { LiveRegion } from "./LiveRegion.tsx";
import { Nav } from "./Nav.tsx";
import { Notice } from "./Notice.tsx";
import { Pager, hasNext, hasPrevious, pageRange } from "./Pager.tsx";
import { ProgressBar, progressPercent } from "./ProgressBar.tsx";
import { Row } from "./Row.tsx";
import { StatusDot } from "./StatusDot.tsx";
import { Tabs } from "./Tabs.tsx";
import { TruncatedText } from "./TruncatedText.tsx";

// The product's component styles are the prototype's own sheet, generated into
// `styles/product.css`; there are no per-component modules left to read.
const componentSheet = (): string =>
  readFileSync(join(import.meta.dir, "..", "styles", "product.css"), "utf8");
const moduleCss = (name: string): string => readFileSync(join(import.meta.dir, `${name}.module.css`), "utf8");
const stylesheet = (name: string): string => readFileSync(join(import.meta.dir, "..", "styles", `${name}.css`), "utf8");

/**
 * Flatten a stylesheet's at-rule blocks for analysis.
 *
 * The tone rules live inside `@media (forced-colors: active)` and a plain-CSS file
 * cannot qualify them with a CSS-module class (those are hashed), so the check that
 * matters is whether the selectors can match the wrapper. Removing the prelude lines
 * lets the same matcher see them; the orphaned closing braces produce empty chunks.
 */
const unwrapAtRules = (css: string): string => css.replace(/^\s*@[a-z-]+[^{]*\{\s*$/gm, "");

/**
 * The paint rules of one component sheet, matched against an element by selector
 * semantics rather than by string shape.
 *
 * A rule paints a given element when its **subject** compound (the last one in the
 * selector) requires nothing the element lacks: same class set, same attribute
 * values. Pseudo-classes are ignored — they cannot paint unconditionally — and any
 * other qualified class disqualifies the match, which is exactly the distinction
 * between `.dot` and a bare `[data-ms-tone]`.
 */
type PaintRule = { selector: string; subject: string; paint: string };

function paintRules(css: string): PaintRule[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: PaintRule[] = [];
  for (const chunk of withoutComments.split("}")) {
    const brace = chunk.indexOf("{");
    if (brace < 0) continue;
    const selectors = chunk.slice(0, brace);
    const body = chunk.slice(brace + 1);
    const paint = /(?:^|[;\s])(background(?:-color)?|border(?:-color|-radius|-width)?|color|transform)\s*:\s*([^;]+)/.exec(body);
    if (paint === null) continue;
    for (const selector of selectors.split(",")) {
      const trimmed = selector.trim();
      if (trimmed === "" || trimmed.startsWith("@")) continue;
      // The subject is the last compound of the selector.
      const subject = trimmed.split(/\s+|>/).filter(Boolean).pop() ?? trimmed;
      rules.push({ selector: trimmed, subject, paint: `${paint[1]}: ${paint[2]!.trim()}` });
    }
  }
  return rules;
}

/**
 * The attributes each `<span>` in a rendered `StatusDot` actually carries.
 *
 * Read from the markup rather than hand-written, so the check follows the component:
 * the matcher is given the real attribute set (tone on both elements, the dot's marker,
 * its `aria-hidden`) and the two symbolic class names the module's selectors use — the
 * rendered classes are hashed, so only the source-level names are comparable.
 */
function renderedSpans(html: string): Record<string, string>[] {
  return [...html.matchAll(/<span\b([^>]*)>/g)].map((match) => {
    const attrs: Record<string, string> = {};
    for (const [, name, value] of match[1]!.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)) {
      if (name === "class") continue;
      attrs[name!] = value ?? "";
    }
    return attrs;
  });
}

/** The wrapper (tone, no dot marker) and the dot (carries the marker), by what they carry. */
function statusElements(html: string): { wrapper: { classes: string[]; attrs: Record<string, string> }; dot: { classes: string[]; attrs: Record<string, string> } } {
  const spans = renderedSpans(html);
  const wrapper = spans.find((span) => span["data-ms-tone"] !== undefined && span["data-ms-dot"] === undefined);
  const dot = spans.find((span) => span["data-ms-dot"] !== undefined);
  if (wrapper === undefined || dot === undefined) throw new Error("StatusDot must render a tone wrapper and a marked dot");
  return { wrapper: { classes: ["status"], attrs: wrapper }, dot: { classes: ["dot"], attrs: dot } };
}

/** Whether a rule's subject can match an element with these classes and attributes. */
function matches(element: { classes: readonly string[]; attrs: Record<string, string> }, rule: PaintRule): boolean {
  const required = [...rule.subject.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((match) => match[1]!);
  const conditions = [...rule.subject.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)];
  // A subject with no class and no attribute (a bare element selector) is not
  // keyed on either, so it is outside what this check is about.
  if (required.length === 0 && conditions.length === 0) return false;
  for (const name of required) if (!element.classes.includes(name)) return false;
  for (const [, attr, value] of conditions) {
    if (element.attrs[attr!] === undefined) return false;
    if (value !== undefined && element.attrs[attr!] !== value) return false;
  }
  return true;
}

const render = (node: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(node);

describe("StatusDot — the label is the signal, colour is secondary", () => {
  test("the literal enum label is rendered as text beside the dot", () => {
    const html = render(<StatusDot label="InProgress" tone="neutral" />);
    expect(html).toContain("InProgress");
    // The dot is decorative; the label carries the meaning.
    expect(html).toContain('aria-hidden="true"');
  });

  test("the tone rides on an attribute, so CSS and forced colors can hook it", () => {
    const html = render(<StatusDot label="critical" tone="danger" emphasis />);
    expect(html).toContain('data-ms-tone="danger"');
    expect(html).toContain('data-ms-emphasis="true"');
  });

  test("no colour is written into markup: the tone is a name, not a value", () => {
    const html = render(<StatusDot label="open" tone="neutral" />);
    expect(html).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(html).not.toContain("rgb(");
  });

  test("the tone paints the dot and nothing else: the label is never a colour block", () => {
    // The defect this pins: the tone rules were bare attribute selectors, and the
    // wrapper carries the same attribute, so every rule matched both elements and
    // filled the whole label instead of the 6px dot beside it.
    const rules = paintRules(componentSheet());
    const { wrapper, dot } = statusElements(render(<StatusDot label="high" tone="danger" emphasis />));

    const paintingWrapper = rules.filter((rule) => matches(wrapper, rule) && /background/.test(rule.paint));
    expect(paintingWrapper.map((rule) => rule.selector)).toEqual([]);

    // Not vacuously true: the same attribute does paint the dot.
    const paintingDot = rules.filter((rule) => matches(dot, rule) && /background/.test(rule.paint));
    expect(paintingDot.length).toBeGreaterThan(0);
  });

  test("the forced-colors shape rules draw the dot, never the label", () => {
    // The same defect one level out: in forced-colors mode these rules give each tone
    // a SHAPE — the dot's second channel. Bare attribute selectors matched the wrapper
    // too, so the whole label got a solid fill, a dot-shaped border, and for `purple`
    // a 45° rotation of the text. A plain-CSS sheet cannot name the CSS-module class,
    // so the dot carries its own contract attribute.
    const rules = paintRules(unwrapAtRules(stylesheet("base")));
    for (const tone of ["danger", "warning", "success", "neutral", "purple"] as const) {
      const { wrapper, dot } = statusElements(render(<StatusDot label={tone} tone={tone} />));
      expect(rules.filter((rule) => matches(wrapper, rule))).toEqual([]);
      expect(rules.filter((rule) => matches(dot, rule)).length).toBeGreaterThan(0);
    }
  });

  test("every tone's fill is on the dot, not on the wrapper", () => {
    const rules = paintRules(componentSheet());
    for (const tone of ["danger", "warning", "success", "neutral", "purple"] as const) {
      const { wrapper, dot } = statusElements(render(<StatusDot label={tone} tone={tone} />));
      expect(rules.filter((rule) => matches(wrapper, rule) && /background/.test(rule.paint))).toEqual([]);
      expect(rules.filter((rule) => matches(dot, rule) && /background/.test(rule.paint)).length).toBeGreaterThan(0);
    }
  });
});

describe("DataTable — the collapse rule", () => {
  type RowT = { id: string; title: string; project: string; severity: string };
  const rows: RowT[] = [{ id: "I-000870", title: "A title", project: "engine", severity: "critical" }];
  const columns: DataTableColumn<RowT>[] = [
    { key: "id", header: "ID", render: (row) => row.id },
    { key: "title", header: "Title", render: (row) => row.title },
    { key: "project", header: "Project", render: (row) => row.project, secondary: true },
    { key: "severity", header: "Severity", render: (row) => row.severity, secondary: true },
  ];

  test("secondary columns are marked in the header and the body alike", () => {
    const html = render(
      <DataTable
        caption="Issues"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        meta={(row) => `${row.project} · ${row.severity}`}
      />,
    );
    expect(html.match(/data-ms-col="secondary"/g)?.length).toBe(4); // 2 columns × (th + td)
  });

  test("the collapsed row keeps the primary cell and grows a meta line from the same data", () => {
    const html = render(
      <DataTable
        caption="Issues"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        meta={(row) => `${row.project} · ${row.severity}`}
      />,
    );
    expect(html).toContain('data-ms-row-meta=""');
    expect(html).toContain("engine · critical");
  });

  test("the second line lives in the record's first cell, as the prototype draws it", () => {
    // The prototype keeps the collapsed facts in `.row-meta` inside the record's own
    // cell; it never adds a spanning second row. A row of its own announced every
    // record twice to a screen reader, which is why the implementation follows the
    // prototype's markup instead.
    const html = render(
      <DataTable
        caption="Issues"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        meta={(row) => row.project}
      />,
    );
    expect(html).toContain('class="row-meta"');
    // One <tr> per record: no spanning companion row.
    expect(html.match(/<tr/g)?.length).toBe(rows.length + 1); // + the header row
    expect(html).not.toContain("data-ms-row-meta-row");
    expect(html).not.toContain("colspan");
  });

  test("activation stays one target and one tab stop per record", () => {
    // The facts are painted inside the record's own cell, so a tap anywhere on the row
    // navigates. Keyboard keeps exactly one stop per record.
    const html = render(
      <DataTable
        caption="Issues"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        meta={(row) => row.project}
        onRowActivate={() => {}}
      />,
    );
    expect(html.match(/tabindex="0"/g)?.length).toBe(rows.length);
    expect(html).not.toContain("data-ms-row-meta-activate");
  });

  test("the collapse is a container query at the declared floor, not a viewport query", () => {
    const css = componentSheet();
    // UNNAMED: a bundler rewrites a named query's prelude into a per-module hash,
    // which never matches the one container declaration — a named query is dead.
    expect(css).not.toContain("@container pane");
    expect(css).toContain("@container (max-width: 619px)");
    // The prototype's mechanism: `data-narrow-cols` hides the columns past the second,
    // and the collapsed facts arrive in `.row-meta`.
    expect(css).toContain("[data-narrow-cols");
    // and the table must emit it, or the positional rule has nothing to match
    const html = render(
      <DataTable caption="Issues" columns={columns} rows={rows} rowKey={(row) => row.id} meta={(row) => row.project} />,
    );
    expect(html).toContain('data-narrow-cols="2"');
    expect(html).toContain('class="row-meta"');
    expect(css).toContain("nth-child(n+3)");
    expect(css).toContain(".row-meta");
  });

  test("the narrow mechanism is the prototype's, not a per-column attribute", () => {
    // The prototype hides columns by position (`data-narrow-cols` + `:nth-child`), on
    // both the header and the body, so a header can never disagree with its cells.
    const css = componentSheet();
    expect(css).toContain("[data-narrow-cols");
    expect(css).toContain(":nth-child(n+3)");
    expect(css).toContain(".row-meta");
  });
  test("the pane's head band carries the prototype's nav inset", () => {
    // `design-v1.html:487`: `.dsh-page-head .app-nav { padding: 0 12px }` on a surface
    // band with a closing hairline. Both seats mount this class, so the dsh pane's nav
    // is inset from the pane's edges instead of touching them.
    expect(stylesheet("base")).toMatch(/\.ms-pane-head\s*\{[^}]*padding-inline: 12px;/);
  });

  test("the navigation is styled by the band both hosts mount it in, narrow rules included", () => {
    // The dsh pane mounts the shared nav in its head band, above `.ms-container`; a
    // container-scoped rule never reaches it. The band is therefore the nav's whole
    // authority: the row, the buttons, the active underline and the narrow behaviour.
    const base = stylesheet("base");
    expect(base).toMatch(/\.ms-pane-head \.app-nav\s*\{[^}]*display: flex;/);
    expect(base).toMatch(/\.ms-pane-head \.nav-btn\s*\{[^}]*height: var\(--ms-header-h\);/);
    expect(base).toMatch(/\.ms-pane-head \.nav-btn\[aria-current="page"\]\s*\{[^}]*box-shadow: inset 0 -2px 0 0 var\(--ms-accent\);/);
    expect(base).toMatch(/@container \(max-width: 479px\) \{\s*\.ms-pane-head \.app-nav \{[^}]*flex-wrap: wrap;/);
    expect(base).toMatch(/\.ms-pane-head \.nav-btn \{[^}]*height: 28px;/);
  });

  test("an empty body renders the caller's absence node inside the table", () => {
    const html = render(
      <DataTable
        caption="Issues"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        emptyBody={<EmptyState arm="empty" labelWord="empty" heading="Issues" body="nothing here" />}
      />,
    );
    expect(html).toContain('data-ms-absence="empty"');
  });
});

describe("Pager — the bounds are computed, never offered", () => {
  test("the first page has no previous", () => {
    expect(hasPrevious(0)).toBe(false);
    expect(hasPrevious(50)).toBe(true);
  });

  test("a full last page offers no next", () => {
    expect(hasNext(0, 50, 26)).toBe(false);
    expect(hasNext(0, 50, 51)).toBe(true);
    expect(hasNext(50, 50, 100)).toBe(false);
  });

  test("the range is 1-based and clamped to the total", () => {
    expect(pageRange(0, 50, 26)).toEqual({ from: 1, to: 26 });
    expect(pageRange(50, 50, 120)).toEqual({ from: 51, to: 100 });
    expect(pageRange(0, 50, 0)).toEqual({ from: 0, to: 0 });
  });

  test("the disabled state is in the markup, not only in behaviour", () => {
    const html = render(
      <Pager
        total={26}
        offset={0}
        pageSize={50}
        onOffsetChange={() => {}}
        previousLabel="Previous"
        nextLabel="Next"
        rangeLabel={(from, to, total) => `${from}–${to} of ${total}`}
      />,
    );
    expect(html.match(/disabled=""/g)?.length).toBe(2);
    expect(html).toContain("1–26 of 26");
  });
});

describe("EmptyState — four arms, four structures, one label word each", () => {
  const arms = ["not-applicable", "absent", "empty", "unavailable"] as const;

  test("each arm renders its own structural hook", () => {
    for (const arm of arms) {
      const html = render(
        <EmptyState arm={arm} labelWord={arm} heading="Roadmap" body="a sentence" reason="why" pointer="see X" hint="create one" />,
      );
      expect(html).toContain(`data-ms-absence="${arm}"`);
      expect(html).toContain(`>${arm}<`); // the label word is text, not colour
    }
  });

  test("the four arms are structurally distinct, not four copies of one line", () => {
    const html = Object.fromEntries(
      arms.map((arm) => [
        arm,
        render(
          <EmptyState arm={arm} labelWord={arm} heading="Roadmap" body="a sentence" reason="why" pointer="see X" hint="create one" />,
        ),
      ]),
    );
    // unavailable carries the read's own reason and nothing else extra
    expect(html.unavailable).toContain('data-ms-reason=""');
    expect(html.unavailable).not.toContain('data-ms-pointer=""');
    // absent carries a pointer to where the concept does exist
    expect(html.absent).toContain('data-ms-pointer=""');
    expect(html.absent).not.toContain('data-ms-reason=""');
    // empty carries the point-of-entry hint
    expect(html.empty).toContain('data-ms-hint=""');
    expect(html.empty).not.toContain('data-ms-pointer=""');
    // not-applicable carries neither: the subject is undetermined, so there is
    // nowhere to point and nothing to create
    expect(html["not-applicable"]).not.toContain('data-ms-pointer=""');
    expect(html["not-applicable"]).not.toContain('data-ms-hint=""');
    expect(html["not-applicable"]).not.toContain('data-ms-reason=""');
    expect(new Set(Object.values(html)).size).toBe(4);
  });

  test("the heading stays even when the body is absent (IA §5 structure)", () => {
    const html = render(<EmptyState arm="absent" labelWord="absent" heading="Milestones" body="no roadmap row" />);
    expect(html).toContain("Milestones");
  });

  test("filtered-empty and store-empty are different copy families", () => {
    expect(listEmptyFamily(true)).toEqual({ arm: "empty", family: "state.empty.filtered" });
    expect(listEmptyFamily(false)).toEqual({ arm: "empty", family: "state.empty.store" });
  });
});

describe("TruncatedText — the one truncation affordance (D24)", () => {
  const html = render(<TruncatedText text="a very long stored value that clips" />);

  test("the FULL text is the element's content, so selection and find still work", () => {
    expect(html).toContain("a very long stored value that clips");
  });

  test("it is focusable, and carries the same string in data-ms-full and title", () => {
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('data-ms-full="a very long stored value that clips"');
    expect(html).toContain('title="a very long stored value that clips"');
  });

  test("truncation is the prototype's one class", () => {
    // The prototype truncates with `.trunc`; there is no second mechanism to keep in
    // sync, and the full value stays available as the element's title.
    const css = componentSheet();
    expect(css).toMatch(/\.trunc\s*\{[^}]*text-overflow: ellipsis;/);
    const html = render(<TruncatedText text="a very long stored value that clips" />);
    expect(html).toContain('class="trunc"');
    expect(html).toContain('title="a very long stored value that clips"');
  });
  test("the read's own reason is carried verbatim", () => {
    const html = render(<Notice reason="no such table: projection_workflows" lead="Could not read workflows" />);
    expect(html).toContain("no such table: projection_workflows");
    expect(html).toContain('data-ms-reason=""');
    expect(html).toContain('role="status"');
  });

  test("it is not an EmptyState: no absence arm is rendered", () => {
    const html = render(<Notice reason="failed" />);
    expect(html).not.toContain("data-ms-absence");
  });
});

describe("Nav and Tabs — the active state is text plus a marker", () => {
  test("only the active destination carries aria-current", () => {
    const html = render(
      <Nav
        items={[
          { id: "overview", label: "Overview" },
          { id: "issues", label: "Issues" },
        ]}
        activeId="issues"
        onSelect={() => {}}
        label="Destinations"
      />,
    );
    expect(html.match(/aria-current="page"/g)?.length).toBe(1);
    expect(html.indexOf('aria-current="page"')).toBeGreaterThan(html.indexOf('data-ms-nav-item="issues"') - 80);
  });

  test("the nav marks its landmark with the caller's label", () => {
    const html = render(<Nav items={[]} activeId={null} onSelect={() => {}} label="Destinations" />);
    expect(html).toContain('aria-label="Destinations"');
    expect(html).not.toContain("aria-current");
  });

  test("a tab strip is a tablist with one selected tab", () => {
    const html = render(
      <Tabs
        tabs={[
          { id: "roadmap", label: "Roadmap" },
          { id: "issues", label: "Issues", count: 14 },
        ]}
        activeId="issues"
        onSelect={() => {}}
        label="Project features"
      />,
    );
    expect(html).toContain('role="tablist"');
    expect(html.match(/aria-selected="true"/g)?.length).toBe(1);
    expect(html).toContain("aria-controls=\"ms-tabpanel-issues\"");
    expect(html).toContain(">14<");
  });
});

describe("Breadcrumb — a detail can always say where it came from", () => {
  test("the trail is links and the current record is not", () => {
    const html = render(
      <Breadcrumb
        trail={[{ id: "projects", label: "Projects" }]}
        onSelect={() => {}}
        label="Breadcrumb"
        current="engine"
      />,
    );
    expect(html).toContain("Projects");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("engine");
  });
});

describe("ProgressBar — a measured fraction, never a series", () => {
  test("the percentage is clamped", () => {
    expect(progressPercent(3, 6)).toBe(50);
    expect(progressPercent(9, 6)).toBe(100);
    expect(progressPercent(-1, 6)).toBe(0);
    expect(progressPercent(0, 0)).toBe(0);
  });

  test("a screen reader gets the same numbers as the bar", () => {
    const html = render(<ProgressBar done={3} total={6} label="plans" />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="3"');
    expect(html).toContain('aria-valuemax="6"');
  });

  test("the bar's width is the clamped percentage", () => {
    expect(render(<ProgressBar done={3} total={6} />)).toContain("inline-size:50%");
  });
});

describe("the remaining primitives keep their contract", () => {
  test("Field renders a label/value pair", () => {
    const html = render(<Field label="Project" mono>engine</Field>);
    expect(html).toContain("<dt");
    expect(html).toContain("Project");
    expect(html).toContain("engine");
  });

  test("FieldGroup is a definition list whose columns are the caller's", () => {
    const html = render(
      <FieldGroup title="Identity" columns={1}>
        <Field label="Kind">project</Field>
      </FieldGroup>,
    );
    expect(html).toContain("<dl");
    expect(html).toContain('class="fields one"');
    expect(html).toContain("Identity");
  });

  test("Row exposes its slots and is keyboard-operable when it activates", () => {
    const html = render(<Row primary="20261025-x" trailing="3/6" onActivate={() => {}} />);
    expect(html).toContain('role="button"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("3/6");
  });

  test("Row without an activation is plain content, not a fake button", () => {
    const html = render(<Row primary="20261025-x" />);
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain("tabindex");
  });

  test("Badge renders its child and an optional tone", () => {
    const html = render(<Badge tone="warning">catalog-missing</Badge>);
    expect(html).toContain("catalog-missing");
    expect(html).toContain('data-ms-badge-tone="warning"');
  });

  test("Collapsible is a native disclosure", () => {
    const html = render(
      <Collapsible summary="Direction">
        <p>text</p>
      </Collapsible>,
    );
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("Direction");
  });

  test("LiveRegion is a polite status region", () => {
    const html = render(<LiveRegion message="26 results" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("26 results");
  });

  test("FilterBar disables clear while nothing is applied", () => {
    const html = render(
      <FilterBar
        fields={[{ key: "severity", label: "Severity", value: "", options: [{ value: "", label: "Any" }] }]}
        onFieldChange={() => {}}
        applied={[]}
        onClearFilter={() => {}}
        onClearAll={() => {}}
        clearLabel="Clear filters"
        resultSummary="26 results"
      />,
    );
    expect(html).toContain("disabled");
    expect(html).not.toContain("data-ms-applied-filters");
  });

  test("FilterBar shows one chip per applied filter", () => {
    const html = render(
      <FilterBar
        fields={[]}
        onFieldChange={() => {}}
        applied={[
          { key: "severity", text: "severity: high" },
          { key: "project", text: "project: engine" },
        ]}
        onClearFilter={() => {}}
        onClearAll={() => {}}
        clearLabel="Clear filters"
        resultSummary="5 results"
      />,
    );
    expect(html).toContain("severity: high");
    expect(html).toContain("project: engine");
    expect(html).toContain('data-ms-applied-filters=""');
  });
});

describe("the component layer obeys the token rules", () => {
  test("no component sheet hard-codes a colour", () => {
    const offenders: string[] = [];
    for (const css of [componentSheet()]) {
      const name = "product.css";
      if (/#[0-9a-f]{3,8}\b/i.test(css)) offenders.push(`${name}.module.css`);
    }
    expect(offenders).toEqual([]);
  });

  test("no component sheet selects a scheme from the viewport", () => {
    for (const name of ["StatusDot", "DataTable", "Nav", "FilterBar"]) {
      expect(componentSheet()).not.toContain("prefers-color-scheme");
    }
  });

  test("product layout reflow is always an UNNAMED container query", () => {
    // A named query cannot survive the bundler, and a viewport media query would
    // reflow by the window rather than by the pane the product is given. The product
    // now ships one generated sheet, so the rule is checked on it once.
    const css = componentSheet();
    expect(css).not.toContain("@container pane");
    expect(css).toContain("@container (max-width: 619px)");
    // Media queries may exist for the host's window chrome only; the product's
    // reflow is the container's.
    for (const block of css.match(/@media[^{]+\{/g) ?? []) {
      expect(block).not.toContain("max-width: 6");
    }
  });});
