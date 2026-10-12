import { MakeReadyClientError, abortedError } from "./errors";

export interface PollingOptions<T> {
  signal?: AbortSignal;
  intervalMs?: number;
  maxIntervalMs?: number;
  maxConsecutiveErrors?: number;
  onUpdate?: (value: T) => void;
  onPollingError?: (error: MakeReadyClientError, consecutiveErrors: number) => void;
}

/** Polls an existing job only. This function never submits or retries generation. */
export async function pollExisting<T>(
  read: () => Promise<T>,
  finished: (value: T) => boolean,
  options: PollingOptions<T> = {},
): Promise<T> {
  const intervalMs = Math.max(0, options.intervalMs ?? 2_000);
  const maxIntervalMs = Math.max(intervalMs, options.maxIntervalMs ?? 10_000);
  const maxErrors = Math.max(1, options.maxConsecutiveErrors ?? 3);
  let errors = 0;
  while (true) {
    if (options.signal?.aborted) throw abortedError(options.signal.reason);
    let value: T;
    try {
      value = await read();
    } catch (cause) {
      if (options.signal?.aborted) throw abortedError(cause);
      const error = cause instanceof MakeReadyClientError
        ? cause
        : new MakeReadyClientError("POLLING_FAILED", "The job could not be refreshed.", { cause });
      errors += 1;
      options.onPollingError?.(error, errors);
      if (!error.retryable || errors >= maxErrors) throw error;
      await abortableDelay(Math.min(maxIntervalMs, intervalMs * 2 ** (errors - 1)), options.signal);
      continue;
    }
    errors = 0;
    options.onUpdate?.(value);
    if (finished(value)) return value;
    await abortableDelay(intervalMs, options.signal);
  }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortedError(signal.reason)); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortedError(signal?.reason));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
