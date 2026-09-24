import { NATIVE_MODEL, PROTOCOL_NUMERIC_TOLERANCE } from "./contracts.js";
import type { CanonicalQuestion, PreparedRequest } from "./review-advice.js";

export type CanonicalAnswer =
  | Readonly<{ type: "choice"; choice: string; probabilities: Readonly<Record<string, number>>; confidence: number }>
  | Readonly<{ type: "noul"; noul: number }>
  | Readonly<{ type: "score"; score: number; legend: Readonly<Record<string, string>>; probabilities: Readonly<Record<string, number>>; confidence: number }>;
export type NormalizedTypeSafeResponse = Readonly<{
  model: typeof NATIVE_MODEL;
  answers: Readonly<Record<string, CanonicalAnswer>>;
  usage: Readonly<{ inputTokens: number; outputTokens: number }> | null;
}>;

const invalid = (message: string): never => { throw new TypeError(`Invalid TypeSafe response: ${message}`); };
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void => {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`unexpected field ${key}`);
  for (const key of required) if (!(key in value)) invalid(`missing field ${key}`);
};
const probability = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) invalid(`${field} must be finite and in [0, 1]`);
  return value;
};
const close = (left: number, right: number): boolean => Math.abs(left - right) <= PROTOCOL_NUMERIC_TOLERANCE;

function distribution(value: unknown, keys: readonly string[], field: string): Record<string, number> {
  if (!isRecord(value)) invalid(`${field} must be an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !(key in value))) invalid(`${field} must contain exactly the expected levels`);
  const result: Record<string, number> = {};
  let total = 0;
  for (const key of keys) {
    result[key] = probability(value[key], `${field}.${key}`);
    total += result[key];
  }
  if (!close(total, 1)) invalid(`${field} must sum to 1`);
  return result;
}
function confidence(value: unknown): number {
  return probability(value, "confidence");
}
function validateAnswer(value: unknown, question: CanonicalQuestion, field: string): CanonicalAnswer {
  if (!isRecord(value) || typeof value.type !== "string") invalid(`${field} must be a typed answer`);
  if (value.type !== question.type) invalid(`${field}.type does not match the requested question`);
  if (question.type === "choice") {
    exactKeys(value, ["type", "choice", "probabilities", "confidence"]);
    const keys = Object.keys(question.criteria);
    const probabilities = distribution(value.probabilities, keys, `${field}.probabilities`);
    if (typeof value.choice !== "string" || !keys.includes(value.choice)) invalid(`${field}.choice is not an allowed label`);
    const maximum = Math.max(...Object.values(probabilities));
    if (probabilities[value.choice] < maximum - PROTOCOL_NUMERIC_TOLERANCE) invalid(`${field}.choice is not a maximal label`);
    return { type: "choice", choice: value.choice, probabilities, confidence: confidence(value.confidence) };
  }
  if (question.type === "noul") {
    exactKeys(value, ["type", "noul"]);
    return { type: "noul", noul: probability(value.noul, `${field}.noul`) };
  }

  exactKeys(value, ["type", "score", "legend", "probabilities", "confidence"]);
  const levels = question.criteria.length;
  if (levels < 2 || levels > 10) invalid(`${field} has an invalid requested Score level count`);
  const keys = Array.from({ length: levels }, (_, i) => String(i));
  if (!isRecord(value.legend) || Object.keys(value.legend).length !== levels || keys.some((key) => typeof value.legend[key] !== "string")) {
    invalid(`${field}.legend must define exactly the requested levels`);
  }
  const expectedLegend: Record<string, string> = {};
  question.criteria.forEach((item, i) => {
    if (typeof item !== "string") invalid(`${field} requested Score levels must be strings`);
    expectedLegend[String(i)] = item;
  });
  if (keys.some((key) => value.legend[key] !== expectedLegend[key])) invalid(`${field}.legend does not match the requested levels`);
  const probabilities = distribution(value.probabilities, keys, `${field}.probabilities`);
  const expectation = keys.reduce((sum, key) => sum + Number(key) * probabilities[key], 0);
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || !close(value.score, expectation)) invalid(`${field}.score does not match its probability-weighted expectation`);
  return { type: "score", score: value.score, legend: expectedLegend, probabilities, confidence: confidence(value.confidence) };
}

function normalizeUsage(value: unknown): NormalizedTypeSafeResponse["usage"] {
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
      !Number.isSafeInteger(value.input_tokens) || !Number.isSafeInteger(value.output_tokens) ||
      (value.input_tokens as number) < 0 || (value.output_tokens as number) < 0) return null;
  return { inputTokens: value.input_tokens as number, outputTokens: value.output_tokens as number };
}

export function normalizeTypeSafeResponse(bytes: Uint8Array, request: PreparedRequest): NormalizedTypeSafeResponse {
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return invalid("body is not valid UTF-8"); }
  let parsed: unknown;
  try { parsed = JSON.parse(decoded); }
  catch { return invalid("body is not valid JSON"); }
  if (!isRecord(parsed)) invalid("body must be an object");
  exactKeys(parsed, ["model", "answers"], ["usage"]);
  if (parsed.model !== NATIVE_MODEL || parsed.model !== request.model) invalid("observed model does not match the fixed requested model");
  if (!isRecord(parsed.answers)) invalid("answers must be an object");
  const expected = Object.keys(request.questionMap);
  const received = Object.keys(parsed.answers);
  if (received.length !== expected.length || expected.some((id) => !(id in parsed.answers))) {
    invalid("answers do not match the complete expected question set");
  }
  const answers: Record<string, CanonicalAnswer> = {};
  for (const id of expected) {
    const question = request.questions[id];
    if (!question) invalid(`request has no schema for ${id}`);
    answers[id] = validateAnswer(parsed.answers[id], question, `answers.${id}`);
  }
  return Object.freeze({ model: NATIVE_MODEL, answers: Object.freeze(answers), usage: normalizeUsage(parsed.usage) });
}
