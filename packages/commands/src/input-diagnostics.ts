/**
 * input-diagnostics.ts — the one projection from a schema rejection to the
 * safe structured diagnostics every transport reports, and the one place that
 * knows how a submitted value is made safe.
 *
 * A command's input can carry secret-shaped strings anywhere: in the rejected
 * scalar itself, in an object key a strict-object issue quotes by name, or in a
 * nested value an issue message copies. The projection is therefore input-aware:
 * it sanitizes both the message and the field path against every string it can
 * reach in the submitted value, and reports the received fact as a type or a
 * redacted scalar — never a submitted value verbatim. Central admission and any
 * family that decodes its own input consume this same implementation instead of
 * hand-rolling a second, lossy normalization.
 */
import { redactSecrets } from "@mstar-harness/engine/src/audit";
import { z } from "zod";
import type { RefusalDiagnostic } from "./envelope.js";

function redactInputScalar(value: string): string {
  return redactSecrets(value).text
    .replace(/\[REDACTED [^\]\r\n]+\]/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9-]+\b/g, "[REDACTED]");
}

/**
 * Sanitize both messages and paths against secret-shaped strings anywhere in
 * the submitted input, including object keys quoted by strict-object issues.
 * Numeric/boolean scalars cannot contain secrets and need no redactor pass.
 */
function issueMessageSanitizer(input: unknown): (message: string) => string {
  const replacements: Record<string, string> = {};
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const redacted = redactInputScalar(value);
      if (redacted !== value && replacements[value] === undefined) replacements[value] = redacted;
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        visit(key);
        visit(item);
      }
    }
  };
  visit(input);
  const scalars = Object.keys(replacements);
  const pattern = scalars.length === 0 ? undefined : new RegExp(scalars.map((scalar) =>
    scalar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|"), "g");
  return (message) => {
    const text = redactSecrets(message).text;
    return pattern === undefined ? text : text.replace(pattern, (scalar) => replacements[scalar] ?? scalar);
  };
}

function inputValueAtPath(input: unknown, path: readonly (string | number | symbol)[]): unknown {
  return path.reduce<unknown>((value, part) =>
    value !== null && typeof value === "object" ? (value as Record<PropertyKey, unknown>)[part] : undefined,
  input);
}

function inputPath(issue: z.ZodError["issues"][number]): string {
  return issue.path.reduce((path: string, part: string | number | symbol) =>
    typeof part === "number" ? `${path}[${String(part)}]` : path === "" ? String(part) : `${path}.${String(part)}`,
  "");
}

function rejectionFacts(issue: z.ZodError["issues"][number], input: unknown): { expected: string; received: string } {
  const expected = issue.code === "invalid_type"
    ? issue.expected
    : issue.code === "invalid_value" && "values" in issue && Array.isArray(issue.values)
      ? issue.values.map(String).join(" | ")
      : issue.code === "too_small" && "minimum" in issue
        ? `${issue.origin} ${issue.inclusive ? ">=" : ">"} ${String(issue.minimum)}`
        : issue.code === "too_big" && "maximum" in issue
          ? `${issue.origin} ${issue.inclusive ? "<=" : "<"} ${String(issue.maximum)}`
          : issue.code === "unrecognized_keys"
            ? "recognized keys"
            : "valid value";
  const value = inputValueAtPath(input, issue.path);
  const received = value === undefined ? "undefined" : value === null ? "null" :
    typeof value === "object" ? Array.isArray(value) ? "array" : "object" :
      typeof value === "string" ? redactInputScalar(value) : String(value);
  return { expected, received };
}

/**
 * One safe structured fact per schema violation, in issue order, in the CLI
 * payload decoder's diagnostic shape: field path, stable issue code, sanitized
 * message and the first array index where relevant. `input` is the submitted
 * value the error came from; it is read only to redact what the error would
 * otherwise echo. Never carries submitted values.
 */
export function decodeInputDiagnostics(error: z.ZodError, input: unknown): RefusalDiagnostic[] {
  const sanitize = issueMessageSanitizer(input);
  return error.issues.map((issue) => {
    const path = sanitize(inputPath(issue));
    const index = issue.path.find((part) => typeof part === "number");
    const facts = rejectionFacts(issue, input);
    return {
      path,
      code: issue.code,
      message: sanitize(issue.message),
      expected: facts.expected,
      received: facts.received,
      ...(typeof index === "number" ? { index } : {}),
    };
  });
}
