import type { z } from "zod";
import { MakeReadyClientError, abortedError } from "./errors";

export interface ClientOptions {
  /** Empty by default: API calls use the current origin. Never include an MCP secret. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export type ClientTransport = <T>(
  path: string,
  schema: z.ZodType<T>,
  options?: RequestOptions & {
    method?: "GET" | "POST" | "DELETE";
    body?: unknown;
    /** A lost acknowledgment may have started paid work: do not auto-retry. */
    submission?: boolean;
  },
) => Promise<T>;

export function createTransport(options: ClientOptions = {}): ClientTransport {
  const baseUrl = options.baseUrl?.replace(/\/$/, "") ?? "";
  return async <T>(
    path: string,
    schema: z.ZodType<T>,
    request: RequestOptions & {
      method?: "GET" | "POST" | "DELETE";
      body?: unknown;
      submission?: boolean;
    } = {},
  ): Promise<T> => {
    if (!path.startsWith("/api/") || path.includes("..")) {
      throw new MakeReadyClientError("INVALID_ROUTE", "Invalid MakeReady API route.");
    }
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (request.body !== undefined) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await (options.fetch ?? globalThis.fetch)(`${baseUrl}${path}`, {
        method: request.method ?? "GET",
        headers,
        credentials: "include",
        cache: "no-store",
        signal: request.signal,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
    } catch (cause) {
      if (request.submission) {
        throw new MakeReadyClientError(
          "TRANSPORT_AMBIGUOUS",
          "The request may have been accepted. Reconcile its idempotency key before submitting again.",
          { cause },
        );
      }
      if (request.signal?.aborted) throw abortedError(cause);
      throw new MakeReadyClientError("NETWORK_ERROR", "MakeReady could not be reached.", {
        retryable: true,
        cause,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new MakeReadyClientError(
        request.submission ? "TRANSPORT_AMBIGUOUS" : "INVALID_RESPONSE",
        request.submission
          ? "The server response was unreadable. Reconcile before submitting again."
          : "The server returned an unreadable response.",
        { status: response.status, cause },
      );
    }

    if (!response.ok) {
      const envelope = isRecord(payload) ? payload : {};
      const error = isRecord(envelope.error) ? envelope.error : envelope;
      throw new MakeReadyClientError(
        typeof error.code === "string" ? error.code : "HTTP_ERROR",
        typeof error.message === "string"
          ? error.message
          : `MakeReady returned HTTP ${response.status}.`,
        {
          status: response.status,
          retryable: error.retryable === true,
          details: error.details,
        },
      );
    }

    const parsed = schema.safeParse(isRecord(payload) && "data" in payload ? payload.data : undefined);
    if (!parsed.success) {
      throw new MakeReadyClientError("CONTRACT_MISMATCH", "The server response did not match the API contract.", {
        status: response.status,
        details: parsed.error.issues,
      });
    }
    return parsed.data;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
