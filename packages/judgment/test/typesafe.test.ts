import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { NATIVE_ENDPOINT } from "../src/contracts.js";
import { sendNativeRequest, type NativeTransportInput } from "../src/typesafe.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const input = (overrides: Partial<NativeTransportInput> = {}) => ({
  requestBytes: bytes('{"prepared":true}'),
  credential: "runtime-secret",
  deadline: performance.now() + 1_000,
  maxResponseBytes: 128,
  ...overrides,
});
let fetchSpy: {
  mockRestore(): void;
  mockResolvedValue(value: Response): unknown;
  mock: { calls: [RequestInfo | URL, RequestInit?][] };
} | undefined;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
});

describe("one-attempt TypeSafe transport", () => {
  test("sends the exact prepared bytes to the fixed endpoint with bearer auth and returns bounded bytes and timing", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes('{"usage":{"input_tokens":4}}'), { status: 200 }));
    const request = input();
    const result = await sendNativeRequest(request);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(NATIVE_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(init?.headers).toEqual({ Authorization: "Bearer runtime-secret", "Content-Type": "application/json" });
    expect(init?.body).toBe(request.requestBytes);
    expect(result.responseBytes).toEqual(bytes('{"usage":{"input_tokens":4}}'));
    expect(result.status).toBe(200);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("refuses redirect and retryable or server error statuses after exactly one attempt without leaking secrets", async () => {
    for (const status of [302, 401, 422, 429, 500, 529]) {
      fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("provider-private-body", { status }));
      let diagnostic = "";
      try {
        await sendNativeRequest(input());
      } catch (error) {
        diagnostic = String(error);
      }
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(diagnostic).toContain(`HTTP ${status}`);
      expect(diagnostic).not.toContain("runtime-secret");
      expect(diagnostic).not.toContain("provider-private-body");
      fetchSpy.mockRestore();
      fetchSpy = undefined;
    }
  });

  test("terminates a stalled response body at its deadline", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream<Uint8Array>({})));
    await expect(sendNativeRequest(input({ deadline: performance.now() + 20 }))).rejects.toThrow("deadline exceeded");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("caller cancellation terminates a stalled response body", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream<Uint8Array>({})));
    const controller = new AbortController();
    const pending = sendNativeRequest(input({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toThrow("request cancelled");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("rejects overflow and truncated streams without returning partial bytes or raw provider diagnostics", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes("12345"));
        controller.close();
      },
    })));
    await expect(sendNativeRequest(input({ maxResponseBytes: 4 }))).rejects.toThrow("response exceeded byte reservation");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockRestore();
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes('{"incomplete":'));
        controller.error(new Error("provider-private-body runtime-secret"));
      },
    })));
    let diagnostic = "";
    try {
      await sendNativeRequest(input());
    } catch (error) {
      diagnostic = String(error);
    }
    expect(diagnostic).toContain("request failed");
    expect(diagnostic).not.toContain("provider-private-body");
    expect(diagnostic).not.toContain("runtime-secret");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("passes bounded malformed payload bytes through unchanged for downstream normalization", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes("{malformed"), { status: 200 }));
    const result = await sendNativeRequest(input());
    expect(result.responseBytes).toEqual(bytes("{malformed"));
  });
});
