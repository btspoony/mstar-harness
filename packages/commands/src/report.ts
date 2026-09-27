import { z } from "zod";
import { redactSecrets } from "@mstar-harness/engine/src/audit";
import type { SurfaceVersions } from "./types.js";


const issueUrl = "https://github.com/btspoony/mstar-harness/issues/new";
const FIELD_LIMIT = 8192;
const TOTAL_LIMIT = 32768;

const versionOverridesSchema = z.object({
  cli: z.string().optional(),
  engine: z.string().optional(),
  plugin: z.string().optional(),
}).strict();

export const reportInputSchema = z.object({
  title: z.string().optional(),
  command: z.string().optional(),
  arguments: z.union([z.string(), z.array(z.string()).max(128)]).optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
  reproduction: z.string().optional(),
  stableCode: z.string().optional(),
  exitStatus: z.number().int().safe().optional(),
  host: z.string().optional(),
  platform: z.string().optional(),
  versionOverrides: versionOverridesSchema.optional(),
}).strict();

export type ReportInput = z.infer<typeof reportInputSchema>;
export type ReportData = {
  issueUrl: string;
  prompt: string;
  redactions: readonly { field: string; count: number }[];
};

function suppliedTextFields(input: ReportInput): [string, string][] {
  const fields: [string, string][] = [];
  for (const field of ["title", "command", "expected", "actual", "reproduction", "stableCode", "host", "platform"] as const) {
    if (input[field] !== undefined) fields.push([field, input[field]!]);
  }
  if (input.arguments !== undefined) {
    fields.push(["arguments", typeof input.arguments === "string" ? input.arguments : input.arguments.join("\n")]);
  }
  if (input.versionOverrides !== undefined) {
    for (const field of ["cli", "engine", "plugin"] as const) {
      const value = input.versionOverrides[field];
      if (value !== undefined) fields.push([`versionOverrides.${field}`, value]);
    }
  }
  return fields;
}

type ReportInputTooLarge = {
  version: 1;
  command: "report";
  status: "refused";
  code: "report.input-too-large";
  exitCode: number;
  message: string;
  details: { field: string; limit: number };
};

function failure(field: string, limit: number): ReportInputTooLarge {
  return {
    version: 1,
    command: "report",
    status: "refused",
    code: "report.input-too-large",
    exitCode: 1,
    message: `input field ${field} exceeds ${limit} UTF-8 bytes`,
    details: { field, limit },
  };
}

function redact(field: string, value: string): { value: string; count: number } {
  const result = redactSecrets(value);
  return {
    value: result.text.replace(/\[REDACTED [^\]\r\n]+\]/g, "[REDACTED]"),
    count: result.findings.length,
  };
}

function json(value: string): string {
  return JSON.stringify(value);
}

