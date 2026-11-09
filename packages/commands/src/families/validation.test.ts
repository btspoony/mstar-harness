/**
 * `lint` over the two document layers (`mstar-artifacts/references/
 * knowledge-and-designs.md`): `--type specs` / `--type adr`, a directory
 * target running the tree check, a file target running one document's check,
 * and the refusal envelope a violating fixture earns.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InvocationContext } from "../types.js";
import { getCommandDefinitions } from "../definitions.js";

function invocation(cwd: string): InvocationContext {
  return {
    cwd,
    controlRoot: null,
    versions: { engine: null, cli: "test", plugin: null, host: null, platform: "test" },
    signal: new AbortController().signal,
    effects: {
      async readInput() { return ""; },
      async spawn() { throw new Error("unused"); },
      async startDashboard() { throw new Error("unused"); },
      async openBrowser() { throw new Error("unused"); },
      writeStderr() {},
    },
  };
}

function lintDefinition() {
  const definition = getCommandDefinitions().find(({ id }) => id === "lint");
  if (definition === undefined) throw new Error("missing lint definition");
  return definition;
}

async function runLint(cwd: string, input: Record<string, unknown>) {
  const definition = lintDefinition();
  return definition.execute(definition.input.parse(input), invocation(cwd));
}

/** Write `files` (relative path -> text) under a fresh temp root. */
function withTree<T>(files: Record<string, string>, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "lint-command-"));
  const done = async (): Promise<T> => {
    try {
      for (const [rel, text] of Object.entries(files)) {
        const target = join(dir, rel);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, text);
      }
      return await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return done();
}

const SPEC = `# Store authority

## Scope

The control-root store.

## Current state

One SQLite file.

## Invariants

Writes go through the domain verbs.

## Where it lives

\`packages/engine/src/store.ts\`

## Change obligations

Update in the same PR as a schema change.
`;

const ADR = `# ADR: Example

Status: implemented \u2014 because

## Problem

Text.

## Decision

Text.

## Alternatives considered

Text.

## Consequences

Text.
`;

const SPECS_README = `# Specs\n\n| Page | Topic |\n|---|---|\n| [store](architecture/store.md) | store |\n`;

describe("lint --type specs|adr — known types", () => {
  test("the usage string lists both document layers", async () => {
    const result = await runLint(tmpdir(), { target: "x", type: "nope" });
    if (result.status !== "usage") throw new Error(`expected a usage envelope, got ${result.status}`);
    expect(result.message).toContain("specs");
    expect(result.message).toContain("adr");
  });

  test("the definition description names both document layers", () => {
    expect(lintDefinition().description).toContain("specs");
    expect(lintDefinition().description).toContain("adr");
  });
});

describe("lint --type specs", () => {
  test("a directory target runs the tree check and passes on an indexed tree", async () => {
    const result = await withTree(
      { "specs/README.md": SPECS_README, "specs/architecture/store.md": SPEC },
      (dir) => runLint(dir, { target: "specs", type: "specs" }),
    );
    expect(result.status).toBe("ok");
    expect(result.exitCode).toBe(0);
  });

  test("a file target checks one document and refuses a version suffix", async () => {
    const result = await withTree(
      { "specs/architecture/store-v2.md": SPEC },
      (dir) => runLint(dir, { target: "specs/architecture/store-v2.md", type: "specs" }),
    );
    expect(result.status).toBe("refused");
    expect(result.exitCode).toBe(1);
    expect(JSON.stringify(result.details)).toContain("lint.specs.name-shape");
  });

  test("the refusal carries the rerun recovery and per-file results", async () => {
    const result = await withTree(
      { "specs/architecture/store.md": "# Store\n" },
      (dir) => runLint(dir, { target: "specs", type: "specs" }),
    );
    expect(result.status).toBe("refused");
    expect(JSON.stringify(result.details)).toContain("rerun mstar lint");
    const data = result.details as { results: Array<{ file: string; violations: unknown[] }> };
    expect(data.results).toHaveLength(1);
    expect(data.results[0]!.violations.length).toBeGreaterThan(0);
  });
});

describe("lint --type adr", () => {
  test("a directory target runs the tree check and passes on a valid tree", async () => {
    const result = await withTree(
      { "adr/implemented/architecture/2026-01-01-example.md": ADR },
      (dir) => runLint(dir, { target: "adr", type: "adr" }),
    );
    expect(result.status).toBe("ok");
  });

  test("an archived record without an Archived: line is refused", async () => {
    const result = await withTree(
      { "adr/archived/architecture/2026-01-02-old.md": ADR },
      (dir) => runLint(dir, { target: "adr", type: "adr" }),
    );
    expect(result.status).toBe("refused");
    expect(JSON.stringify(result.details)).toContain("lint.adr.archive-line-missing");
  });

  test("a file target checks that record, and a path outside {bucket}/{class}/ is a usage error", async () => {
    const inside = await withTree(
      { "adr/rejected/architecture/2026-01-03-moved.md": ADR },
      (dir) => runLint(dir, { target: "adr/rejected/architecture/2026-01-03-moved.md", type: "adr" }),
    );
    expect(inside.status).toBe("refused");
    expect(JSON.stringify(inside.details)).toContain("lint.adr.status-mismatch");

    const outside = await withTree(
      { "notes/2026-01-04-loose.md": ADR },
      (dir) => runLint(dir, { target: "notes/2026-01-04-loose.md", type: "adr" }),
    );
    expect(outside.status).toBe("usage");
  });
});
