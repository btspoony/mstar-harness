/**
 * The render gate — the product's visual contract, asserted against a real
 * browser instead of against the markup that is supposed to produce it.
 *
 * What it does: seeds a throwaway store, starts the dashboard on an ephemeral
 * port, drives a real Chromium over the five destinations and one detail screen
 * at a fixed viewport, writes the PNGs under the gitignored `.tmp/render-gate/`,
 * and asserts the structural anchors that the visual work is judged by —
 * the cards, the summary line, the tone-per-status-dot rule, the header control
 * pair and the date form in cells.
 *
 * Why a browser and not `renderToStaticMarkup`: those anchors are about computed
 * layout and paint (a card is a box with a border and a radius; a status is a dot
 * and not a filled chip). Server rendering cannot see either, so the two rounds of
 * visual work would have nothing holding them once a human stops looking.
 *
 * Skip contract: CI has no browser and no CI job may depend on one. Availability
 * is detected with `Bun.which("agent-browser")` plus a `--version` probe; when it
 * is absent the suite reports why it skipped and asserts nothing. `agent-browser`
 * is deliberately NOT a dependency of this repository — it is an interactive
 * verification tool, so the gate rides it when present and steps aside when not.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { captureIssue, createExecutionWorkflow, initializeStore, openStore, readExecutionAuthority, registerCatalogEntity } from "@mstar-harness/engine";
import { startDashboard, type RunningDashboard } from "../../commands/src/dashboard/index.ts";

const RECORDED_AT = "2026-10-24T09:06:22.870Z";
const VIEWPORT = { width: 1280, height: 800 } as const;

/** Where the captures land: gitignored, and never compared byte-for-byte. */
const CAPTURE_DIR = resolve(import.meta.dir, "../../../.tmp/render-gate");

const browserBinary = Bun.which("agent-browser");
const browserAvailable =
  browserBinary !== null && spawnSync(browserBinary, ["--version"], { encoding: "utf8" }).status === 0;

const SKIP_REASON =
  browserBinary === null
    ? "render-gate skipped: `agent-browser` is not on PATH, so no browser is available here"
    : "render-gate skipped: `agent-browser --version` failed, so the browser tooling is present but unusable";

/**
 * One browser session per run, named so this suite cannot hijack the page another
 * agent or a human left open in the shared default session.
 */
const SESSION = `mstar-render-gate-${process.pid}`;

/**
 * One browser call, awaited rather than blocked on: the dashboard runs in THIS
 * process, so a synchronous spawn would stall the event loop that has to answer
 * the browser's requests — the page would never load and every assertion would
 * time out.
 */