function maxBacktickRun(values: Iterable<string>): number {
  let max = 0;
  for (const value of values) {
    for (const match of value.matchAll(/`+/g)) max = Math.max(max, match[0].length);
  }
  return max;
}

export function createReport(input: ReportInput, versions: SurfaceVersions): ReportData {
  const fields = suppliedTextFields(input);
  for (const [field, value] of fields) {
    const bytes = field === "arguments" && Array.isArray(input.arguments)
      ? input.arguments.reduce((total, argument) => total + Buffer.byteLength(argument, "utf8"), 0)
      : Buffer.byteLength(value, "utf8");
    if (bytes > FIELD_LIMIT) throw failure(field, FIELD_LIMIT);
  }
  const totalBytes = fields.reduce((total, [field, value]) => total + (
    field === "arguments" && Array.isArray(input.arguments)
      ? input.arguments.reduce((argumentTotal, argument) => argumentTotal + Buffer.byteLength(argument, "utf8"), 0)
      : Buffer.byteLength(value, "utf8")
  ), 0);
  if (totalBytes > TOTAL_LIMIT) throw failure("total", TOTAL_LIMIT);

  const redactions: { field: string; count: number }[] = [];
  const sanitized = new Map<string, string>();
  for (const [field, value] of fields) {
    const result = redact(field, value);
    if (!(field === "arguments" && Array.isArray(input.arguments))) sanitized.set(field, result.value);
    if (result.count > 0) redactions.push({ field, count: result.count });
  }
  const safe = (field: string, fallback = "absent") => sanitized.get(field) ?? fallback;

  let safeArguments: string | string[] | undefined;
  if (typeof input.arguments === "string") {
    safeArguments = safe("arguments");
  } else if (input.arguments !== undefined) {
    const itemResults = input.arguments.map((value) => redactSecrets(value));
    const itemValues = itemResults.map((result) => result.text.replace(/\[REDACTED [^\]\r\n]+\]/g, "[REDACTED]"));
    const joined = input.arguments.join("\n");
    const joinedResult = redactSecrets(joined);
    const joinedValue = joinedResult.text.replace(/\[REDACTED [^\]\r\n]+\]/g, "[REDACTED]");
    const itemJoinedValue = itemValues.join("\n");
    const crossesBoundary = joinedValue !== itemJoinedValue;
    safeArguments = crossesBoundary ? input.arguments.map(() => "[REDACTED]") : itemValues;
    const count = crossesBoundary ? input.arguments.length : joinedResult.findings.length;
    if (count > 0) {
      const argumentRedaction = redactions.find((entry) => entry.field === "arguments");
      if (argumentRedaction !== undefined) argumentRedaction.count = count;
    }
  }
  const redactSurface = (field: string, value: string): string => {
    const result = redact(field, value);
    if (result.count > 0) redactions.push({ field, count: result.count });
    return result.value;
  };
  const safeVersions = {
    cli: versions.cli === null ? "unknown" : redactSurface("versions.cli", versions.cli),
    engine: versions.engine === null ? "unknown" : redactSurface("versions.engine", versions.engine),
    plugin: versions.plugin === null ? "unknown" : redactSurface("versions.plugin", versions.plugin),
  };
  const hostValue = input.host === undefined
    ? versions.host === null ? "unknown" : redactSurface("host", versions.host)
    : safe("host");
  const platformValue = input.platform === undefined
    ? versions.platform === null ? "unknown" : redactSurface("platform", versions.platform)
    : safe("platform");
  const argumentFenceValues = typeof safeArguments === "string" ? [safeArguments] : safeArguments ?? [];
  const dataValues = [...sanitized.values(), ...Object.values(safeVersions), hostValue, platformValue, ...argumentFenceValues];
  const overrideValues = ["cli", "engine", "plugin"].flatMap((field) => {
    const value = sanitized.get(`versionOverrides.${field}`);
    return value === undefined ? [] : [[field, value] as const];
  });
  const fence = "`".repeat(Math.max(3, maxBacktickRun(dataValues) + 1));
  const lines = [
    "Review this draft before submission. Redaction is not a guarantee that every secret was removed.",
    `Issue URL: ${issueUrl}`,
    fence,
    `Title: ${json(safe("title"))}`,
    "Versions:",
    `- CLI (${versions.cli === null ? "unknown" : "observed"}): ${json(safeVersions.cli)}`,
    `- Engine (${versions.engine === null ? "unknown" : "observed"}): ${json(safeVersions.engine)}`,
    `- Plugin (${versions.plugin === null ? "unknown" : "observed"}): ${json(safeVersions.plugin)}`,
  ];
  if (overrideValues.length > 0) {
    lines.push("Caller-supplied version overrides:");
    for (const [field, value] of overrideValues) lines.push(`- ${field}: ${json(value)}`);
  }
  lines.push(
    `Host (${input.host === undefined ? versions.host === null ? "unknown" : "observed" : "caller-supplied"}): ${json(hostValue)}`,
    `Platform (${input.platform === undefined ? versions.platform === null ? "unknown" : "observed" : "caller-supplied"}): ${json(platformValue)}`,
  );
  if (input.command !== undefined) lines.push(`Command: ${json(safe("command"))}`);
  if (safeArguments !== undefined) lines.push(`Arguments: ${typeof safeArguments === "string" ? json(safeArguments) : JSON.stringify(safeArguments)}`);
  lines.push(
    `Expected: ${json(safe("expected"))}`,
    `Actual: ${json(safe("actual"))}`,
    `Stable code: ${json(safe("stableCode"))}`,
    `Exit status: ${input.exitStatus === undefined ? "absent" : input.exitStatus}`,
    `Reproduction: ${json(safe("reproduction"))}`,
    "Complete fields marked absent with the user before submission.",
    fence,
  );
  return { issueUrl, prompt: lines.join("\n"), redactions };
}


