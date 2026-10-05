import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  AUDIT_CATEGORIES,
  AUDIT_CONFIDENCES,
  AUDIT_EFFORTS,
  AUDIT_PRIORITIES,
  AUDIT_RISKS,
  createFsStore,
  SddScriptError,
  listAuditPlanIds,
  registerShippedCatalogExecution,
  resolveProcessHarnessDir,
  scanSecrets,
  scaffoldAuditPlan,
  setArtifactStore,
  supplyChainChecks,
  WORKFLOW_DELIVERY_KINDS,
  type AuditFinding,
} from "@mstar-harness/engine";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveCliPath } from "../host-health.js";
import { commandEnvelopeSchema } from "../definitions.js";
import { refusalEnvelope } from "../envelope.js";
import type { CommandDefinition, CommandEffect, CommandEnvelope, InvocationContext } from "../types.js";

const verbs = ["scaffold", "promote", "secret-scan", "supply-chain"] as const;
type Verb = (typeof verbs)[number];
type Input = {
  findings?: string; dir?: string; sha?: string; date?: string; repo?: string;
  plans?: string; workflow?: string; deliveryKind?: string; branchSource?: string; branchTarget?: string; completionPolicy?: string; harness?: string;
  path?: string;
};
const inputSchema = z.object({
  findings: z.string().optional(), dir: z.string().optional(), sha: z.string().optional(), date: z.string().optional(), repo: z.string().optional(),
  plans: z.string().optional(), workflow: z.string().optional(), deliveryKind: z.string().optional(), branchSource: z.string().optional(), branchTarget: z.string().optional(), completionPolicy: z.string().optional(), harness: z.string().optional(),
  path: z.string().optional(),
});
const contracts: Record<Verb, { args: { key: string; required: boolean; variadic: boolean }[]; options: { key: string; flags: string; required: boolean }[]; effects: readonly CommandEffect[]; description: string }> = {
  scaffold: { args: [{ key: "findings", required: false, variadic: false }], options: [
    { key: "dir", flags: "--dir <out-dir>", required: false }, { key: "sha", flags: "--sha <commit>", required: false },
    { key: "date", flags: "--date <YYYY-MM-DD>", required: false }, { key: "repo", flags: "--repo <name>", required: false },
  ], effects: ["read", "write"], description: "Scaffold audit plan artifacts in the declared output directory." },
  promote: { args: [{ key: "path", required: false, variadic: false }], options: [
    { key: "plans", flags: "--plans <ids>", required: false }, { key: "workflow", flags: "--workflow <id>", required: false },
    { key: "deliveryKind", flags: "--delivery-kind <kind>", required: false }, { key: "branchSource", flags: "--branch-source <branch>", required: false },
    { key: "branchTarget", flags: "--branch-target <branch>", required: false }, { key: "completionPolicy", flags: "--completion-policy <text>", required: false },
    { key: "harness", flags: "--harness <dir>", required: false },
  ], effects: ["read", "write"], description: "Promote selected audit plans into a declared v2 workflow lifecycle." },
  "secret-scan": { args: [{ key: "path", required: false, variadic: false }], options: [], effects: ["read", "validate", "process"], description: "Scan git-tracked files for credential findings without printing secret values." },
  "supply-chain": { args: [{ key: "path", required: false, variadic: false }], options: [], effects: ["read", "validate"], description: "Run existing read-only supply-chain checks on a repository root." },
};
function idFor(verb: Verb): string { return `audit.${verb}`; }
function ok<T>(id: string, data: T): CommandEnvelope<T> { return { version: 1, command: id, status: "ok", code: `${id}.ok`, exitCode: 0, data }; }
function failure(id: string, error: unknown): CommandEnvelope<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SddScriptError && error.exitCode === 2) return refusalEnvelope({ command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message });
  const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : `${id}.refused`;
  const details = error !== null && typeof error === "object" && "details" in error
    && error.details !== null && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : undefined;
  return refusalEnvelope({ command: id, status: "refused", code, exitCode: 1, message, ...(details === undefined ? {} : { details }) });
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
    const rawDependency = typeof row.dependsOn === "string" && row.dependsOn.trim() ? row.dependsOn.trim() : undefined;
    if (rawDependency !== undefined && !/^(?:none|plans\/\d{3}-[\w.*-]+\.md|\d{3})$/i.test(rawDependency)) throw new SddScriptError(`findings[${index}].dependsOn must be "none", "plans/NNN-*.md", or a plan number NNN`, 2);
    const dependsOn = rawDependency !== undefined && /^\d{3}$/.test(rawDependency) ? `plans/${rawDependency}-*.md` : rawDependency;
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
      ...(dependsOn !== undefined ? { dependsOn } : {}),
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
function parseCsv(value: string): string[] { return value.split(",").map((part) => part.trim()).filter(Boolean); }
async function execute(verb: Verb, input: Input, context: InvocationContext): Promise<CommandEnvelope> {
  const id = idFor(verb);
  try {
    if (verb === "scaffold") {
      const findingsFile = resolvePath(context.cwd, required(input.findings, "findings"));
      if (!existsSync(findingsFile)) throw new Error(`findings file not found: ${findingsFile}`);
      if (input.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new SddScriptError("--date must be YYYY-MM-DD", 2);
      if (input.sha !== undefined && !/^[0-9a-f]{7,40}$/.test(input.sha)) throw new SddScriptError("--sha must be a 7-40 char hex commit SHA", 2);
      const date = input.date ?? new Date().toISOString().slice(0, 10);
      const outDir = resolvePath(context.cwd, input.dir ?? `audit-${date}`);
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
        result = scaffoldAuditPlan(outDir, payload.findings, { date, repoName: input.repo, repoShortSha: sha, needsVerification: payload.needsVerification, hardeningChecked: payload.hardeningChecked });
      } catch (error) {
        if (error instanceof TypeError && error.message.includes("audit.finding.")) throw new SddScriptError(error.message, 2);
        throw error;
      }
      return ok(id, result);
    }
    if (verb === "promote") {
      const auditDir = resolvePath(context.cwd, required(input.path, "audit-dir"));
      if (!existsSync(auditDir)) throw new Error(`audit dir not found: ${auditDir}`);
      const selected = input.plans === undefined ? listAuditPlanIds(auditDir) : parseCsv(input.plans);
      if (selected.length === 0) throw new SddScriptError(input.plans === undefined ? `no audit plans found in ${auditDir}` : "--plans must select at least one plan", 2);
      if (input.plans === undefined && selected.length > 1) {
        throw new SddScriptError(`--plans is a required decision because ${selected.length} audit plans are available: ${selected.join(", ")}`, 2);
      }
      const deliveryKind = required(input.deliveryKind, "--delivery-kind");
      if (!(WORKFLOW_DELIVERY_KINDS as readonly string[]).includes(deliveryKind)) throw new SddScriptError(`--delivery-kind must be one of ${WORKFLOW_DELIVERY_KINDS.join(" | ")}`, 2);
      const harnessDir = resolveProcessHarnessDir(context.cwd, input.harness);
      if (harnessDir === null) throw new Error(`harness dir not found from ${context.cwd} — pass --harness`);
      setArtifactStore(createFsStore(harnessDir));
      const result = await registerShippedCatalogExecution({ harnessDir }, {
        operationId: randomUUID(), actor: "mcp:audit-promote",
        workflow: { kind: "audit", outDir: auditDir, selected, options: {
          harnessDir, deliveryKind: deliveryKind as (typeof WORKFLOW_DELIVERY_KINDS)[number],
          ...(input.workflow !== undefined ? { workflowId: input.workflow } : {}),
          ...(input.branchSource !== undefined ? { branchSource: input.branchSource } : {}),
          ...(input.branchTarget !== undefined ? { branchTarget: input.branchTarget } : {}),
          ...(input.completionPolicy !== undefined ? { completionPolicy: input.completionPolicy } : {}),
        } },
      });
      return ok(id, result);
    }
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
        ? { version: 1, command: id, status: "refused", code: result.unreadableFiles > 0 ? "audit.secret-scan.incomplete" : "audit.secret-scan.findings", exitCode: 1, message: result.unreadableFiles > 0 ? `failed to read ${result.unreadableFiles} tracked files; refusing to report clean` : `${result.findings.length} secret findings`, details: { findings: result.findings, unreadableFiles: result.unreadableFiles } }
        : ok(id, { findings: [], unreadableFiles: 0, filesScanned: files.length });
    }
    const result = supplyChainChecks(root);
    return result.ok ? ok(id, result) : { version: 1, command: id, status: "refused", code: "audit.supply-chain.findings", exitCode: 1, message: `${result.findings.length} supply-chain findings`, details: { findings: result.findings, violations: result.violations } };
  } catch (error) { return failure(id, error); }
}
function makeDefinition(verb: Verb): CommandDefinition<Input, unknown> {
  const contract = contracts[verb];
  const id = idFor(verb);
  const fields = [...contract.args.map(({ key }) => key), ...contract.options.map(({ key }) => key)];
  const input = inputSchema.pick(Object.fromEntries(fields.map((field) => [field, true])) as never);
  return {
    id,
    cli: { path: ["audit", verb], aliases: [], arguments: contract.args, options: contract.options },
    input, output: commandEnvelopeSchema, effects: contract.effects, description: contract.description,
    async execute(raw, context) { const parsed = input.safeParse(raw); return parsed.success ? execute(verb, parsed.data, context) : { version: 1, command: id, status: "usage", code: "command.invalid-input", exitCode: 2, message: parsed.error.message }; },
  };
}

export function getAuditCommandDefinitions(): readonly CommandDefinition[] { return verbs.map(makeDefinition); }
