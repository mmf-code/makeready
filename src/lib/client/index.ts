import { z } from "zod";
import {
  AccessInputSchema, AccessResultSchema, ArtifactRefSchema, CompleteUploadInputSchema,
  CreateSessionInputSchema, DecisionInputSchema, DesignSessionSchema, ExecutePlanInputSchema,
  GenerateModelInputSchema, GenerationJobSchema, HumanDecisionSchema, MakePackageResultSchema,
  PlanRevisionInputSchema, RevisionPlanSchema, StartDesignInputSchema, StartDesignResultSchema,
  UploadGrantSchema, UploadInputSchema,
  type ArtifactRef, type DesignSession, type GenerationJob, type ProgressEvent,
} from "../contracts";
import { createIndexedDbCache, type MakeReadyCache } from "./cache";
import { MakeReadyClientError } from "./errors";
import { createTransport, type ClientOptions, type RequestOptions } from "./http";
import { pollExisting, type PollingOptions } from "./polling";

export { MakeReadyClientError } from "./errors";
export { createIndexedDbCache } from "./cache";
export type { MakeReadyCache, CacheEntry } from "./cache";
export type { ClientOptions, RequestOptions } from "./http";
export type { PollingOptions } from "./polling";

export interface MakeReadyClientOptions extends ClientOptions {
  cache?: MakeReadyCache | false;
  onCacheError?: (error: unknown) => void;
}

export interface UploadSourceOptions extends RequestOptions {
  fileName: string;
  onProgress?: (event: ProgressEvent) => void;
}

