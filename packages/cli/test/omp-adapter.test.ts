/**
 * omp adapter init state handling — `packages/cli/src/adapters/omp.ts`.
 *
 * ## What is real here, and what the test supplies
 *
 * Real: the adapter's state handling (it reads the plugin-manager manifest and
 * `lstat`s the entry), the argv it hands to omp, and the plugin-manager lookup
 * `listInstalledPlugins` performs.
 *
 * Supplied by the test: a fake `omp` executable on a controlled PATH that
 * records argv and answers `plugin list --json` from the entry's real state, plus
 * temp directories for the plugin root and the linked tree. Nothing here touches
 * the operator's home: `clearOmpEntry` takes its root as a parameter, and
 * `verifyOmpInstall` reads only through the fake binary on PATH.
 *
 * The `runInit` end-to-end wiring (link → verify → refusal) is NOT covered here:
 * its plugin root and harness checkout resolve from the process home, which this
 * runtime caches at startup, so an end-to-end case would mutate the operator's
 * real plugin state. See the plan's residual list.
 *
 * No omp version appears in this file: expectations derive from the CLI's own
 * manifest through `readHarnessVersion()`, except where a synthetic token is the
 * input domain (`readHarnessVersion()`-independent fake output).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clearOmpEntry, ompAdapter, verifyOmpInstall } from "../src/adapters/omp";
import { HARNESS_REPO_PATH } from "../src/adapters/shared-install";
import { readHarnessVersion } from "../src/utils";

const PLUGIN_NAME = "@mstar-harness/omp";
const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface FakeOmp {
  /** Recorded invocations, one space-joined argv per line. */
  argv: () => string[];
}

/**
 * Fake `omp` on a PATH of its own. `plugin list --json` reports whatever the
 * entry's real state is, so verification sees what actually exists; `plugin
 * uninstall` removes the entry the way omp owns it.
 */
