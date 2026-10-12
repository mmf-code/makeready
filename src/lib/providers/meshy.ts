import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { MAX_GLB_BYTES, MAX_IMAGE_BYTES, readBoundedBody } from "./download";
import { assertImageInput } from "./fal";
import { MESHY_ENDPOINT_ID, MESHY_MODEL_ID, ProviderError, type MeshyProviderJobRef, type ProviderJobRef, type ProviderResult, type ProviderStatus } from "./types";

const API = "https://api.meshy.ai/openapi/v1/image-to-3d";
const TaskId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const TaskStatus = z.object({
  id: TaskId,
  status: z.enum(["PENDING", "IN_PROGRESS", "SUCCEEDED", "FAILED", "CANCELED"]),
  consumed_credits: z.number().int().nonnegative().optional(),
});
const TaskResult = TaskStatus.extend({
  model_urls: z.object({ glb: z.string().min(1) }),
  thumbnail_url: z.string().nullable().optional(),
});

/** Only provider-returned assets from Meshy's documented download origin are accepted. */
export function assertMeshyAssetUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError("Invalid Meshy asset URL", "unsafe_url"); }
  if (url.protocol !== "https:" || url.hostname !== "assets.meshy.ai" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new ProviderError("Asset origin is not the allowed Meshy origin", "unsafe_url");
  }
  return url;
}

export function validateMeshyJobRef(job: ProviderJobRef): asserts job is MeshyProviderJobRef {
  if (job.provider !== "meshy" || job.operation !== "model" || job.endpointId !== MESHY_ENDPOINT_ID || job.modelId !== MESHY_MODEL_ID || !TaskId.safeParse(job.requestId).success) {
    throw new ProviderError("Invalid Meshy job reference", "invalid_result");
  }
  const canonical = `${API}/${job.requestId}`;
  if (job.statusUrl !== canonical || job.responseUrl !== canonical) throw new ProviderError("Invalid Meshy task URLs", "unsafe_url");
}

export function normalizeMeshyResult(job: ProviderJobRef, data: unknown): ProviderResult {
  validateMeshyJobRef(job);
  const status = TaskStatus.safeParse(data);
  if (!status.success || status.data.id !== job.requestId) throw new ProviderError("Invalid Meshy result receipt", "invalid_result");
  if (status.data.status === "FAILED" || status.data.status === "CANCELED") throw new ProviderError("Meshy generation did not succeed", "provider_failure");
  if (status.data.status !== "SUCCEEDED") throw new ProviderError("Meshy result is not complete", "transport");
  const result = TaskResult.safeParse(data);
  if (!result.success) throw new ProviderError("Meshy response contains no valid GLB", "invalid_result");
  return {
    job, imageUrls: [], glbUrl: assertMeshyAssetUrl(result.data.model_urls.glb).toString(),
    thumbnailUrl: result.data.thumbnail_url ? assertMeshyAssetUrl(result.data.thumbnail_url).toString() : undefined,
    consumedCredits: result.data.consumed_credits,
  };
}