/** Browser/Node-safe typed transport. No React and no provider credentials. */
export function createClient(options: MakeReadyClientOptions = {}) {
  const request = createTransport(options);
  const cache = options.cache === false ? undefined : options.cache ?? createIndexedDbCache();
  const fetch = options.fetch ?? globalThis.fetch;
  const post = <T>(path: string, schema: z.ZodType<T>, body: unknown, requestOptions?: RequestOptions, submission = false) =>
    request(path, schema, { ...requestOptions, method: "POST", body, submission });
  const ignoreCacheFailure = (error: unknown) => { options.onCacheError?.(error); };

  const client = {
    async createSession(input: z.input<typeof CreateSessionInputSchema> = {}, requestOptions?: RequestOptions) {
      return post("/api/sessions", DesignSessionSchema, parseInput(CreateSessionInputSchema, input), requestOptions);
    },
    async getSession(sessionId: string, requestOptions?: RequestOptions): Promise<DesignSession> {
      const session = await request(`/api/sessions/${validId(sessionId)}`, DesignSessionSchema, requestOptions);
      if (cache) await cache.put("sessions", session.id, session).catch(ignoreCacheFailure);
      return session;
    },
    async startDesign(input: z.input<typeof StartDesignInputSchema>, requestOptions?: RequestOptions) {
      return post("/api/designs/start", StartDesignResultSchema, parseInput(StartDesignInputSchema, input), requestOptions, true);
    },
    async planRevision(input: z.input<typeof PlanRevisionInputSchema>, requestOptions?: RequestOptions) {
      return post("/api/revisions/plan", RevisionPlanSchema, parseInput(PlanRevisionInputSchema, input), requestOptions, true);
    },
    async executePlan(input: z.input<typeof ExecutePlanInputSchema>, requestOptions?: RequestOptions) {
      const parsed = parseInput(ExecutePlanInputSchema, input);
      return post(`/api/plans/${parsed.planId}/execute`, GenerationJobSchema, parsed, requestOptions, true);
    },
    async decideRevision(input: z.input<typeof DecisionInputSchema>, requestOptions?: RequestOptions) {
      const parsed = parseInput(DecisionInputSchema, input);
      return post(`/api/revisions/${parsed.revisionId}/decision`, HumanDecisionSchema, parsed, requestOptions);
    },
    async generateModel(input: z.input<typeof GenerateModelInputSchema>, requestOptions?: RequestOptions) {
      const parsed = parseInput(GenerateModelInputSchema, input);
      return post(`/api/revisions/${parsed.revisionId}/model`, GenerationJobSchema, parsed, requestOptions, true);
    },
    async getMakePackage(revisionId: string, requestOptions?: RequestOptions) {
      return request(`/api/revisions/${validId(revisionId)}/package`, MakePackageResultSchema, requestOptions);
    },
    async getJob(jobId: string, requestOptions?: RequestOptions) {
      return request(`/api/jobs/${validId(jobId)}`, GenerationJobSchema, requestOptions);
    },
    async getStatus(jobId: string, requestOptions?: RequestOptions) {
      return request(`/api/status?jobId=${validId(jobId)}`, GenerationJobSchema, requestOptions);
    },
    async requestUpload(input: z.input<typeof UploadInputSchema>, requestOptions?: RequestOptions) {
      return post("/api/uploads", UploadGrantSchema, parseInput(UploadInputSchema, input), requestOptions);
    },
    async completeUpload(input: z.input<typeof CompleteUploadInputSchema>, requestOptions?: RequestOptions) {
      return post("/api/uploads/complete", ArtifactRefSchema, parseInput(CompleteUploadInputSchema, input), requestOptions);
    },
    async unlock(input: z.input<typeof AccessInputSchema>, requestOptions?: RequestOptions) {
      return post("/api/access", AccessResultSchema, parseInput(AccessInputSchema, input), requestOptions);
    },
    async pollJob(jobId: string, pollingOptions: PollingOptions<GenerationJob> = {}) {
      validId(jobId);
      return pollExisting(
        () => client.getJob(jobId, { signal: pollingOptions.signal }),
        (job) => ["completed", "failed", "submission_unknown"].includes(job.status),
        pollingOptions,
      );
    },
    async getCachedSession(sessionId: string) {
      if (!cache) return undefined;
      const entry = await cache.get<unknown>("sessions", validId(sessionId));
      if (!entry) return;
      const parsed = DesignSessionSchema.safeParse(entry.value);
      if (!parsed.success) { await cache.remove("sessions", sessionId); return; }
      return { value: parsed.data, cachedAt: entry.cachedAt };
    },
    async uploadSourceImage(sessionId: string, file: Blob, uploadOptions: UploadSourceOptions): Promise<ArtifactRef> {
      const mimeType = file.type as z.infer<typeof UploadInputSchema>["mimeType"];
      uploadOptions.onProgress?.({ stage: "uploading", progress: null, message: "Hashing the source image." });
      const sha256 = await hashBlob(file);
      const grant = await client.requestUpload({ sessionId, fileName: uploadOptions.fileName, mimeType, sizeBytes: file.size, sha256 }, uploadOptions);
      uploadOptions.onProgress?.({ stage: "uploading", progress: null, message: "Uploading the original image directly to private storage." });
      let response: Response;
      try {
        response = await fetch(grant.signedUrl, {
          method: "PUT", headers: { "Content-Type": mimeType }, body: file,
          credentials: "omit", signal: uploadOptions.signal,
        });
      } catch (cause) {
        throw new MakeReadyClientError("UPLOAD_INTERRUPTED", "The upload acknowledgement was lost. Try completing this upload before requesting a new one.", {
          details: { artifactId: grant.artifactId, sessionId }, cause,
        });
      }
      if (!response.ok) throw new MakeReadyClientError("STORAGE_FAILED", "The source image could not be uploaded.", { status: response.status, details: { artifactId: grant.artifactId, sessionId } });
      uploadOptions.onProgress?.({ stage: "verifying", progress: null, message: "The server is verifying the stored image hash and format." });
      const artifact = await client.completeUpload({ artifactId: grant.artifactId, sessionId }, uploadOptions);
      if (artifact.sha256 !== sha256 || artifact.sizeBytes !== file.size || artifact.sessionId !== sessionId || artifact.id !== grant.artifactId) {
        throw new MakeReadyClientError("INVALID_ARTIFACT", "The verified upload reference does not match the source image.");
      }
      if (cache) await cache.put("artifacts", artifact.sha256, file).catch(ignoreCacheFailure);
      uploadOptions.onProgress?.({ stage: "completed", progress: 100, message: "The source image has been stored and verified." });
      return artifact;
    },
    async getArtifactBlob(artifactInput: ArtifactRef, requestOptions?: RequestOptions): Promise<Blob> {
      const artifact = parseInput(ArtifactRefSchema, artifactInput);
      const cached = cache ? await cache.get<Blob>("artifacts", artifact.sha256).catch((error) => { ignoreCacheFailure(error); return undefined; }) : undefined;
      if (cached?.value instanceof Blob && cached.value.size === artifact.sizeBytes && await hashBlob(cached.value) === artifact.sha256) return cached.value;
      if (!artifact.url) throw new MakeReadyClientError("ARTIFACT_UNAVAILABLE", "Reload the session to obtain a signed artifact URL.");
      const response = await fetch(artifact.url, { credentials: "omit", signal: requestOptions?.signal });
      if (!response.ok) throw new MakeReadyClientError("ARTIFACT_UNAVAILABLE", "The artifact could not be downloaded. Reload the session for a fresh URL.", { status: response.status });
      const blob = await response.blob();
      if (blob.size !== artifact.sizeBytes || await hashBlob(blob) !== artifact.sha256) throw new MakeReadyClientError("INVALID_ARTIFACT", "Downloaded bytes do not match the stored artifact hash and size.");
      if (cache) await cache.put("artifacts", artifact.sha256, blob).catch(ignoreCacheFailure);
      return blob;
    },
    clearCache() { return cache?.clear() ?? Promise.resolve(); },
  };
  return client;
}

export type MakeReadyClient = ReturnType<typeof createClient>;

// These helpers use same-origin HTTP; call createClient for a custom fetch/base URL.
const defaultClient = createClient();
export const { createSession, getSession, startDesign, planRevision, executePlan, decideRevision,
  generateModel, getMakePackage, getJob, getStatus, requestUpload, completeUpload, unlock,
  pollJob, getCachedSession, uploadSourceImage, getArtifactBlob, clearCache } = defaultClient;

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new MakeReadyClientError("INVALID_INPUT", "The request does not match the MakeReady contract.", { details: parsed.error.issues });
  return parsed.data;
}

function validId(value: string): string { return parseInput(z.uuid(), value); }

async function hashBlob(blob: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new MakeReadyClientError("HASH_UNAVAILABLE", "Artifact verification requires Web Crypto in a secure context.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
