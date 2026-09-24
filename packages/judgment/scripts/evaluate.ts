import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { runShadowSupervisor, type ShadowRunInput } from "../src/shadow-supervisor.js";
import { summarizeQualification, type QualificationRow } from "../src/evaluation.js";

const actions: Record<string, true> = { "check-protocol": true, "check-corpus": true, "check-annotations": true, "check-freeze": true, calibrate: true, holdout: true, report: true };
const REVISION = "phase3a-native-20260924";
function fail(message: string): never { throw new Error(message); }
function args(argv: readonly string[]): { action: string; root: string; shard?: string; seat?: string } {
  const [action, ...tail] = argv;
  if (!action || !Object.hasOwn(actions, action)) return fail("Usage: evaluate.ts <check-protocol|check-corpus|check-annotations|check-freeze|calibrate|holdout|report> --root <authorized-view> [--shard <id>] [--seat <A|B>]");
  let root: string | undefined, shard: string | undefined, seat: string | undefined;
  for (let i = 0; i < tail.length; i++) {
    const flag = tail[i], value = tail[++i];
    if (!value) return fail("Missing flag value");
    if (flag === "--root" && root === undefined) root = value;
    else if (flag === "--shard" && shard === undefined && action.startsWith("check-")) shard = value;
    else if (flag === "--seat" && seat === undefined && action === "check-annotations" && ["A", "B"].includes(value)) seat = value;
    else return fail("Invalid command arguments");
  }
  if (!root || !isAbsolute(root)) return fail("--root must be an explicit absolute authorized-view path");
  return { action, root: realpathSync(root), ...(shard ? { shard } : {}), ...(seat ? { seat } : {}) };
}
function readJson<T>(root: string, rel: string): T {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return fail("Invalid artifact path");
  const path = resolve(root, rel), canonical = realpathSync(path);
  const relPath = relative(root, canonical);
  if (relPath === ".." || relPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || !statSync(canonical).isFile() || statSync(canonical).size > 16_777_216) return fail("Artifact outside authorized root or exceeds limit");
  return JSON.parse(readFileSync(canonical, "utf8")) as T;
}
function readJsonLines<T>(root: string, rel: string): T[] {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return fail("Invalid artifact path");
  const path = resolve(root, rel), canonical = realpathSync(path), relPath = relative(root, canonical);
  if (relPath === ".." || relPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || !statSync(canonical).isFile() || statSync(canonical).size > 16_777_216) return fail("Artifact outside authorized root or exceeds limit");
  return readFileSync(canonical, "utf8").split(/\r?\n/).filter((line) => line.length > 0).map((line) => JSON.parse(line) as T);
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function fileDigest(root: string, rel: string): string {
  if (isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return fail("Manifest path invalid");
  const path = resolve(root, rel), canonical = realpathSync(path), relPath = relative(root, canonical);
  if (relPath === ".." || relPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || !statSync(canonical).isFile()) return fail("Manifest path escapes authorized root");
  return digest(readFileSync(canonical));
}
type Manifest = { schema: string; contractRevision: string; files?: Array<{ path: string; sha256: string }> };
type Corpus = { groups: Array<{ id: string; split: string; lineageId: string; causalClusterId: string; variants: Array<{ id: string; primary?: boolean }> }> };
type Gold = Array<{ itemId: string; groupId: string; label: string }>;
function assertRevision(value: { contractRevision?: string }): void { if (value.contractRevision !== REVISION) fail("Frozen revision mismatch"); }
function verifyFiles(root: string, manifest: Manifest): void {
  if (!Array.isArray(manifest.files)) fail("Manifest file commitments missing");
  for (const entry of manifest.files) if (!entry.path || fileDigest(root, entry.path) !== entry.sha256) fail("Artifact digest mismatch");
}
export async function runEvaluationCommand(argv = process.argv.slice(2)): Promise<number> {
  try {
    const { action, root, shard, seat } = args(argv);
    const protocol = readJson<Record<string, unknown>>(root, "protocol.json");
    if (action === "check-protocol") {
      if (protocol.schema !== "mstar.qualification-protocol/v1" || protocol.contractRevision !== REVISION || protocol.mode !== "shadow" || protocol.transport !== "native-typesafe") fail("Protocol contract mismatch");
      const budget = readJson<Record<string, unknown>>(root, "budget.json");
      assertRevision(budget as { contractRevision?: string });
      if (budget.attemptPolicy === undefined || budget.tokenPolicy === undefined) fail("Frozen budget policy missing");
      const permission = readJson<Record<string, unknown>>(root, "permission.json");
      assertRevision(permission as { contractRevision?: string });
      if (permission.status !== "synthetic-only-policy-declaration; not a self-authorizing pilot") fail("Permission declaration mismatch");
      process.stdout.write(`${JSON.stringify({ action, status: "valid", revision: REVISION })}\n`);
      return 0;
    }
    const manifest = readJson<Manifest>(root, "manifest.json");
    assertRevision(manifest);
    verifyFiles(root, manifest);
    if (action === "check-corpus") {
      const corpus = readJson<Corpus>(root, "corpus.json");
      const groups = shard ? corpus.groups.filter((g) => g.id.startsWith(`${shard}/`)) : corpus.groups;
      if (!Array.isArray(corpus.groups) || groups.some((g) => !g.id || !g.lineageId || !g.causalClusterId || !Array.isArray(g.variants) || g.variants.length < 1 || g.variants.length > 2 || g.variants.filter((v) => v.primary).length !== 1)) fail("Corpus group integrity failure");
      const lineage = new Map<string, string>(), causal = new Map<string, string>();
      for (const group of groups) for (const [table, value] of [[lineage, group.lineageId], [causal, group.causalClusterId]] as const) { const old = table.get(value); if (old && old !== group.split) fail("Lineage/causal split leakage"); table.set(value, group.split); }
      process.stdout.write(`${JSON.stringify({ action, status: "valid", groups: groups.length })}\n`); return 0;
    }
    if (action === "check-annotations") {
      const rows = readJsonLines<Gold[number]>(root, `annotations/${seat ?? "A"}-${shard ?? "1"}.jsonl`);
      if (!Array.isArray(rows) || rows.some((r) => !r.itemId || !r.groupId || !["same_cause", "different_cause", "insufficient_evidence"].includes(r.label))) fail("Annotation integrity failure");
      process.stdout.write(`${JSON.stringify({ action, status: "valid", annotations: rows.length })}\n`); return 0;
    }
    if (action === "check-freeze") {
      const split = readJson<{ contractRevision?: string; sha256?: string }>(root, "split-manifest.json");
      const gold = readJsonLines<unknown>(root, "gold/adjudicated.jsonl");
      if (!split.sha256 || !gold) fail("Freeze inputs missing");
      process.stdout.write(`${JSON.stringify({ action, status: "valid", splitSha256: split.sha256 })}\n`); return 0;
    }
    if (action === "calibrate" || action === "holdout") {
      const job = readJson<ShadowRunInput>(root, `${action}-run.json`);
      if (job.evidenceClass !== "synthetic-offline" || job.pilot.contractRevision !== REVISION) fail("Live evaluator requires a synthetic-only frozen runtime input");
      const result = await runShadowSupervisor(job);
      process.stdout.write(`${JSON.stringify({ action, status: result.failures.length ? "unavailable" : "recorded", w5: false, failures: result.failures.length })}\n`);
      return result.failures.length ? 1 : 0;
    }
    const ledger = readJson<QualificationRow[]>(root, "evaluation-rows.json");
    const summary = summarizeQualification(ledger);
    process.stdout.write(`${JSON.stringify({ action, summary })}\n`); return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "qualification evaluation failed"}\n`);
    return 2;
  }
}
if (import.meta.main) process.exitCode = await runEvaluationCommand();
