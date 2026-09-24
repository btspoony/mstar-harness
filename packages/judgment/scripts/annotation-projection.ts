import { realpathSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { runAnnotationProjection, runLeakCheck } from "../src/annotation-projection.js";

const USAGE = "Usage: annotation-projection.ts <project|leak-check> --qualification-root <E> --out <annotation-view-root>";

function fail(message: string): never {
  throw new Error(message);
}

function parseProject(argv: readonly string[]): { qualificationRoot: string; outputRoot: string; shuffleSeedHex?: string } {
  let qualificationRoot: string | undefined;
  let outputRoot: string | undefined;
  let shuffleSeedHex: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[++index];
    if (!value) fail("Missing flag value");
    if (flag === "--qualification-root" && qualificationRoot === undefined) qualificationRoot = value;
    else if (flag === "--out" && outputRoot === undefined) outputRoot = value;
    else if (flag === "--shuffle-seed" && shuffleSeedHex === undefined) shuffleSeedHex = value;
    else fail("Invalid command arguments");
  }
  if (!qualificationRoot || !outputRoot || !isAbsolute(qualificationRoot) || !isAbsolute(outputRoot)) fail(USAGE);
  return {
    qualificationRoot: realpathSync(qualificationRoot),
    outputRoot: resolve(outputRoot),
    ...(shuffleSeedHex ? { shuffleSeedHex } : {}),
  };
}

export async function runAnnotationProjectionCommand(argv = process.argv.slice(2)): Promise<number> {
  try {
    const [action, ...tail] = argv;
    if (action === "project") {
      const parsed = parseProject(tail);
      mkdirSync(parsed.outputRoot, { recursive: true, mode: 0o700 });
      const result = runAnnotationProjection({
        qualificationRoot: parsed.qualificationRoot,
        outputRoot: parsed.outputRoot,
        ...(parsed.shuffleSeedHex ? { shuffleSeed: Buffer.from(parsed.shuffleSeedHex, "hex") } : {}),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    if (action === "leak-check") {
      const parsed = parseProject(tail);
      const manifest = JSON.parse(await Bun.file(resolve(parsed.outputRoot, "manifest.json")).text()) as {
        seatViewPaths: string[];
        crosswalkPath: string;
      };
      const seatViewPaths = manifest.seatViewPaths.map((rel) => resolve(parsed.outputRoot, rel));
      const crosswalkPath = resolve(parsed.outputRoot, manifest.crosswalkPath);
      const report = runLeakCheck(seatViewPaths, crosswalkPath);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return report.verdict === "pass" ? 0 : 1;
    }
    fail(USAGE);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "annotation projection failed"}\n`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = await runAnnotationProjectionCommand();
