import { NATIVE_ENDPOINT } from "./contracts.js";

export type NativeTransportInput = Readonly<{
  requestBytes: Uint8Array;
  credential: string;
  signal?: AbortSignal;
  /** Absolute deadline measured with performance.now(). */
  deadline: number;
  /** Maximum response bytes reserved for this attempt. */
  maxResponseBytes: number;
}>;

export type NativeTransportResult = Readonly<{
  responseBytes: Uint8Array;
  status: number;
  elapsedMs: number;
}>;

function failure(message: string): never { throw new Error(`TypeSafe transport: ${message}`); }

export async function sendNativeRequest(input: NativeTransportInput): Promise<NativeTransportResult> {
  const startedAt = performance.now();
  if (!(input.requestBytes instanceof Uint8Array)) failure("invalid request bytes");
  if (typeof input.credential !== "string" || input.credential.length === 0) failure("credential unavailable");
  if (!Number.isFinite(input.deadline) || input.deadline <= startedAt) failure("deadline exceeded");
  if (!Number.isSafeInteger(input.maxResponseBytes) || input.maxResponseBytes < 1) failure("invalid response byte reservation");
  if (input.signal?.aborted) failure("request cancelled");

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort("cancelled");

  const timer = setTimeout(() => controller.abort("deadline"), Math.max(0, input.deadline - performance.now()));
  input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await Promise.race([fetch(NATIVE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.credential}`,
        "Content-Type": "application/json",
      },
      body: new Uint8Array(input.requestBytes),
      redirect: "manual",
      signal: controller.signal,
    }), aborted]);
    if (response.status < 200 || response.status >= 300) {
      if (response.body) void response.body.cancel().catch(() => {});
      failure(`request rejected with HTTP ${response.status}`);
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    if (response.body) {
      reader = response.body.getReader();
      while (true) {
        const { done, value } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > input.maxResponseBytes) {
          void reader.cancel().catch(() => {});
          failure("response exceeded byte reservation");
        }
        chunks.push(value);
      }
    }
    if (controller.signal.aborted) failure(controller.signal.reason === "deadline" ? "deadline exceeded" : "request cancelled");
    const responseBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      responseBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { responseBytes, status: response.status, elapsedMs: performance.now() - startedAt };
  } catch (error) {
    if (reader) void reader.cancel().catch(() => {});
    if (error instanceof Error && error.message.startsWith("TypeSafe transport:")) throw error;
    if (controller.signal.aborted) failure(controller.signal.reason === "deadline" ? "deadline exceeded" : "request cancelled");
    return failure("request failed");
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortFromCaller);
    controller.signal.removeEventListener("abort", onAbort);
    if (reader) reader.releaseLock();
  }
}
