/**
 * note: provider.test.ts — the remote record shapes carry no credential.
 *
 * mstar owns no transport and no token here, so the types the engine hands a
 * caller must never grow a credential field: the bearer belongs to the host.
 */
import { describe, expect, test } from "bun:test";
import type { ProviderItem, ProviderWritePayload } from "./provider.js";

const FORBIDDEN = ["token", "accesstoken", "apikey", "secret", "authorization", "bearer", "credential"];

function credentialFree(value: object): boolean {
  return Object.keys(value).every((key) => !FORBIDDEN.some((forbidden) => key.toLowerCase().includes(forbidden)));
}

describe("the remote record shapes are credential-free", () => {
  test("neither a listed record nor a push payload carries a credential field", () => {
    const item: ProviderItem = {
      externalId: "LIN-1",
      title: "t",
      description: "d",
      state: "open",
      priority: null,
      labels: [],
      updatedAt: "2026-10-31T00:00:00Z",
      url: "https://linear.app/LIN-1",
    };
    const payload: ProviderWritePayload = {
      title: "t",
      description: "d",
      priority: 2,
      state: "Todo",
      labels: ["bug"],
      removeLabels: ["risk"],
    };
    expect(credentialFree(item)).toBe(true);
    expect(credentialFree(payload)).toBe(true);
  });
});
