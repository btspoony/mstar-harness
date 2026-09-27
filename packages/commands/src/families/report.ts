import { commandEnvelopeSchema } from "../definitions.js";
import { createReport, reportInputSchema } from "../report.js";
import type { ReportData, ReportInput } from "../report.js";
import type { CommandDefinition, CommandEnvelope } from "../types.js";

const cliOptions = [
  "title", "command", "arguments", "expected", "actual", "reproduction", "stableCode", "exitStatus", "host", "platform", "versionOverrides",
] as const;

export function getReportCommandDefinitions(): readonly CommandDefinition<ReportInput, ReportData>[] {
  return [{
    id: "report",
    cli: {
      path: ["report"],
      aliases: [],
      arguments: [],
      options: cliOptions.map((key) => ({
        key,
        flags: `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} <${key}>`,
        required: false,
      })),
    },
    input: reportInputSchema,
    output: commandEnvelopeSchema as CommandDefinition<ReportInput, ReportData>["output"],
    decodeCliInput(input) {
      const decoded = { ...input };
      if (decoded.arguments !== undefined) {
        if (Array.isArray(decoded.arguments)) {
          if (!decoded.arguments.every((argument) => typeof argument === "string")) return null;
        } else {
          try {
            decoded.arguments = JSON.parse(String(decoded.arguments));
          } catch {
            return null;
          }
        }
      }
      if (decoded.versionOverrides !== undefined) {
        try {
          decoded.versionOverrides = JSON.parse(String(decoded.versionOverrides));
        } catch {
          return null;
        }
      }
      if (decoded.exitStatus !== undefined) {
        const value = String(decoded.exitStatus);
        if (!/^-?\d+$/.test(value)) return null;
        const status = Number(value);
        if (!Number.isSafeInteger(status)) return null;
        decoded.exitStatus = status;
      }
      return decoded;
    },
    effects: ["validate"],
    description: "Create an offline, redacted issue-report draft.",
    async execute(input, context) {
      try {
        return { version: 1, command: "report", status: "ok", code: "report.ok", exitCode: 0, data: createReport(input, context.versions) };
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "report.input-too-large") {
          return error as CommandEnvelope<ReportData>;
        }
        throw error;
      }
    },
  }];
}