async function browser(args: string[]): Promise<string> {
  const child = Bun.spawn([browserBinary!, ...args], {
    env: { ...process.env, AGENT_BROWSER_SESSION: SESSION },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) {
    throw new Error(`agent-browser ${args.join(" ")} failed (${status}): ${stderr || stdout}`);
  }
  return stdout;
}

/**
 * The eval channel answers a JSON-encoded string (the CLI serializes the value
 * once more than the expression does), so unwrap until an object appears.
 */
async function evalJson(expression: string): Promise<Record<string, unknown>> {
  const stdout = (await browser(["eval", expression])).trim();
  const line = stdout.split("\n").filter((candidate) => candidate.trim() !== "").at(-1) ?? "";
  let value: unknown = JSON.parse(line);
  if (typeof value === "string") value = JSON.parse(value);
  if (typeof value !== "object" || value === null) {
    throw new Error(`render-gate: eval returned ${typeof value}, not an object. stdout: ${stdout}`);
  }
  return value as Record<string, unknown>;
}

/**
 * What every screen must satisfy, measured in the browser.
 *
 * The `tone` probe is the one that keeps status readable: a tone may paint the
 * dot and nothing else, so no status is a coloured chip whose meaning disappears
 * in forced colours.
 */
const PROBE = `(() => {
  const cards = document.querySelectorAll('[data-ms-panel]');
  const table = document.querySelector('table');
  const paintedTones = [...document.querySelectorAll('[data-ms-tone]:not([data-ms-dot])')]
    .filter((el) => {
      const bg = getComputedStyle(el).backgroundColor;
      return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
    }).length;
  const seg = document.querySelectorAll('.app-seg');
  const icon = document.querySelectorAll('.app-icon-btn');
  const box = (el) => (el === null ? null : el.getBoundingClientRect().width);
  // The collapsed second line is one spanning cell, so it is also its row's last
  // child: it restates facts and is not a date column.
  const cells = [...document.querySelectorAll('tbody tr[data-ms-row-main] td:last-child')]
    .map((cell) => cell.textContent.trim()).filter((text) => text !== '');
  const timestamps = [...document.querySelectorAll('dd')]
    .map((cell) => cell.textContent.trim()).filter((text) => /\\d{4}-\\d{2}-\\d{2}/.test(text));
  const summary = document.querySelector('[data-ms-summary]');
  const foot = document.querySelector('[data-ms-panel-foot]');
  const range = document.querySelector('[data-ms-page-range]');
  const buttons = foot === null ? [] : [...foot.querySelectorAll('button')];
  const card = foot === null ? null : foot.closest('[data-ms-panel]');
  const pager = foot === null ? null : {
    lastButtonRight: buttons.length === 0 ? null : buttons[buttons.length - 1].getBoundingClientRect().right,
    footInnerRight: foot.getBoundingClientRect().right - parseFloat(getComputedStyle(foot).paddingRight),
    cardInnerRight: card === null ? null : card.getBoundingClientRect().right - 1 - 12,
    buttonCentreY: buttons.length === 0 ? null : buttons[buttons.length - 1].getBoundingClientRect().top
      + buttons[buttons.length - 1].getBoundingClientRect().height / 2,
    rangeCentreY: range === null ? null : range.getBoundingClientRect().top + range.getBoundingClientRect().height / 2,
    footHeight: foot.getBoundingClientRect().height,
    buttonCount: buttons.length,
  };
  // The narrow-band facts: contentWidth is what the frame leaves inside the
  // screen, and a card that does not fill it is a card that stopped growing.
  const screenEl = document.querySelector('[data-ms-screen]');
  const screenBox = screenEl === null ? null : screenEl.getBoundingClientRect();
  const screenPad = screenEl === null ? null : getComputedStyle(screenEl);
  const contentWidth = screenBox === null || screenPad === null ? null : screenBox.width
    - parseFloat(screenPad.paddingLeft) - parseFloat(screenPad.paddingRight);
  const rendered = (el) => el.getBoundingClientRect().width > 0;
  const visibleCells = [...document.querySelectorAll('table tbody tr[data-ms-row-main]')]
    .flatMap((row) => [...row.querySelectorAll('td')])
    .filter(rendered);
  const cellWidths = visibleCells.map((cell) => Math.round(cell.getBoundingClientRect().width * 10) / 10);
  // One row's visible cells: the column count, not the column count times the rows.
  const firstRow = document.querySelector('table tbody tr[data-ms-row-main]');
  const rowCells = firstRow === null ? [] : [...firstRow.querySelectorAll('td')].filter(rendered);
  const header = document.querySelector('header.app-header');
  const h1 = document.querySelector('[data-ms-screen] h1');
  const summaryEl = document.querySelector('[data-ms-summary]');
  const centreY = (el) => (el === null ? null : el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2);
  const band = {
    contentWidth: contentWidth === null ? null : Math.round(contentWidth * 10) / 10,
    cardWidths: [...document.querySelectorAll('[data-ms-panel]')].map((card) => Math.round(card.getBoundingClientRect().width * 10) / 10),
    narrowestCell: cellWidths.length === 0 ? null : Math.min(...cellWidths),

    visibleCells: rowCells.length,
    summaryOverflows: summaryEl === null ? null : summaryEl.scrollWidth > summaryEl.clientWidth + 1,
    titleOverflows: h1 === null ? null : h1.scrollWidth > h1.clientWidth + 1,
    // A title is a unit: CJK breaks between every glyph, so a squeezed head stacked a
    // two-glyph title on two lines. One line box is the whole assertion. The box height
    // over the line height, not the Range rect count: a heading that wraps its text in
    // an inline-block (the detail screens' TruncatedText) reports two rects for one line.
    titleLines: h1 === null ? null : (() => {
      const lineHeight = parseFloat(getComputedStyle(h1).lineHeight) || 0;
      if (lineHeight === 0) return 1;
      return Math.max(1, Math.round(h1.getBoundingClientRect().height / lineHeight));
    })(),
    titleWidth: h1 === null ? null : Math.round(h1.getBoundingClientRect().width * 10) / 10,
    titleText: h1 === null ? null : (h1.textContent ?? '').trim(),
    // Whether the title was actually clipped: the heading itself, or the inline-block
    // clip the detail screens wrap it in (the clip owns the truncation there).
    titleTruncated: h1 === null ? null : [h1, ...h1.querySelectorAll("[data-ms-full]")]
      .some((el) => el.scrollWidth > el.clientWidth + 1),
    // In the collapsed band the title owns its row and the summary wraps under it, so
    // the fact to measure is the wrap, not the baseline.
    summaryTopOffset: (() => {
      const summary = document.querySelector('[data-ms-summary]');
      const title = document.querySelector('[data-ms-screen] h1');
      if (summary === null || title === null) return null;
      return Math.round((summary.getBoundingClientRect().top - title.getBoundingClientRect().bottom) * 10) / 10;
    })(),
    tableWidth: (() => {
      const table = document.querySelector('table');
      return table === null ? null : Math.round(table.getBoundingClientRect().width * 10) / 10;
    })(),
    visiblePrimaryCells: (() => {
      const row = document.querySelector('table tbody tr[data-ms-row-main]');
      if (row === null) return null;
      return [...row.querySelectorAll('td[data-ms-col="primary"]')]
        .filter((cell) => cell.getBoundingClientRect().width > 0).length;
    })(),
    // The collapsed second line: every fact whole, none cut by the cell's width.
    metaTruncated: (() => {
      const metas = [...document.querySelectorAll('[data-ms-row-meta]')]
        .filter((el) => el.getBoundingClientRect().width > 0);
      if (metas.length === 0) return null;
      return metas.some((el) => el.scrollWidth > el.clientWidth + 1);
    })(),
    metaWidth: (() => {
      const metas = [...document.querySelectorAll('[data-ms-row-meta]')]
        .filter((el) => el.getBoundingClientRect().width > 0);
      if (metas.length === 0) return null;
      return Math.round(Math.min(...metas.map((el) => el.getBoundingClientRect().width)) * 10) / 10;
    })(),
    metaRowSpan: (() => {
      const cell = document.querySelector('[data-ms-row-meta-row] td');
      return cell === null ? null : cell.getAttribute('colspan');
    })(),
    // Prose inside a card, measured on its own line boxes: the reported failure was
    // a sentence wrapping one character per line, and characters-per-line is the
    // only measurement that sees it.
    worstPerLine: (() => {
      let worst = null;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = (node.textContent ?? '').trim();
        if (text.length < 20) continue;
        const holder = node.parentElement;
        if (holder === null || holder.closest('[data-ms-panel]') === null) continue;
        if (holder.closest('[hidden], [aria-hidden="true"]') !== null) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = [...range.getClientRects()];
        if (rects.length === 0) continue;
        const perLine = text.length / rects.length;
        if (worst === null || perLine < worst) worst = Math.round(perLine * 10) / 10;
      }
      return worst;
    })(),
    hiddenColumns: [...document.querySelectorAll('table thead th[data-ms-col="secondary"]')]
      .filter((th) => getComputedStyle(th).display === 'none').length,
    tableScrollsSideways: (() => {
      const scroller = document.querySelector('[data-ms-table-scroller]');
      if (scroller === null) return null;
      return scroller.scrollWidth > scroller.clientWidth + 1;
    })(),
    // scrollWidth reports overflow even when the box cannot scroll, so the scroll
    // anchor needs both halves: content wider than the card AND a box that scrolls.
    scrollerOverflowX: (() => {
      const scroller = document.querySelector('[data-ms-table-scroller]');
      return scroller === null ? null : getComputedStyle(scroller).overflowX;
    })(),
    summaryLeft: summaryEl === null ? null : Math.round(summaryEl.getBoundingClientRect().left * 10) / 10,
    baselineDelta: h1 === null || summaryEl === null ? null : Math.abs(centreY(h1) - centreY(summaryEl)),
    headerHeight: header === null ? null : Math.round(header.getBoundingClientRect().height * 10) / 10,
    // The header's own gutter. The pane's nav gets 12px from the shared band; the
    // dashboard's window header is the prototype's 0-20px band and owns that number,
    // so a regression to a flush edge is visible here.
    headerPadInline: header === null ? null : parseFloat(getComputedStyle(header).paddingInlineStart),
    headerHairline: header === null ? null : getComputedStyle(header).borderBottomWidth,
    controlsInside: (() => {
      const controls = [...document.querySelectorAll('.app-seg, .app-icon-btn')];
      return controls.every((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.right <= window.innerWidth + 0.5 && rect.left >= -0.5;
      });
    })(),
    controlsLabelled: [...document.querySelectorAll('.app-seg, .app-icon-btn')]
      .every((el) => (el.getAttribute('aria-label') ?? '').trim() !== ''),
    pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
  return JSON.stringify({
    band,
    pager,
    cards: cards.length,
    hasTable: table !== null,
    tableInCard: table !== null && table.closest('[data-ms-panel]') !== null,
    paintedTones,
    languageButtons: seg.length,
    themeButtons: icon.length,
    languageWidth: box(seg[0] ?? null),
    themeWidth: box(icon[0] ?? null),
    cells: cells.slice(0, 3),
    timestamps: timestamps.slice(0, 3),
    summary: summary === null ? null : summary.textContent.replace(/\\s+/g, ' ').trim(),
    isoInDocument: /\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}/.test(document.body.textContent ?? ''),
    nested: (() => {
      const inner = document.querySelector('[data-ms-screen] [data-ms-screen]');
      if (inner === null) return null;
      const cs = getComputedStyle(inner);
      return { padding: cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft, maxWidth: cs.maxInlineSize };
    })(),
  });
})()`;

describe.skipIf(!browserAvailable)("the render gate", () => {
  let root = "";
  let server: RunningDashboard;
  let issueId = "";
  /** A sentence-shaped title: the long-title arm needs one that cannot fit a 400px pane. */
  let longTitleIssueId = "";

  beforeAll(async () => {
    if (!browserAvailable) console.log(SKIP_REASON);
    root = mkdtempSync(join(tmpdir(), "mstar-render-gate-"));
    mkdirSync(join(root, ".mstar"), { recursive: true });
    const context = { harnessDir: join(root, ".mstar") };
    (await initializeStore(context)).close();

    const captured = await captureIssue(
      context,
      {
        projectId: "proj-a",
        title: "A status is one tone, and that tone is a dot",
        severity: "high",
        kind: "bug",
        impact: "A reader cannot tell two statuses apart without colour",
        acceptance: "Every status is a dot plus its word",
        sourceIdentity: "render-gate",
        rootCauseKey: "render-gate",
        acceptanceKey: "render-gate",
        occurrenceKey: "render-gate",
        sourceKind: "test",
        location: "packages/cli/test/render-gate.test.ts",
        observedBehavior: "the tone was painted behind the word",
        evidence: ["isolated fixture"],
        discoveredAt: RECORDED_AT,
      },
      { actor: "project-manager", operationId: "render-gate-capture" },
    );
    issueId = captured.issueId;

    // A second issue whose title is a full sentence. The long-title arm asserts that a
    // heading wider than its frame truncates INSIDE it, so the fixture has to overrun
    // 400px by a wide margin (a 47-character title still fits 360px of measure).
    const longTitle = await captureIssue(
      context,
      {
        projectId: "proj-a",
        title: "A reader cannot tell two statuses apart without colour when the tone is painted behind the word instead of beside it",
        severity: "medium",
        kind: "bug",
        impact: "The status word is the only non-colour cue",
        acceptance: "A status is a dot plus its word, and the word is never cut",
        sourceIdentity: "render-gate-long-title",
        rootCauseKey: "render-gate-long-title",
        acceptanceKey: "render-gate-long-title",
        occurrenceKey: "render-gate-long-title",
        sourceKind: "test",
        location: "packages/cli/test/render-gate.test.ts",
        observedBehavior: "the title escaped the frame instead of truncating in it",
        evidence: ["isolated fixture"],
        discoveredAt: RECORDED_AT,
      },
      { actor: "project-manager", operationId: "render-gate-capture-long-title" },
    );
    longTitleIssueId = longTitle.issueId;

    // A project so `#project/<id>/issues` renders the nested Issues screen — the
    // double-gutter case (PR 597 F3) only exists on a project feature page.
    await registerCatalogEntity(
      context,
      { kind: "project", id: "proj-a", title: "Render gate project", rootKind: "projects", relativePath: "proj-a" },
      { operationId: "render-gate-project", actor: "project-manager" },
    );

    // One catalog iteration, so the Iterations screen has a table to squeeze: the
    // narrow-band anchors are vacuous on an absence arm, and an absence arm is not
    // what the owner's screenshots showed.
    await registerCatalogEntity(
      context,
      {
        kind: "iteration",
        id: "iter-render-gate",
        title: "The narrow pane is a designed state",
        rootKind: "iterations",
        relativePath: "iter-render-gate",
      },
      { operationId: "render-gate-iteration", actor: "project-manager" },
    );

    const authority = await readExecutionAuthority(context);
    await createExecutionWorkflow(
      { ...context, caller: { role: "coordinator", sessionId: "render-gate", workflowId: "render-gate-workflow" } },
      {
        expected: authority.token,
        operationId: "render-gate-workflow",
        entry: { id: "render-gate-workflow", type: "plan", started_at: RECORDED_AT, dir: "workflows/render-gate" },
        snapshot: {
          schema_version: 1,
          id: "render-gate-workflow",
          type: "plan",
          status: "running",
          started_at: RECORDED_AT,
          updated_at: RECORDED_AT,
          plans: [],
        },
      },
    );
    // Drain the WAL side files so the server's read-only open cannot refuse.
    (await openStore(context, "read")).close();

    mkdirSync(CAPTURE_DIR, { recursive: true });
    server = await startDashboard({ harnessDir: context.harnessDir, port: 0 });

    await browser(["set", "viewport", String(VIEWPORT.width), String(VIEWPORT.height)]);
  }, 120_000);

  afterAll(async () => {
    if (browserAvailable) {
      try {
        await browser(["close"]);
      } catch {
        // A browser that already exited is not a failure of the gate.
      }
    }
    server?.close();
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  /**
   * Open one destination, capture it, and return what the browser measured.
   *
   * The wait is on the screen's own anchor, not on a sleep: every screen mounts
   * `data-ms-screen` and every screen puts its content in a card, so waiting for
   * the card is what makes the capture deterministic — and a screen that stopped
   * rendering a card fails here rather than in a human's eyes.
   */
  async function visit(route: string, screen: string, card = true, capture = route): Promise<Record<string, unknown>> {
    await browser(["open", `${server.url}#${route}`]);
    await browser(["wait", `[data-ms-screen="${screen}"]`]);
    // The detail screens are hairline sections (`design-v1.html:1377`), not cards,
    // so only a list screen is waited on for one.
    if (card) {
      // Named failure: a screen that lost its card says so, instead of the raw
      // `wait` timeout, because "no card" IS the regression this gate exists for.
      try {
        await browser(["wait", "[data-ms-panel]"]);
      } catch {
        throw new Error(`render-gate: the ${screen} screen rendered no [data-ms-panel] — it lost its card`);
      }
    }
    await browser(["wait", "200"]);
    await browser(["screenshot", join(CAPTURE_DIR, `${capture.replaceAll("/", "-")}.png`)]);
    return evalJson(PROBE);
  }

  /** The dashboard's stored locale (`prefs.ts` LOCALE_KEY): a reload applies it. */
  async function setLocale(locale: "en" | "zh"): Promise<void> {
    // The page must be on the dashboard's origin before storage is reachable: a test
    // that runs first would otherwise eval against a blank document and fail with a
    // SecurityError instead of testing anything.
    await browser(["open", `${server.url}#issues`]);
    await browser(["wait", "[data-ms-screen]"]);
    await browser(["eval", `localStorage.setItem("mstar.dashboard.locale", "${locale}")`]);
    await browser(["open", `${server.url}#issues`]);
    await browser(["wait", "[data-ms-screen]"]);
  }

  /** Set the band, then visit: the container is the root element, so the width
      given to the window IS the width the product is given. */
  async function visitAt(width: number, route: string, screen: string): Promise<Record<string, unknown>> {
    await browser(["set", "viewport", String(width), String(VIEWPORT.height)]);
    // One capture per band, so a reviewer opens the width they are judging.
    return visit(route, screen, true, `${route}-${width}`);
  }

  /** The anchors every screen shares: the header pair, and no chip-coloured tone. */
  function sharedAnchors(screen: Record<string, unknown>): void {
    expect(screen.paintedTones).toBe(0);
    expect(screen.languageButtons).toBe(1);
    expect(screen.themeButtons).toBe(1);
    expect(screen.languageWidth).toBeGreaterThan(0);
    expect(screen.themeWidth).toBeGreaterThan(0);
  }

  test("overview is a column of cards", async () => {
    const screen = await visit("overview", "overview");
    sharedAnchors(screen);
    // Four panels: active work, residuals, the iteration, the milestones.
    expect(screen.cards).toBe(4);
  }, 60_000);

  for (const route of ["workflows", "iterations", "projects"] as const) {
    test(`${route} is one card holding its table`, async () => {
      const screen = await visit(route, route);
      sharedAnchors(screen);
      expect(screen.cards).toBe(1);
      if (screen.hasTable === true) expect(screen.tableInCard).toBe(true);
    }, 60_000);
  }

  test("issues is the filters card and the table card, with the summary line", async () => {
    const screen = await visit("issues", "issues");
    sharedAnchors(screen);
    expect(screen.cards).toBe(2);
    expect(screen.tableInCard).toBe(true);
    const summary = String(screen.summary ?? "");
    expect(summary.length).toBeGreaterThan(0);
    // The count is stated above the table, in the summary line's own words.
    expect(summary).toMatch(/\d/);
    // `design-v1.html:1215`: a cell date is `MM-DD` or `MM-DD HH:mm`, never ISO.
    for (const cell of screen.cells as string[]) expect(cell).toMatch(/^\d{2}-\d{2}( \d{2}:\d{2})?$/);
    expect(screen.isoInDocument).toBe(false);
  }, 60_000);

  test("the pager's controls sit on the foot's trailing edge and its line", async () => {
    const screen = await visit("issues", "issues");
    const pager = screen.pager as Record<string, number | null>;
    // The prototype's foot splits left fact / right controls (`:1345`).
    expect(pager.buttonCount).toBe(2);
    expect(Math.abs((pager.lastButtonRight as number) - (pager.footInnerRight as number))).toBeLessThan(2);
    // and they share the range's centre line rather than standing taller than it.
    expect(Math.abs((pager.buttonCentreY as number) - (pager.rangeCentreY as number))).toBeLessThan(1.5);
    expect(pager.footHeight as number).toBeLessThan(34);
  }, 60_000);

  /**
   * THE BANDS THAT WERE NEVER TESTED.
   *
   * Every earlier round of visual work was verified at 1280px, and the product's
   * own live width — a 400-900px pane — was never in a gate at all. What shipped
   * was not a narrow layout: it was the wide layout squeezed, with the collapse
   * rules dead because the bundler had hashed their container names.
   *
   * Four samples, because the policy has four states and each one needs the
   * assertion that FAILS when it is gone:
   *
   * - 760: the pane's wide band. Every column, no scroll, no hidden column.
   * - 620: just above the collapse floor and just below the declared-width floor, so
   *   this is the ONLY sample where "scroll instead of squeeze" is true. A gate that
   *   asserts `tableScrollsSideways === false` here would pass with `overflow-x: auto`
   *   deleted and with the floor token dropped.
   * - 420: the collapsed band. Secondary columns hidden by rule, no scroll.
   * - 280: under the documented 300px table floor, where the floor rule is the only
   *   thing keeping a column readable.
   */
  /**
   * 280 sits under the documented table floor. One of the summary's two contracts is
   * genuinely unholdable there — the card (240px) is narrower than the summary's four
   * facts, so the line overflows its own box instead of reading as one measured line —
   * and DESIGN.md's floor row states that as the band's behaviour, not as a test
   * adjusted to go green. The baseline is width-independent, so it is still asserted
   * there; every band at 400 and above keeps both.
   */
  const FLOOR_SAMPLE = (sample: { floor?: number }): boolean => sample.floor !== undefined;

  const BANDS = [
    { width: 760, collapse: false, scrolls: false },
    // 620 is above the collapse floor and below the declared-width floor. Whether a
    // given list overflows there is a function of its own declared widths (the issues
    // table still does; the projects table no longer needs to), so the band does not
    // pin one answer — the "scroll instead of squeeze" contract is asserted on the
    // issues table directly, where the floor is genuinely short.
    { width: 620, collapse: false },
    { width: 420, collapse: true, scrolls: false },
    { width: 280, collapse: true, scrolls: true, floor: 300 },
  ] as const;

  for (const sample of BANDS) {
    for (const [route, screen] of [
      ["overview", "overview"],
      ["workflows", "workflows"],
      ["iterations", "iterations"],
      ["projects", "projects"],
      ["issues", "issues"],
    ] as const) {
      test(`at ${sample.width}px the ${route} screen still reads: no squeezed cell, a full card, a live header`, async () => {
        const measured = await visitAt(sample.width, route, screen);
        sharedAnchors(measured);
        const band = measured.band as Record<string, number | boolean | string | null>;
        const table = route !== "overview";

        // The card spans the width it was given (Task 2): a card narrower than its
        // container leaves the pane looking unfinished, which is what the owner saw.
        expect(band.contentWidth).not.toBeNull();
        for (const width of band.cardWidths as number[]) {
          expect(Math.abs(width - (band.contentWidth as number))).toBeLessThanOrEqual(1);
        }

        // A list screen with no rows is a DATA regression, not an absence arm: the
        // fixture seeds one row per list, so emptiness here must fail rather than
        // skip the whole table contract. Overview has no table at all.
        if (table) {
          expect(band.visibleCells as number).toBeGreaterThan(0);

          // No column is squeezed below its own identity: 44px is five monospace
          // characters, under which a cell is `I-…`, not an id. This is the half of
          // "scroll instead of squeeze" that the scrollbar itself cannot prove.
          expect(band.narrowestCell as number).toBeGreaterThanOrEqual(44);

          // The collapse is a RULE, not an overflow: it hides the secondary columns
          // and keeps the table inside its card. Where the policy allows a scroll
          // (620 above the declared floor, 280 under the documented floor) the
          // assertion inverts — otherwise deleting `overflow-x: auto` passes.
          expect(band.hiddenColumns as number > 0).toBe(sample.collapse);
          if ("scrolls" in sample) expect(band.tableScrollsSideways).toBe(sample.scrolls);
          // Scroll INSTEAD of squeeze means both halves: the table is wider than the
          // card where the policy permits it, and the box it sits in can actually
          // scroll (a `scrollWidth` check alone passes with `overflow-x` deleted).
          expect(band.scrollerOverflowX).toBe("auto");
          if ("floor" in sample) expect(band.tableWidth as number).toBeGreaterThanOrEqual(sample.floor);
        }

        // The screen's own title is not squeezed away, and never stacks one glyph per
        // line: one line box, with its own measure.
        expect(band.titleOverflows).toBe(false);
        expect(band.titleLines).toBe(1);
        expect(band.titleWidth as number).toBeGreaterThan(20);

        // Prose in a card stays prose (Task 3): the folded card is a measure, not a
        // column one character wide.
        if (band.worstPerLine !== null) expect(band.worstPerLine as number).toBeGreaterThanOrEqual(10);

        // The collapsed second line: the facts are whole, and they span exactly the
        // visible primary cells — the width is what makes them whole.
        if (sample.collapse && table) {
          expect(band.metaTruncated).toBe(false);
          expect(band.metaWidth as number).toBeGreaterThan(200);
          expect(Number(band.metaRowSpan)).toBe(band.visiblePrimaryCells as number);
        }

        // The summary line still reads (the Issues screen is the one that has one) and
        // sits on the title's baseline. Under the floor the card is narrower than the
        // summary's facts, so only the no-overflow half is waived — see FLOOR_SAMPLE.
        if (measured.summary !== null) {
          expect(String(measured.summary)).not.toBe("");
          if (sample.collapse) {
            // The title owns its row here, so the summary wraps under it: the contract
            // is that it sits directly below the title, not that it shares a baseline.
            expect(band.summaryTopOffset as number).toBeGreaterThanOrEqual(-2);
            expect(band.summaryTopOffset as number).toBeLessThan(24);
          } else {
            if (!FLOOR_SAMPLE(sample)) expect(band.summaryOverflows).toBe(false);
            expect(band.baselineDelta as number).toBeLessThanOrEqual(4);
          }
        }

        // The header controls stay reachable and labelled, and the page never
        // scrolls sideways: a horizontal page scrollbar is the layout giving up.
        expect(band.controlsInside).toBe(true);
        expect(band.controlsLabelled).toBe(true);
        expect(band.pageOverflow).toBe(false);

        // The pane's title band exists (Task 4): a header with its closing hairline.
        expect(band.headerHeight as number).toBeGreaterThan(0);
        expect(band.headerHairline).toBe("1px");
      }, 60_000);
    }
  }

  /**
   * The title rule exists for ONE shape: a CJK title has a break opportunity between
   * every glyph, so a squeezed head stacks it. Under `en` every sampled title is a
   * single word with nowhere to break — deleting the whole
   * `white-space: nowrap; min-inline-size: max-content` rule would still pass, which
   * makes an English-only arm an assertion that cannot fail.
   */
  test("under a CJK locale the title is still one line box", async () => {
    await setLocale("zh");
    try {
      // 400 is the product's own lower bound and the width the defect was reported at.
      await browser(["set", "viewport", "400", String(VIEWPORT.height)]);
      const measured = await visit("issues", "issues", true, "issues-400-zh");
      const band = measured.band as Record<string, number | boolean | string | null>;
      expect(String(band.titleText)).toMatch(/[\u4e00-\u9fff]/);
      expect(band.titleLines).toBe(1);
      // The title owns its row at this width, so the box is the row's width — never one
      // glyph (the pre-fix shape measured 30.4px over two lines), never ellipsis-only.
      expect(band.titleWidth as number).toBeGreaterThanOrEqual(120);
      expect(band.titleOverflows).toBe(false);
      expect(band.titleOverflows).toBe(false);
    } finally {
      await setLocale("en");
    }
  }, 60_000);

  /**
   * F2 — the collapsed second line is half the record's painted area, so it must be
   * the same activation target. The markup alone cannot prove that: this clicks it.
   */
  test("clicking the collapsed second line activates the record", async () => {
    await browser(["set", "viewport", "420", String(VIEWPORT.height)]);
    await visit("issues", "issues", true, "issues-420-click");
    const before = await evalJson('JSON.stringify({ hash: window.location.hash })');
    await browser(["click", "[data-ms-row-meta-row] td"]);
    await browser(["wait", "400"]);
    const after = await evalJson('JSON.stringify({ hash: window.location.hash })');
    // Navigation is a hash change on this host; the detail screen is the proof it
    // actually rendered rather than merely changed an address.
    expect(after.hash).not.toBe(before.hash);
    await browser(["wait", "[data-ms-screen] .ms-container [data-ms-screen], [data-ms-breadcrumb], main"]);
  }, 60_000);

  test("a screen inside a screen does not pay the frame's gutter twice", async () => {
    // `ProjectDetail` embeds the Issues screen (PR 597 F3).
    const screen = await visit("project/proj-a/issues", "project-detail");
    const nested = screen.nested as { padding: string; maxWidth: string } | null;
    expect(nested).not.toBeNull();
    expect(nested!.padding).toBe("0px 0px 0px 0px");
    expect(nested!.maxWidth).toBe("none");

  }, 60_000);

  /**
   * A title is a sentence on the detail screens and a project name on Projects. The
   * frame must hold it: it truncates with an ellipsis and the page never scrolls
   * sideways. The floor of zero (not `max-content`) is what makes that true — a CSS
   * minimum beats a maximum, so a `max-content` floor let the heading grow PAST the
   * frame instead of truncating in it.
   */
  test("a long title truncates inside the frame instead of escaping it", async () => {
    await browser(["set", "viewport", "400", String(VIEWPORT.height)]);
    const measured = await visit(`issue/${longTitleIssueId}`, "issue-detail", false, "issue-detail-400-longtitle");
    const band = measured.band as Record<string, number | boolean | string | null>;
    const title = String(band.titleText);
    expect(title.length).toBeGreaterThan(40);
    // One line box: the sentence never wraps into a paragraph-shaped heading.
    expect(band.titleLines).toBe(1);
    // It DOES truncate — an un-truncated sentence at 400px would mean it escaped.
    expect(band.titleTruncated).toBe(true);
    // ...inside the frame, and without scrolling the page sideways.
    expect(band.titleWidth as number).toBeLessThanOrEqual(band.contentWidth as number);
    expect(band.pageOverflow).toBe(false);
    // And not down to an ellipsis-only box: the row is still a readable measure.
    expect(band.titleWidth as number).toBeGreaterThanOrEqual(120);
  }, 60_000);

  test("at 620px the issues table scrolls inside its card instead of squeezing", async () => {
    // Above the collapse floor and below the declared-width floor: the table is wider
    // than its card AND the box scrolls, which is "scroll instead of squeeze" in both
    // halves. Deleting `overflow-x: auto` or dropping the floor fails here.
    await browser(["set", "viewport", "620", String(VIEWPORT.height)]);
    const measured = await visit("issues", "issues", true, "pane-620-issues");
    const band = measured.band as Record<string, number | boolean | string | null>;
    expect(band.tableScrollsSideways).toBe(true);
    expect(band.scrollerOverflowX).toBe("auto");
  }, 60_000);

  test("every list keeps the prototype's columns inside its card at 720px", async () => {
    // The pane the owner approves is 720px wide (`design-v1.html` sidebar stages).
    // At that width the prototype shows every column of every list, with the title
    // absorbing the slack — no clip, no card that scrolls its own table.
    await browser(["set", "viewport", "720", String(VIEWPORT.height)]);
    const lists = [
      ["issues", "issues", 7],
      ["workflows", "workflows", 6],
      ["iterations", "iterations", 7],
      ["projects", "projects", 5],
    ] as const;
    for (const [route, screen, columns] of lists) {
      const measured = await visit(route, screen, true, `pane-720-${route}`);
      const band = measured.band as Record<string, number | boolean | null>;
      // Every column the prototype shows is rendered: the eighth (milestone) is a
      // wide-only column and must be the only thing missing.
      expect(band.visibleCells).toBe(columns);
      // A table wider than its card is the defect this anchor exists for: the last
      // column was cut at the pane edge and the card looked like it had no frame.
      // `tableScrollsSideways` is the overflow test; the scroller keeps
      // `overflow-x: auto` at every width as the safety net, so its computed value is
      // not the anchor here.
      expect(band.tableScrollsSideways).toBe(false);
      const contentWidth = band.contentWidth as number;
      expect(band.tableWidth as number).toBeLessThanOrEqual(contentWidth + 0.5);
      for (const width of band.cardWidths as number[]) expect(width).toBeLessThanOrEqual(contentWidth + 0.5);
    }
  }, 90_000);

  test("the overview is one run of full-width sections at both pane widths", async () => {
    // The prototype's sidebar Overview is a single column of 694px panels
    // (`design-v1.html` sidebar focus view); a second column at a wide width only
    // squeezes prose that has nowhere to grow.
    for (const width of [720, 1900]) {
      await browser(["set", "viewport", String(width), "900"]);
      const measured = await visit("overview", "overview", true, `overview-${width}`);
      const band = measured.band as Record<string, number | boolean | null>;
      const cards = band.cardWidths as number[];
      expect(cards.length).toBeGreaterThan(1);
      for (const card of cards) expect(card).toBeCloseTo(band.contentWidth as number, 0);
    }
  }, 90_000);

  test("the pane head is inset from the pane's edges", async () => {
    // The prototype's head band is `padding: 0 12px` around the nav (`design-v1.html:487`),
    // and the dashboard's window header keeps its own 20px gutter on that band.
    // A flush edge is the defect: zero inset means the nav touches the pane's sides.
    const measured = await visit("issues", "issues", true, "pane-head-inset");
    const band = measured.band as Record<string, number | boolean | null>;
    expect(band.headerPadInline as number).toBeGreaterThanOrEqual(12);
    expect(band.headerHairline).not.toBe("0px");
  }, 60_000);

  test("a detail screen shows its timestamps in the prototype's form", async () => {
    const screen = await visit(`issue/${issueId}`, "issue-detail", false);
    sharedAnchors(screen);
    const stamps = screen.timestamps as string[];
    expect(stamps.length).toBeGreaterThan(0);
    // `design-v1.html:1444`: `2026-10-23 09:14` — the space form, not the ISO one.
    for (const stamp of stamps) expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/);
    expect(screen.isoInDocument).toBe(false);
  }, 60_000);
});

if (!browserAvailable) {
  test("render-gate skipped: no browser on this host", () => {
    console.log(SKIP_REASON);
  });
}
