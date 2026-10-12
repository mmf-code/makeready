import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { ProviderError, type ProviderJobRef } from "@/lib/providers/types";
import type { ArtifactRef, DesignSpec, GenerationJob, Revision } from "@/lib/contracts";

const mock = vi.hoisted(() => ({
  rpc: vi.fn(), getDb: vi.fn(), evaluate: vi.fn(), store: vi.fn(), read: vi.fn(), signed: vi.fn(), prepare: vi.fn(), pack: vi.fn(),
  configured: vi.fn(), spec: vi.fn(), critique: vi.fn(), submitConcept: vi.fn(), submitEdit: vi.fn(), submitModel: vi.fn(), poll: vi.fn(), result: vi.fn(), image: vi.fn(), glb: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ getDb: mock.getDb, rpc: mock.rpc, checked: async (query: PromiseLike<{ data: unknown; error: unknown }>) => { const value = await query; if (value.error) throw value.error; return value.data; } }));
vi.mock("@/lib/storage", () => ({ storeArtifact: mock.store, readArtifact: mock.read, signedArtifact: mock.signed }));
vi.mock("@/lib/harness/evaluate", () => ({ evaluateRevision: mock.evaluate }));
vi.mock("@/lib/geometry", async (original) => ({ ...await original<typeof import("@/lib/geometry")>(), prepareModel: mock.prepare }));
vi.mock("@/lib/make-package", () => ({ makePackage: mock.pack }));
vi.mock("@/lib/providers", async (original) => ({
  ...await original<typeof import("@/lib/providers")>(),
  isIntelligenceConfigured: mock.configured,
  createDesignIntelligence: () => ({ designSpec: mock.spec, critiqueVisual: mock.critique }),
  createFalProvider: () => ({ submitConcept: mock.submitConcept, submitConceptEdit: mock.submitEdit, submitModel: mock.submitModel, poll: mock.poll, getResult: mock.result, downloadImage: mock.image, downloadGlb: mock.glb }),
}));
import { advanceJob, reconcileJobs } from "@/lib/executor";

const sessionId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-10-12T09:00:00.000Z";
const spec: DesignSpec = { description: "A friendly cat", objectType: "figurine", use: "desk decoration", targetHeightMm: 120, preserve: ["face"], changeable: ["ears"], process: "resin_candidate" };
const providerRef: ProviderJobRef = { provider: "fal", operation: "concept", endpointId: "fal-ai/nano-banana", requestId: "fal-123", statusUrl: "https://queue.fal.run/fal-ai/nano-banana/requests/fal-123/status", responseUrl: "https://queue.fal.run/fal-ai/nano-banana/requests/fal-123", submittedAt: timestamp };
const artifact = (kind: ArtifactRef["kind"]): ArtifactRef => ({ id: randomUUID(), sessionId, kind, storagePath: `test/${kind}`, sha256: "a".repeat(64), sizeBytes: 32, mimeType: kind.includes("image") ? "image/png" : "application/octet-stream", units: "none", axis: "none", createdAt: timestamp });
type TestRow = { id: string; session_id: string; fence: number; data: GenerationJob; payload: Record<string, unknown>; provider_ref: ProviderJobRef | null };
let row: TestRow;
let record: Revision | undefined;
let locked = false;
let activeRows: { id: string }[] = [];
let completedRows: { id: string }[] = [];

