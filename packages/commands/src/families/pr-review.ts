import { existsSync, readFileSync, renameSync, unlinkSync, openSync, fstatSync, lstatSync, closeSync, linkSync } from "node:fs";
import path from "node:path";
import {
  computePrTally, planReviewPost, prReviewReportPath, prReviewSeatPrompt, prReviewSizing,
  resolvePrReviewTier, PR_REVIEW_TIER_BUDGETS, validatePrReviewReport,
  type MergeClass, type PrReportTarget, type ReviewPostPlan,
} from "@mstar-harness/engine";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { commandEnvelopeSchema } from "../definitions.js";
import { refusalEnvelope } from "../envelope.js";
import type { CommandDefinition, CommandEnvelope, InvocationContext } from "../types.js";

const verbs = ["tally", "report-path", "validate-report", "post", "worktree-cleanup", "size", "seat-prompt", "budget"] as const;
type Verb = (typeof verbs)[number];
type Input = {
  findings?: string; unverified?: string; unmetAcUnsafe?: string; unmetAcSafe?: string;
  reportsDir?: string; target?: string; stage?: string; slug?: string; date?: string; reportFile?: string;
  pr?: string; bodyFile?: string; body?: string; worktreePath?: string; branch?: string; reportSaved?: boolean;
  base?: string; head?: string; largestFileTotal?: string;
  domain?: string; seat?: string; worktree?: string; security?: boolean; skillRoot?: string; recon?: string[]; tier?: string; diffFile?: string; collectFolded?: boolean;
};
const inputSchema = z.object({
  findings: z.string().optional(), unverified: z.string().optional(), unmetAcUnsafe: z.string().optional(), unmetAcSafe: z.string().optional(),
  reportsDir: z.string().optional(), target: z.string().optional(), stage: z.string().optional(), slug: z.string().optional(), date: z.string().optional(), reportFile: z.string().optional(),
  pr: z.string().optional(), bodyFile: z.string().optional(), body: z.string().optional(), worktreePath: z.string().optional(), branch: z.string().optional(), reportSaved: z.boolean().optional(),
  base: z.string().optional(), head: z.string().optional(), largestFileTotal: z.string().optional(), domain: z.string().optional(), seat: z.string().optional(), worktree: z.string().optional(),
  security: z.boolean().optional(), skillRoot: z.string().optional(), recon: z.array(z.string()).optional(), tier: z.string().optional(), diffFile: z.string().optional(), collectFolded: z.boolean().optional(),
});
const contracts: Record<Verb, { args: { key: string; required: boolean; variadic: boolean }[]; options: { key: string; flags: string; required: boolean }[]; effects: readonly CommandDefinition["effects"][number][]; description: string }> = {
  tally: { args: [], options: [{ key: "findings", flags: "--findings <file.json>", required: true }, { key: "unverified", flags: "--unverified <n>", required: false }, { key: "unmetAcUnsafe", flags: "--unmet-ac-unsafe <n>", required: false }, { key: "unmetAcSafe", flags: "--unmet-ac-safe <n>", required: false }], effects: ["read", "validate"], description: "Compute PR-review tally and verdict from accepted findings." },
  "report-path": { args: [], options: [{ key: "reportsDir", flags: "--reports-dir <dir>", required: true }, { key: "target", flags: "--target <spec>", required: true }, { key: "stage", flags: "--stage <1|2>", required: false }, { key: "slug", flags: "--slug <domain-seat>", required: false }, { key: "date", flags: "--date <YYYY-MM-DD>", required: false }], effects: ["read"], description: "Resolve a local PR-review report path without writing." },
  "validate-report": { args: [{ key: "reportFile", required: true, variadic: false }], options: [], effects: ["read", "validate"], description: "Validate a saved PR-review report." },
  post: { args: [], options: [{ key: "pr", flags: "--pr <n>", required: true }, { key: "bodyFile", flags: "--body-file <path>", required: true }, { key: "findings", flags: "--findings <file.json>", required: false }], effects: ["read", "validate", "process", "service"], description: "Post a GitHub PR review through the admitted gh process effect." },
  "worktree-cleanup": { args: [], options: [{ key: "worktreePath", flags: "--path <dir>", required: true }, { key: "branch", flags: "--branch <name>", required: true }, { key: "reportSaved", flags: "--report-saved", required: false }], effects: ["read", "write", "process"], description: "Remove a recorded PR-review worktree after its report is saved." },
  size: { args: [], options: [{ key: "base", flags: "--base <ref>", required: true }, { key: "head", flags: "--head <ref>", required: true }, { key: "largestFileTotal", flags: "--largest-file-total <n>", required: false }], effects: ["read", "process"], description: "Classify a PR-review changeset and derive tier and seats." },
  "seat-prompt": { args: [], options: [{ key: "stage", flags: "--stage <1|2>", required: true }, { key: "domain", flags: "--domain <d>", required: true }, { key: "seat", flags: "--seat <id>", required: true }, { key: "worktree", flags: "--worktree <path>", required: true }, { key: "security", flags: "--security", required: false }, { key: "skillRoot", flags: "--skill-root <dir>", required: false }, { key: "recon", flags: "--recon <facts...>", required: false }, { key: "tier", flags: "--tier <quick|default|deep>", required: false }, { key: "diffFile", flags: "--diff-file <path>", required: false }, { key: "collectFolded", flags: "--collect-folded", required: false }], effects: ["read"], description: "Generate a read-only PR-review seat prompt." },
  budget: { args: [], options: [], effects: ["read"], description: "Print PR-review tier budgets." },
};
const idFor = (verb: Verb) => `pr-review.${verb}`;
const ok = (id: string, data: unknown): CommandEnvelope => ({ version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data });
const failure = (id: string, error: unknown): CommandEnvelope<never> => {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof UsageError) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message });
  return { version: 1, command: id, status: "error", code: `${id}.failed`, exitCode: 1, message };
};
class UsageError extends Error {}
const abs = (cwd: string, file: string) => path.isAbsolute(file) ? file : path.resolve(cwd, file);
const need = (value: string | undefined, name: string): string => { if (value === undefined || value === "") throw new UsageError(`${name} is required`); return value; };
function parseTarget(raw: string): PrReportTarget {
  const colon = raw.indexOf(":"); const kind = colon < 0 ? raw : raw.slice(0, colon); const value = colon < 0 ? "" : raw.slice(colon + 1);
  if (kind === "pr" && /^\d+$/.test(value) && Number(value) > 0) return { kind: "pr", n: Number(value) };
  if (kind === "branch" && value !== "") return { kind: "branch", slug: value };
  if (kind === "diff" && value === "") return { kind: "diff" };
  if (kind === "diff") return { kind: "diff", headSha: value };
  throw new UsageError(`invalid --target ${JSON.stringify(raw)}; expected pr:<n> | branch:<slug> | diff:<sha> | diff`);
}
async function spawn(context: InvocationContext, argv: string[], cwd = context.cwd, stdin?: string) {
  return context.effects.spawn({
    argv,
    cwd,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    ...(stdin !== undefined ? { stdin } : {}),
    signal: context.signal,
  });
}
function parseFinding(entry: unknown, index: number): ReviewPostPlan["inlineComments"][number] | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const row = entry as Record<string, unknown>;
  if (row.path === undefined && row.body === undefined && row.line === undefined) return null;
  if (typeof row.path !== "string" || !row.path.trim() || typeof row.body !== "string" || !row.body.trim() || typeof row.line !== "number" || !Number.isInteger(row.line) || row.line < 1) throw new UsageError(`findings[${index}] must be {path: string, line: number >= 1, body: string}`);
  return { path: row.path, line: row.line, side: "RIGHT", body: row.body };
}
function foldComments(body: string, dropped: ReviewPostPlan["inlineComments"]): string {
  return [
    ...body.split(/\r?\n/),
    "",
    "## Inline comments folded into this summary",
    "",
    ...dropped.map((entry) => `- \`${entry.path}:${entry.line}\` — ${entry.body}`),
  ].join("\n");
}
async function execute(verb: Verb, input: Input, context: InvocationContext): Promise<CommandEnvelope> {
  const id = idFor(verb);
  try {
    if (verb === "tally") {
      const file = abs(context.cwd, need(input.findings, "--findings"));
      if (!existsSync(file)) throw new Error(`findings file not found: ${file}`);
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(parsed)) throw new UsageError("findings file must be a JSON array of {mergeClass} objects");
      const allowed: readonly string[] = ["must-fix", "should-fix", "nit"];
      const findings = parsed.map((row, index) => {
        const mergeClass = row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>).mergeClass : undefined;
        if (typeof mergeClass !== "string" || !allowed.includes(mergeClass)) throw new UsageError(`findings[${index}].mergeClass must be one of ${allowed.join(" | ")}`);
        return { mergeClass: mergeClass as MergeClass };
      });
      const count = (raw: string | undefined, label: string) => { if (raw === undefined) return 0; if (!/^\d+$/.test(raw) || Number(raw) > 50) throw new UsageError(`${label} must be a non-negative integer no greater than 50`); return Number(raw); };
      const result = computePrTally({ findings, unverifiedCount: count(input.unverified, "--unverified"), unmetAc: [...Array.from({ length: count(input.unmetAcUnsafe, "--unmet-ac-unsafe") }, () => ({ unsafeToShip: true })), ...Array.from({ length: count(input.unmetAcSafe, "--unmet-ac-safe") }, () => ({ unsafeToShip: false }))] });
      return ok(id, result);
    }
    if (verb === "report-path") {
      const stage = input.stage === undefined ? undefined : input.stage === "1" ? 1 : input.stage === "2" ? 2 : (() => { throw new UsageError("--stage must be 1 or 2"); })();
      if ((stage !== undefined) !== (input.slug !== undefined)) throw new UsageError("--stage and --slug go together");
      if (input.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new UsageError("--date must be YYYY-MM-DD");
      return ok(id, { path: prReviewReportPath({ reportsDir: abs(context.cwd, need(input.reportsDir, "--reports-dir")), target: parseTarget(need(input.target, "--target")), ...(stage ? { stage } : {}), ...(input.slug ? { slug: input.slug } : {}), ...(input.date ? { date: input.date } : {}) }) });
    }
    if (verb === "validate-report") {
      const file = abs(context.cwd, need(input.reportFile, "report file"));
      if (!existsSync(file)) throw new Error(`report file not found: ${file}`);
      const result = validatePrReviewReport(readFileSync(file, "utf8"));
      return result.ok ? ok(id, result) : { version: 1, command: id, status: "refused", code: `${id}.invalid`, exitCode: 1, message: "PR-review report validation failed", details: { violations: result.violations } };
    }
    if (verb === "post") {
      if (!/^\d+$/.test(need(input.pr, "--pr")) || Number(input.pr) < 1) throw new UsageError("--pr requires a positive integer");
      const bodyFile = abs(context.cwd, need(input.bodyFile, "--body-file"));
      if (!existsSync(bodyFile)) throw new Error(`body file not found: ${bodyFile}`);
      const body = readFileSync(bodyFile, "utf8");
      let comments: ReviewPostPlan["inlineComments"] = [];
      if (input.findings !== undefined) {
        const findingsFile = abs(context.cwd, input.findings);
        if (!existsSync(findingsFile)) throw new Error(`findings file not found: ${findingsFile}`);
        const parsed: unknown = JSON.parse(readFileSync(findingsFile, "utf8"));
        if (!Array.isArray(parsed)) throw new UsageError("--findings must be a JSON array");
        comments = parsed.flatMap((entry, index) => { const value = parseFinding(entry, index); return value ? [value] : []; });
      }
      const viewResult = await spawn(context, ["gh", "pr", "view", String(Number(input.pr)), "--json", "url,headRefOid"]);

      if (viewResult.exitCode !== 0 || viewResult.signal !== null) {
        return { version: 1, command: id, status: "refused", code: `${id}.unauthorized`, exitCode: 1, message: viewResult.stderr || "GitHub authentication/target lookup failed" };
      }
      const plan = planReviewPost(JSON.parse(viewResult.stdout), { body, comments });
      if (plan.pr !== Number(input.pr)) {
        return { version: 1, command: id, status: "refused", code: `${id}.wrong-target`, exitCode: 1, message: `resolved PR ${plan.pr} does not match requested PR ${input.pr}` };
      }
      const apiPath = `repos/${plan.ownerRepo}/pulls/${plan.pr}/reviews`;
      const payload = (kept: ReviewPostPlan["inlineComments"], dropped: ReviewPostPlan["inlineComments"]): string => JSON.stringify({ commit_id: plan.commitId, event: plan.event, body: dropped.length ? foldComments(plan.body, dropped) : plan.body, ...(kept.length ? { comments: kept.map(({ path: filePath, line, side, body: commentBody }) => ({ path: filePath, line, side, body: commentBody })) } : {}) });
      const send = (kept: ReviewPostPlan["inlineComments"], dropped: ReviewPostPlan["inlineComments"]) => spawn(context, ["gh", "api", "--method", "POST", apiPath, "--input", "-"], context.cwd, payload(kept, dropped));
      let response = await send(plan.inlineComments, []);
      if (response.exitCode !== 0 && /HTTP\s+422|"status"\s*:\s*422/.test(`${response.stderr}\n${response.stdout}`) && plan.inlineComments.length) response = await send([], plan.inlineComments);
      if (response.exitCode !== 0 || response.signal !== null) {
        return {
          version: 1, command: id, status: "error", code: `${id}.unknown-outcome`, exitCode: 1,
          message: `GitHub review post outcome is unknown; inspect PR ${plan.pr} before retrying: ${response.stderr || "gh api review post failed"}`,
          details: { outcome: "unknown", pr: plan.pr, commitId: plan.commitId },
        };
      }
      let reviewUrl = response.stdout.trim();
      try { const parsed = JSON.parse(response.stdout) as { html_url?: unknown }; if (typeof parsed.html_url === "string") reviewUrl = parsed.html_url; } catch { /* preserve successful response text */ }
      return ok(id, { posted: true, comments: "posted", review_url: reviewUrl || "(gh response)" });
    }
    if (verb === "worktree-cleanup") {
      const worktreePath = path.resolve(abs(context.cwd, need(input.worktreePath, "--path")));
      const sidecarPath = path.join(path.dirname(worktreePath), `.${path.basename(worktreePath)}.prreview.json`);
      if (!existsSync(sidecarPath)) throw new Error(`no setup sidecar found at ${sidecarPath} - run pr-review worktree-setup first`);
      const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as { reviewBranch?: string; repoRoot?: string; reportSaved?: boolean; diffFileDev?: number; diffFileIno?: string; diffFileMtimeMs?: number };
      const branch = sidecar.reviewBranch ?? "";
      if (branch === "" ? input.branch !== "" : input.branch !== branch) throw new Error(`--branch does not match the recorded review branch ${JSON.stringify(branch)} - refusing to delete a foreign branch`);
      if (input.reportSaved !== true && sidecar.reportSaved !== true) throw new Error("refusing cleanup: the local report is not saved yet - save it first or pass --report-saved");
      const gitRoot = typeof sidecar.repoRoot === "string" && sidecar.repoRoot !== "" ? sidecar.repoRoot : path.dirname(worktreePath);
      if (existsSync(worktreePath)) { const removed = await spawn(context, ["git", "worktree", "remove", worktreePath], gitRoot); if (removed.exitCode !== 0 || removed.signal !== null) throw new Error(removed.stderr || "git worktree remove failed"); }
      const pruned = await spawn(context, ["git", "worktree", "prune"], gitRoot); if (pruned.exitCode !== 0 || pruned.signal !== null) throw new Error(pruned.stderr || "git worktree prune failed");
      if (branch) {
        const branchCheck = await spawn(context, ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], gitRoot);
        if (branchCheck.exitCode !== 0 || branchCheck.signal !== null) throw new Error(`recorded review branch ${branch} no longer resolves - refusing ambiguous cleanup`);
        const deleted = await spawn(context, ["git", "branch", "-D", branch], gitRoot); if (deleted.exitCode !== 0 || deleted.signal !== null) throw new Error(deleted.stderr || `failed to delete ${branch}`);
      }
      const diffPath = path.join(path.dirname(worktreePath), `.${path.basename(worktreePath)}.prreview.diff`);
      try {
        const fd = openSync(diffPath, "r");
        try {
          const st = fstatSync(fd);
          if (st.isFile() && typeof sidecar.diffFileIno === "string" && st.dev === sidecar.diffFileDev && String(st.ino) === sidecar.diffFileIno && st.mtimeMs === sidecar.diffFileMtimeMs && st.nlink === 1) {
            const tmp = `${diffPath}.cleanup.${process.pid}.${randomUUID()}`; renameSync(diffPath, tmp);
            const after = fstatSync(fd); const moved = lstatSync(tmp);
            if (moved.dev === after.dev && moved.ino === after.ino && after.nlink === 1 && moved.nlink === 1) unlinkSync(tmp);
            else { linkSync(tmp, diffPath); unlinkSync(tmp); }
          }
        } finally { closeSync(fd); }
      } catch { /* missing or unowned snapshots remain untouched */ }
      unlinkSync(sidecarPath);
      return ok(id, { removed: worktreePath, branch: branch || null });
    }
    if (verb === "size") {
      const base = need(input.base, "--base"); const head = need(input.head, "--head");
      const rootResult = await spawn(context, ["git", "rev-parse", "--show-toplevel"]);
      if (rootResult.exitCode !== 0 || rootResult.signal !== null) throw new Error(rootResult.stderr || "not a git repository");
      const root = rootResult.stdout.trim();
      const diff = await spawn(context, ["git", "diff", `${base}...${head}`], root);
      const numstat = await spawn(context, ["git", "diff", "--numstat", `${base}...${head}`], root);
      if (diff.exitCode !== 0 || diff.signal !== null || numstat.exitCode !== 0 || numstat.signal !== null) throw new Error(diff.stderr || numstat.stderr || "git diff failed");
      const changedLines = numstat.stdout.split(/\r?\n/).reduce((sum, line) => { const match = /^(\d+)\t(\d+)\t/.exec(line); return sum + (match ? Number(match[1]) + Number(match[2]) : 0); }, 0);
      let largestTouchedFileTotal: number | undefined;
      if (input.largestFileTotal !== undefined) { if (!/^\d+$/.test(input.largestFileTotal)) throw new UsageError("--largest-file-total must be a non-negative integer"); largestTouchedFileTotal = Number(input.largestFileTotal); }
      else {
        const files = [...new Set([...diff.stdout.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]!))];
        for (const file of files) { const content = await spawn(context, ["git", "show", `${head}:${file}`], root); if (content.signal !== null) throw new Error(content.stderr || "git show failed"); const total = content.exitCode === 0 ? (content.stdout === "" ? 0 : content.stdout.split("\n").length) : 0; largestTouchedFileTotal = largestTouchedFileTotal === undefined ? total : Math.max(largestTouchedFileTotal, total); }
      }
      const sizing = prReviewSizing({ changedLines, ...(largestTouchedFileTotal !== undefined ? { largestTouchedFileTotal } : {}) });
      return ok(id, { ...sizing, tier: resolvePrReviewTier({ band: sizing.band }), changedLines });
    }
    if (verb === "seat-prompt") {
      if (input.stage !== "1" && input.stage !== "2") throw new UsageError("--stage must be 1 or 2");
      if (input.tier !== undefined && !["quick", "default", "deep"].includes(input.tier)) throw new UsageError("--tier must be quick | default | deep");
      const skillRoot = abs(context.cwd, input.skillRoot ?? "skills/mstar-audit");
      return ok(id, { prompt: prReviewSeatPrompt({ stage: input.stage === "1" ? 1 : 2, domain: need(input.domain, "--domain"), seat: need(input.seat, "--seat"), skillRoot, worktreePath: path.resolve(input.worktree ?? context.cwd), reconFacts: input.recon ?? [], ...(input.security ? { securitySeat: true } : {}), ...(input.tier ? { tier: input.tier as "quick" | "default" | "deep" } : {}), ...(input.diffFile ? { diffFile: abs(context.cwd, input.diffFile) } : {}), ...(input.collectFolded ? { collectFolded: true } : {}) }) });
    }
    return ok(id, { budgets: PR_REVIEW_TIER_BUDGETS });
  } catch (error) { return failure(id, error); }
}

export function getPrReviewCommandDefinitions(): readonly CommandDefinition[] {
  return verbs.map((verb) => {
    const contract = contracts[verb]; const id = idFor(verb);
    const fields = [...contract.args.map(({ key }) => key), ...contract.options.map(({ key }) => key)];
    return {
      id, cli: { path: ["pr-review", verb], aliases: [], arguments: contract.args, options: contract.options },
      input: inputSchema.pick(Object.fromEntries(fields.map((field) => [field, true])) as never), output: commandEnvelopeSchema,
      effects: contract.effects, description: contract.description,
      async execute(raw, context) { const parsed = inputSchema.pick(Object.fromEntries(fields.map((field) => [field, true])) as never).safeParse(raw); return parsed.success ? execute(verb, parsed.data, context) : failure(id, new UsageError(parsed.error.message)); },
    };
  });
}