function withFakeOmp(entry: string, opts: { uninstallExit?: number } = {}): FakeOmp {
  const binDir = tempDir("omp-fake-");
  const logFile = join(binDir, "argv.log");
  const script = [
    "#!/bin/sh",
    `echo "$@" >> "${logFile}"`,
    'if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then',
    `  if [ -e "${entry}" ]; then`,
    `    printf '[{"name":"${PLUGIN_NAME}","path":"${entry}","manifest":{"name":"${PLUGIN_NAME}","version":"${readHarnessVersion()}"}}]\\n'`,
    "  else",
    `    printf '[]\\n'`,
    "  fi",
    "  exit 0",
    "fi",
    'if [ "$1" = "plugin" ] && [ "$2" = "uninstall" ]; then',
    opts.uninstallExit
      ? `  printf '%s\\n' "not installed" >&2; exit ${opts.uninstallExit}`
      : `  /bin/rm -rf "${entry}"; exit 0`,
    "fi",
    "exit 0",
  ].join("\n");
  const binPath = join(binDir, "omp");
  writeFileSync(binPath, `${script}\n`);
  chmodSync(binPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:/usr/bin:/bin`;
  return {
    argv: () => {
      if (!existsSync(logFile)) return [];
      const raw = readFileSync(logFile, "utf8").trim();
      return raw ? raw.split("\n") : [];
    },
  };
}

/** Restore PATH after a fake-binary case. */
const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
});

function pluginsRoot(): string {
  const root = tempDir("omp-plugins-");
  mkdirSync(join(root, "node_modules", "@mstar-harness"), { recursive: true });
  return root;
}

describe("clearOmpEntry", () => {
  test("a leftover tree is replaced through omp's own uninstall, never deleted by hand", () => {
    const root = pluginsRoot();
    const entry = join(root, "node_modules", PLUGIN_NAME);
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, "stale.txt"), "stale\n");
    const fake = withFakeOmp(entry);
    const notes: string[] = [];
    clearOmpEntry(root, "/nonexistent/linked/tree", notes);
    expect(fake.argv()).toContain(`plugin uninstall ${PLUGIN_NAME}`);
    expect(existsSync(entry)).toBe(false);
    expect(notes.some((note) => note.includes("through omp"))).toBe(true);
  });

  test("an entry omp cannot remove is refused with the path and every supported route", () => {
    const root = pluginsRoot();
    const entry = join(root, "node_modules", PLUGIN_NAME);
    mkdirSync(entry, { recursive: true });
    const fake = withFakeOmp(entry, { uninstallExit: 1 });
    let thrown: Error | null = null;
    try {
      clearOmpEntry(root, "/nonexistent/linked/tree", []);
    } catch (error) {
      thrown = error as Error;
    }
    // The plugin manager owns its node_modules: init never deletes the entry
    // itself, so the refusal must name the path and both supported routes.
    expect(existsSync(entry)).toBe(true);
    expect(fake.argv()).toContain(`plugin uninstall ${PLUGIN_NAME}`);
    expect(thrown?.message).toContain(entry);
    expect(thrown?.message).toContain(`omp plugin uninstall ${PLUGIN_NAME}`);
    expect(thrown?.message).toContain(`omp plugin install ${PLUGIN_NAME}`);
  });

  test("an entry the plugin manager declares is removed through omp", () => {
    const root = pluginsRoot();
    const entry = join(root, "node_modules", PLUGIN_NAME);
    mkdirSync(entry, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "omp-plugins", private: true, dependencies: { [PLUGIN_NAME]: "workspace:*" } })}\n`,
    );
    const fake = withFakeOmp(entry);
    const notes: string[] = [];
    clearOmpEntry(root, "/nonexistent/linked/tree", notes);
    expect(fake.argv()).toContain(`plugin uninstall ${PLUGIN_NAME}`);
    expect(existsSync(entry)).toBe(false);
  });

  test("a dangling symlink in the entry is cleared", () => {
    const root = pluginsRoot();
    const entry = join(root, "node_modules", PLUGIN_NAME);
    symlinkSync("/nonexistent/target", entry);
    withFakeOmp(entry);
    clearOmpEntry(root, "/nonexistent/linked/tree", []);
    expect(existsSync(entry)).toBe(false);
  });

  test("every mutating verb carries the selected scope", () => {
    const root = pluginsRoot();
    const entry = join(root, "node_modules", PLUGIN_NAME);
    mkdirSync(entry, { recursive: true });
    const fake = withFakeOmp(entry);
    clearOmpEntry(root, "/nonexistent/linked/tree", [], "project");
    expect(fake.argv()).toContain(`plugin uninstall ${PLUGIN_NAME} --scope project`);
  });

  test("an entry that does not exist is a no-op", () => {
    const root = pluginsRoot();
    const fake = withFakeOmp(join(root, "node_modules", PLUGIN_NAME));
    const notes: string[] = [];
    clearOmpEntry(root, "/nonexistent/linked/tree", notes);
    expect(notes).toEqual([]);
    expect(fake.argv()).toEqual([]);
  });
});

