import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runShadowSupervisor, assessShadowRun, type ApprovedChild, type EvidenceClass, type ShadowMountPlan, type FrozenBaseline, type WorkUnitReceipt, type ProbeEvent, type ProbeLauncher } from "../src/shadow-supervisor.js";
import { validatePack, validatePilot, type ReviewDecisionPack, type JudgmentPilot } from "../src/contracts.js";

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
}>;
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
      const supervisorInput = { runRoot: root, runId: manifest.runId, pack, pilot, evidenceClass: manifest.evidenceClass, child: manifest.child, mountPlan: manifest.mountPlan, baseline: manifest.baseline };
      const result = launcher === undefined ? await runShadowSupervisor(supervisorInput) : await runShadowSupervisor(supervisorInput, undefined, launcher);
      process.stdout.write(`${JSON.stringify({ status: result.failures.length === 0 ? "recorded" : "unavailable", evidenceClass: result.evidenceClass, w5: result.w5, metrics: result.metrics })}\n`);
      return result.failures.length === 0 ? 0 : 1;
    }
    if (command === "assess") {
      const baseline = baselineFrom(root);
      const manifest = readManifest(root);
      const studyResult = JSON.parse(readFileSync(resolve(root, "study-result.json"), "utf8")) as { elapsedMs?: unknown; childOutputBytes?: unknown };
      const result = assessShadowRun({ baseline, receipts: receiptsFrom(root), childEvents: eventsFrom(root), evidenceClass: manifest.evidenceClass, elapsedMs: typeof studyResult.elapsedMs === "number" ? studyResult.elapsedMs : 0, childOutputBytes: typeof studyResult.childOutputBytes === "number" ? studyResult.childOutputBytes : 0 });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result.failures.length === 0 ? 0 : 1;
    }
    return fail(ROOT_USAGE);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "shadow command failed"}\n`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = await runShadowCommand();
