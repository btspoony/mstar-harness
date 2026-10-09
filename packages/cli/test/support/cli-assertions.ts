/**
 * Shared CLI envelope/assertion adapters for the command-owner CLI suites.
 * Moved verbatim from slice4-cli.test.ts during the command-owner test
 * split; `RunResult` is the structural spawn
 * result copied here so suites can type table callbacks without importing
 * production code. Test-only module: bun:test + types, no production imports.
 */
import { expect } from "bun:test";

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface CliEnvelope {
  version: number;
  command: string;
  status: string;
  code: string;
  exitCode: number;
  helpRoute?: string;
  recovery?: string;
  data?: Record<string, unknown>;
  details?: {
    helpRoute?: string;
    recovery?: string;
    violations?: { code: string }[];
    diagnostics?: { path?: string; code: string; expected?: string; received?: string }[];
    results?: LintResult[];
    findings?: Finding[];
    unreadableFiles?: number;
  };
}
type Finding = { file?: string; line?: number; type?: string; kind?: string; code?: string };

export function cliEnvelope(result: RunResult, status?: string, code?: string): CliEnvelope {
  const envelope = JSON.parse(result.stdout) as CliEnvelope;
  expect(envelope.version).toBe(1);
  expect(envelope.exitCode).toBe(result.exitCode);
  if (status !== undefined) expect(envelope.status).toBe(status);
  if (code !== undefined) expect(envelope.code).toBe(code);
  return envelope;
}

export function expectUsageDiagnostic(result: RunResult, path: string): CliEnvelope {
  const envelope = cliEnvelope(result, "usage", "command.invalid-input");
  expect(envelope.details?.helpRoute).toEqual(expect.any(String));
  expect(envelope.details?.recovery).toEqual(expect.any(String));
  expect(envelope.details?.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ path, code: expect.any(String) })]),
  );
  return envelope;
}


export function violationCodes(result: RunResult): string[] {
  const envelope = cliEnvelope(result, result.exitCode === 0 ? "ok" : "refused");
  const violations = envelope.details?.violations ?? (envelope.data?.violations as { code: string }[] | undefined);
  return violations?.map(({ code }) => code) ?? [envelope.code];
}

interface LintResult {
  file: string;
  violations: { code: string; message: string }[];
  markers: string[];
}

export function lintResults(result: RunResult): LintResult[] {
  const envelope = cliEnvelope(result, result.exitCode === 0 ? "ok" : "refused");
  const results = envelope.details?.results ?? envelope.data?.results;
  if (!Array.isArray(results)) throw new Error(`lint returned no per-file results: ${result.stdout}`);
  return results as LintResult[];
}

export function lintViolationCodes(result: RunResult): string[] {
  return lintResults(result).flatMap(({ violations }) => violations.map(({ code }) => code));
}