export function createMeshyProvider(options: { apiKey?: string; fetch?: typeof fetch; now?: () => Date } = {}) {
  const doFetch = options.fetch ?? fetch;
  function key(): string {
    const value = options.apiKey ?? process.env.MESHY_API_KEY;
    if (!value?.trim()) throw new ProviderError("MESHY_API_KEY is not configured", "configuration");
    return value;
  }
  async function request(url: string, init: RequestInit, submission = false, result = false): Promise<Response> {
    const authorization = `Bearer ${key()}`;
    let response: Response;
    try {
      response = await doFetch(url, { ...init, headers: { ...init.headers, Authorization: authorization }, redirect: "error", cache: "no-store", signal: init.signal ?? AbortSignal.timeout(30_000) });
    } catch {
      throw new ProviderError(submission ? "Submission outcome is unknown; do not automatically submit again" : "Meshy polling connection failed; job may still be running", submission ? "submission_unknown" : "transport");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const ambiguous = submission && (response.status >= 500 || response.status === 408);
      const rejected = submission && response.status >= 400 && response.status < 500 && response.status !== 408;
      // Never read or expose a vendor error body; it may contain user input or signed URLs.
      throw new ProviderError(`Meshy request failed with HTTP ${response.status}`, ambiguous ? "submission_unknown" : rejected || result && [400, 422].includes(response.status) ? "provider_failure" : "transport", response.status);
    }
    return response;
  }
  async function json(response: Response): Promise<unknown> {
    try { return JSON.parse((await readBoundedBody(response, 2 * 1024 * 1024)).toString("utf8")); }
    catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError("Meshy returned invalid JSON", "invalid_result"); }
  }
  async function asset(value: string, maxBytes: number, timeout: number): Promise<Buffer> {
    const url = assertMeshyAssetUrl(value);
    let response: Response;
    try { response = await doFetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeout) }); }
    catch { throw new ProviderError("Meshy asset download connection failed", "transport"); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError("Meshy asset download failed", "transport", response.status);
    }
    return readBoundedBody(response, maxBytes);
  }
  return {
    async submitModel(input: { imageUrl: string; webhookUrl?: string }): Promise<MeshyProviderJobRef> {
      const imageUrl = assertImageInput(input.imageUrl);
      // One paid POST only. No SDK retries, fallback submissions, or ambiguous receipt retries.
      const response = await request(API, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_url: imageUrl, ai_model: MESHY_MODEL_ID, model_type: "standard",
          geometry_resolution: "standard", texture_resolution: "2k", should_remesh: true,
          topology: "triangle", target_polycount: 80_000, target_formats: ["glb"],
          should_texture: true, enable_pbr: false, image_enhancement: false,
        }),
      }, true);
      let body: unknown;
      try { body = await json(response); }
      catch { throw new ProviderError("Submission receipt could not be read; do not automatically submit again", "submission_unknown"); }
      const receipt = z.object({ result: TaskId }).safeParse(body);
      if (!receipt.success) throw new ProviderError("Submission returned no task ID; do not automatically submit again", "submission_unknown");
      const canonical = `${API}/${receipt.data.result}`;
      return { provider: "meshy", operation: "model", endpointId: MESHY_ENDPOINT_ID, modelId: MESHY_MODEL_ID, requestId: receipt.data.result, statusUrl: canonical, responseUrl: canonical, submittedAt: (options.now?.() ?? new Date()).toISOString() };
    },
    async poll(job: ProviderJobRef): Promise<ProviderStatus> {
      validateMeshyJobRef(job);
      const response = await request(job.statusUrl, { method: "GET" });
      const task = TaskStatus.safeParse(await json(response));
      if (!task.success || task.data.id !== job.requestId) throw new ProviderError("Invalid Meshy status receipt", "invalid_result");
      const state = task.data.status === "PENDING" ? "queued" : task.data.status === "IN_PROGRESS" ? "running" : task.data.status === "SUCCEEDED" ? "completed" : "failed";
      const after = Number(response.headers.get("retry-after"));
      return {
        job, state, rawStatus: task.data.status, consumedCredits: task.data.consumed_credits,
        error: state === "failed" ? task.data.status === "CANCELED" ? "Meshy generation was canceled" : "Meshy generation failed" : undefined,
        retryAfterSeconds: Number.isFinite(after) && after > 0 ? after : undefined,
      };
    },
    async getResult(job: ProviderJobRef): Promise<ProviderResult> {
      validateMeshyJobRef(job);
      return normalizeMeshyResult(job, await json(await request(job.responseUrl, { method: "GET" }, false, true)));
    },
    async downloadGlb(result: ProviderResult): Promise<{ bytes: Buffer; sha256: string }> {
      if (!result.glbUrl) throw new ProviderError("Meshy returned no GLB", "invalid_result");
      const bytes = await asset(result.glbUrl, MAX_GLB_BYTES, 60_000);
      if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "glTF" || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new ProviderError("Meshy asset is not a complete GLB v2", "invalid_result");
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    },
    async downloadImage(result: ProviderResult): Promise<{ bytes: Buffer; sha256: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }> {
      const value = result.imageUrls[0];
      if (!value) throw new ProviderError("Meshy returned no image", "invalid_result");
      const bytes = await asset(value, MAX_IMAGE_BYTES, 30_000);
      const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png" :
        bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg" :
        bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : undefined;
      if (!mimeType) throw new ProviderError("Meshy image has an unsupported file signature", "invalid_result");
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType };
    },
  };
}
