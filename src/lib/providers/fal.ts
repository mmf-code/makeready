import "server-only";
import { isIP } from "node:net";
import { z } from "zod";
import { assertFalAssetUrl, downloadOriginalGlb, downloadOriginalImage, readBoundedBody } from "./download";
import { FAL_ENDPOINTS, ProviderError, type FalOperation, type ProviderJobRef, type ProviderResult, type ProviderStatus } from "./types";

const RequestId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const FileResult = z.object({ url: z.string().url() });
const ImageResult = z.object({ images: z.array(FileResult).min(1) });
const ModelResult = z.object({ model_glb: FileResult, thumbnail: FileResult.optional() });

export function assertImageInput(value: string): string {
  if (/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value)) {
    if (value.length > 28 * 1024 * 1024) throw new ProviderError("Image input is too large", "asset_too_large");
    return value;
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError("Image must be a public HTTPS URL or image data URI", "unsafe_url"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
    isIP(url.hostname) || url.hostname.startsWith("[") ||
    !url.hostname.includes(".") || /\.(local|localhost|internal)$/.test(url.hostname)) {
    throw new ProviderError("Image input must be publicly accessible HTTPS", "unsafe_url");
  }
  return url.toString();
}

function queueBase(operation: FalOperation): string {
  return operation === "model" ? "https://queue.fal.run/fal-ai/hunyuan3d-v3" : "https://queue.fal.run/fal-ai/nano-banana";
}

export function validateJobRef(job: ProviderJobRef): void {
  if (job.provider !== "fal" || !(job.operation in FAL_ENDPOINTS) || job.endpointId !== FAL_ENDPOINTS[job.operation]) {
    throw new ProviderError("Invalid provider job reference", "invalid_result");
  }
  RequestId.parse(job.requestId);
  const prefix = `${queueBase(job.operation)}/requests/${job.requestId}`;
  if (job.statusUrl !== `${prefix}/status` || (job.responseUrl !== prefix && job.responseUrl !== `${prefix}/response`)) {
    throw new ProviderError("Invalid provider queue URLs", "unsafe_url");
  }
}

export function normalizeFalResult(job: ProviderJobRef, data: unknown): ProviderResult {
  validateJobRef(job);
  if (job.operation === "model") {
    const parsed = ModelResult.safeParse(data);
    if (!parsed.success) throw new ProviderError("Provider response contains no valid GLB", "invalid_result");
    const glbUrl = assertFalAssetUrl(parsed.data.model_glb.url).toString();
    const thumbnailUrl = parsed.data.thumbnail ? assertFalAssetUrl(parsed.data.thumbnail.url).toString() : undefined;
    return { job, glbUrl, thumbnailUrl, imageUrls: [] };
  }
  const parsed = ImageResult.safeParse(data);
  if (!parsed.success) throw new ProviderError("Provider response contains no image", "invalid_result");
  return { job, imageUrls: parsed.data.images.map((image) => assertFalAssetUrl(image.url).toString()) };
}

