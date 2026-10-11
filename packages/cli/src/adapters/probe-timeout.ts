/** A runner promise may expose an abort hook for an underlying process. */
type AbortablePromise<T> = Promise<T> & { abort?: () => void };

/** Independently cut off a probe runner that ignores its timeout hint. */
export function withProbeAbort<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortable = pending as AbortablePromise<T>;
  const timeout = Promise.withResolvers<never>();
  timer = setTimeout(() => {
    let cause: unknown;
    try {
      abortable.abort?.();
    } catch (error) {
      cause = error;
    }
    const failure = Object.assign(new Error(`Probe timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT", cause });
    timeout.reject(failure);
  }, timeoutMs);
  timeout.promise.catch(() => {}); // the losing branch must never surface as an unhandled rejection
  return Promise.race([pending, timeout.promise]).finally(() => clearTimeout(timer));
}
