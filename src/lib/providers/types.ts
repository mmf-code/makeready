export const FAL_ENDPOINTS = {
  concept: "fal-ai/nano-banana",
  edit: "fal-ai/nano-banana/edit",
  model: "fal-ai/hunyuan3d-v3/image-to-3d",
} as const;

export type FalOperation = keyof typeof FAL_ENDPOINTS;
export interface ProviderJobRef {
  provider: "fal";
  operation: FalOperation;
  endpointId: (typeof FAL_ENDPOINTS)[FalOperation];
  requestId: string;
  gatewayRequestId?: string;
  statusUrl: string;
  responseUrl: string;
  submittedAt: string;
}

export type ProviderStatus = {
  job: ProviderJobRef;
  state: "queued" | "running" | "completed" | "failed";
  rawStatus: string;
  error?: string;
  retryAfterSeconds?: number;
};

export type ProviderResult = {
  job: ProviderJobRef;
  imageUrls: string[];
  glbUrl?: string;
  thumbnailUrl?: string;
};

/** Finite, value-free failure evidence safe to expose alongside a durable job receipt. */
export type ProviderDiagnosticCode =
  | "INTELLIGENCE_INCOMPLETE"
  | "INTELLIGENCE_NO_TEXT"
  | "INTELLIGENCE_INVALID_JSON"
  | "INTELLIGENCE_SCHEMA_MISMATCH"
  | "REVISION_ACTION_TARGET_MISMATCH";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "configuration"
      | "transport"
      | "submission_unknown"
      | "provider_failure"
      | "invalid_result"
      | "unsafe_url"
      | "asset_too_large",
    public readonly httpStatus?: number,
    public readonly diagnosticCode?: ProviderDiagnosticCode,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
