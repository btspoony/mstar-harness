import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  AUDIT_CATEGORIES,
  AUDIT_CONFIDENCES,
  AUDIT_EFFORTS,
  AUDIT_PRIORITIES,
  AUDIT_RISKS,
  SddScriptError,
  resolveReviewDir,
  scanSecrets,
  scaffoldAuditReport,
  supplyChainChecks,
  type AuditFinding,
  type ReviewRunLevel,
} from "@mstar-harness/engine";
import { z } from "zod";
import { resolveCliPath } from "../host-health.js";
import { commandEnvelopeSchema } from "../definitions.js";
import { refusalEnvelope } from "../envelope.js";
import { engineErrorFacts } from "./family-refusal.js";
import { launchDirectoryRefusal } from "./launch-workspace.js";
import { decodeInputDiagnostics } from "../input-diagnostics.js";
import type { CommandDefinition, CommandEffect, CommandEnvelope, InvocationContext } from "../types.js";

const verbs = ["scaffold", "secret-scan", "supply-chain"] as const;
type Verb = (typeof verbs)[number];
const auditLevels = ["quick", "standard", "deep"] as const satisfies readonly ReviewRunLevel[];
type Input = {
  findings?: string; dir?: string; level?: string; round?: string; reviewsDir?: string; sha?: string; date?: string; repo?: string;
  path?: string;
};
const inputSchema = z.object({
  findings: z.string().optional(), dir: z.string().optional(), level: z.string().optional(), round: z.string().optional(), reviewsDir: z.string().optional(),
  sha: z.string().optional(), date: z.string().optional(), repo: z.string().optional(),
  path: z.string().optional(),
});
const contracts: Record<Verb, { args: { key: string; required: boolean; variadic: boolean }[]; options: { key: string; flags: string; required: boolean; help?: string; defaultValue?: unknown; context?: "sessionId" }[]; effects: readonly CommandEffect[]; description: string }> = {
  scaffold: { args: [{ key: "findings", required: true, variadic: false }], options: [
    { key: "level", flags: "--level <quick|standard|deep>", required: false, help: "Audit effort level; defaults to standard." },
    { key: "round", flags: "--round <n>", required: false, help: "Run round, an integer >= 1; omitted, one more than the highest round already recorded for the date and level." },
    { key: "reviewsDir", flags: "--reviews-dir <dir>", required: false, help: "Review root; defaults to {REVIEW_DIR} under the harness dir." },
    { key: "dir", flags: "--dir <out-dir>", required: false, help: "Whole run-dir override; --level, --round and --reviews-dir are then ignored." },
    { key: "sha", flags: "--sha <commit>", required: false, help: "Defaults to the current Git HEAD short SHA; uses unknown if Git cannot resolve it." },
    { key: "date", flags: "--date <YYYY-MM-DD>", required: false, help: "Defaults to the local calendar date." }, { key: "repo", flags: "--repo <name>", required: false },
  ], effects: ["read", "write"], description: "Scaffold the audit review report for one run under {REVIEW_DIR} from a JSON findings array or {findings:[...]}; each finding requires non-empty title and description plus valid priority, effort, risk and category. Confidence defaults to MED and evidence defaults to []." },
  "secret-scan": { args: [{ key: "path", required: false, variadic: false }], options: [], effects: ["read", "validate", "process"], description: "Scan git-tracked files for credential findings without printing secret values; path defaults to the current directory." },
  "supply-chain": { args: [{ key: "path", required: false, variadic: false }], options: [], effects: ["read", "validate"], description: "Run existing read-only supply-chain checks on a repository root; path defaults to the current directory." },
};
function idFor(verb: Verb): string { return `audit.${verb}`; }
function ok<T>(id: string, data: T): CommandEnvelope<T> { return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data }; }
export function failure(id: string, error: unknown): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SddScriptError && error.exitCode === 2) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message });
  const { code, details, recovery } = engineErrorFacts(error);
  return refusalEnvelope({
    command: id, status: "refused", code: code ?? `${id}.refused`, exitCode: 1, message,
    details: details ?? {},
    recovery: recovery ?? "Correct the reported audit input or source problem, then rerun the command.",
  });
}
function required(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === "") throw new SddScriptError(`${label} is required`, 2);
  return value;
}
function resolvePath(cwd: string, value: string): string { return path.isAbsolute(value) ? value : path.resolve(cwd, value); }
function parseFindings(text: string): { findings: AuditFinding[]; needsVerification?: { lead: string; how: string; evidence?: string }[]; hardeningChecked?: { kind: "Hardening" | "Checked and clean"; text: string }[] } {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new SddScriptError("findings file is not valid JSON", 2); }
  const doc = Array.isArray(data) ? { findings: data } : data;
  if (doc === null || typeof doc !== "object" || !Array.isArray((doc as Record<string, unknown>).findings)) throw new SddScriptError("findings file must be an array or an object with a findings array", 2);
  const raw = doc as Record<string, unknown>;
  const findings = (raw.findings as unknown[]).map((value, index): AuditFinding => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SddScriptError(`findings[${index}] is not an object`, 2);
    const row = value as Record<string, unknown>;
    const enumValue = <T extends string>(field: string, values: readonly T[]): T => {
      const selected = row[field];
      if (typeof selected !== "string" || !values.includes(selected as T)) throw new SddScriptError(`findings[${index}].${field} must be one of ${values.join("|")}`, 2);
      return selected as T;
    };
    const title = typeof row.title === "string" ? row.title.trim() : "";
    const impact = typeof row.description === "string" ? row.description.trim() : "";
    if (!title || !impact) throw new SddScriptError(`findings[${index}] needs non-empty title and description`, 2);
    const priority = enumValue("priority", AUDIT_PRIORITIES);
    const effort = enumValue("effort", AUDIT_EFFORTS);
    const risk = enumValue("risk", AUDIT_RISKS);
    const category = enumValue("category", AUDIT_CATEGORIES);
    const confidence = row.confidence === undefined ? "MED" : enumValue("confidence", AUDIT_CONFIDENCES);
    const evidence = row.evidence === undefined ? [] : row.evidence;
    if (!Array.isArray(evidence)) throw new SddScriptError(`findings[${index}].evidence must be an array`, 2);
    const normalizedEvidence = evidence.map((entry, itemIndex) => {
      if (typeof entry === "string" && entry.trim() !== "") return entry;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new SddScriptError(`findings[${index}].evidence[${itemIndex}] must be a non-empty string or location object`, 2);
      const location = entry as Record<string, unknown>;
      if (typeof location.file !== "string" || location.file === "" || typeof location.description !== "string" || location.description.trim() === "") throw new SddScriptError(`findings[${index}].evidence[${itemIndex}] requires a repository-relative file and non-empty description`, 2);
      if (location.line !== undefined && (typeof location.line !== "number" || !Number.isSafeInteger(location.line) || location.line <= 0)) throw new SddScriptError(`findings[${index}].evidence[${itemIndex}].line must be a positive integer`, 2);
      return { file: location.file, ...(location.line !== undefined ? { line: location.line } : {}), description: location.description };
    });
    const fingerprint = row.fingerprint;
    if (fingerprint !== undefined && (typeof fingerprint !== "string" || fingerprint === "")) throw new SddScriptError(`findings[${index}].fingerprint must be a non-empty string`, 2);
    const optionalText = (key: string): string | undefined => {
      const v = row[key];
      if (v === undefined) return undefined;
      if (typeof v !== "string" || v.trim() === "") throw new SddScriptError(`findings[${index}].${key} must be a non-empty string`, 2);
      return v.trim();
    };
    const severity = row.severity as AuditFinding["severity"];
    if (severity !== undefined) {
      if (severity === null || typeof severity !== "object" || !["likelihood", "impact", "overall"].every((key) => ["informational", "low", "medium", "high", "critical"].includes(severity[key as keyof typeof severity] as string))) throw new SddScriptError(`findings[${index}].severity must contain likelihood, impact and overall ranks`, 2);
    }
    const trace = row.trace;
    if (trace !== undefined && !Array.isArray(trace)) throw new SddScriptError(`findings[${index}].trace must be an array`, 2);
    return {
      title, impact, priority, effort, risk, category, confidence, evidence: normalizedEvidence as AuditFinding["evidence"],
      ...(fingerprint !== undefined ? { fingerprint } : {}), ...(severity !== undefined ? { severity } : {}),
      ...(trace !== undefined ? { trace: trace as AuditFinding["trace"] } : {}),
      ...(optionalText("fixSketch") !== undefined ? { fixSketch: optionalText("fixSketch") } : {}),
      ...(optionalText("verification") !== undefined ? { verification: optionalText("verification") } : {}),
    };
  });
  const needsVerification = raw.needsVerification;
  if (needsVerification !== undefined && !Array.isArray(needsVerification)) throw new SddScriptError("needsVerification must be an array of {lead, how, evidence?}", 2);
  const parsedVerification = needsVerification?.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new SddScriptError(`needsVerification[${index}] is not an object`, 2);
    const item = entry as Record<string, unknown>;
    const lead = typeof item.lead === "string" ? item.lead.trim() : "";
    const how = typeof item.how === "string" ? item.how.trim() : "";
    if (!lead || !how) throw new SddScriptError(`needsVerification[${index}] needs non-empty lead and how`, 2);
    const evidence = typeof item.evidence === "string" && item.evidence.trim() ? item.evidence.trim() : undefined;
    return { lead, how, ...(evidence !== undefined ? { evidence } : {}) };
  });
  const hardeningChecked = raw.hardeningChecked;
  if (hardeningChecked !== undefined && !Array.isArray(hardeningChecked)) throw new SddScriptError("hardeningChecked must be an array of {kind, text}", 2);
  const parsedHardening = hardeningChecked?.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new SddScriptError(`hardeningChecked[${index}] is not an object`, 2);
    const item = entry as Record<string, unknown>;
    const kind = item.kind;
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (kind !== "Hardening" && kind !== "Checked and clean") throw new SddScriptError(`hardeningChecked[${index}].kind must be Hardening|Checked and clean`, 2);
    if (!text) throw new SddScriptError(`hardeningChecked[${index}] needs non-empty text`, 2);
    return { kind: kind as "Hardening" | "Checked and clean", text };
  });
  return {
    findings,
    ...(parsedVerification !== undefined ? { needsVerification: parsedVerification } : {}),
    ...(parsedHardening !== undefined ? { hardeningChecked: parsedHardening } : {}),
  };
}
async function execute(verb: Verb, input: Input, context: InvocationContext): Promise<CommandEnvelope> {
  const id = idFor(verb);
  try {
    if (verb === "scaffold") {
      const findingsFile = resolvePath(context.cwd, required(input.findings, "findings"));
      if (!existsSync(findingsFile)) throw new Error(`findings file not found: ${findingsFile}`);
      if (input.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new SddScriptError("--date must be YYYY-MM-DD", 2);
      if (input.sha !== undefined && !/^[0-9a-f]{7,40}$/.test(input.sha)) throw new SddScriptError("--sha must be a 7-40 char hex commit SHA", 2);
      const dirOverride = input.dir === undefined ? undefined : resolvePath(context.cwd, input.dir);
      // --dir pins the run dir outright: --level / --round are then ignored
      // entirely (not even validated), and the harness review root is only
      // resolved when the engine has to derive the run dir from it; otherwise
      // its parent stands in as a root the engine never reads.
      const derived = dirOverride === undefined;
      const level = !derived || input.level === undefined ? undefined : auditLevels.find((candidate) => candidate === input.level);
      if (derived && input.level !== undefined && level === undefined) throw new SddScriptError(`--level must be one of ${auditLevels.join(" | ")}`, 2);
      if (derived && input.round !== undefined && !/^[1-9]\d*$/.test(input.round)) throw new SddScriptError("--round must be an integer >= 1", 2);
      const reviewsDir = input.reviewsDir !== undefined
        ? resolvePath(context.cwd, input.reviewsDir)
        : derived ? resolveReviewDir(context.cwd) : path.dirname(dirOverride);
      const payload = parseFindings(readFileSync(findingsFile, "utf8"));
      let sha = input.sha;
      if (sha === undefined) {
        try {
          const out = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: context.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
          sha = out.trim();
        } catch { sha = "unknown"; }
      }
      let result;
      try {
        result = scaffoldAuditReport(payload.findings, {
          reviewsDir,
          ...(dirOverride !== undefined ? { dir: dirOverride } : {}),
          ...(level !== undefined ? { level } : {}),
          ...(derived && input.round !== undefined ? { round: Number(input.round) } : {}),
          ...(input.date !== undefined ? { date: input.date } : {}),
          ...(input.repo !== undefined ? { repoName: input.repo } : {}),
          repoShortSha: sha,
          ...(payload.needsVerification !== undefined ? { needsVerification: payload.needsVerification } : {}),
          ...(payload.hardeningChecked !== undefined ? { hardeningChecked: payload.hardeningChecked } : {}),
        });
      } catch (error) {
        if (error instanceof TypeError && error.message.includes("audit.finding.")) throw new SddScriptError(error.message, 2);
        throw error;
      }
      return ok(id, result);
    }
    // Both verbs take the checkout itself as their subject (`path` defaults to
    // the invocation directory). On a connection that declared no workspace
    // that directory is the MCP server's launch directory (the HOST's
    // checkout), so the repository is a required, absolute input: scanning or
    // checking the host's repository and reporting it as the caller's answer
    // would be a silent wrong answer.
    const unnamedRepository = launchDirectoryRefusal(id, context, {
      fields: [{ field: "path", subject: verb === "secret-scan" ? "the repository to scan" : "the repository to check", value: input.path }],
    });
    if (unnamedRepository !== undefined) return unnamedRepository;
    const root = resolvePath(context.cwd, input.path ?? ".");
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new SddScriptError(`not a directory: ${root}`, 2);
    if (verb === "secret-scan") {
      const process = context.effects.spawn;
      if (process === undefined) throw new Error("secret scan process capability is unavailable");
      const listed = await process({ argv: ["git", "ls-files", "-z", "--", "."], cwd: root, env: {}, signal: context.signal });
      if (listed.exitCode !== 0 || listed.signal !== null) throw new SddScriptError("not a git repository or git unavailable — refusing to report an empty scan as clean", 2);
      const files = listed.stdout.split("\0").filter(Boolean).map((file) => path.join(root, file));
      const result = scanSecrets(files);
      return result.unreadableFiles > 0 || result.findings.length > 0
        ? refusalEnvelope({ command: id, status: "refused", code: result.unreadableFiles > 0 ? "audit.secret-scan.incomplete" : "audit.secret-scan.findings", exitCode: 1, message: result.unreadableFiles > 0 ? `failed to read ${result.unreadableFiles} tracked files; refusing to report clean` : `${result.findings.length} secret findings`, details: { findings: result.findings, unreadableFiles: result.unreadableFiles } , recovery: result.unreadableFiles > 0 && result.findings.length > 0
            ? "Restore access to each unreadable tracked file and rotate or revoke every reported credential before purging it from tracked content. Run mstar audit secret-scan."
            : result.unreadableFiles > 0
              ? "Restore read access to every unreadable tracked file. Run mstar audit secret-scan."
              : "Rotate or revoke every reported credential and purge it from tracked content. Run mstar audit secret-scan."})
        : ok(id, { findings: [], unreadableFiles: 0, filesScanned: files.length });
    }
    const result = supplyChainChecks(root);
    return result.ok ? ok(id, result) : refusalEnvelope({ command: id, status: "refused", code: "audit.supply-chain.findings", exitCode: 1, message: `${result.findings.length} supply-chain findings`, details: { findings: result.findings, violations: result.violations } , recovery: "Resolve the listed dependency and policy violations. Run mstar audit supply-chain."});
  } catch (error) { return failure(id, error); }
}
function makeDefinition(verb: Verb): CommandDefinition<Input, unknown> {
  const contract = contracts[verb];
  const id = idFor(verb);
  const fields = [...contract.args.map(({ key }) => key), ...contract.options.filter(({ context }) => context === undefined).map(({ key }) => key)];
  const input = inputSchema.pick(Object.fromEntries(fields.map((field) => [field, true])) as never);
  const routes = ["cli", "mcp"] as const;
  const requirements = routes.flatMap((route) => {
    if (verb === "scaffold") return [
      { name: "findings", ownership: "caller" as const, route, required: true, constraint: "JSON array or object with findings array; each finding needs title, description, priority, effort, risk and category; confidence defaults to MED and evidence to []" },
      { name: "date", ownership: "derivable" as const, route, required: false, constraint: "defaults to the local calendar date" },
      { name: "level", ownership: "derivable" as const, route, required: false, constraint: "one of quick | standard | deep; defaults to standard" },
      { name: "round", ownership: "derivable" as const, route, required: false, constraint: "integer >= 1; omitted, one more than the highest round already present for the date and level" },
      { name: "reviewsDir", ownership: "derivable" as const, route, required: false, constraint: "defaults to {REVIEW_DIR} under the harness dir" },
      { name: "dir", ownership: "derivable" as const, route, required: false, constraint: "whole run-dir override; --level, --round and --reviews-dir are then ignored" },
      { name: "sha", ownership: "derivable" as const, route, required: false, constraint: "defaults to current Git HEAD short SHA or unknown if unavailable" },
    ];
    return [{ name: "path", ownership: "derivable" as const, route, required: false, constraint: "defaults to current working directory" }];
  });
  return {
    id,
    cli: { path: ["audit", verb], aliases: [], arguments: contract.args, options: contract.options },
    input, output: commandEnvelopeSchema, effects: contract.effects, description: contract.description,
    requirements,
    async execute(raw, context) {
      const parsed = input.safeParse(raw);
      return parsed.success
        ? execute(verb, parsed.data, context)
        : refusalEnvelope({
            command: id, status: "usage", code: "command.invalid-input", exitCode: 2,
            message: "Invalid input.",
            diagnostics: decodeInputDiagnostics(parsed.error, raw),
          });
    },
  };
}

export function getAuditCommandDefinitions(): readonly CommandDefinition[] { return verbs.map(makeDefinition); }