export function createFalProvider(options: { apiKey?: string; fetch?: typeof fetch; now?: () => Date } = {}) {
  const doFetch = options.fetch ?? fetch;
  function key(): string {
    const value = options.apiKey ?? process.env.FAL_KEY;
    if (!value) throw new ProviderError("FAL_KEY is not configured", "configuration");
    return value;
  }
  async function request(url: string, init: RequestInit, submission = false, result = false): Promise<Response> {
    const authorization = `Key ${key()}`;
    let response: Response;
    try {
      response = await doFetch(url, {
        ...init, headers: { ...init.headers, Authorization: authorization },
        redirect: "error", cache: "no-store", signal: init.signal ?? AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ProviderError(submission ? "Submission outcome is unknown; do not automatically submit again" : "Provider polling connection failed; job may still be running", submission ? "submission_unknown" : "transport");
    }
    if (!response.ok) {
      const ambiguousSubmission = submission && (response.status >= 500 || response.status === 408);
      const rejectedSubmission = submission && response.status >= 400 && response.status < 500 && response.status !== 408;
      throw new ProviderError(`fal request failed with HTTP ${response.status}`, ambiguousSubmission ? "submission_unknown" : rejectedSubmission || result && [400, 422].includes(response.status) ? "provider_failure" : "transport", response.status);
    }
    return response;
  }
  async function json(response: Response): Promise<unknown> {
    try { return JSON.parse((await readBoundedBody(response, 2 * 1024 * 1024)).toString("utf8")); }
    catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError("Provider returned invalid JSON", "invalid_result"); }
  }
  async function submit(operation: FalOperation, input: Record<string, unknown>, webhookUrl?: string): Promise<ProviderJobRef> {
    const endpointId = FAL_ENDPOINTS[operation];
    const url = new URL(`https://queue.fal.run/${endpointId}`);
    if (webhookUrl) {
      const webhook = new URL(webhookUrl);
      if (webhook.protocol !== "https:" || webhook.username || webhook.password) throw new ProviderError("Webhook must use HTTPS", "unsafe_url");
      url.searchParams.set("fal_webhook", webhook.toString());
    }
    // fal SDK queue.submit currently hardcodes retries. A single fetch avoids duplicate paid POSTs.
    const response = await request(url.toString(), {
      method: "POST", headers: { "Content-Type": "application/json", "X-Fal-No-Retry": "1" }, body: JSON.stringify(input),
    }, true);
    let body: unknown;
    try { body = await json(response); }
    catch { throw new ProviderError("Submission receipt could not be read; do not automatically submit again", "submission_unknown"); }
    const data = z.object({ request_id: RequestId, gateway_request_id: RequestId.optional(), response_url: z.string().url().optional() }).safeParse(body);
    if (!data.success) throw new ProviderError("Submission returned no request ID; do not automatically submit again", "submission_unknown");
    const prefix = `${queueBase(operation)}/requests/${data.data.request_id}`;
    const job: ProviderJobRef = {
      provider: "fal", operation, endpointId, requestId: data.data.request_id,
      gatewayRequestId: data.data.gateway_request_id,
      statusUrl: `${prefix}/status`, responseUrl: data.data.response_url ?? prefix,
      submittedAt: (options.now?.() ?? new Date()).toISOString(),
    };
    validateJobRef(job);
    return job;
  }
  return {
    submitConcept(input: { prompt: string; webhookUrl?: string }) {
      const prompt = z.string().min(1).max(8000).parse(input.prompt);
      return submit("concept", { prompt, num_images: 1, aspect_ratio: "1:1", output_format: "png" }, input.webhookUrl);
    },
    submitConceptEdit(input: { imageUrl: string; prompt: string; webhookUrl?: string }) {
      return submit("edit", { prompt: z.string().min(1).max(8000).parse(input.prompt), image_urls: [assertImageInput(input.imageUrl)], num_images: 1, output_format: "png", limit_generations: true }, input.webhookUrl);
    },
    submitModel(input: { imageUrl: string; webhookUrl?: string }) {
      return submit("model", { input_image_url: assertImageInput(input.imageUrl), face_count: 80_000, generate_type: "Normal", polygon_type: "triangle", enable_pbr: false }, input.webhookUrl);
    },
    async poll(job: ProviderJobRef): Promise<ProviderStatus> {
      validateJobRef(job);
      const response = await request(job.statusUrl, { method: "GET" });
      const data = z.object({ status: z.enum(["IN_QUEUE", "IN_PROGRESS", "COMPLETED"]), error: z.string().nullable().optional() }).safeParse(await json(response));
      if (!data.success) throw new ProviderError("Invalid provider status response", "invalid_result");
      const state = data.data.error ? "failed" : data.data.status === "IN_QUEUE" ? "queued" : data.data.status === "IN_PROGRESS" ? "running" : "completed";
      const after = Number(response.headers.get("retry-after"));
      return { job, state, rawStatus: data.data.status, error: data.data.error?.slice(0,500), retryAfterSeconds: Number.isFinite(after) && after > 0 ? after : undefined };
    },
    async getResult(job: ProviderJobRef): Promise<ProviderResult> {
      validateJobRef(job);
      return normalizeFalResult(job, await json(await request(job.responseUrl, { method: "GET" }, false, true)));
    },
    downloadGlb(result: ProviderResult) { return downloadOriginalGlb(result, { fetch: doFetch }); },
    downloadImage(result: ProviderResult) { return downloadOriginalImage(result, { fetch: doFetch }); },
    async uploadImage(file: File): Promise<string> {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 20 * 1024 * 1024) throw new ProviderError("Upload must be PNG, JPEG or WebP up to 20 MB", "invalid_result");
      const { createFalClient } = await import("@fal-ai/client");
      const client = createFalClient({ credentials: key(), fetch: doFetch, retry: { maxRetries: 0 } });
      return assertFalAssetUrl(await client.storage.upload(file)).toString();
    },
  };
}
