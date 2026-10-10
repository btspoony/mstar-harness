/** Independently cut off a probe runner that ignores its timeout hint. */
export function withProbeAbort<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`Probe timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" })),
      timeoutMs,
    );
  });
  abort.catch(() => {}); // the losing branch must never surface as an unhandled rejection
  return Promise.race([pending, abort]).finally(() => clearTimeout(timer));
}
