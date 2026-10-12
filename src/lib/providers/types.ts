export const FAL_ENDPOINTS = {
  concept: "fal-ai/nano-banana",
  edit: "fal-ai/nano-banana/edit",
  model: "fal-ai/hunyuan3d-v3/image-to-3d",
} as const;

export type FalOperation = keyof typeof FAL_ENDPOINTS;
export const MESHY_MODEL_ID = "meshy-7.1" as const;
export const MESHY_ENDPOINT_ID = "meshy/image-to-3d" as const;

interface ProviderJobBase {
  requestId: string;
  gatewayRequestId?: string;
  statusUrl: string;
  responseUrl: string;
  submittedAt: string;
}
export interface FalProviderJobRef extends ProviderJobBase {
  provider: "fal";
  operation: FalOperation;
  endpointId: (typeof FAL_ENDPOINTS)[FalOperation];
}
export interface MeshyProviderJobRef extends ProviderJobBase {
  provider: "meshy";
  operation: "model";
  endpointId: typeof MESHY_ENDPOINT_ID;
  modelId: typeof MESHY_MODEL_ID;
}
export type ProviderJobRef = FalProviderJobRef | MeshyProviderJobRef;

export type ProviderStatus = {
  job: ProviderJobRef;
  state: "queued" | "running" | "completed" | "failed";
  rawStatus: string;
  error?: string;
  retryAfterSeconds?: number;
  /** Meshy task-reported credits. Never an inferred USD amount. */
  consumedCredits?: number;
};

export type ProviderResult = {
  job: ProviderJobRef;
  imageUrls: string[];
  glbUrl?: string;
  thumbnailUrl?: string;
  /** Meshy task-reported credits. Never an inferred USD amount. */
  consumedCredits?: number;
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
