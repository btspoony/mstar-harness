import fs, { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { SddScriptError, checkSddAction, pickReviewBranchName, preflightChangeset, resolveProcessHarnessDir, resolveSddExecutionContext, readExecutionCleanupState, readMainWorktree, planWorktreeCleanup, type CleanupFacts, type CleanupTarget, type SddExecutionContext, type WorkflowSnapshot } from "@mstar-harness/engine";
import { z } from "zod";
import { commandEnvelopeSchema } from "../envelope.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";
import { refusalEnvelope } from "../envelope.js";

type Input = { context?: string; argv?: string[]; workflow?: string; harness?: string; apply?: boolean; remote?: boolean; allWorkflows?: boolean; worktree?: string[]; verbose?: boolean; pr?: string; branch?: string; diff?: boolean; workingTree?: boolean; commit?: string; targetPath?: string };
const execArgvSchema = z.array(z.string()).min(1);
const cleanupWorktreeSchema = z.array(z.string());
const execInput = z.object({ context: z.string(), argv: execArgvSchema }) as z.ZodType<Input>;
const cleanupInput = z.object({ workflow: z.string(), harness: z.string().optional(), apply: z.boolean().optional(), remote: z.boolean().optional(), worktree: cleanupWorktreeSchema.optional(), allWorkflows: z.boolean().optional(), verbose: z.boolean().optional() }) as z.ZodType<Input>;
const setupInput = z.object({ pr: z.string().optional(), branch: z.string().optional(), diff: z.boolean().optional(), workingTree: z.boolean().optional(), commit: z.string().optional(), targetPath: z.string().optional() }) as z.ZodType<Input>;

function ok(id: string, data: unknown): CommandEnvelope { return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data }; }
export function failure(id: string, error: unknown): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  const details = error !== null && typeof error === "object" && "details" in error
    && error.details !== null && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : undefined;
  if (error instanceof SddScriptError && error.exitCode === 2) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message, ...(details === undefined ? {} : { details }) });
  if (error instanceof SddScriptError) return { version: 1, command: id, status: "error", code: `${id}.refused`, exitCode: error.exitCode, message, ...(details === undefined ? {} : { details }) };
  if (error !== null && typeof error === "object" && "exitCode" in error && typeof error.exitCode === "number") {
    return { version: 1, command: id, status: "error", code: "command.child-failed", exitCode: error.exitCode, message, ...(details === undefined ? {} : { details }) };
  }
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.refused`;
  return refusalEnvelope({ command: id, status: "refused", code, exitCode: 1, message, ...(details === undefined ? {} : { details }) , recovery: id === "sdd.exec"
        ? "Verify the admitted executable, feature-worktree context, working directory, and child environment. Run mstar sdd exec <command> <args...>."
        : id === "worktree.cleanup" && code === "store.corrupt"
          // A malformed stored row is repaired from a recovery point, never by
          // editing the live store.
          ? "Repair the execution authority from a store recovery point: run mstar store execution restore-preview --harness <absolute-root> --backup <backup> --out <preview>, then apply that preview with --preview <preview> --operator <name> --authorization <ref> --out <receipt> using the verb in mstar schema --command store.execution.restore."
          : id === "worktree.cleanup"
            ? "Correct the reported ownership, merge-evidence, checkout, or worktree-state blocker before cleanup. Run mstar worktree cleanup --workflow <workflow-id>."
            : "Verify the base ref and source checkout are reachable and correct the worktree setup inputs. Run mstar pr-review worktree-setup --path <worktree-path> --branch <branch>."});
}

function definitions(): readonly CommandDefinition[] {
  const make = (id: string, input: z.ZodType<Input>, args: CommandDefinition["cli"]["arguments"], options: CommandDefinition["cli"]["options"], effects: CommandDefinition["effects"], description: string, execute: (input: Input, context: InvocationContext) => Promise<CommandEnvelope>): CommandDefinition<Input, unknown> => ({
    id,
    cli: { path: id === "pr-review.worktree-setup" ? ["pr-review", "worktree-setup"] : id.split(".").map((part) => part.replace("-", " ")).flatMap((part) => part.split(" ")), aliases: [], arguments: args, options },
    input,
    ...(id === "sdd.exec"
      ? { payloads: { argv: { schema: execArgvSchema } } }
      : id === "worktree.cleanup"
        ? { payloads: { worktree: { schema: cleanupWorktreeSchema } } }
        : {}),
    output: commandEnvelopeSchema,
    effects,
    description,
    execute,
  });
  return [
    make("sdd.exec", execInput, [{ key: "argv", required: true, variadic: true }], [{ key: "context", flags: "--context <path>", required: false }], ["read", "validate", "process"], "Run an admitted literal argv child in the SDD feature worktree.", async (input, invocation) => {
      try {
        if (!input.context || !path.isAbsolute(input.context)) throw new SddScriptError("usage: sdd exec --context <absolute.json> -- <executable> [args...]", 2);
        if (!input.argv?.length) throw new SddScriptError("argv after -- must include the child executable", 2);
        const decoded: unknown = JSON.parse(fs.readFileSync(input.context, "utf8"));
        if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new SddScriptError("context file must contain a JSON object", 2);
        const context = await resolveSddExecutionContext(decoded as SddExecutionContext);
        const gate = checkSddAction(context, { kind: "launch", cwd: invocation.cwd });
        if (!gate.ok) throw new SddScriptError(gate.violations.map(({ code, message }) => `${code}: ${message}`).join("; "), 1);
        if (invocation.signal.aborted) throw Object.assign(new Error("process admission cancelled"), { code: "command.cancelled" });
        const child = await invocation.effects.spawn({ argv: input.argv, cwd: context.featureCwd, env: { ...process.env } as Record<string, string>, signal: invocation.signal });
        if (child.exitCode === 0) return ok("sdd.exec", { stdout: child.stdout, stderr: child.stderr, signal: child.signal });
        return { version: 1, command: "sdd.exec", status: "error", code: "sdd.exec.child-exit", exitCode: child.exitCode ?? 1, message: child.signal ? `child terminated by ${child.signal}` : `child exited with status ${child.exitCode}`, details: { stdout: child.stdout, stderr: child.stderr, signal: child.signal } };
      } catch (error) { return failure("sdd.exec", error); }
    }),
    make("worktree.cleanup", cleanupInput, [], [{ key: "workflow", flags: "--workflow <id>", required: false }, { key: "harness", flags: "--harness <path>", required: false }, { key: "apply", flags: "--apply", required: false }, { key: "remote", flags: "--remote", required: false }, { key: "worktree", flags: "--worktree <path...>", required: false, variadic: true }, { key: "allWorkflows", flags: "--all-workflows", required: false }, { key: "verbose", flags: "--verbose", required: false }], ["read", "write", "process"], "Plan and optionally execute guarded worktree/branch cleanup. Dry-run by default; apply uses ownership, merge-evidence, active-lease, checked-out, foreign, dirty, locked, and non-terminal protections.", async (input, invocation) => {
      try {
        if (!input.workflow) throw new SddScriptError("usage: worktree cleanup --workflow <id>", 2);
        return await cleanupWorktrees(input, invocation);
      } catch (error) {
        return failure("worktree.cleanup", error);
      }
    }),
    make("pr-review.worktree-setup", setupInput, [], [{ key: "pr", flags: "--pr <n>", required: false }, { key: "branch", flags: "--branch <name>", required: false }, { key: "diff", flags: "--diff", required: false }, { key: "workingTree", flags: "--working-tree", required: false }, { key: "commit", flags: "--commit <sha>", required: false }, { key: "targetPath", flags: "--path <dir>", required: false }], ["read", "write", "process"], "Create an isolated review worktree: resolve the base, fetch explicit refs, run one admitted input mode, compute its diff basis inside the worktree, and write an identity-bound sidecar and diff snapshot.", async (input, invocation) => {
      try {
        return await setupReviewWorktree(input, invocation);
      } catch (error) {
        return failure("pr-review.worktree-setup", error);
      }
    }),
  ];
}

export function getProcessCommandDefinitions(): readonly CommandDefinition[] { return definitions(); }
type ProcessReply = { exitCode: number | null; signal: string | null; stdout: string; stderr: string };
async function processReply(invocation: InvocationContext, argv: readonly string[], cwd: string): Promise<ProcessReply> {
  if (invocation.signal.aborted) throw Object.assign(new Error("process admission cancelled"), { code: "command.cancelled" });
  return invocation.effects.spawn({ argv, cwd, env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), signal: invocation.signal });
}
async function git(invocation: InvocationContext, args: readonly string[], cwd: string): Promise<string> {
  const result = await processReply(invocation, ["git", ...args], cwd);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} exited ${result.exitCode}`);
  return result.stdout.trim();
}
async function gitProbe(invocation: InvocationContext, args: readonly string[], cwd: string): Promise<string> {
  const result = await processReply(invocation, ["git", ...args], cwd);
  return result.exitCode === 0 ? result.stdout.trim() : "";
}
async function setupReviewWorktree(input: Input, invocation: InvocationContext): Promise<CommandEnvelope> {
  const modes = [input.pr !== undefined, input.branch !== undefined, input.diff === true, input.workingTree === true, input.commit !== undefined].filter(Boolean).length;
  if (modes !== 1) throw new SddScriptError("usage: pr-review worktree-setup requires exactly one of --pr, --branch, --diff, --working-tree, or --commit", 2);
  const repoRoot = await git(invocation, ["rev-parse", "--show-toplevel"], invocation.cwd);
  const mode = input.pr !== undefined ? "pr" : input.branch !== undefined ? "branch" : input.diff ? "diff" : input.workingTree ? "working-tree" : "commit";
  if (mode === "pr" && !/^\d+$/.test(input.pr!)) throw new SddScriptError(`usage: --pr requires a positive integer PR number, got ${JSON.stringify(input.pr)}`, 2);
  if (mode === "diff" || mode === "working-tree") {
    if (mode === "working-tree") {
      const status = await git(invocation, ["status", "--porcelain"], repoRoot);
      const gate = preflightChangeset(mode, { refsResolve: true, changesetEmpty: status === "" });
      if (!gate.ok) return { version: 1, command: "pr-review.worktree-setup", status: "error", code: gate.violations[0]?.code ?? "prreview.preflight.changeset-empty", exitCode: 1, message: gate.violations.map(({ message }) => message).join("; ") };
    }
    return ok("pr-review.worktree-setup", { reviewBranch: null, worktreePath: repoRoot, base: null, mergeBase: null, diffCmd: mode === "diff" ? "(provided changeset)" : "git diff + git diff --cached + ls-files --others", diffFile: null });
  }
  let baseRef = "";
  let headSpec = input.commit ?? input.branch ?? "";
  let prNumber = 0;
  if (mode === "pr") {
    prNumber = Number(input.pr);
    const gh = await processReply(invocation, ["gh", "pr", "view", String(prNumber), "--json", "baseRefName", "--jq", ".baseRefName"], repoRoot);
    if (gh.exitCode !== 0) throw new Error(gh.stderr.trim() || `gh pr view exited ${gh.exitCode}`);
    baseRef = gh.stdout.trim();
    if (baseRef === "") throw new Error(`gh pr view returned an empty base ref for PR ${prNumber}`);
    headSpec = `pull/${prNumber}/head`;
  } else if (mode === "branch") {
    baseRef = (await gitProbe(invocation, ["symbolic-ref", "refs/remotes/origin/HEAD"], repoRoot)).replace("refs/remotes/origin/", "");
    if (!baseRef) {
      const remoteHeads = await gitProbe(invocation, ["ls-remote", "--symref", "origin", "HEAD"], repoRoot);
      baseRef = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(remoteHeads)?.[1] ?? "";
    }
    if (!baseRef && await gitProbe(invocation, ["rev-parse", "--verify", "--quiet", "origin/main"], repoRoot)) baseRef = "main";
    if (!baseRef) throw new SddScriptError("prreview.preflight.refs-unresolved: cannot resolve origin default branch", 1);
  } else {
    if (!await gitProbe(invocation, ["rev-parse", "--verify", "--quiet", `${headSpec}^{commit}`], repoRoot)) throw new SddScriptError("prreview.preflight.refs-unresolved: commit does not resolve", 1);
    const defaultBranch = (await gitProbe(invocation, ["symbolic-ref", "refs/remotes/origin/HEAD"], repoRoot)).replace("refs/remotes/origin/", "");
    baseRef = defaultBranch && await gitProbe(invocation, ["rev-parse", "--verify", "--quiet", `origin/${defaultBranch}`], repoRoot) ? `origin/${defaultBranch}` : `${headSpec}^`;
  }
  const existing = new Set((await git(invocation, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], repoRoot)).split(/\r?\n/).filter(Boolean));
  const seed = mode === "pr" ? prNumber : Math.abs([...headSpec].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 1_000_003, 7)) || 1;
  const reviewBranch = pickReviewBranchName(existing, seed, new Date().toISOString().slice(0, 10).replace(/-/g, ""));
  const repoReal = realpathSync(repoRoot);
  const defaultRoot = path.join(path.dirname(repoReal), `${path.basename(repoReal)}.worktrees`);
  const worktreePath = path.resolve(input.targetPath ?? path.join(defaultRoot, `review-${reviewBranch}${mode === "pr" ? "" : `-${headSpec.slice(0, 8)}`}`));
  if (input.targetPath === undefined) fs.mkdirSync(defaultRoot, { recursive: true });
  const origin = await gitProbe(invocation, ["remote", "get-url", "origin"], repoRoot);
  let fetched = true;
  if (origin) {
    try {
      const base = baseRef.replace(/^origin\//, "");
      await git(invocation, ["fetch", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], repoRoot);
      if (mode === "pr") await git(invocation, ["fetch", "origin", `+${headSpec}:${reviewBranch}`], repoRoot);
      else if (mode === "branch") await git(invocation, ["fetch", "origin", `+refs/heads/${headSpec}:refs/remotes/origin/${headSpec}`], repoRoot);
    } catch { fetched = false; }
  }
  const recordedBase = mode === "commit" ? baseRef : `origin/${baseRef.replace(/^origin\//, "")}`;
  const headRef = mode === "pr" ? reviewBranch : mode === "branch" ? `origin/${headSpec}` : headSpec;
  const baseResolved = mode === "commit" && baseRef === `${headSpec}^` || Boolean(await gitProbe(invocation, ["rev-parse", "--verify", "--quiet", `${recordedBase}^{commit}`], repoRoot));
  const resolved = Boolean(await gitProbe(invocation, ["rev-parse", "--verify", "--quiet", `${headRef}^{commit}`], repoRoot)) && baseResolved && (mode !== "branch" || origin !== "");
  const diffCheck = await processReply(invocation, ["git", "diff", "--quiet", mode === "commit" ? `${headSpec}^...${headSpec}` : `${recordedBase}...${headRef}`], repoRoot);
  const changesetEmpty = diffCheck.exitCode === 0;
  const admission = preflightChangeset(mode, { refsResolve: resolved && fetched, changesetEmpty });
  if (!admission.ok) return { version: 1, command: "pr-review.worktree-setup", status: "error", code: admission.violations[0]?.code ?? "prreview.preflight.refs-unresolved", exitCode: 1, message: admission.violations.map(({ message }) => message).join("; ") };
  let createdWorktree = false;
  try {
  if (mode === "pr") await git(invocation, ["worktree", "add", worktreePath, reviewBranch], repoRoot);
  else if (mode === "branch") await git(invocation, ["worktree", "add", "--detach", worktreePath, headRef], repoRoot);
  else await git(invocation, ["worktree", "add", "--detach", worktreePath, headSpec], repoRoot);
  createdWorktree = true;
  const mergeBase = await gitProbe(invocation, ["merge-base", recordedBase, headRef], worktreePath);
  const range = `${recordedBase}...${headRef}`;
  const diffCmd = mode === "commit" ? `git show ${headSpec}` : `git diff ${range}`;
  const parts = mode === "commit"
    ? [`# Review package: ${recordedBase} (single commit)\n\n## Commits\n`, await git(invocation, ["log", "--oneline", "-1", headSpec], worktreePath), "\n\n## Files changed\n", await git(invocation, ["show", "--stat", headSpec], worktreePath), "\n\n## Diff\n", await git(invocation, ["show", "-U10", headSpec], worktreePath)]
    : [`# Review package: ${recordedBase}..${headRef}\n\n## Commits\n`, await git(invocation, ["log", "--oneline", `${recordedBase}..${headRef}`], worktreePath), "\n\n## Files changed\n", await git(invocation, ["diff", "--stat", range], worktreePath), "\n\n## Diff\n", await git(invocation, ["diff", "-U10", range], worktreePath)];
  const diffText = parts.join("");
  const diffFile = path.join(path.dirname(worktreePath), `.${path.basename(worktreePath)}.prreview.diff`);
  const sidecarFile = path.join(path.dirname(worktreePath), `.${path.basename(worktreePath)}.prreview.json`);
  let diffFd: number | undefined;
  let sidecarFd: number | undefined;
  let snapshotStat: { dev: number; ino: number } | undefined;
  try {
    sidecarFd = fs.openSync(sidecarFile, "wx+");
    const sidecar = { reviewBranch: mode === "pr" ? reviewBranch : "", worktreePath, base: recordedBase, mergeBase, diffCmd, reportSaved: false, createdAt: new Date().toISOString(), repoRoot, diffFile, diffFileSha256: createHash("sha256").update(diffText).digest("hex") };
    fs.writeSync(sidecarFd, JSON.stringify(sidecar, null, 2));
    diffFd = fs.openSync(diffFile, "wx");
    fs.writeFileSync(diffFd, diffText);
    const stat = fs.fstatSync(diffFd);
    snapshotStat = { dev: stat.dev, ino: stat.ino };
    fs.ftruncateSync(sidecarFd, 0);
    fs.writeSync(sidecarFd, JSON.stringify({ ...sidecar, diffFileDev: stat.dev, diffFileIno: String(stat.ino), diffFileMtimeMs: stat.mtimeMs }, null, 2), 0);
    fs.closeSync(diffFd);
    diffFd = undefined;
    fs.closeSync(sidecarFd);
    sidecarFd = undefined;
    return ok("pr-review.worktree-setup", { reviewBranch: mode === "pr" ? reviewBranch : null, worktreePath, base: recordedBase, mergeBase: mergeBase || null, diffCmd, diffFile });
  } catch (error) {
    if (diffFd !== undefined) {
      const openStat = fs.fstatSync(diffFd);
      fs.closeSync(diffFd);
      try { const pathStat = fs.lstatSync(diffFile); if (pathStat.dev === openStat.dev && pathStat.ino === openStat.ino) fs.unlinkSync(diffFile); } catch {}
    } else if (snapshotStat !== undefined) {
      try { const pathStat = fs.lstatSync(diffFile); if (pathStat.dev === snapshotStat.dev && pathStat.ino === snapshotStat.ino) fs.unlinkSync(diffFile); } catch {}
    }
    if (sidecarFd !== undefined) {
      const openStat = fs.fstatSync(sidecarFd);
      fs.closeSync(sidecarFd);
      try { const pathStat = fs.lstatSync(sidecarFile); if (pathStat.dev === openStat.dev && pathStat.ino === openStat.ino) fs.unlinkSync(sidecarFile); } catch {}
    }
    if (createdWorktree) {
      await gitProbe(invocation, ["worktree", "remove", "--force", worktreePath], repoRoot);
      await gitProbe(invocation, ["worktree", "prune"], repoRoot);
      if (mode === "pr" && !existing.has(reviewBranch)) await gitProbe(invocation, ["branch", "-D", reviewBranch], repoRoot);
      createdWorktree = false;
    }
    throw error;
  }
  } catch (error) {
    if (createdWorktree) {
      await gitProbe(invocation, ["worktree", "remove", "--force", worktreePath], repoRoot);
      await gitProbe(invocation, ["worktree", "prune"], repoRoot);
      if (mode === "pr" && !existing.has(reviewBranch)) await gitProbe(invocation, ["branch", "-D", reviewBranch], repoRoot);
    }
    throw error;
  }
}
/** Engine-defined layer-ref namespace (`iteration-stack/<workflow-id>/sNN`) — see skills/mstar-iteration/references/pr-stack.md. */
const LAYER_REF = /^iteration-stack\/([^/]+)\/s\d+(?:\/|$)/;
/**
 * The short branch name a recorded anchor names: cleanup compares recorded
 * anchors against Git's own short names (`worktree list` / `for-each-ref
 * refs/heads`), so a qualified `refs/heads/<name>` / `refs/remotes/origin/<name>`
 * record must normalize exactly once — merge evidence still resolves the raw
 * anchor itself. See skills/mstar-branch-worktree/references/worktree-cleanup.md.
 */
