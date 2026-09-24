import { describe, expect, test } from "bun:test";
import { NATIVE_MODEL, PROTOCOL_NUMERIC_TOLERANCE } from "../src/contracts.js";
import { normalizeTypeSafeResponse } from "../src/normalize.js";
import type { CanonicalQuestion, PreparedRequest } from "../src/review-advice.js";
import { A05_QUESTION } from "../src/review-advice.js";

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const baseChoice = {
  type: "choice",
  choice: "same_cause",
  probabilities: { same_cause: 0.8, different_cause: 0.1, insufficient_evidence: 0.1 },
  confidence: 0.75,
};
function syntheticRequest(questions: Record<string, CanonicalQuestion>): PreparedRequest {
  const questionMap = Object.fromEntries(Object.keys(questions).map((id) => [id, {
    taskId: id, useCase: "JEV-A05" as const, subjectIds: ["left", "right"] as const, workUnit: { id: "unit", revision: 1 },
  }]));
  return { bytes: new Uint8Array(), requestSha256: "", model: NATIVE_MODEL, questions, questionMap, packId: "pack", packSha256: "", pilotId: "pilot" };
}

describe("TypeSafe response normalization", () => {
  test("replays frozen official Choice response bytes as canonical output", () => {
    const request = syntheticRequest({ "a05_task-1": A05_QUESTION });
    const frozenBytes = new TextEncoder().encode('{"model":"jev-1.13.0","answers":{"a05_task-1":{"type":"choice","choice":"same_cause","probabilities":{"same_cause":0.8,"different_cause":0.1,"insufficient_evidence":0.1},"confidence":0.75}},"usage":{"input_tokens":123,"output_tokens":9}}');
    const first = normalizeTypeSafeResponse(frozenBytes, request);
    const second = normalizeTypeSafeResponse(frozenBytes, request);
    expect(first).toEqual(second);
    expect(first.answers["a05_task-1"]).toEqual(baseChoice);
    expect(first.usage).toEqual({ inputTokens: 123, outputTokens: 9 });
  });

  test("accepts maximal-label ties and tolerance-boundary distribution sums, but not nonmaximal labels", () => {
    const request = syntheticRequest({ "a05_task-1": A05_QUESTION });
    const nearSum = {
      type: "choice", choice: "same_cause",
      probabilities: { same_cause: 0.5, different_cause: 0.5, insufficient_evidence: PROTOCOL_NUMERIC_TOLERANCE * 0.9 }, confidence: 0.5,
    };
    const valid = normalizeTypeSafeResponse(encode({ model: NATIVE_MODEL, answers: { "a05_task-1": nearSum } }), request);
    expect(valid.answers["a05_task-1"].type).toBe("choice");
    expect(() => normalizeTypeSafeResponse(encode({ model: NATIVE_MODEL, answers: { "a05_task-1": { ...nearSum, choice: "insufficient_evidence" } } }), request)).toThrow("maximal label");
    expect(() => normalizeTypeSafeResponse(encode({ model: NATIVE_MODEL, answers: { "a05_task-1": {
      type: "choice", choice: "same_cause",
      probabilities: { same_cause: 0.4999995, different_cause: 0.5000005, insufficient_evidence: 0 }, confidence: 0.5,
    } } }), request)).toThrow("maximal label");
    expect(() => normalizeTypeSafeResponse(encode({ model: NATIVE_MODEL, answers: { "a05_task-1": { ...baseChoice, probabilities: { same_cause: 0.8, different_cause: 0.1, insufficient_evidence: 0.100002 } } } }), request)).toThrow("sum to 1");
  });

  test("rejects the whole response when any expected answer is malformed or missing", () => {
    const request = syntheticRequest({ one: { type: "choice", instructions: "fixed", criteria: { yes: "", no: "" } }, two: { type: "choice", instructions: "fixed", criteria: { yes: "", no: "" } } });
    const answer = { type: "choice", choice: "yes", probabilities: { yes: 0.7, no: 0.3 }, confidence: 0.7 };
    expect(() => normalizeTypeSafeResponse(encode({ model: NATIVE_MODEL, answers: { one: answer, two: { ...answer, choice: "other" } } }), request)).toThrow("allowed label");
    expect(() => normalizeTypeSafeResponse(encode({ model: NATIVE_MODEL, answers: { one: answer } }), request)).toThrow("complete expected question set");
    expect(() => normalizeTypeSafeResponse(encode({ model: NATIVE_MODEL, answers: { one: answer, two: answer, extra: answer } }), request)).toThrow("complete expected question set");
  });

  test("supports Noul without confidence and validates Score legend and expectation", () => {
    const noulRequest = syntheticRequest({ noul: { type: "noul", instructions: "fixed" } });
    expect(normalizeTypeSafeResponse(encode({ model: NATIVE_MODEL, answers: { noul: { type: "noul", noul: 0.25 } } }), noulRequest).answers.noul).toEqual({ type: "noul", noul: 0.25 });
    expect(() => normalizeTypeSafeResponse(encode({ model: NATIVE_MODEL, answers: { noul: { type: "noul", noul: 0.25, confidence: 0.9 } } }), noulRequest)).toThrow("unexpected field");

    const scoreRequest = syntheticRequest({ score: { type: "score", instructions: "fixed", criteria: ["low", "middle", "high"] } });
    const score = { type: "score", score: 0.4, legend: { "0": "low", "1": "middle", "2": "high" }, probabilities: { "0": 0.7, "1": 0.2, "2": 0.1 }, confidence: 0.7 };
    expect(normalizeTypeSafeResponse(encode({ model: NATIVE_MODEL, answers: { score } }), scoreRequest).answers.score).toEqual(score);
    expect(() => normalizeTypeSafeResponse(encode({ model: NATIVE_MODEL, answers: { score: { ...score, score: 0.61 } } }), scoreRequest)).toThrow("expectation");
  });

  test("keeps genuinely absent usage unknown and rejects malformed present usage", () => {
    const request = syntheticRequest({ "a05_task-1": A05_QUESTION });
    expect(normalizeTypeSafeResponse(encode({ model: NATIVE_MODEL, answers: { "a05_task-1": baseChoice } }), request).usage).toBeNull();
    for (const usage of [
      { input_tokens: "unknown", output_tokens: 2 },
      { input_tokens: -1, output_tokens: 2 },
      { input_tokens: 1, output_tokens: 2, extra: 3 },
    ]) {
      expect(() => normalizeTypeSafeResponse(encode({ model: NATIVE_MODEL, answers: { "a05_task-1": baseChoice }, usage }), request)).toThrow("usage");
    }
    expect(() => normalizeTypeSafeResponse(encode({ model: "jev-latest", answers: { "a05_task-1": baseChoice } }), request)).toThrow("observed model");
  });
});
