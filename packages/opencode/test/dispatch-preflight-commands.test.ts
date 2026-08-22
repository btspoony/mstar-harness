/**
 * OpenCode package fixture test — omp `/iteration-*` commands point at the
 * shared dispatch-preflight reference (`mstar-iteration` command-shared
 * invariants; iteration-thin refactor).
 *
 * The omp host has no TS hook surface (roadmap D4): binding is command-layer
 * shell-out. The three iteration commands now render a one-line pointer to
 * `skills/mstar-iteration/references/command-shared-invariants.md`, which
 * carries the OPTIONAL `mstar dispatch validate` preflight that (a) is
 * skipped silently when the `mstar-harness` bin is absent
 * (`command -v … >/dev/null 2>&1 &&` guard) and (b) does not change the
 * commands' core flow (documented as optional / warn-only).
 *
 * Reads the shared reference markdown file (unit test on the rendered
 * text) and asserts the snippet in the shared sections; the command files
 * are only required to exist and point at the reference.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const commandsDir = path.resolve(import.meta.dir, "../../../commands");
const sharedReference = path.resolve(
  import.meta.dir,
  "../../../skills/mstar-iteration/references/command-shared-invariants.md",
);
// Command bodies reference the shared file by its bare skill path (the
// commands' convention: `mstar-*` assets are named without the `skills/`
// prefix; only bundled non-`mstar-*` assets like grill-me use `skills/`).
const SHARED_REFERENCE_POINTER = "mstar-iteration/references/command-shared-invariants.md";
// Quoted placeholder (qc2 W-2): agent-substituted paths must not enter the
// shell unquoted — the snippet itself is the documented safe form.
const PREFLIGHT_SNIPPET = 'command -v mstar-harness >/dev/null 2>&1 && mstar-harness dispatch validate "<latest-assignment-file>"';
// Slice 5 (roadmap §8.5 D2): fail-fast variant when the iteration compass
// frontmatter declares `enforcement: hard` — validation failure exits 1,
// but the bin-absent silent-skip guard is preserved.
const FAILFAST_SNIPPET =
  'if command -v mstar-harness >/dev/null 2>&1; then mstar-harness dispatch validate "<latest-assignment-file>" || exit 1; fi';
const iterationCommands = ["iteration-start.md", "iteration-drive.md", "iteration-loop.md"] as const;

describe("omp iteration commands optional dispatch preflight (shared reference)", () => {
  test("all three command files exist in the repo commands dir", () => {
    for (const file of iterationCommands) {
      expect(fs.existsSync(path.join(commandsDir, file))).toBe(true);
    }
  });

  test("each command points at the shared preflight reference", () => {
    expect(fs.existsSync(sharedReference)).toBe(true);
    for (const file of iterationCommands) {
      const content = fs.readFileSync(path.join(commandsDir, file), "utf8");
      expect(content).toContain(SHARED_REFERENCE_POINTER);
    }
  });

  test("shared reference renders the preflight snippet", () => {
    const content = fs.readFileSync(sharedReference, "utf8");
    expect(content).toContain(PREFLIGHT_SNIPPET);
    expect(content).toContain("mstar-harness dispatch validate");
  });

  test("shared reference documents the preflight as optional with a silent-skip guard", () => {
    const content = fs.readFileSync(sharedReference, "utf8");
    // Optional marker (Chinese commands are bilingual; accept either).
    expect(content).toMatch(/可选|optional/i);
    // Silent skip when the bin is absent.
    expect(content).toMatch(/静默|silent/i);
    // Default mode stays warn-only, does not alter the core flow.
    expect(content).toMatch(/不阻断|不改变|warn/i);
  });
});

describe("omp iteration commands Slice 5 fail-fast (compass enforcement: hard)", () => {
  // Spec: roadmap §8.5 C4/D2 — when the iteration compass carries
  // `enforcement: hard`, the preflight becomes fail-fast
  // (`mstar-harness dispatch validate "<file>" || exit 1`-style); the
  // documented conditional still skips silently when the bin is absent.
  test("shared reference renders the fail-fast conditional snippet", () => {
    const content = fs.readFileSync(sharedReference, "utf8");
    expect(content).toContain(FAILFAST_SNIPPET);
    expect(content).toContain("|| exit 1");
  });

  test("shared reference documents the fail-fast as conditional on the compass enforcement flag", () => {
    const content = fs.readFileSync(sharedReference, "utf8");
    // The trigger: iteration compass frontmatter `enforcement: hard`.
    expect(content).toMatch(/enforcement: hard/);
    expect(content).toMatch(/fail-fast/);
  });

  test("shared reference preserves the bin-absent silent-skip in the fail-fast form", () => {
    const content = fs.readFileSync(sharedReference, "utf8");
    // The fail-fast snippet keeps the `command -v mstar-harness` guard —
    // bin absent → the whole conditional is skipped (silent, exit 0).
    expect(FAILFAST_SNIPPET).toMatch(/command -v mstar-harness/);
    expect(content).toContain(FAILFAST_SNIPPET);
  });

  // Real shell smoke test (Slice 5 review finding): the documented fail-fast
  // snippet is not just rendered text — it must actually exit 1 when the bin
  // is present and validation fails, and exit 0 silently when the bin is
  // absent. Runs against a temp PATH with a fake `mstar-harness` bin (exits
  // 1), never depending on the real mstar-harness install.
  const makeTempProject = (): { dir: string; binDir: string; cleanup: () => void } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mstar-preflight-"));
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    return { dir, binDir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  };

  const writeFakeBin = (binDir: string, exitCode: number): void => {
    fs.writeFileSync(path.join(binDir, "mstar-harness"), `#!/bin/sh\nexit ${exitCode}\n`, {
      mode: 0o755,
    });
  };

  const writeTempAssignment = (dir: string): string => {
    const assignmentFile = path.join(dir, "assignment.md");
    // Deliberately invalid: heading + `Enforcement: hard` but no core fields.
    fs.writeFileSync(assignmentFile, "## Assignment\n\n**Enforcement**: hard\n\nDispatch me.\n", "utf8");
    return assignmentFile;
  };

  const runSnippet = (snippet: string, envPath: string): { status: number | null; stderr: string } => {
    const result = spawnSync("/bin/sh", ["-c", snippet], {
      env: { PATH: envPath },
      encoding: "utf8",
    });
    return { status: result.status, stderr: result.stderr };
  };

  test("fail-fast snippet: bin present + validation fails → command exits 1", () => {
    const { dir, binDir, cleanup } = makeTempProject();
    try {
      writeFakeBin(binDir, 1);
      const snippet = FAILFAST_SNIPPET.replace("<latest-assignment-file>", writeTempAssignment(dir));
      const { status } = runSnippet(snippet, binDir);
      expect(status).toBe(1);
    } finally {
      cleanup();
    }
  });

  test("fail-fast snippet: bin present + validation passes → command exits 0", () => {
    const { dir, binDir, cleanup } = makeTempProject();
    try {
      writeFakeBin(binDir, 0);
      const snippet = FAILFAST_SNIPPET.replace("<latest-assignment-file>", writeTempAssignment(dir));
      const { status } = runSnippet(snippet, binDir);
      expect(status).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("fail-fast snippet: bin absent → exit 0 silent skip", () => {
    const { dir, binDir, cleanup } = makeTempProject();
    try {
      // No bin written — and PATH points at an empty dir only, so even a
      // real mstar-harness install elsewhere cannot satisfy `command -v`.
      const emptyPath = path.join(dir, "empty");
      fs.mkdirSync(emptyPath, { recursive: true });
      const snippet = FAILFAST_SNIPPET.replace("<latest-assignment-file>", writeTempAssignment(dir));
      const { status, stderr } = runSnippet(snippet, emptyPath);
      expect(status).toBe(0);
      expect(stderr).toBe("");
    } finally {
      cleanup();
    }
  });
});
