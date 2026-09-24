import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runShadowSupervisor, assessShadowRun, type ApprovedChild, type EvidenceClass, type ShadowMountPlan, type FrozenBaseline, type WorkUnitReceipt, type ProbeEvent, type ProbeLauncher } from "../src/shadow-supervisor.js";
import { validatePack, validatePilot, type ReviewDecisionPack, type JudgmentPilot } from "../src/contracts.js";
import { buildA05Request, canonicalJsonBytes } from "../src/review-advice.js";

const ROOT_USAGE = "Usage: shadow.ts <probe|exercise|study|assess> --root <authorized-run-root>";
type StudyManifest = Readonly<{
  schema: "mstar.shadow-study/v1";
  runId: string;
  evidenceClass: EvidenceClass;
  pack: unknown;
  pilot: unknown;
  child: ApprovedChild;
  mountPlan: ShadowMountPlan;
  baseline: Readonly<{ inventory: unknown; seatOutputs: unknown; originalConsumption: unknown; finalReport: unknown }>;
  controlledExercise?: Readonly<{ schema: "mstar.shadow-controlled-exercise/v1"; outcome: "same_cause" | "different_cause" | "insufficient_evidence" | "below-band" | "transport-failure" | "invalid-response" }>;
}>;
type StudyResult = Readonly<{
  schema: "mstar.shadow-study-result/v1";
  runId: string;
  evidenceClass: Exclude<EvidenceClass, "named-host">;
  elapsedMs: number;
  childOutputBytes: number;
  exitStatus: "completed" | "failed";
}>;
function readStudyResult(root: string, manifest: StudyManifest, baseline: FrozenBaseline): StudyResult {
  const value = JSON.parse(readFileSync(resolve(root, "study-result.json"), "utf8")) as Partial<StudyResult>;
  if (value.schema !== "mstar.shadow-study-result/v1" || typeof value.runId !== "string" ||
      (value.evidenceClass !== "component" && value.evidenceClass !== "synthetic-offline") ||
      typeof value.elapsedMs !== "number" || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 86_400_000 ||
      !Number.isSafeInteger(value.childOutputBytes) || value.childOutputBytes! < 0 || value.childOutputBytes! > 1_048_576 ||
      (value.exitStatus !== "completed" && value.exitStatus !== "failed")) return fail("Invalid study result");
  if (value.runId !== manifest.runId || value.runId !== baseline.runId || value.evidenceClass !== manifest.evidenceClass) return fail("Study result identity mismatch");
  if (value.exitStatus !== "completed") return fail("Study did not complete successfully");
  return value as StudyResult;
}
function fail(message: string): never { throw new Error(message); }
function rootFromArgs(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--root" || !isAbsolute(args[1]!)) return fail(ROOT_USAGE);
  const root = realpathSync(args[1]!);
  if (!statSync(root).isDirectory()) return fail("Run root must be a directory");
  return root;
}
function readManifest(root: string): StudyManifest {
  const manifestPath = resolve(root, "study-manifest.json");
  const canonicalPath = realpathSync(manifestPath);
  if (!canonicalPath.startsWith(`${root}/`) || statSync(canonicalPath).size > 1_048_576) return fail("Study manifest path or size is invalid");
  const value = JSON.parse(readFileSync(canonicalPath, "utf8")) as Partial<StudyManifest>;
  if (value.schema !== "mstar.shadow-study/v1" || typeof value.runId !== "string" || !value.child || !value.mountPlan || !value.baseline) return fail("Invalid study manifest");
  return value as StudyManifest;
}
function baselineFrom(root: string): FrozenBaseline {
  const value = JSON.parse(readFileSync(resolve(root, "baseline.json"), "utf8")) as FrozenBaseline;
  return value;
}
function receiptsFrom(root: string): readonly WorkUnitReceipt[] {
  return JSON.parse(readFileSync(resolve(root, "receipts.json"), "utf8")) as WorkUnitReceipt[];
}
function eventsFrom(root: string): readonly ProbeEvent[] {
  return JSON.parse(readFileSync(resolve(root, "probe-events.json"), "utf8")) as ProbeEvent[];
}
export async function runShadowCommand(args = process.argv.slice(2), launcher?: ProbeLauncher): Promise<number> {
  const [command, ...options] = args;
  try {
    const root = rootFromArgs(options);
    if (command === "probe" || command === "exercise" || command === "study") {
      const manifest = readManifest(root);
      const pack: ReviewDecisionPack = validatePack(manifest.pack);
      const pilot: JudgmentPilot = validatePilot(manifest.pilot);
      if (manifest.evidenceClass === "named-host") return fail("named-host requires separate issue-owned authorization and host facts");
      const controlled = manifest.controlledExercise;
      if (controlled !== undefined && (command !== "exercise" || manifest.evidenceClass !== "synthetic-offline" ||
          controlled.schema !== "mstar.shadow-controlled-exercise/v1" ||
          !["same_cause", "different_cause", "insufficient_evidence", "below-band", "transport-failure", "invalid-response"].includes(controlled.outcome))) return fail("Invalid synthetic-offline controlled exercise");
      const supervisorInput = { runRoot: root, runId: manifest.runId, pack, pilot, evidenceClass: manifest.evidenceClass, child: manifest.child, mountPlan: manifest.mountPlan, baseline: manifest.baseline };
      const result = controlled === undefined
        ? launcher === undefined ? await runShadowSupervisor(supervisorInput) : await runShadowSupervisor(supervisorInput, undefined, launcher)
        : await runShadowSupervisor({
            ...supervisorInput,
            credentialProvider: () => "synthetic-offline-marker",
            sendRequest: async () => {
              if (controlled.outcome === "transport-failure") return { responseBytes: new Uint8Array(), status: 503, elapsedMs: 1 };
              if (controlled.outcome === "invalid-response") return { responseBytes: new TextEncoder().encode("{}"), status: 200, elapsedMs: 1 };
              const choice = controlled.outcome === "below-band" ? "same_cause" : controlled.outcome;
              const top = controlled.outcome === "below-band" ? 0.5 : 0.8;
              const answers = Object.fromEntries(Object.keys(buildA05Request(pack, pilot).questionMap).map((id) => [id, {
                type: "choice", choice,
                probabilities: { same_cause: choice === "same_cause" ? top : 0.1, different_cause: choice === "different_cause" ? top : controlled.outcome === "below-band" ? 0.3 : 0.1, insufficient_evidence: choice === "insufficient_evidence" ? top : controlled.outcome === "below-band" ? 0.2 : 0.1 },
                confidence: controlled.outcome === "below-band" ? 0.4 : 0.8,
              }]));
              return { responseBytes: new TextEncoder().encode(JSON.stringify({ model: pilot.model, answers, usage: { input_tokens: 0, output_tokens: 0 } })), status: 200, elapsedMs: 1 };
            },
          }, undefined, (_child, runId, plan) => spawn(process.execPath, [manifest.child.executable, runId], {
            env: {
              PATH: process.env.PATH ?? "",
              HOME: plan.scratch,
              JEV_REQUESTS_DIR: plan.requests,
              JEV_PACK_BYTES: Buffer.from(canonicalJsonBytes(pack)).toString("base64"),
              JEV_PILOT_DIGEST: createHash("sha256").update(canonicalJsonBytes(pilot)).digest("hex"),
            },
            stdio: ["ignore", "pipe", "pipe"],
          }));
      process.stdout.write(`${JSON.stringify({ status: result.failures.length === 0 ? "recorded" : "unavailable", evidenceClass: result.evidenceClass, w5: result.w5, metrics: result.metrics })}\n`);
      return result.failures.length === 0 ? 0 : 1;
    }
    if (command === "assess") {
      const baseline = baselineFrom(root);
      const manifest = readManifest(root);
      const pack = validatePack(manifest.pack);
      const studyResult = readStudyResult(root, manifest, baseline);
      const packSha256 = createHash("sha256").update(canonicalJsonBytes(pack)).digest("hex");
      const scopeSha256 = createHash("sha256").update(canonicalJsonBytes(pack.scope)).digest("hex");
      const result = assessShadowRun({ baseline, receipts: receiptsFrom(root), childEvents: eventsFrom(root), evidenceClass: manifest.evidenceClass, elapsedMs: studyResult.elapsedMs, childOutputBytes: studyResult.childOutputBytes, packId: pack.packId, packSha256, scopeSha256, requiredUnitIds: pack.tasks.map((task) => task.workUnit.id), originalConsumption: manifest.baseline.originalConsumption, originalSeatOutputs: manifest.baseline.seatOutputs });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result.failures.length === 0 ? 0 : 1;
    }
    return fail(ROOT_USAGE);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "shadow command failed"}\n`);
    return 2;
  }
}

if (import.meta.main && process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runShadowCommand();
