import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ArtifactRefSchema, DesignSpecSchema, GenerationJobSchema, PhysicalAuditSchema,
  RevisionPlanSchema, RevisionSchema, StartDesignInputSchema,
  type ApiError, type ArtifactRef, type DesignSpec, type GenerationJob, type Revision,
} from "./contracts";
import { checked, getDb, rpc } from "./db";
import { AppError } from "./errors";
import { GeometryPreparationError, prepareModel, type PreparedModel } from "./geometry";
import { evaluateRevision } from "./harness/evaluate";
import { makePackage } from "./make-package";
import {
  assertImageInput, createDesignIntelligence, createFalProvider, isIntelligenceConfigured, MAX_IMAGE_BYTES, ProviderError, VisualCritiqueSchema,
  type IntelligenceResponseMetadata, type ProviderJobRef, type ProviderResult,
} from "./providers";
import { readArtifact, signedArtifact, storeArtifact } from "./storage";

const PayloadSchema = z.object({
  input: z.unknown(), spec: DesignSpecSchema.optional(), parent: RevisionSchema.optional(),
  plan: RevisionPlanSchema.optional(), sourceImage: ArtifactRefSchema.optional(),
  parentRevisionId: z.uuid().optional(), sourceImageArtifactId: z.uuid().optional(), sourceGlbArtifactId: z.uuid().optional(),
  revisionId: z.uuid().optional(), revisionCreatedAt: z.iso.datetime().optional(), dispatchInFlight: z.boolean().optional(),
  sourceImageArtifact: ArtifactRefSchema.optional(), sourceGlbArtifact: ArtifactRefSchema.optional(),
  modelGlbArtifact: ArtifactRefSchema.optional(), stlArtifact: ArtifactRefSchema.optional(),
  auditArtifact: ArtifactRefSchema.optional(), manifestArtifact: ArtifactRefSchema.optional(), packageArtifact: ArtifactRefSchema.optional(),
  previewArtifact: ArtifactRefSchema.optional(),
  visual: VisualCritiqueSchema.optional(), visualModel: z.string().min(1).optional(), evaluationComplete: z.boolean().optional(),
}).passthrough();
type Payload = z.infer<typeof PayloadSchema>;
type JobRow = {
  id: string; session_id: string; fence: number; data: GenerationJob;
  payload: Payload; provider_ref: ProviderJobRef | null;
};
const TERMINAL = ["completed", "failed", "submission_unknown"];

function webhookEndpoint(): string | undefined {
  if (!process.env.APP_URL) return undefined;
  try { return assertImageInput(new URL("/api/webhooks/fal", process.env.APP_URL).toString()); }
  catch { return undefined; } // Local development has no publicly reachable webhook; cron polling remains available.
}

function errorData(error: unknown): ApiError {
  if (error instanceof AppError) return error.toJSON();
  if (error instanceof GeometryPreparationError) return { code: "UNSUPPORTED_GEOMETRY", message: error.message, retryable: false };
  if (error instanceof ProviderError) {
    const code: ApiError["code"] = error.kind === "submission_unknown" ? "SUBMISSION_UNKNOWN" :
      error.kind === "configuration" ? "PROVIDER_UNAVAILABLE" : error.kind === "transport" ? "PROVIDER_UNAVAILABLE" :
        ["unsafe_url", "asset_too_large", "invalid_result"].includes(error.kind) ? "INVALID_ARTIFACT" : "PROVIDER_FAILED";
    return { code, message: error.message, retryable: error.kind === "transport" };
  }
  if (error instanceof z.ZodError) return { code: "INVALID_INPUT", message: "The job payload does not match the MakeReady contract.", retryable: false };
  return { code: "INTERNAL_ERROR", message: "The executor could not complete this stage.", retryable: false };
}

async function artifactById(id: string, sessionId: string): Promise<ArtifactRef> {
  const row = await checked(getDb().from("make_artifacts").select("data").eq("id", id).eq("session_id", sessionId).eq("verified", true).single());
  return ArtifactRefSchema.parse(row.data);
}