function query(table: string) {
  const chain: Record<string, unknown> = {};
  let selected = "*", completed = false, updating = false;
  for (const name of ["not", "neq", "or", "order", "limit"]) chain[name] = () => chain;
  chain.select = (fields: string) => { selected = fields; return chain; };
  chain.eq = (field: string, value: unknown) => { if (field === "data->>status" && value === "completed") completed = true; return chain; };
  chain.update = (patch: { payload?: Record<string, unknown> }) => { updating = true; if (patch.payload) row.payload = patch.payload; return chain; };
  chain.single = async () => ({ data: table === "design_records" ? { data: record } : { id: row.id }, error: null });
  chain.maybeSingle = async () => ({ data: row, error: null });
  chain.then = (resolve: (value: { data: unknown; error: null }) => unknown) => Promise.resolve({ data: selected === "id" && !updating ? completed ? completedRows : activeRows : row, error: null }).then(resolve);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks(); locked = false; record = undefined; activeRows = []; completedRows = [];
  vi.stubEnv("ENABLE_MODEL_VISUAL_CRITIQUE", ""); mock.configured.mockReturnValue(true);
  row = {
    id: jobId, session_id: sessionId, fence: 0, provider_ref: null,
    data: { id: jobId, sessionId, parentRevisionId: null, planId: null, operation: "concept", status: "created", progress: null, provider: null, providerRequestId: null, attempts: 0, estimatedCostUsd: 0.5, result: null, error: null, createdAt: timestamp, updatedAt: timestamp },
    payload: { input: { prompt: "A friendly cat figurine", heightMm: 120, use: "desk decoration", confirmCost: true, idempotencyKey: "test-key-123" } },
  };
  mock.getDb.mockReturnValue({ from: query });
  mock.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "mr_claim_job") {
      if (locked || ["completed", "failed", "submission_unknown"].includes(row.data.status)) return null;
      locked = true; row.fence++;
      return structuredClone(row);
    }
    if (name === "mr_patch_job") {
      row.data = { ...row.data, ...args.p_patch as object };
      row.payload = { ...row.payload, ...args.p_payload as object };
      if (args.p_provider_ref) row.provider_ref = args.p_provider_ref as ProviderJobRef;
      return row.data;
    }
    if (name === "mr_release_job") { locked = false; return; }
    if (name === "mr_fail_job") { row.data.status = args.p_unknown ? "submission_unknown" : "failed"; locked = false; return; }
    if (name === "mr_finish_job") { record = args.p_record as Revision; row.data.status = "completed"; row.data.result = { revisionId: record.id }; locked = false; return record; }
  });
  mock.spec.mockResolvedValue(spec);
  mock.critique.mockResolvedValue({ summary: "Design matches reference", alignment: "aligned", observations: [{ criterion: "face", finding: "Face preserved", status: "met" }], preserveObserved: ["face"], suggestedChanges: [], limitations: ["Image-only assessment"] });
  mock.submitConcept.mockResolvedValue(providerRef);
  mock.submitModel.mockResolvedValue({ ...providerRef, operation: "model", endpointId: "fal-ai/hunyuan3d-v3/image-to-3d" });
  mock.poll.mockResolvedValue({ state: "completed" });
  mock.result.mockResolvedValue({ job: providerRef, imageUrls: ["https://v3.fal.media/concept.png"] });
  mock.image.mockResolvedValue({ bytes: Buffer.alloc(32), mimeType: "image/png", sha256: "a".repeat(64) });
  mock.store.mockImplementation(async (_session: string, kind: ArtifactRef["kind"]) => artifact(kind));
  mock.read.mockResolvedValue(new Uint8Array(32));
  mock.signed.mockImplementation(async (ref: ArtifactRef) => ({ ...ref, url: `https://storage.example.com/${ref.id}.png` }));
  mock.pack.mockResolvedValue(new Uint8Array(32));
});
afterEach(() => vi.unstubAllEnvs());

