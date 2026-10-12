/** Errors the UI can display without parsing provider or network messages. */
export class MakeReadyClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    options: {
      status?: number;
      retryable?: boolean;
      details?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "MakeReadyClientError";
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function abortedError(cause?: unknown): MakeReadyClientError {
  return new MakeReadyClientError(
    "POLLING_INTERRUPTED",
    "Waiting stopped. The server job continues; reopen it to resume polling.",
    { cause },
  );
}