/** Projections are idempotent; a crash after mr_finish_job is recovered by reconciliation. */
async function projectCompleted(row: JobRow): Promise<void> {
  if (row.payload.evaluationComplete || !row.data.result?.revisionId) return;
  const record = await checked(getDb().from("design_records").select("data").eq("id", row.data.result.revisionId).eq("session_id", row.session_id).eq("kind", "revision").single());
  await evaluateRevision(RevisionSchema.parse(record.data), row.payload.plan, row.payload.visual, row.payload.visualModel);
  await checked(getDb().from("generation_jobs").update({ payload: { ...row.payload, evaluationComplete: true } }).eq("id", row.id).eq("data->>status", "completed").select("id").single());
}

/** Advances one leased job through bounded stages; queue waiting never holds the lease. */
export async function advanceJob(jobId: string): Promise<void> {
  z.uuid().parse(jobId);
  const claimed = await rpc<JobRow | null>("mr_claim_job", { p_id: jobId, p_owner: randomUUID() });
  if (!claimed) {
    const { data, error } = await getDb().from("generation_jobs").select("*").eq("id", jobId).maybeSingle();
    if (!error && data?.data?.status === "completed") await projectCompleted({ ...data, data: GenerationJobSchema.parse(data.data), payload: PayloadSchema.parse(data.payload) });
    return;
  }
  let row: JobRow;
  try { row = { ...claimed, data: GenerationJobSchema.parse(claimed.data), payload: PayloadSchema.parse(claimed.payload) }; }
  catch (error) {
    await rpc("mr_fail_job", { p_id: jobId, p_fence: claimed.fence, p_error: errorData(error), p_unknown: false });
    await rpc("mr_release_job", { p_id: jobId, p_fence: claimed.fence });
    return;
  }
  let finished = false;
  async function checkpoint(patch: Partial<GenerationJob> = {}, payload: Record<string, unknown> = {}, providerRef?: ProviderJobRef) {
    await rpc("mr_patch_job", { p_id: row.id, p_fence: row.fence, p_patch: patch, p_payload: payload, p_provider_ref: providerRef ?? null });
    row.data = { ...row.data, ...patch };
    row.payload = { ...row.payload, ...payload };
    if (providerRef) row.provider_ref = providerRef;
  }
  async function paid<T>(name: string, operation: () => Promise<T>, save: (result: T) => Record<string, unknown>): Promise<T> {
    await checkpoint({ attempts: row.data.attempts + 1, error: null }, { dispatchInFlight: true, dispatchStage: name });
    const result = await operation();
    await checkpoint({}, { ...save(result), dispatchInFlight: false });
    return result;
  }
  function intelligence() {
    return createDesignIntelligence({ onResponse: async (metadata: IntelligenceResponseMetadata) => {
      await checkpoint(row.provider_ref ? {} : { providerRequestId: metadata.responseId, provider: process.env.LLM_BASE_URL?.trim() ? null : "openai" }, {
        [`${metadata.operation}Usage`]: metadata,
        ...(metadata.operation === "visual_critique" ? { visualModel: metadata.model } : {}),
      });
    } });
  }
  async function storeOnce(key: keyof Payload, kind: ArtifactRef["kind"], bytes: Uint8Array, mime: string, ext: string, units: ArtifactRef["units"] = "none", axis: ArtifactRef["axis"] = "none"): Promise<ArtifactRef> {
    const existing = row.payload[key];
    if (existing) return ArtifactRefSchema.parse(existing);
    const stored = await storeArtifact(row.session_id, kind, bytes, mime, ext, units, axis);
    await checkpoint({}, { [key]: stored });
    return stored;
  }
  async function imageUrl(ref: ArtifactRef): Promise<string> {
    if (ref.sessionId !== row.session_id) throw new AppError("INVALID_ARTIFACT", "Artifact/session mismatch.", 422);
    const signed = await signedArtifact(ref);
    if (!signed.url) throw new AppError("ARTIFACT_UNAVAILABLE", "Image download URL is unavailable.", 503, true);
    return signed.url;
  }
  async function imageData(ref: ArtifactRef): Promise<string> {
    if (ref.sessionId !== row.session_id || !["source_image", "concept_image"].includes(ref.kind) ||
      !["image/png", "image/jpeg", "image/webp"].includes(ref.mimeType) || ref.sizeBytes <= 0 || ref.sizeBytes > MAX_IMAGE_BYTES) {
      throw new AppError("INVALID_ARTIFACT", "The visual reference is not a supported image within the 20 MB limit.", 422);
    }
    // readArtifact verifies the bytes against the immutable artifact's hash and size.
    const bytes = await readArtifact(ref);
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new AppError("INVALID_ARTIFACT", "The visual reference exceeds the 20 MB limit.", 422);
    return `data:${ref.mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  }
  async function sourceImage(): Promise<ArtifactRef> {
    const ref = row.payload.sourceImage ?? (row.payload.sourceImageArtifactId ? await artifactById(row.payload.sourceImageArtifactId, row.session_id) : undefined) ??
      row.payload.parent?.artifacts.find((artifact) => artifact.kind === "concept_image" || artifact.kind === "source_image");
    if (!ref || !["source_image", "concept_image"].includes(ref.kind)) throw new AppError("INVALID_ARTIFACT", "This job requires a stored reference image.", 422);
    if (ref.sessionId !== row.session_id) throw new AppError("INVALID_ARTIFACT", "Artifact/session mismatch.", 422);
    return ref;
  }
  async function visual(candidate: ArtifactRef, spec: DesignSpec, reference?: ArtifactRef) {
    if (row.payload.visual) return;
    const parentImage = row.payload.parent?.artifacts.find((artifact) => artifact.kind === "concept_image" || artifact.kind === "source_image");
    const [candidateImageUrl, parentImageUrl, referenceImageUrl] = await Promise.all([
      imageData(candidate), parentImage ? imageData(parentImage) : undefined, reference ? imageData(reference) : undefined,
    ]);
    await paid("visual_critique", () => intelligence().critiqueVisual({ spec, candidateImageUrl, referenceImageUrl, parentImageUrl, requestedChange: row.payload.plan?.requestedChange }), (result) => ({ visual: result }));
  }
  async function finish(kind: Revision["kind"], spec: DesignSpec, artifacts: ArtifactRef[]) {
    const unique = [...new Map(artifacts.map((artifact) => [artifact.id, artifact])).values()];
    const revision = RevisionSchema.parse({
      id: row.payload.revisionId, sessionId: row.session_id, parentRevisionId: row.payload.parent?.id ?? row.payload.parentRevisionId ?? row.data.parentRevisionId,
      kind, spec, artifacts: unique, sourceJobId: row.id, createdAt: row.payload.revisionCreatedAt,
    });
    await checkpoint({ status: "verifying", progress: 95, error: null });
    await rpc("mr_finish_job", { p_id: row.id, p_fence: row.fence, p_record: revision, p_kind: "revision" });
    finished = true;
    await projectCompleted({ ...row, data: { ...row.data, status: "completed", result: { revisionId: revision.id } } });
  }

  try {
    if (TERMINAL.includes(row.data.status)) return;
    if (row.data.operation === "planning") {
      await rpc("mr_release_job", { p_id: row.id, p_fence: row.fence });
      const { resumePlanningJob } = await import("./services");
      await resumePlanningJob(row.id);
      return;
    }
    if (!row.payload.revisionId) await checkpoint({}, { revisionId: randomUUID(), revisionCreatedAt: new Date().toISOString() });
    if (!row.payload.revisionCreatedAt) await checkpoint({}, { revisionCreatedAt: new Date().toISOString() });
    let spec = row.payload.spec ?? row.payload.parent?.spec;
    if (row.data.operation === "concept" && row.payload.sourceImage) {
      const input = StartDesignInputSchema.parse(row.payload.input);
      spec = DesignSpecSchema.parse({ description: input.prompt, objectType: "Reference object", use: input.use, targetHeightMm: input.heightMm, preserve: [], changeable: [], process: "resin_candidate" });
      if (row.payload.specMethod !== "user_input") await checkpoint({ status: "preparing", provider: "local", providerRequestId: null, progress: 10 }, { spec, specComputed: true, specMethod: "user_input", visualMethod: "not_checked" });
    } else if (row.data.operation === "concept" && !row.payload.specComputed) {
      const input = StartDesignInputSchema.parse(row.payload.input);
      const reference = row.payload.sourceImage;
      const referenceImageUrl = reference ? await imageData(reference) : undefined;
      await checkpoint({ status: "planning", progress: 10 });
      spec = await paid("design_spec", () => intelligence().designSpec({ description: input.prompt, use: input.use, targetHeightMm: input.heightMm, referenceImageUrl }), (result) => ({ spec: result, specComputed: true }));
    }
    if (!spec) throw new AppError("INVALID_INPUT", "This job has no design specification.", 422);
    const scale = row.data.operation === "scale" || row.payload.plan?.action === "scale_geometry";
    if (scale) {
      if (!row.payload.plan?.targetHeightMm || !row.payload.parent || row.payload.parent.kind !== "manufacturing") throw new AppError("INVALID_INPUT", "A scale revision requires a manufacturing parent and target height.", 422);
      spec = { ...spec, targetHeightMm: row.payload.plan.targetHeightMm };
      await checkpoint({}, { spec });
    }
    const manufacturing = scale || row.data.operation === "model" || row.payload.plan?.action === "regenerate_model";
    const provider = createFalProvider();
    let providerResult = row.payload.providerResult as ProviderResult | undefined;

    if (!manufacturing && row.data.operation === "concept" && row.payload.sourceImage) {
      // An uploaded reference can be the initial concept; it remains actual user data.
      const original = row.payload.sourceImage;
      const bytes = await readArtifact(original);
      const ext = original.mimeType === "image/jpeg" ? "jpg" : original.mimeType === "image/webp" ? "webp" : "png";
      const concept = await storeOnce("sourceImageArtifact", "concept_image", bytes, original.mimeType, ext);
      await finish("concept", spec, [original, concept]);
      return;
    }

    if (!scale && !row.provider_ref && !row.payload.sourceImageArtifact && !row.payload.sourceGlbArtifact) {
      // The durable in-flight bit is written before the single paid queue POST.
      const reference = manufacturing || row.payload.plan ? await sourceImage() : undefined;
      const referenceUrl = reference ? await imageUrl(reference) : undefined;
      const webhookUrl = webhookEndpoint();
      await checkpoint({ status: "submitting", provider: "fal", progress: 20, attempts: row.data.attempts + 1, error: null }, { dispatchInFlight: true, dispatchStage: "fal_submit" });
      const ref = manufacturing ? await provider.submitModel({ imageUrl: referenceUrl!, webhookUrl }) : row.payload.plan ?
        await provider.submitConceptEdit({ imageUrl: referenceUrl!, prompt: `${row.payload.plan.interpretedIntent}\nPreserve: ${row.payload.plan.preserve.join("; ")}\nChange: ${row.payload.plan.requestedChange}\n${row.payload.plan.reason}`, webhookUrl }) :
        await provider.submitConcept({ prompt: `${spec.description}\nObject: ${spec.objectType}. Use: ${spec.use}.\nPreserve: ${spec.preserve.join("; ")}.\nSingle complete object, isolated neutral background, clear three-quarter view, suitable as a 3D reference.`, webhookUrl });
      await checkpoint({ status: "queued", providerRequestId: ref.requestId, provider: "fal", progress: 25 }, { dispatchInFlight: false }, ref);
      return;
    }

    if (!scale && !row.payload.sourceImageArtifact && !row.payload.sourceGlbArtifact) {
      if (!row.provider_ref) throw new AppError("INVALID_INPUT", "This job has no provider queue reference.", 422);
      if (!providerResult) {
        const status = await provider.poll(row.provider_ref);
        if (status.state === "failed") throw new ProviderError(status.error || "The provider could not generate this design.", "provider_failure");
        if (status.state !== "completed") {
          await checkpoint({ status: status.state === "queued" ? "queued" : "running", progress: status.state === "queued" ? 25 : 45, error: null });
          return;
        }
        providerResult = await provider.getResult(row.provider_ref);
        await checkpoint({ status: "ingesting", progress: 60, error: null }, { providerResult });
      }
      if (manufacturing) {
        const downloaded = await provider.downloadGlb(providerResult);
        await storeOnce("sourceGlbArtifact", "source_glb", downloaded.bytes, "model/gltf-binary", "glb", "m", "y_up");
      } else {
        const downloaded = await provider.downloadImage(providerResult);
        const ext = downloaded.mimeType === "image/jpeg" ? "jpg" : downloaded.mimeType === "image/webp" ? "webp" : "png";
        await storeOnce("sourceImageArtifact", "concept_image", downloaded.bytes, downloaded.mimeType, ext);
      }
    }

    if (!manufacturing) {
      const concept = ArtifactRefSchema.parse(row.payload.sourceImageArtifact);
      const reference = row.payload.sourceImage;
      await visual(concept, spec, reference);
      await finish("concept", spec, [concept, ...(reference ? [reference] : [])]);
      return;
    }

    let source = row.payload.sourceGlbArtifact;
    if (!source && scale) {
      source = row.payload.sourceGlbArtifactId ? await artifactById(row.payload.sourceGlbArtifactId, row.session_id) : row.payload.parent?.artifacts.find((artifact) => artifact.kind === "source_glb") ?? row.payload.parent?.artifacts.find((artifact) => artifact.kind === "model_glb");
      if (!source) throw new AppError("INVALID_ARTIFACT", "The parent has no stored geometry to scale.", 422);
      await checkpoint({}, { sourceGlbArtifact: source });
    }
    if (!source || source.sessionId !== row.session_id) throw new AppError("INVALID_ARTIFACT", "This job has no verified source geometry.", 422);
    await checkpoint({ status: "preparing", progress: 70, error: null });
    const model: PreparedModel = await prepareModel({ source: await readArtifact(source), targetHeightMm: spec.targetHeightMm });
    const normalized = await storeOnce("modelGlbArtifact", "model_glb", model.glb, "model/gltf-binary", "glb", "m", "y_up");
    const stl = await storeOnce("stlArtifact", "model_stl", model.stl, "model/stl", "stl", "mm", "z_up");
    if (source.sha256 !== model.hashes.source || normalized.sha256 !== model.hashes.glb || stl.sha256 !== model.hashes.stl) {
      throw new AppError("INVALID_ARTIFACT", "Prepared geometry hashes do not match the checkpointed artifacts.", 422);
    }
    if (row.payload.auditArtifact) model.audit = PhysicalAuditSchema.parse(JSON.parse(Buffer.from(await readArtifact(row.payload.auditArtifact)).toString("utf8")));
    if (model.audit.inputSha256 !== source.sha256 || model.audit.outputSha256.glb !== normalized.sha256 || model.audit.outputSha256.stl !== stl.sha256 || model.audit.targetHeightMm !== spec.targetHeightMm) {
      throw new AppError("INVALID_ARTIFACT", "The physical audit does not describe the prepared artifacts.", 422);
    }
    const audit = await storeOnce("auditArtifact", "audit", Buffer.from(JSON.stringify(model.audit, null, 2)), "application/json", "json");
    const manifestData = {
      schemaVersion: "makeready.make-package.v1", revisionId: row.payload.revisionId, parentRevisionId: row.payload.parent?.id ?? null,
      planId: row.payload.plan?.id ?? null, provider: row.provider_ref ?? null, spec,
      files: {
        "source.glb": { sha256: model.hashes.source, bytes: model.source.byteLength, purpose: "Exact original provider artifact" },
        "normalized.glb": { sha256: model.hashes.glb, bytes: model.glb.byteLength, units: "m", upAxis: "Y" },
        "model.stl": { sha256: model.hashes.stl, bytes: model.stl.byteLength, units: "mm", upAxis: "Z" },
      },
      physicalAuditStatus: model.geometryAudit.status, dimensionsMm: { width: model.bounds.width, height: model.bounds.height, depth: model.bounds.depth },
      provenance: model.provenance,
    };
    const manifest = await storeOnce("manifestArtifact", "manifest", Buffer.from(JSON.stringify(manifestData, null, 2)), "application/json", "json");
    const pack = row.payload.packageArtifact ?? await storeOnce("packageArtifact", "make_package", await makePackage(model, manifestData), "application/zip", "zip");
    const reference = row.payload.sourceImage ?? row.payload.parent?.artifacts.find((artifact) => artifact.kind === "concept_image" || artifact.kind === "source_image");
    // Bind preview-based visual evaluation to stored, hashed bytes, not an expiring provider URL.
    let preview = row.payload.previewArtifact;
    if (!scale && providerResult?.thumbnailUrl && process.env.ENABLE_MODEL_VISUAL_CRITIQUE === "true" && isIntelligenceConfigured()) {
      if (!preview) {
        const downloaded = await provider.downloadImage({ ...providerResult, imageUrls: [providerResult.thumbnailUrl] });
        const ext = downloaded.mimeType === "image/jpeg" ? "jpg" : downloaded.mimeType === "image/webp" ? "webp" : "png";
        preview = await storeOnce("previewArtifact", "concept_image", downloaded.bytes, downloaded.mimeType, ext);
      }
      await visual(preview, spec, reference);
    } else await checkpoint({}, { visualMethod: "not_checked" });
    await finish("manufacturing", spec, [source, normalized, stl, audit, manifest, pack, ...(reference ? [reference] : []), ...(preview ? [preview] : [])]);
  } catch (error) {
    if (finished) throw error; // Cron retries only the idempotent evaluation projection.
    const detail = errorData(error);
    const inFlight = row.payload.dispatchInFlight === true;
    const knownNoSubmission = error instanceof ProviderError && ["configuration", "invalid_result", "unsafe_url", "asset_too_large", "provider_failure"].includes(error.kind);
    const unknown = error instanceof ProviderError && error.kind === "submission_unknown" || inFlight && !knownNoSubmission;
    if (unknown) {
      await rpc("mr_fail_job", { p_id: row.id, p_fence: row.fence, p_error: { code: "SUBMISSION_UNKNOWN", message: "A paid request outcome could not be checkpointed. Automatic resubmission is disabled.", retryable: false }, p_unknown: true });
    } else if (detail.retryable && !inFlight) {
      await checkpoint({ error: detail }); // Existing queue and ingestion work will resume via cron.
    } else {
      await rpc("mr_fail_job", { p_id: row.id, p_fence: row.fence, p_error: detail, p_unknown: false });
    }
  } finally {
    if (!finished) await rpc("mr_release_job", { p_id: row.id, p_fence: row.fence });
  }
}

/** Durable cron path. At most ten rows, with at most two jobs executing concurrently. */
export async function reconcileJobs(): Promise<{ processed: number }> {
  const now = new Date().toISOString();
  const active = await checked(getDb().from("generation_jobs").select("id").not("data->>status", "in", "(completed,failed,submission_unknown)").or(`lease_until.is.null,lease_until.lt.${now}`).order("created_at", { ascending: true }).limit(10));
  const remaining = 10 - active.length;
  const completed = remaining ? await checked(getDb().from("generation_jobs").select("id").eq("data->>status", "completed").or("payload->>evaluationComplete.is.null,payload->>evaluationComplete.eq.false").order("updated_at", { ascending: true }).limit(remaining)) : [];
  const ids = [...active, ...completed].map((row) => row.id as string);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= ids.length) return;
      try { await advanceJob(ids[index]); } catch { /* Leases and checkpoints allow the next cron attempt to recover. */ }
    }
  }
  await Promise.all([worker(), worker()]);
  return { processed: ids.length };
}