function shortBranchName(branch: string): string {
  return branch.replace(/^refs\/(heads|remotes\/origin)\//, "");
}
type CleanupClaim = { workflowId: string; planId?: string };
function cleanupClaims(snapshot: WorkflowSnapshot, field: "branch" | "path", value: string): CleanupClaim[] {
  const claims: CleanupClaim[] = [];
  const pathKey = (candidate: string) => {
    try { return fs.realpathSync(candidate); } catch { return path.resolve(candidate); }
  };
  if (field === "branch" && snapshot.branch?.integration === value) claims.push({ workflowId: snapshot.id });
  // see skills/mstar-iteration/references/pr-stack.md — a layer ref names its
  // owning workflow; no planId, so merged evidence reads branch.target.
  if (field === "branch" && LAYER_REF.exec(value)?.[1] === snapshot.id) claims.push({ workflowId: snapshot.id });
  if (field === "path" && [snapshot.integration_worktree_path, (snapshot as WorkflowSnapshot & { control_worktree_path?: string }).control_worktree_path].some((candidate) => typeof candidate === "string" && pathKey(candidate) === pathKey(value))) claims.push({ workflowId: snapshot.id });
  for (const row of snapshot.plans as unknown as Record<string, unknown>[]) {
    const meta = row.metadata as Record<string, unknown> | undefined;
    const matches = field === "branch"
      ? meta?.working_branch === value || (Array.isArray(meta?.track_branches) && meta.track_branches.includes(value))
      : (typeof meta?.worktree_path === "string" && pathKey(meta.worktree_path) === pathKey(value)) ||
        (Array.isArray(meta?.cleanup_protective_worktree_paths) && meta.cleanup_protective_worktree_paths.some((candidate) => typeof candidate === "string" && pathKey(candidate) === pathKey(value)));
    if (matches) {
      const planId = typeof row.id === "string" ? row.id : typeof row.plan_id === "string" ? row.plan_id : undefined;
      claims.push({ workflowId: snapshot.id, ...(planId ? { planId } : {}) });
    }
  }
  return claims;
}

function cleanupOwner(claims: CleanupClaim[], snapshots: readonly WorkflowSnapshot[]): CleanupClaim | null {
  const owners = new Map(claims.map((claim) => [JSON.stringify(claim), claim]));
  if (owners.size === 1) return [...owners.values()][0]!;
  if (owners.size < 2) return null;
  const eligible = [...owners.values()].filter((owner) => {
    const status = snapshots.find((snapshot) => snapshot.id === owner.workflowId)?.status;
    return status !== "stopped" && status !== "failed";
  });
  return eligible.length === 1 ? eligible[0]! : null;
}

/**
 * The repository `gh pr list --repo` must probe, in the `host/owner/repo` form
 * it accepts for a non-default host: keeping the origin host is what stops a
 * GitHub Enterprise origin from silently probing github.com (see
 * skills/mstar-branch-worktree/references/worktree-cleanup.md). URL and
 * scp-like remotes parse; a non-GitHub origin (local path, no host) returns
 * undefined so the probe fails closed instead of aiming at the wrong host.
 */
function githubRepoOf(origin: string): string | undefined {
  const normalized = origin.replace(/\.git$/, "").replace(/\/+$/, "");
  const parsed = (() => { try { return new URL(normalized); } catch { return undefined; } })();
  // see skills/mstar-branch-worktree/references/worktree-cleanup.md — the
  // scp-like `[user@]host:path` form (git-clone(1): the user is optional —
  // SSH config may supply it); a local relative path never contains `:`
  // before its first `/`, so this form is unambiguous.
  const scp = parsed?.hostname ? null : /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(normalized);
  const host = scp ? scp[1] : parsed?.hostname;
  const tail = scp ? scp[2]! : parsed?.pathname.replace(/^\/+/, "");
  if (!host || !tail || !/^[^/]+\/[^/]+$/.test(tail)) return undefined;
  return `${host}/${tail}`;
}

async function cleanupWorktrees(input: Input, invocation: InvocationContext, retainedOwnerKeys?: ReadonlySet<string>, retainedPullRequestBases?: readonly string[]): Promise<CommandEnvelope> {
  if (!input.workflow) throw new SddScriptError("usage: worktree cleanup --workflow <id>", 2);
  if (input.workflow === "." || input.workflow === ".." || input.workflow.includes("/") || input.workflow.includes("\\")) throw new SddScriptError(`invalid workflow id ${JSON.stringify(input.workflow)}`, 1);
  const main = readMainWorktree(invocation.cwd);
  if (!main) throw new Error("cannot resolve the main worktree of the current repository — run inside the repo");
  const harness = resolveProcessHarnessDir(invocation.cwd, input.harness);
  if (!harness) throw new Error("harness directory not found");
  // Source selection: the ACTIVE execution authority answers with ONE
  // authoritative read (`readExecutionCleanupState`) that addresses the workflow
  // independently of registry membership and carries the complete protective
  // inventory of every retained sibling. The pre-activation file route is
  // retired (issue #428), so a control root without an ACTIVE authority refuses
  // out of that read instead of degrading to retired/absent JSON snapshots.
  const { selected, workflows: snapshots } = await readExecutionCleanupState({ harnessDir: harness }, input.workflow);
  const records: Array<CleanupFacts["worktrees"][number] & { tip: string }> = [];
  let current: { path: string; branch: string | null; tip: string; locked: boolean } | undefined;
  for (const line of (await git(invocation, ["worktree", "list", "--porcelain"], main.root)).split(/\r?\n/)) {
    if (!line) { if (current) records.push({ ...current, isMain: records.length === 0, clean: (await git(invocation, ["status", "--porcelain"], current.path)) === "" }); current = undefined; }
    else if (line.startsWith("worktree ")) current = { path: line.slice(9), branch: null, tip: "", locked: false };
    else if (current && line.startsWith("HEAD ")) current.tip = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (current && line.startsWith("locked")) current.locked = true;
  }
  if (current) records.push({ ...current, isMain: records.length === 0, clean: (await git(invocation, ["status", "--porcelain"], current.path)) === "" });
  const claimsFor = (field: "branch" | "path", value: string) => snapshots.flatMap((snapshot) => cleanupClaims(snapshot, field, value));
  const targets: CleanupTarget[] = [];
  const pathKey = (value: string) => {
    try { return fs.realpathSync(value); } catch { return path.resolve(value); }
  };
  const assertedPaths = new Set((input.worktree ?? []).map(pathKey));
  const ownerKey = (owner: { workflowId: string; planId?: string | null }) => JSON.stringify(owner);
  const assertedOwnerKeys = retainedOwnerKeys ?? new Set(records
    .filter((wt) => assertedPaths.has(pathKey(wt.path)))
    .flatMap((wt) => {
      const owner = cleanupOwner([...claimsFor("path", wt.path), ...(wt.branch ? claimsFor("branch", wt.branch) : [])], snapshots);
      return owner && (input.allWorkflows || owner.workflowId === input.workflow) ? [ownerKey(owner)] : [];
    }));
  for (const wt of records) {
    if (assertedPaths.size && !assertedPaths.has(pathKey(wt.path))) continue;
    const explicitlyAsserted = assertedPaths.has(pathKey(wt.path));
    const pathClaims = claimsFor("path", wt.path);
    const branchClaims = wt.branch ? claimsFor("branch", wt.branch) : [];
    const inScope = input.allWorkflows || [...pathClaims, ...branchClaims].some((claim) => claim.workflowId === input.workflow);
    const ownershipClaims = explicitlyAsserted ? [...pathClaims, ...branchClaims] : pathClaims;
    if (inScope) targets.push({ kind: "worktree", ref: wt.path, branch: wt.branch ?? "", tip: wt.tip, owner: cleanupOwner(ownershipClaims, snapshots) });
  }
  const local = (await git(invocation, ["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads"], main.root)).split(/\r?\n/).filter(Boolean);
  for (const line of local) {
    const [branch, tip] = line.split("\t");
    const claims = claimsFor("branch", branch!);
    const scoped = input.allWorkflows || claims.some((claim) => claim.workflowId === input.workflow);
    const retainedByAssertion = claims.some((claim) =>
      (input.allWorkflows || claim.workflowId === input.workflow) &&
      (assertedOwnerKeys.has(ownerKey(claim)) ||
        targets.some((target) => target.kind === "worktree" && target.owner && ownerKey(target.owner) === ownerKey(claim))));
    if (scoped && (!assertedPaths.size || retainedByAssertion)) {
      targets.push({ kind: "local-branch", ref: branch!, branch: branch!, tip: tip ?? "", owner: cleanupOwner(claims, snapshots) });
    }
  }
  const remoteEvidence: CleanupFacts["remoteEvidence"][number][] = [];
  const remoteCandidates: { branch: string; tip: string; base: string | undefined }[] = [];
  const bases = new Set(snapshots.flatMap((snapshot) => [
    snapshot.branch?.base,
    snapshot.branch?.integration,
    snapshot.branch?.target,
  ].filter((base): base is string => typeof base === "string" && base !== "")));
  const baseOids = new Map<string, string>();
  for (const base of bases) baseOids.set(base, await gitProbe(invocation, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], main.root));
  if (input.remote) {
    const remoteRows = (await git(invocation, ["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/remotes/origin"], main.root)).split(/\r?\n/).filter((line) => line && !line.startsWith("origin/HEAD"));
    for (const line of remoteRows) {
      const [fullName, tip] = line.split("\t");
      const branch = fullName!.replace(/^origin\//, "");
      const claims = claimsFor("branch", branch);
      if (!(input.allWorkflows || claims.some((claim) => claim.workflowId === input.workflow))) continue;
      const owner = cleanupOwner(claims, snapshots);
      const ownerSnapshot = snapshots.find((snapshot) => snapshot.id === owner?.workflowId);
      const base = owner?.planId && ownerSnapshot?.type === "iteration" ? ownerSnapshot.branch?.integration : ownerSnapshot?.branch?.target;
      targets.push({ kind: "remote-branch", ref: fullName!, branch, tip: tip ?? "", owner });
      remoteCandidates.push({ branch, tip: tip ?? "", base });
    }
  }
  const mergedLocalBranches: Record<string, string[]> = {};
  const localMergedByOid = new Map<string, string[]>();
  const remoteMembership = new Map<string, { positive: Map<string, string>; negative: Map<string, string> }>();
  for (const [base, oid] of baseOids) {
    if (!oid) continue;
    let localMerged = localMergedByOid.get(oid);
    if (!localMerged) {
      localMerged = (await gitProbe(invocation, ["branch", "--merged", oid, "--format=%(refname:short)"], main.root)).split(/\r?\n/).filter(Boolean);
      localMergedByOid.set(oid, localMerged);
    }
    mergedLocalBranches[base] = localMerged;
  }
  if (input.remote) {
    const remoteOids = new Set(remoteCandidates.flatMap(({ base }) => {
      const oid = base === undefined ? "" : baseOids.get(base) ?? "";
      return oid ? [oid] : [];
    }));
    for (const oid of remoteOids) {
      const [positive, negative] = await Promise.all([
        processReply(invocation, ["git", "for-each-ref", "--merged", oid, "--format=%(refname:short)%09%(objectname)", "refs/remotes/origin"], main.root),
        processReply(invocation, ["git", "for-each-ref", "--no-merged", oid, "--format=%(refname:short)%09%(objectname)", "refs/remotes/origin"], main.root),
      ]);
      const membership = (reply: ProcessReply) => new Map(reply.exitCode === 0
        ? reply.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
          const [ref, tip] = line.split("\t");
          return [ref!.replace(/^origin\//, ""), tip ?? ""] as const;
        })
        : []);
      remoteMembership.set(oid, { positive: membership(positive), negative: membership(negative) });
    }
    for (const candidate of remoteCandidates) {
      const oid = candidate.base === undefined ? "" : baseOids.get(candidate.base) ?? "";
      if (!oid) continue;
      const membership = remoteMembership.get(oid);
      const positiveTip = membership?.positive.get(candidate.branch);
      const negativeTip = membership?.negative.get(candidate.branch);
      if (positiveTip === candidate.tip) remoteEvidence.push({ ...candidate, base: candidate.base!, ancestor: true, prMerged: null });
      else if (negativeTip === candidate.tip) remoteEvidence.push({ ...candidate, base: candidate.base!, ancestor: false, prMerged: null });
  }
  }
  const defaultBranch = (await gitProbe(invocation, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], main.root)).replace(/^origin\//, "") || records[0]?.branch;
  if (!defaultBranch) throw new Error("cannot determine the default branch");
  // see skills/mstar-branch-worktree/references/worktree-cleanup.md — an apply
  // invocation re-plans after each deletion wave. While a layer-ref candidate
  // remains, EVERY pass re-probes the provider: a PR that gained this run's
  // base after an earlier pass must still refuse the destructive branch pass,
  // so a previously verified list is only the fallback once no layer ref is
  // left to probe for. A probe that cannot START (gh not installed, a vanished
  // cwd) fails closed exactly like one that fails or cannot parse — `null`,
  // refusing only the probed layer refs — instead of aborting unrelated
  // candidates; a cancellation is never swallowed.
  let openPullRequestBases: CleanupFacts["openPullRequestBases"] = retainedPullRequestBases ?? [];
  const layerBranches = targets.filter((target) => target.kind !== "worktree" && LAYER_REF.test(target.branch)).map((target) => target.branch);
  if (layerBranches.length > 0) {
    const origin = (await gitProbe(invocation, ["remote", "get-url", "origin"], main.root)).replace(/\.git$/, "").replace(/\/+$/, "");
    const slug = githubRepoOf(origin);
    if (slug === undefined) {
      openPullRequestBases = null;
    } else {
      let reply: ProcessReply | undefined;
      try {
        reply = await processReply(invocation, ["gh", "pr", "list", "--repo", slug, "--state", "open", "--json", "baseRefName", "--limit", "1000"], main.root);
      } catch (error) {
        // see skills/mstar-branch-worktree/references/worktree-cleanup.md —
        // a cancelled probe stays an abort: the failure path never converts
        // a user cancellation into a cleanup decision (processReply checks
        // the signal the same way).
        const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
        if (invocation.signal.aborted || code === "command.cancelled") throw error;
      }
      let verified = false;
      const bases: string[] = [];
      if (reply !== undefined && reply.exitCode === 0) {
        verified = true;
        try {
          const rows = JSON.parse(reply.stdout) as unknown;
          if (!Array.isArray(rows) || rows.length >= 1000) {
            verified = false;
          } else {
            for (const row of rows) {
              if (typeof row !== "object" || row === null || !("baseRefName" in row) || typeof row.baseRefName !== "string") { verified = false; break; }
              bases.push(row.baseRefName);
            }
          }
        } catch {
          verified = false;
        }
      }
      openPullRequestBases = verified ? bases : null;
    }
  }
  const facts: CleanupFacts = { targets, worktrees: records, snapshots, defaultBranch, mergedLocalBranches, remoteEvidence, openPullRequestBases, openPullRequestProbeRefs: layerBranches };
  const plan = planWorktreeCleanup(selected, facts);
  if (!input.apply) return ok("worktree.cleanup", { workflow: input.workflow, dryRun: true, decisions: plan });
  const evidenceBaseBranches = new Set(snapshots.flatMap((snapshot) => [snapshot.branch?.integration, snapshot.branch?.target]).filter((value): value is string => Boolean(value)).map(shortBranchName));
  const deferred = new Set(plan.filter((row) => row.kind === "worktree" && row.verdict === "remove" && records.some((wt) => wt.path === row.ref && wt.branch !== null && evidenceBaseBranches.has(wt.branch))).map(({ ref }) => ref));
  for (const row of plan) if (row.kind === "worktree" && row.verdict === "remove" && !deferred.has(row.ref) && !records.find((wt) => wt.path === row.ref)?.isMain) {
    await git(invocation, ["worktree", "remove", row.ref], main.root);
  }
  // see skills/mstar-branch-worktree/references/worktree-cleanup.md — `git
  // branch -d` judges merge evidence against the checkout it runs in, so a
  // branch merged only into a recorded target checkout must be deleted from
  // THAT checkout: the anchor's short branch name finds the worktree still
  // checked out on it (the raw qualified anchor never matches Git's short
  // names). Merge evidence itself stays on the raw anchor.
  const deleteBranchRow = async (row: { ref: string }): Promise<void> => {
    const target = targets.find((candidate) => candidate.kind === "local-branch" && candidate.ref === row.ref);
    const ownerSnapshot = snapshots.find((snapshot) => snapshot.id === target?.owner?.workflowId);
    const base = target?.owner?.planId && ownerSnapshot?.type === "iteration" ? ownerSnapshot.branch?.integration : ownerSnapshot?.branch?.target;
    const deletionCwd = base === undefined ? main.root : records.find((wt) => wt.branch === shortBranchName(base) && fs.existsSync(wt.path))?.path ?? main.root;
    await git(invocation, ["branch", "-d", row.ref], deletionCwd);
  };
  const refreshed = await cleanupWorktrees({ ...input, apply: false }, { ...invocation, cwd: main.root }, assertedOwnerKeys, openPullRequestBases ?? undefined);
  if (refreshed.status !== "ok") return refreshed;
  const secondPlan = (refreshed.data as { decisions: ReturnType<typeof planWorktreeCleanup> }).decisions;
  for (const row of secondPlan) if (row.kind === "local-branch" && row.verdict === "remove") await deleteBranchRow(row);
  for (const row of secondPlan) if (row.kind === "worktree" && row.verdict === "remove" && deferred.has(row.ref)) {
    await git(invocation, ["worktree", "remove", row.ref], main.root);
  }
  for (const row of secondPlan) if (row.kind === "remote-branch" && row.verdict === "remove") {
    const target = targets.find((candidate) => candidate.kind === "remote-branch" && candidate.ref === row.ref);
    if (target) await git(invocation, ["push", `--force-with-lease=refs/heads/${target.branch}:${target.tip}`, "origin", `:refs/heads/${target.branch}`], main.root);
  }
  const finalRefresh = await cleanupWorktrees({ ...input, apply: false }, { ...invocation, cwd: main.root }, assertedOwnerKeys, openPullRequestBases ?? undefined);
  if (finalRefresh.status !== "ok") return finalRefresh;
  const finalPlan = (finalRefresh.data as { decisions: ReturnType<typeof planWorktreeCleanup> }).decisions;
  for (const row of finalPlan) if (row.kind === "local-branch" && row.verdict === "remove") await deleteBranchRow(row);
  return ok("worktree.cleanup", { workflow: input.workflow, dryRun: false, decisions: [...plan, ...secondPlan, ...finalPlan] });
}