describe("verifyOmpInstall", () => {
  test("an install omp does not list is a refusal naming the supported route", () => {
    const root = pluginsRoot();
    withFakeOmp(join(root, "node_modules", PLUGIN_NAME));
    let thrown: Error | null = null;
    try {
      verifyOmpInstall([], readHarnessVersion());
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain("omp plugin list");
    expect(thrown?.message).toContain(`omp plugin install ${PLUGIN_NAME}`);
  });

  test("a listed entry at the expected version passes and is reported", () => {
    const root = pluginsRoot();
    const entry = join(root, "node_modules", PLUGIN_NAME);
    mkdirSync(entry, { recursive: true });
    withFakeOmp(entry);
    const notes: string[] = [];
    verifyOmpInstall(notes, readHarnessVersion());
    expect(notes.some((note) => note.includes(PLUGIN_NAME))).toBe(true);
  });

  test("a linked tree omp does not list is a refusal naming the link route", () => {
    const root = pluginsRoot();
    const entry = join(root, "node_modules", PLUGIN_NAME);
    mkdirSync(entry, { recursive: true });
    const elsewhere = tempDir("omp-linked-");
    withFakeOmp(entry);
    expect(() => verifyOmpInstall([], readHarnessVersion(), elsewhere)).toThrow(/omp plugin link/);
  });

  test("a linked tree omp lists passes", () => {
    const root = pluginsRoot();
    const entry = join(root, "node_modules", PLUGIN_NAME);
    mkdirSync(entry, { recursive: true });
    withFakeOmp(entry);
    const notes: string[] = [];
    verifyOmpInstall(notes, readHarnessVersion(), entry);
    expect(notes.some((note) => note.includes("linked from"))).toBe(true);
  });
});

/**
 * End-to-end `runInit` cases. The adapter resolves its plugin root and its
 * harness checkout from the process home, which this runtime caches at startup,
 * so the only isolated way to exercise the real flow is a child process launched
 * with its own HOME — exactly what a real operator's shell does.
 */
describe("verifyOmpInstall identity and probe failures", () => {
  test("a legacy entry listed first does not stand in for the installed package", () => {
    const root = pluginsRoot();
    const entry = join(root, "node_modules", PLUGIN_NAME);
    mkdirSync(entry, { recursive: true });
    withFakeOmpListing(
      `[{"name":"morning-star-legacy","path":"${join(root, "node_modules", "morning-star-legacy")}"},` +
        `{"name":"${PLUGIN_NAME}","path":"${entry}","manifest":{"name":"${PLUGIN_NAME}","version":"${readHarnessVersion()}"}}]`,
    );
    const notes: string[] = [];
    verifyOmpInstall(notes, readHarnessVersion(), entry);
    expect(notes.some((note) => note.includes("linked from"))).toBe(true);
  });

  test("a failed listing probe is reported as a probe failure, not a missing registration", () => {
    withFakeOmpListingFail();
    let thrown: Error | null = null;
    try {
      verifyOmpInstall([], readHarnessVersion());
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toContain("could not read omp's plugin listing");
    expect(thrown?.message).not.toContain("did not register the entry");
  });

  /** Fake `omp` whose listing is a fixed JSON payload. */
  function withFakeOmpListing(payload: string): void {
    writeFakeOmpScript(`printf '%s\\n' '${payload}'`);
  }

  /** Fake `omp` whose listing probe fails. */
  function withFakeOmpListingFail(): void {
    writeFakeOmpScript(`printf '%s\\n' "listing unavailable" >&2; exit 3`);
  }

  function writeFakeOmpScript(listBody: string): void {
    const binDir = tempDir("omp-fake-");
    const binPath = join(binDir, "omp");
    writeFileSync(
      binPath,
      [
        "#!/bin/sh",
        'if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then',
        `  ${listBody}`,
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(binPath, 0o755);
    process.env.PATH = `${binDir}:/usr/bin:/bin`;
  }
});

describe("omp init end-to-end (child process with its own home)", () => {
  interface ChildHome {
    home: string;
    binDir: string;
    argv: () => string[];
    run: (script: string) => { status: number | null; stdout: string; stderr: string };
  }

  function childHome(opts: { linkExit?: number; linkText?: string }): ChildHome {
    const home = tempDir("omp-child-home-");
    const binDir = tempDir("omp-child-bin-");
    const repo = join(home, ".mstar", "harness");
    mkdirSync(join(repo, ".omp-plugin"), { recursive: true });
    writeFileSync(join(repo, ".omp-plugin", "plugin.json"), "{}\n");
    mkdirSync(join(repo, "packages", "omp"), { recursive: true });
    writeFileSync(join(repo, "packages", "omp", "plugin.json"), "{}\n");
    for (const argv of [["init"], ["add", "."], ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-m", "init"]]) {
      execFileSync("git", argv, { cwd: repo, stdio: "pipe" });
    }
    const entry = join(home, ".omp", "plugins", "node_modules", PLUGIN_NAME);
    const logFile = join(binDir, "argv.log");
    const linked = join(repo, "packages", "omp");
    const linkText = opts.linkText ?? "Failed to link: Error: EPERM: operation not permitted, unlink '<entry>'";
    writeFileSync(
      join(binDir, "omp"),
      [
        "#!/bin/sh",
        `echo "$@" >> "${logFile}"`,
        'if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then',
        `  if [ -e "${entry}" ]; then`,
        // The version comes from the entry itself, as a real listing reports it.
        `    __v=$(/usr/bin/sed -n 's/.*"version":"\\([^"]*\\)".*/\\1/p' "${entry}/package.json" 2>/dev/null)`,
        `    printf '[{"name":"${PLUGIN_NAME}","path":"${entry}","manifest":{"name":"${PLUGIN_NAME}","version":"%s"}}]\\n' "$__v"`,
        "  else",
        `    printf '[]\\n'`,
        "  fi",
        "  exit 0",
        "fi",
        'if [ "$1" = "plugin" ] && [ "$2" = "link" ]; then',
        opts.linkExit
          ? `  printf '%s\\n' "${linkText}" >&2; exit ${opts.linkExit}`
          : `  /bin/mkdir -p "${join(home, ".omp", "plugins", "node_modules", "@mstar-harness")}"; /bin/ln -s "${linked}" "${entry}"; exit 0`,
        "fi",
        'if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then',
        `  /bin/mkdir -p "${entry}"; printf '{"name":"${PLUGIN_NAME}","version":"%s"}' "\${3##*@}" > "${entry}/package.json"; exit 0`,
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(join(binDir, "omp"), 0o755);
    return {
      home,
      binDir,
      argv: () => {
        if (!existsSync(logFile)) return [];
        const raw = readFileSync(logFile, "utf8").trim();
        return raw ? raw.split("\n") : [];
      },
      run: (script) => {
        const scriptPath = join(home, "run-init.ts");
        writeFileSync(scriptPath, script);
        try {
          const stdout = execFileSync(process.execPath, [scriptPath], {
            cwd: home,
            encoding: "utf8",
            stdio: "pipe",
            env: {
              ...process.env,
              HOME: home,
              PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
            },
          });
          return { status: 0, stdout, stderr: "" };
        } catch (error) {
          const failure = error as { status?: number | null; stdout?: string; stderr?: string };
          return { status: failure.status ?? null, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
        }
      },
    };
  }

  /** Change a prepared child home so the build path cannot produce plugin.json. */
  function stripHarnessPluginMarker(home: string): void {
    rmSync(join(home, ".mstar", "harness", "packages", "omp", "plugin.json"), { force: true });
  }

  test("a project-scoped run refuses the published fallback it cannot scope", () => {
    const fixture = childHome({});
    stripHarnessPluginMarker(fixture.home);
    const fakeBun = join(fixture.binDir, "bun");
    writeFileSync(fakeBun, "#!/bin/sh\nexit 1\n");
    chmodSync(fakeBun, 0o755);
    const result = fixture.run(
      `import { ompAdapter } from ${JSON.stringify(join(import.meta.dir, "..", "src", "adapters", "omp"))};
await ompAdapter.runInstallInit("project", false);
`,
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    // omp ignores --scope outside marketplace specs, so the fallback must name a
    // route that can express the requested scope.
    expect(result.stderr).toContain("--scope global");
    expect(fixture.argv().some((line) => line.startsWith("plugin install"))).toBe(false);
  });

  test("the published install pins the version the CLI chose, not the running one", () => {
    const fixture = childHome({});
    stripHarnessPluginMarker(fixture.home);
    const fakeBun = join(fixture.binDir, "bun");
    writeFileSync(fakeBun, "#!/bin/sh\nexit 1\n");
    chmodSync(fakeBun, 0o755);
    const chosen = "9.9.9-synthetic";
    const result = fixture.run(
      `import { ompAdapter } from ${JSON.stringify(join(import.meta.dir, "..", "src", "adapters", "omp"))};
const { notes } = await ompAdapter.runInstallInit("global", false, { pluginVersion: ${JSON.stringify(chosen)} });
console.log(JSON.stringify(notes));
`,
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fixture.argv()).toContain(`plugin install ${PLUGIN_NAME}@${chosen}`);
  });

  const RUN_INIT = `import { ompAdapter } from ${JSON.stringify(join(import.meta.dir, "..", "src", "adapters", "omp"))};
const { notes } = await ompAdapter.runInstallInit("global", false);
console.log(JSON.stringify(notes));
`;

  test("a refused link ends init non-zero and names the supported replacement", () => {
    const fixture = childHome({ linkExit: 1 });
    const result = fixture.run(RUN_INIT);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("EPERM");
    expect(result.stderr).toContain(`omp plugin uninstall ${PLUGIN_NAME}`);
    expect(result.stderr).toContain(`omp plugin install ${PLUGIN_NAME}`);
  });

  test("a successful link is verified against omp's own listing", () => {
    const fixture = childHome({});
    const result = fixture.run(RUN_INIT);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(fixture.argv().some((line) => line.startsWith("plugin link "))).toBe(true);
    expect(result.stdout).toContain("linked from");
  });
});

describe("omp init preview", () => {
  test.skipIf(!existsSync(join(HARNESS_REPO_PATH, ".git")))(
    "--dry-run previews the link and writes nothing",
    async () => {
      const { notes } = await ompAdapter.runInstallInit("global", true);
      expect(notes.some((note) => note.startsWith("Would run: omp plugin link "))).toBe(true);
    },
  );
});