describe("durable executor", () => {
  it("checkpoints paid dispatches and resumes queue waiting without creating another design", async () => {
    mock.spec.mockImplementationOnce(async () => { expect(row.payload.dispatchInFlight).toBe(true); return spec; });
    mock.submitConcept.mockImplementationOnce(async () => { expect(row.payload.dispatchInFlight).toBe(true); expect(row.payload.specComputed).toBe(true); return providerRef; });
    await advanceJob(jobId);
    expect(row.data.status).toBe("queued");
    expect(row.provider_ref?.requestId).toBe("fal-123");
    expect(row.payload.dispatchInFlight).toBe(false);
    mock.poll.mockResolvedValueOnce({ state: "running" });
    await advanceJob(jobId);
    expect(row.data.status).toBe("running");
    await advanceJob(jobId);
    expect(row.data.status).toBe("completed");
    expect(record?.kind).toBe("concept");
    expect(record?.artifacts[0].kind).toBe("concept_image");
    expect(mock.spec).toHaveBeenCalledTimes(1);
    expect(mock.submitConcept).toHaveBeenCalledTimes(1);
    expect(mock.evaluate).toHaveBeenCalledTimes(1);
    expect(row.payload.evaluationComplete).toBe(true);
  });

  it("stops ambiguous submissions permanently rather than billing another POST", async () => {
    mock.submitConcept.mockRejectedValueOnce(new ProviderError("Outcome unknown", "submission_unknown"));
    await advanceJob(jobId);
    expect(row.data.status).toBe("submission_unknown");
    await advanceJob(jobId);
    expect(mock.submitConcept).toHaveBeenCalledTimes(1);
    expect(mock.rpc).toHaveBeenCalledWith("mr_fail_job", expect.objectContaining({ p_unknown: true }));
  });

  it("marks a crash between provider acceptance and durable receipt as unknown", async () => {
    const original = mock.rpc.getMockImplementation()!;
    mock.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "mr_patch_job" && args.p_provider_ref) throw new AppError("STORAGE_FAILED", "Receipt checkpoint failed", 503, true);
      return original(name, args);
    });
    await advanceJob(jobId);
    expect(row.data.status).toBe("submission_unknown");
    expect(row.payload.dispatchInFlight).toBe(true);
    await advanceJob(jobId);
    expect(mock.submitConcept).toHaveBeenCalledTimes(1);
  });

  it("resumes transient ingestion from cached provider output without polling or regenerating", async () => {
    row.data.status = "running"; row.payload.spec = spec; row.payload.specComputed = true; row.provider_ref = providerRef;
    mock.image.mockRejectedValueOnce(new ProviderError("download outage", "transport"));
    await advanceJob(jobId);
    expect(row.data.status).toBe("ingesting");
    expect(row.payload.providerResult).toBeDefined();
    await advanceJob(jobId);
    expect(row.data.status).toBe("completed");
    expect(mock.poll).toHaveBeenCalledTimes(1);
    expect(mock.result).toHaveBeenCalledTimes(1);
    expect(mock.submitConcept).not.toHaveBeenCalled();
    expect(mock.image).toHaveBeenCalledTimes(2);
  });

  it("copies an uploaded actual image into a concept instead of generating an invented substitute", async () => {
    const source = artifact("source_image"); row.payload.sourceImage = source;
    await advanceJob(jobId);
    expect(record?.artifacts.map((value) => value.kind)).toEqual(["source_image", "concept_image"]);
    expect(mock.read).toHaveBeenCalledWith(source);
    expect(mock.submitConcept).not.toHaveBeenCalled();
    expect(mock.spec).not.toHaveBeenCalled();
    expect(mock.critique).not.toHaveBeenCalled();
    expect(record?.spec).toMatchObject({ objectType: "Reference object", description: "A friendly cat figurine", targetHeightMm: 120 });
    expect(row.payload.specMethod).toBe("user_input");
    expect(row.payload.visualMethod).toBe("not_checked");
  });

  it("recovers a completed revision's evaluation without any paid calls", async () => {
    const image = artifact("concept_image");
    record = { id: randomUUID(), sessionId, kind: "concept", parentRevisionId: null, spec, artifacts: [image], sourceJobId: jobId, createdAt: timestamp };
    row.data.status = "completed"; row.data.result = { revisionId: record.id };
    row.payload.visualModel = "compatible-vision-model";
    await advanceJob(jobId);
    expect(mock.evaluate).toHaveBeenCalledWith(record, undefined, undefined, "compatible-vision-model");
    expect(mock.spec).not.toHaveBeenCalled(); expect(mock.critique).not.toHaveBeenCalled(); expect(mock.submitConcept).not.toHaveBeenCalled();
    expect(row.payload.evaluationComplete).toBe(true);
  });

  function manufacturingFixture() {
    const source = artifact("source_glb"), image = artifact("concept_image");
    row.data.operation = "model"; row.data.status = "preparing";
    row.payload = { input: {}, spec, sourceGlbArtifact: source, sourceImage: image };
    row.provider_ref = { ...providerRef, operation: "model", endpointId: "fal-ai/hunyuan3d-v3/image-to-3d" };
    const bounds = { width: 80, height: 120, depth: 60, min: [0,0,0], max: [80,120,60] };
    const audit = { engineVersion: "test", measuredBy: "server", inputSha256: source.sha256, outputSha256: { glb: "a".repeat(64), stl: "a".repeat(64) }, targetHeightMm: 120, measuredBoundsMm: bounds, triangleCount: 80, weldToleranceMm: 0.001, checks: [{ id: "boundary_edges", status: "fail", actual: 3, threshold: 0, method: "welded edge count", limitation: null }], notChecked: ["wall_thickness"], manufacturingStatus: "preparation_only", createdAt: timestamp };
    mock.prepare.mockResolvedValue({ source: new Uint8Array(32), glb: new Uint8Array(32), stl: new Uint8Array(32), audit, geometryAudit: { status: "fail", issues: [], notChecked: ["wall_thickness"] }, bounds, hashes: { source: source.sha256, glb: "a".repeat(64), stl: "a".repeat(64) }, provenance: { pipelineVersion: "test" } });
    return { source, image, audit };
  }

  it("keeps readable manufacturing files downloadable with failed physical checks intact", async () => {
    const { source, image, audit } = manufacturingFixture();
    await advanceJob(jobId);
    expect(row.data.status).toBe("completed");
    expect(record?.kind).toBe("manufacturing");
    expect(record?.artifacts.map((value) => value.kind)).toEqual(["source_glb", "model_glb", "model_stl", "audit", "manifest", "make_package", "concept_image"]);
    expect(record?.artifacts).toContainEqual(source); expect(record?.artifacts).toContainEqual(image);
    const auditCall = mock.store.mock.calls.find((call) => call[1] === "audit")!;
    expect(JSON.parse(Buffer.from(auditCall[2]).toString("utf8"))).toEqual(audit);
    expect(mock.pack.mock.calls[0][0].geometryAudit.status).toBe("fail");
  });

  it("rejects resumed output artifacts whose hashes disagree with the recomputed geometry", async () => {
    manufacturingFixture();
    row.payload.modelGlbArtifact = { ...artifact("model_glb"), sha256: "b".repeat(64) };
    await advanceJob(jobId);
    expect(row.data.status).toBe("failed");
    expect(mock.rpc).toHaveBeenCalledWith("mr_fail_job", expect.objectContaining({ p_error: expect.objectContaining({ code: "INVALID_ARTIFACT" }), p_unknown: false }));
    expect(record).toBeUndefined();
  });

  it("stores and hash-binds a provider preview before the visual critic sees it", async () => {
    vi.stubEnv("ENABLE_MODEL_VISUAL_CRITIQUE", "true");
    const { source, image: reference } = manufacturingFixture();
    const parentImage = artifact("concept_image");
    row.payload.parent = { id: randomUUID(), sessionId, kind: "concept", parentRevisionId: null, spec, artifacts: [parentImage], sourceJobId: null, createdAt: timestamp };
    const candidateBytes = Buffer.alloc(32, 2), parentBytes = Buffer.alloc(32, 3), referenceBytes = Buffer.alloc(32, 1);
    mock.image.mockResolvedValue({ bytes: candidateBytes, mimeType: "image/png", sha256: "a".repeat(64) });
    mock.read.mockImplementation(async (ref: ArtifactRef) => ref.id === source.id ? new Uint8Array(32) : ref.id === reference.id ? referenceBytes : ref.id === parentImage.id ? parentBytes : candidateBytes);
    row.payload.providerResult = { job: row.provider_ref, imageUrls: [], glbUrl: "https://v3.fal.media/model.glb", thumbnailUrl: "https://v3.fal.media/preview.png" };
    await advanceJob(jobId);
    const preview = row.payload.previewArtifact as ArtifactRef;
    expect(preview.kind).toBe("concept_image");
    expect(mock.image).toHaveBeenCalledWith(expect.objectContaining({ imageUrls: ["https://v3.fal.media/preview.png"] }));
    expect(mock.critique).toHaveBeenCalledWith(expect.objectContaining({
      candidateImageUrl: `data:image/png;base64,${candidateBytes.toString("base64")}`,
      parentImageUrl: `data:image/png;base64,${parentBytes.toString("base64")}`,
      referenceImageUrl: `data:image/png;base64,${referenceBytes.toString("base64")}`,
    }));
    expect(mock.read).toHaveBeenCalledWith(preview);
    expect(mock.signed).not.toHaveBeenCalled();
    expect(record?.artifacts.at(-1)).toEqual(preview);
  });

  it("keeps signed HTTPS image references for fal model generation", async () => {
    const source = artifact("concept_image");
    row.data.operation = "model"; row.payload = { input: {}, spec, sourceImage: source };
    await advanceJob(jobId);
    expect(row.data.status).toBe("queued");
    expect(mock.submitModel).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: `https://storage.example.com/${source.id}.png` }));
    expect(mock.critique).not.toHaveBeenCalled();
  });

  it("rejects an oversized visual image before reading or making a paid LLM call", async () => {
    row.payload = { input: {}, spec, specComputed: true, sourceImageArtifact: { ...artifact("concept_image"), sizeBytes: 20 * 1024 * 1024 + 1 } };
    await advanceJob(jobId);
    expect(row.data.status).toBe("failed");
    expect(mock.read).not.toHaveBeenCalled(); expect(mock.critique).not.toHaveBeenCalled();
  });

  it("finishes real 3D preparation without an LLM even when the provider supplies a preview", async () => {
    manufacturingFixture();
    row.payload.providerResult = { job: row.provider_ref, imageUrls: [], glbUrl: "https://v3.fal.media/model.glb", thumbnailUrl: "https://v3.fal.media/preview.png" };
    mock.critique.mockRejectedValue(new ProviderError("Quota exhausted", "provider_failure", 429));
    await advanceJob(jobId);
    expect(row.data.status).toBe("completed");
    expect(row.payload.visualMethod).toBe("not_checked");
    expect(mock.critique).not.toHaveBeenCalled(); expect(mock.image).not.toHaveBeenCalled();
  });

  it("processes a maximum of ten reconciliation jobs with at most two simultaneous claims", async () => {
    activeRows = Array.from({ length: 10 }, () => ({ id: randomUUID() }));
    let active = 0, maximum = 0;
    mock.rpc.mockImplementation(async (name: string) => {
      if (name !== "mr_claim_job") return;
      active++; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--; return null;
    });
    const result = await reconcileJobs();
    expect(result.processed).toBe(10);
    expect(maximum).toBe(2);
    expect(mock.rpc.mock.calls.filter(([name]) => name === "mr_claim_job")).toHaveLength(10);
  });
});
