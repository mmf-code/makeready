import { z } from "zod";

export const CONTRACT_VERSION = "1.1.0" as const;
const Id = z.uuid();
const Timestamp = z.iso.datetime();
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const NotChecked = ["wall_thickness", "self_intersections", "supports", "material_strength"] as const;

export const ApiErrorSchema = z.object({
  code: z.enum(["INVALID_INPUT", "ACCESS_REQUIRED", "NOT_FOUND", "CONFLICT", "BUDGET_EXCEEDED", "CONFIRM_COST_REQUIRED", "PROVIDER_UNAVAILABLE", "PROVIDER_FAILED", "SUBMISSION_UNKNOWN", "ARTIFACT_UNAVAILABLE", "INVALID_ARTIFACT", "UNSUPPORTED_GEOMETRY", "STORAGE_FAILED", "NOT_READY", "INTERNAL_ERROR"]),
  message: z.string(), retryable: z.boolean(), details: z.record(z.string(), z.json()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const DesignSpecSchema = z.object({
  description: z.string().min(1), objectType: z.string().min(1), use: z.string().min(1),
  targetHeightMm: z.number().positive().max(2000), preserve: z.array(z.string()),
  changeable: z.array(z.string()), process: z.enum(["resin_candidate", "fdm_candidate", "cnc_candidate"]),
});
export type DesignSpec = z.infer<typeof DesignSpecSchema>;

export const ArtifactRefSchema = z.object({
  id: Id, sessionId: Id,
  kind: z.enum(["source_image", "concept_image", "source_glb", "model_glb", "model_stl", "audit", "manifest", "make_package"]),
  storagePath: z.string().min(1), sha256: Hash, sizeBytes: z.number().int().nonnegative(), mimeType: z.string(),
  units: z.enum(["m", "mm", "none"]), axis: z.enum(["y_up", "z_up", "none"]), createdAt: Timestamp,
  url: z.url().optional(), expiresAt: Timestamp.optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

export const GenerationJobStatusSchema = z.enum(["created", "planning", "submitting", "submission_unknown", "queued", "running", "ingesting", "preparing", "verifying", "completed", "failed"]);
export const GenerationJobStatus = GenerationJobStatusSchema.enum;
export type GenerationJobStatus = z.infer<typeof GenerationJobStatusSchema>;
export const GenerationJobSchema = z.object({
  id: Id, sessionId: Id, parentRevisionId: Id.nullable(), planId: Id.nullable(),
  operation: z.enum(["concept", "refinement", "model", "planning", "scale", "import"]),
  status: GenerationJobStatusSchema, progress: z.number().min(0).max(100).nullable(),
  provider: z.enum(["fal", "openai", "local"]).nullable(), providerRequestId: z.string().nullable(),
  attempts: z.number().int().nonnegative(), estimatedCostUsd: z.number().nonnegative(),
  result: z.object({ revisionId: Id.optional(), planId: Id.optional() }).nullable(),
  error: ApiErrorSchema.nullable(), createdAt: Timestamp, updatedAt: Timestamp,
});
export type GenerationJob = z.infer<typeof GenerationJobSchema>;

export const RevisionPlanSchema = z.object({
  id: Id, sessionId: Id, parentRevisionId: Id, requestedChange: z.string().min(1),
  interpretedIntent: z.string().min(1), preserve: z.array(z.string()),
  action: z.enum(["edit_concept", "scale_geometry", "regenerate_model"]), reason: z.string().min(1),
  expectedDifferences: z.array(z.string()), targetHeightMm: z.number().positive().max(2000).nullable(),
  maxAttempts: z.literal(2), estimatedCostUsd: z.number().nonnegative(), createdAt: Timestamp,
});
export type RevisionPlan = z.infer<typeof RevisionPlanSchema>;

export const RevisionSchema = z.object({
  id: Id, sessionId: Id, parentRevisionId: Id.nullable(), kind: z.enum(["concept", "manufacturing"]),
  spec: DesignSpecSchema, artifacts: z.array(ArtifactRefSchema).min(1), sourceJobId: Id.nullable(), createdAt: Timestamp,
}).superRefine((revision, ctx) => {
  const kinds = new Set(revision.artifacts.map(a => a.kind));
  const required = revision.kind === "concept" ? [] : ["model_glb", "model_stl", "audit"];
  if (revision.kind === "concept" && !kinds.has("source_image") && !kinds.has("concept_image"))
    ctx.addIssue({ code: "custom", message: "A concept revision requires a stored image." });
  for (const kind of required) if (!kinds.has(kind as ArtifactRef["kind"]))
    ctx.addIssue({ code: "custom", message: `A manufacturing revision requires ${kind}.` });
  if (revision.artifacts.some(a => a.sessionId !== revision.sessionId))
    ctx.addIssue({ code: "custom", message: "Artifact/session mismatch." });
});
export type Revision = z.infer<typeof RevisionSchema>;

export const AuditCheckSchema = z.object({
  id: z.string(), status: z.enum(["pass", "fail", "not_checked"]), actual: z.json(),
  threshold: z.json(), method: z.string(), limitation: z.string().nullable(),
});
export type AuditCheck = z.infer<typeof AuditCheckSchema>;
export const BoundsSchema = z.object({
  width: z.number().nonnegative(), height: z.number().nonnegative(), depth: z.number().nonnegative(),
  min: z.tuple([z.number(), z.number(), z.number()]), max: z.tuple([z.number(), z.number(), z.number()]),
});
export const PhysicalAuditSchema = z.object({
  engineVersion: z.string(), measuredBy: z.literal("server"), inputSha256: Hash,
  outputSha256: z.object({ glb: Hash, stl: Hash }), targetHeightMm: z.number().positive(),
  measuredBoundsMm: BoundsSchema, triangleCount: z.number().int().nonnegative(),
  weldToleranceMm: z.number().positive(), checks: z.array(AuditCheckSchema), notChecked: z.array(z.string()),
  manufacturingStatus: z.literal("preparation_only"), createdAt: Timestamp,
});
export type PhysicalAudit = z.infer<typeof PhysicalAuditSchema>;
const EvaluationBase = { id: Id, sessionId: Id, revisionId: Id, artifactHashes: z.array(Hash), engine: z.string(), method: z.string(), limitations: z.array(z.string()), createdAt: Timestamp };
export const EvaluationSchema = z.discriminatedUnion("kind", [
  z.object({ ...EvaluationBase, kind: z.literal("visual"), summary: z.string(), changesObserved: z.array(z.string()), preservationFindings: z.array(z.string()), uncertainties: z.array(z.string()) }),
  z.object({ ...EvaluationBase, kind: z.literal("physical"), audit: PhysicalAuditSchema }),
  z.object({ ...EvaluationBase, kind: z.literal("human"), decision: z.enum(["approve", "reject"]), note: z.string().nullable() }),
]);
export type Evaluation = z.infer<typeof EvaluationSchema>;
export const HumanDecisionSchema = z.object({ id: Id, sessionId: Id, revisionId: Id, decision: z.enum(["approve", "reject"]), note: z.string().nullable(), artifactHashes: z.array(Hash), createdAt: Timestamp });
export type HumanDecision = z.infer<typeof HumanDecisionSchema>;
export const ComparisonSchema = z.object({
  id: Id, sessionId: Id, parentRevisionId: Id, childRevisionId: Id, planId: Id.nullable(),
  visualEvaluationIds: z.array(Id), physicalEvaluationIds: z.array(Id), summary: z.string(),
  differences: z.array(z.string()), preservationFindings: z.array(z.string()), limitations: z.array(z.string()),
  geometryDelta: z.object({ widthMm: z.number(), heightMm: z.number(), depthMm: z.number(), triangles: z.number().int(), boundaryEdges: z.number().int().nullable() }).nullable(),
  cameraPreset: z.literal("matched_front_side_three_quarter"), createdAt: Timestamp,
});
export type Comparison = z.infer<typeof ComparisonSchema>;
export const DesignSessionSchema = z.object({
  id: Id, title: z.string(), spec: DesignSpecSchema, createdAt: Timestamp, updatedAt: Timestamp,
  revisions: z.array(RevisionSchema), jobs: z.array(GenerationJobSchema), plans: z.array(RevisionPlanSchema),
  evaluations: z.array(EvaluationSchema), comparisons: z.array(ComparisonSchema), decisions: z.array(HumanDecisionSchema),
  notChecked: z.array(z.string()),
});
export type DesignSession = z.infer<typeof DesignSessionSchema>;

const Paid = { confirmCost: z.literal(true), idempotencyKey: z.string().min(8).max(200) };
export const CreateSessionInputSchema = z.object({ title: z.string().max(160).optional() });
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;
export const StartDesignInputSchema = z.object({ ...Paid, sessionId: Id.optional(), prompt: z.string().min(1).max(6000), heightMm: z.number().positive().max(2000).default(120), use: z.string().min(1).default("Paintable tabletop figurine"), imageArtifactId: Id.optional() });
export type StartDesignInput = z.infer<typeof StartDesignInputSchema>;
export const StartDesignResultSchema = z.object({ sessionId: Id, job: GenerationJobSchema });
export type StartDesignResult = z.infer<typeof StartDesignResultSchema>;
export const PlanRevisionInputSchema = z.object({ ...Paid, sessionId: Id, revisionId: Id, feedback: z.string().min(1).max(4000) });
export type PlanRevisionInput = z.infer<typeof PlanRevisionInputSchema>;
export const ExecutePlanInputSchema = z.object({ ...Paid, planId: Id });
export type ExecutePlanInput = z.infer<typeof ExecutePlanInputSchema>;
export const GenerateModelInputSchema = z.object({ ...Paid, revisionId: Id });
export type GenerateModelInput = z.infer<typeof GenerateModelInputSchema>;
export const DecisionInputSchema = z.object({ revisionId: Id, decision: z.enum(["approve", "reject"]), note: z.string().max(4000).optional() });
export type DecisionInput = z.infer<typeof DecisionInputSchema>;
export const MakePackageResultSchema = z.object({ revisionId: Id, audit: PhysicalAuditSchema, artifact: ArtifactRefSchema, downloadUrl: z.url(), expiresAt: Timestamp, notChecked: z.array(z.string()) });
export type MakePackageResult = z.infer<typeof MakePackageResultSchema>;
export const UploadInputSchema = z.object({ sessionId: Id, fileName: z.string().min(1).max(180), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), sizeBytes: z.number().int().positive().max(10 * 1024 * 1024), sha256: Hash });
export type UploadInput = z.infer<typeof UploadInputSchema>;
export const UploadGrantSchema = z.object({ artifactId: Id, sessionId: Id, storagePath: z.string(), signedUrl: z.url(), token: z.string(), expiresAt: Timestamp });
export type UploadGrant = z.infer<typeof UploadGrantSchema>;
export const CompleteUploadInputSchema = z.object({ artifactId: Id, sessionId: Id });
export type CompleteUploadInput = z.infer<typeof CompleteUploadInputSchema>;
export const AccessInputSchema = z.object({ password: z.string().min(1), returnTo: z.string().optional() });
export const AccessResultSchema = z.object({ redirectTo: z.string() });
export type AccessInput = z.infer<typeof AccessInputSchema>;
export type AccessResult = z.infer<typeof AccessResultSchema>;
export const ProgressEventSchema = z.object({ stage: z.enum(["uploading", "planning", "queued", "running", "downloading", "preparing", "verifying", "completed"]), jobId: Id.optional(), progress: z.number().min(0).max(100).nullable(), message: z.string() });
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;
export type ApiResponse<T> = { data: T } | { error: ApiError };
