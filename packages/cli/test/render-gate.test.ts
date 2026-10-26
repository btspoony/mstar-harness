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
import { captureIssue, createExecutionWorkflow, initializeStore, openStore, readExecutionAuthority } from "@mstar-harness/engine";
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
  const cells = [...document.querySelectorAll('tbody tr td:last-child')]
    .map((cell) => cell.textContent.trim()).filter((text) => text !== '');
  const timestamps = [...document.querySelectorAll('dd')]
    .map((cell) => cell.textContent.trim()).filter((text) => /\\d{4}-\\d{2}-\\d{2}/.test(text));
  const summary = document.querySelector('[data-ms-summary]');
  return JSON.stringify({
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
  });
})()`;

describe.skipIf(!browserAvailable)("the render gate", () => {
  let root = "";
  let server: RunningDashboard;
  let issueId = "";

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
  async function visit(route: string, screen: string, card = true): Promise<Record<string, unknown>> {
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
    await browser(["screenshot", join(CAPTURE_DIR, `${route.replace("/", "-")}.png`)]);
    return evalJson(PROBE);
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
