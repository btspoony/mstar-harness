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
  // A hidden element stays in the DOM, so a raw querySelectorAll().length reports the
  // language group as present at 760px where the prototype hides it. Counting painted
  // boxes is what the assertions below mean by the header pair.
  const painted = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const segNodes = [...document.querySelectorAll('.app-seg')];
  const iconNodes = [...document.querySelectorAll('.app-icon-btn')];
  const seg = segNodes.filter(painted);
  const icon = iconNodes.filter(painted);
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
  // The overview's plan table is the workflow panel's own child, not part of the
  // workflow summary line (the prototype has three siblings: summary, branch line, table).
  // Scoped by the panel's accessible name, the stable marker across that move.
  const ovWorkflow = document.querySelector('[aria-labelledby="ms-overview-workflows"]');
  const ovWorkflowMeta = ovWorkflow === null ? null : ovWorkflow.querySelector('[data-ms-panel-meta]');
  const centreY = (el) => (el === null ? null : el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2);
  const band = {
    contentWidth: contentWidth === null ? null : Math.round(contentWidth * 10) / 10,
    cardWidths: [...document.querySelectorAll('[data-ms-panel]')].map((card) => Math.round(card.getBoundingClientRect().width * 10) / 10),
    // The overview's grid: one cell per column plus the spanning iteration cell.
    ovColumns: [...document.querySelectorAll('[data-ms-ov-column]')].map((col) => Math.round(col.getBoundingClientRect().width * 10) / 10),
    ovColumnsX: [...document.querySelectorAll('[data-ms-ov-column]')].map((col) => Math.round(col.getBoundingClientRect().left * 10) / 10),
    ovSpanningW: (() => {
      const span = document.querySelector('[data-ms-ov-spanning]');
      return span === null ? null : Math.round(span.getBoundingClientRect().width * 10) / 10;
    })(),
    // The trend: present, how it is drawn, and which arm rendered.
    // Scoped to the trend card: the page's other members render their own arms, and an
    // unscoped lookup would report whichever absence came first in the DOM.
    flowArm: (() => {
      const flow = document.querySelector('[data-ms-flow]');
      if (flow === null) return null;
      const absent = flow.querySelector('[data-ms-absence]');
      return absent === null ? 'populated' : absent.getAttribute('data-ms-absence');
    })(),
    flowPaths: document.querySelectorAll('[data-ms-flow-chart] path').length,
    // The workflow panel's plan table: its columns, its rows, and the header facts.
    planColumns: [...(ovWorkflow === null ? [] : ovWorkflow.querySelectorAll('table thead th'))].map((th) => th.getAttribute('data-ms-col-key')),
    planRows: ovWorkflow === null ? 0 : ovWorkflow.querySelectorAll('table tbody tr').length,
    planRowKeys: [...(ovWorkflow === null ? [] : ovWorkflow.querySelectorAll('table tbody tr'))].map((tr) => tr.getAttribute('data-ms-row-key')),
    planRowHeights: [...(ovWorkflow === null ? [] : ovWorkflow.querySelectorAll('table tbody tr'))].map((tr) => Math.round(tr.getBoundingClientRect().height * 10) / 10),
    planTitleWidth: (() => {
      const th = ovWorkflow === null ? null : ovWorkflow.querySelector('table th[data-ms-col-key="title"]');
      return th === null ? null : Math.round(th.getBoundingClientRect().width * 10) / 10;
    })(),
    planTableWidth: (() => {
      const table = ovWorkflow === null ? null : ovWorkflow.querySelector('table');
      return table === null ? null : Math.round(table.getBoundingClientRect().width * 10) / 10;
    })(),
    planTableVisibleColumns: (() => {
      const ths = [...(ovWorkflow === null ? [] : ovWorkflow.querySelectorAll('table thead th'))];
      return ths.filter((th) => getComputedStyle(th).display !== "none").length;
    })(),
    rowHeight: getComputedStyle(document.documentElement).getPropertyValue("--ms-row-h").trim(),
    workflowMetaCount: (() => {
      const count = ovWorkflowMeta === null ? null : ovWorkflowMeta.querySelector('.num');
      return count === null ? null : (count.textContent ?? "").trim();
    })(),
    workflowMeta: ovWorkflowMeta === null ? null : (ovWorkflowMeta.textContent ?? "").trim(),
    branchAnchors: document.querySelectorAll('[data-ms-branch] > span:not([aria-hidden])').length,
    planProgressBars: ovWorkflow === null ? 0 : ovWorkflow.querySelectorAll('table [role="progressbar"]').length,
    flowRows: document.querySelectorAll('[data-ms-flow] details tbody tr').length,
    flowAxis: [...document.querySelectorAll('[data-ms-flow] [class*="axis"] span')].map((el) => (el.textContent ?? '').trim()),
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
    // The floor the caller published for this table: below it the card body scrolls
    // instead of squeezing. It is a number the layout can be reasoned about with.
    tableFloorPx: (() => {
      const table = document.querySelector('table');
      if (table === null) return null;
      const value = getComputedStyle(table).getPropertyValue('--ms-table-floor').trim();
      return value === '' ? null : parseFloat(value);
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
    // The column sequence, visible columns only: the prototype fixes an order, and a
    // count alone cannot see a reorder. Keys rather than labels, so the anchor does not
    // depend on which locale the page happens to carry.
    columnKeys: [...document.querySelectorAll('table thead th')]
      .filter((th) => getComputedStyle(th).display !== 'none')
      .map((th) => th.getAttribute('data-ms-col-key')),
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
      const shown = controls.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      return shown.every((el) => {
        const rect = el.getBoundingClientRect();
        return rect.right <= window.innerWidth + 0.5 && rect.left >= -0.5;
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
    // The band decides what the header MUST look like; the assertions below read it rather
    // than treating either shape as acceptable at any width.
    headerNarrow: window.innerWidth <= 860,
    // The control must be MOUNTED at every width; only its painted-ness follows the
    // breakpoint. Without this, a filter that drops unrendered boxes would turn a control
    // that stopped mounting altogether into a passing run.
    languageNodes: segNodes.length,
    themeNodes: iconNodes.length,
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
          // The header line's branch chain reads these four anchors.
          branch: { base: "main", source: "render-gate-workflow", integration: "render-gate-workflow", target: "main" },
          // Two dated plans: the Overview's plan table is one row per plan, and the
          // gate's job is to see two rows from real store rows, not a fixture object.
          plans: [
            { id: "20261025-issue-project-move", file: "plans/20261025-issue-project-move.md", title: "Move issue ownership into the project domain", status: "InProgress" },
            { id: "20261018-panel-retirement", file: "plans/20261018-panel-retirement.md", title: "Retire the event log and meta dock", status: "Done" },
          ],
        },
      },
    );
    // Two dated buckets, so the trend has a line: the issues were captured in the same
    // minute, which is one UTC day. Back-date the first one by fixture, not by waiting.
    const dated = await openStore(context, "write");
    dated.db.exec("update issues set registered_at = '2026-10-10T08:00:00.000Z' where id = (select min(id) from issues)");
    dated.close();
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
  async function visit(
    route: string,
    screen: string,
    card = true,
    capture = route,
    baseUrl = server.url,
  ): Promise<Record<string, unknown>> {
    await browser(["open", `${baseUrl}#${route}`]);
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
    // The prototype hides the language group and the scope select below 860
    // (`design-v1.html`'s `@media (max-width: 860px)`), and the theme button stays at
    // every width. So the group is asserted only where the prototype shows it — and where
    // it is hidden, the count and the measured box must AGREE. A button that exists with
    // zero width is the defect this pins, not a narrow viewport.
    expect(screen.themeButtons).toBe(1);
    expect(screen.themeWidth).toBeGreaterThan(0);
    // The group is MOUNTED at every width, and what it paints is decided by the viewport
    // band, not by whatever happens to be true. `design-v1.html:741` hides it under
    // `@media (max-width: 860px)` (`:743`), so below that breakpoint it must be 0 painted
    // and above it exactly 1 — an earlier version of this assertion accepted 0 at every
    // width, which would have let a global `display: none` pass at 1280.
    expect(screen.languageNodes).toBe(1);
    expect(screen.themeNodes).toBe(1);
    expect(screen.themeButtons).toBe(1);
    expect(screen.themeWidth).toBeGreaterThan(0);
    if (screen.headerNarrow === true) {
      expect(screen.languageButtons).toBe(0);
      expect(screen.languageWidth).toBeNull();
    } else {
      expect(screen.languageButtons).toBe(1);
      expect(screen.languageWidth).toBeGreaterThan(0);
    }
  }

  test("overview is a column of cards", async () => {
    const screen = await visit("overview", "overview");
    sharedAnchors(screen);
    // Five panels: active work, the flow trend, residuals, the milestones, the iteration.
    expect(screen.cards).toBe(5);
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
    // 760 does not pin one answer either: the prototype's workflow table declares 962px of
    // fixed columns (`design-v1.html:1543`), iterations 830px (`:1752`), projects 720px, so
    // at this width those three overflow their card while the two wide screens do not. The
    // collapse contract — which is what this band is for — is asserted with `collapse: false`.
    { width: 760, collapse: false },
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
      // The dsh seat scrolls with `overflow-y: auto`, so on a classic-scrollbar
      // platform the vertical bar takes ~15px of the 720px pane and the card holds
      // 663px, not the 678px this macOS gate measures. The floor has to sit under
      // THAT number, or the iterations card scrolls at the width the owner approved
      // while this gate stays green on overlay scrollbars.
      if (route === "iterations") expect(band.tableFloorPx as number).toBeLessThanOrEqual(656);
      const contentWidth = band.contentWidth as number;
      expect(band.tableWidth as number).toBeLessThanOrEqual(contentWidth + 0.5);
      for (const width of band.cardWidths as number[]) expect(width).toBeLessThanOrEqual(contentWidth + 0.5);
    }
  }, 90_000);

  test("the issues column order is the prototype's sequence", async () => {
    // `design-v1.html:1199-1207`: ID, Title, Project, Kind, Severity, Disposition,
    // Last activity. The gate asserts the sequence, not just the count, because a
    // reorder keeps the count and changes what the reader scans.
    await browser(["set", "viewport", "720", String(VIEWPORT.height)]);
    const measured = await visit("issues", "issues", true, "pane-720-issues-order");
    const band = measured.band as Record<string, unknown>;
    expect(band.columnKeys).toEqual([
      "id",
      "title",
      "project",
      "kind",
      "severity",
      "disposition",
      "lastActivity",
    ]);
  }, 60_000);

  test("the overview is the prototype's two columns at 1.85 : 1, and one column at 720", async () => {
    // `design-v1.html:317-318`: `grid-template-columns: minmax(0, 1.85fr) minmax(0, 1fr)`.
    // The ratio is the design decision; measuring it is the only way to see a fold.
    const RATIO = 1.85;
    for (const width of [1900, 1280]) {
      await browser(["set", "viewport", String(width), "900"]);
      const measured = await visit("overview", "overview", true, `overview-${width}`);
      const band = measured.band as Record<string, number | number[] | null>;
      const columns = band.ovColumns as number[];
      expect(columns.length).toBe(2);
      const [left, right] = columns as [number, number];
      expect(left / right).toBeCloseTo(RATIO, 1);
      // Side by side, not stacked: different left edges on the same row band, and the
      // pair together spans the content width.
      const [leftX, rightX] = band.ovColumnsX as [number, number];
      expect(rightX).toBeGreaterThan(leftX);
      // A gap sits between them, so the pair is narrower than the content width.
      const contentWidth = band.contentWidth as number;
      expect(left + right).toBeLessThan(contentWidth);
      expect(left + right).toBeGreaterThan(contentWidth * 0.95);
      // The iteration is a full-width row beneath both.
      expect(band.ovSpanningW as number).toBeCloseTo(band.contentWidth as number, 0);
    }
    // The sidebar's narrow form: one column, nothing beside it.
    await browser(["set", "viewport", "720", "900"]);
    const narrow = await visit("overview", "overview", true, "overview-720");
    const narrowBand = narrow.band as Record<string, number | number[] | null>;
    const narrowColumns = narrowBand.ovColumns as number[];
    expect(narrowColumns.length).toBe(2);
    // Two cells, one stacked under the other: same left edge, full width each.
    const [aX, bX] = narrowBand.ovColumnsX as [number, number];
    expect(bX).toBe(aX);
    for (const column of narrowColumns) expect(column).toBeCloseTo(narrowBand.contentWidth as number, 0);
  }, 120_000);

  test("the workflow panel is the prototype's plan table, one row per plan", async () => {
    await browser(["set", "viewport", "1900", "900"]);
    const measured = await visit("overview", "overview", true, "overview-planboard");
    const band = measured.band as Record<string, unknown>;
    // Five columns, in the prototype's order (`design-v1.html:859-866`). A missing key
    // means a column the owner asked for is rendered by nobody.
    expect(band.planColumns).toEqual(["plan", "title", "status", "progress", "done"]);
    // Two plans in the fixture, two rows on the page. The order is the read's own —
    // `projection_plans` is ordered by `plan_id`, not by the snapshot's array — so the
    // gate states what the store answers rather than what the fixture wrote.
    expect(band.planRows).toBe(2);
    expect(band.planRowKeys).toEqual(["20261018-panel-retirement", "20261025-issue-project-move"]);
    // The header line above it states the workflow's own count, not the page's. The
    // number is asserted on the attribute, and the status word is an enum the
    // dictionary carries verbatim — so this anchor does not depend on which locale
    // the page happened to load.
    expect(band.workflowMetaCount).toBe("2");
    expect(String(band.workflowMeta)).toContain("running");
    // The branch chain drew its four anchors.
    expect(band.branchAnchors).toBe(4);
    // Every row is exactly one row tall: the table's height rule, measured.
    const rowHeight = Number.parseFloat(String(band.rowHeight));
    expect(rowHeight).toBeGreaterThan(0);
    for (const height of band.planRowHeights as number[]) expect(height).toBeCloseTo(rowHeight, 0);
    // The title column is the flexible one: it is wider than any declared cell.
    expect(band.planTitleWidth as number).toBeGreaterThan(100);
    // All five columns survive the 900px floor, and the table stays inside its card.
    expect(band.planTableVisibleColumns).toBe(5);
    expect(band.planTableWidth as number).toBeLessThanOrEqual((band.contentWidth as number) + 0.5);
  }, 90_000);

  test("the trend is drawn from the store, not faked", async () => {
    await browser(["set", "viewport", "1900", "900"]);
    const measured = await visit("overview", "overview", true, "overview-trend");
    const band = measured.band as Record<string, number | string | string[] | null>;
    expect(band.flowArm).toBe("populated");
    // Two step lines, one per series.
    expect(band.flowPaths).toBe(2);
    // The table alternative carries one row per dated bucket, so the series has a length
    // a reader can count without the figure.
    expect(band.flowRows as number).toBeGreaterThanOrEqual(2);
    // The axis labels the prototype draws: first, middle, last — and DISTINCT. The
    // format check alone passed on `first, first, last`, which is what a two-bucket
    // store produced before the middle label learned to step aside.
    const axis = band.flowAxis as string[];
    expect(axis.length).toBeGreaterThanOrEqual(2);
    expect(new Set(axis).size).toBe(axis.length);
    for (const label of axis) expect(label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }, 60_000);

  test("an unavailable flow member renders the unavailable arm, never an empty chart", async () => {
    // The store's own failure path, not a flag: `readIssueFlow`'s closure read joins
    // `issue_transitions`, so a store without that table answers `unavailable`. The
    // point of the anchor is that the trend degrades through the shared arm — a fake
    // zero-line would look like a healthy trend that reports nothing.
    const dir = mkdtempSync(join(tmpdir(), "mstar-render-gate-flow-"));
    mkdirSync(join(dir, ".mstar"), { recursive: true });
    const context = { harnessDir: join(dir, ".mstar") };
    (await initializeStore(context)).close();
    await captureIssue(
      context,
      {
        projectId: "proj-a",
        title: "A flow member that cannot be read",
        severity: "high",
        kind: "bug",
        impact: "The trend has no buckets to draw",
        acceptance: "The unavailable arm is drawn instead",
        sourceIdentity: "render-gate-flow",
        rootCauseKey: "render-gate-flow",
        acceptanceKey: "render-gate-flow",
        occurrenceKey: "render-gate-flow",
        sourceKind: "test",
        location: "packages/cli/test/render-gate.test.ts",
        observedBehavior: "an empty chart was drawn",
        evidence: ["isolated fixture"],
        discoveredAt: RECORDED_AT,
      },
      { actor: "project-manager", operationId: "render-gate-flow-capture" },
    );
    const handle = await openStore(context, "write");
    // `readIssueFlow`'s closure read filters `issue_transitions.to_disposition`; without
    // the column that statement fails, which is the store's own failure path — not a
    // synthetic flag, and not a dropped table (dropping one trips foreign keys).
    handle.db.exec("alter table issue_transitions drop column to_disposition");
    handle.close();
    // Two dated buckets, so the trend has a line: the issues were captured in the same
    // minute, which is one UTC day. Back-date the first one by fixture, not by waiting.
    const dated = await openStore(context, "write");
    dated.db.exec("update issues set registered_at = '2026-10-10T08:00:00.000Z' where id = (select min(id) from issues)");
    dated.close();
    // Drain the WAL side files so the server's read-only open cannot refuse.
    (await openStore(context, "read")).close();

    const broken = await startDashboard({ harnessDir: context.harnessDir, port: 0 });
    try {
      await browser(["set", "viewport", "1900", "900"]);
      const measured = await visit("overview", "overview", true, "overview-flow-unavailable", broken.url);
      const band = measured.band as Record<string, number | string | null>;
      expect(band.flowArm).toBe("unavailable");
      expect(band.flowPaths).toBe(0);
      expect(band.flowRows).toBe(0);
    } finally {
      broken.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test("the pane head is inset from the pane's edges", async () => {
    // The prototype's head band is `padding: 0 12px` around the nav (`design-v1.html:487`),
    // and the dashboard's window header keeps its own 20px gutter on that band.
    // A flush edge is the defect: zero inset means the nav touches the pane's sides.
    const measured = await visit("issues", "issues", true, "pane-head-inset");
    const band = measured.band as Record<string, number | boolean | null>;
    // The exact dashboard gutter, not a range: the shared band supplies 12px and the
    // window header overrides it. A range would pass at both numbers and would not see
    // the override lose its specificity (or the sheets swap order).
    expect(band.headerPadInline).toBe(20);
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
