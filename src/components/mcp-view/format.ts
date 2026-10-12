import type {
  ApiError, DesignSession, Evaluation, GenerationJob, GenerationJobStatus, HumanDecision,
  MakePackageResult, PhysicalAudit, Revision, RevisionPlan, StartDesignResult,
} from "@/lib/contracts";

/** Tool names the view knows how to render. Mirrors McpToolName without a runtime import. */
export type ViewToolName =
  | "start_design" | "get_design" | "plan_refinement" | "apply_refinement"
  | "decide_revision" | "generate_model" | "get_make_package";

export type ViewModel =
  | { kind: "start_design"; result: StartDesignResult }
  | { kind: "get_design"; result: DesignSession }
  | { kind: "plan_refinement"; result: RevisionPlan }
  | { kind: "job"; tool: "apply_refinement" | "generate_model"; result: GenerationJob }
  | { kind: "decide_revision"; result: HumanDecision }
  | { kind: "get_make_package"; result: MakePackageResult }
  | { kind: "error"; error: ApiError }
  | { kind: "unknown" };

/** A side effect a card asks the host to perform. The entry wires these to the App bridge. */
export type ViewAction =
  | { type: "call"; name: ViewToolName; arguments: Record<string, unknown> }
  | { type: "open"; url: string };

/** Rejects with an Error whose message is shown under the button. */
export type ActionHandler = (action: ViewAction) => Promise<void>;

const KNOWN_TOOLS = new Set<string>([
  "start_design", "get_design", "plan_refinement", "apply_refinement",
  "decide_revision", "generate_model", "get_make_package",
]);

export function isViewToolName(value: unknown): value is ViewToolName {
  return typeof value === "string" && KNOWN_TOOLS.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Build the view model from `structuredContent`. Detection is by result shape;
 * the tool name only separates apply_refinement from generate_model.
 */
export function toViewModel(structured: unknown, toolName?: string | null): ViewModel {
  if (!isRecord(structured)) return { kind: "unknown" };
  if (isRecord(structured.error) && typeof structured.error.message === "string") {
    return { kind: "error", error: structured.error as ApiError };
  }
  const result = structured.result;
  if (!isRecord(result)) return { kind: "unknown" };

  if (typeof result.sessionId === "string" && isRecord(result.job)) {
    return { kind: "start_design", result: result as StartDesignResult };
  }
  if (Array.isArray(result.revisions) && Array.isArray(result.jobs)) {
    return { kind: "get_design", result: result as DesignSession };
  }
  if (typeof result.requestedChange === "string" && typeof result.action === "string") {
    return { kind: "plan_refinement", result: result as RevisionPlan };
  }
  if (typeof result.operation === "string" && typeof result.status === "string") {
    const job = result as GenerationJob;
    const tool = toolName === "generate_model" || (toolName !== "apply_refinement" && job.operation === "model")
      ? "generate_model" : "apply_refinement";
    return { kind: "job", tool, result: job };
  }
  if (typeof result.downloadUrl === "string" && isRecord(result.audit)) {
    return { kind: "get_make_package", result: result as MakePackageResult };
  }
  if ((result.decision === "approve" || result.decision === "reject") && typeof result.revisionId === "string") {
    return { kind: "decide_revision", result: result as HumanDecision };
  }
  return { kind: "unknown" };
}

export function readNotChecked(structured: unknown): string[] {
  if (!isRecord(structured) || !Array.isArray(structured.notChecked)) return [];
  return structured.notChecked.filter((item): item is string => typeof item === "string");
}

export function sessionIdOf(model: ViewModel): string | null {
  switch (model.kind) {
    case "start_design": return model.result.sessionId;
    case "get_design": return model.result.id;
    case "plan_refinement": return model.result.sessionId;
    case "job": return model.result.sessionId;
    case "decide_revision": return model.result.sessionId;
    case "get_make_package": return model.result.artifact.sessionId;
    default: return null;
  }
}

export function runUrl(appUrl: string | null | undefined, sessionId: string | null): string | null {
  if (!appUrl || !sessionId) return null;
  try {
    const base = new URL(appUrl);
    if (base.protocol !== "https:" && base.protocol !== "http:") return null;
    return `${base.origin}${base.pathname.replace(/\/+$/, "")}/runs/${encodeURIComponent(sessionId)}`;
  } catch {
    return null;
  }
}

/** Plain words for every GenerationJob status. */
export function statusWords(status: GenerationJobStatus): string {
  switch (status) {
    case "created":
    case "planning":
    case "submitting": return "Starting";
    case "queued": return "In line";
    case "running": return "Generating";
    case "ingesting":
    case "preparing": return "Saving and preparing";
    case "verifying": return "Checking";
    case "completed": return "Done";
    case "failed": return "Failed";
    case "submission_unknown": return "Can't confirm it was sent: not resent automatically";
  }
}

export const JOB_STEPS = ["Sent", "In line", "Generating", "Saving and preparing", "Checking"] as const;

/** Index of the current step in JOB_STEPS. 5 means every step is done; -1 means no step applies. */
export function jobStepIndex(status: GenerationJobStatus): number {
  switch (status) {
    case "created":
    case "planning":
    case "submitting":
    case "submission_unknown": return 0;
    case "queued": return 1;
    case "running": return 2;
    case "ingesting":
    case "preparing": return 3;
    case "verifying": return 4;
    case "completed": return 5;
    case "failed": return -1;
  }
}

export function isJobActive(job: GenerationJob): boolean {
  return job.status !== "completed" && job.status !== "failed";
}

export function actionWords(action: RevisionPlan["action"]): string {
  switch (action) {
    case "edit_concept": return "Edit the concept image";
    case "scale_geometry": return "Rescale the model";
    case "regenerate_model": return "Make a new 3D model";
  }
}

export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function mm(value: number): string {
  return `${value.toFixed(1)} mm`;
}

const CHECK_WORDS: Record<string, string> = {
  wall_thickness: "wall thickness",
  self_intersections: "self-intersections",
  supports: "supports",
  material_strength: "material strength",
  regional_feature_measurements: "regional measurements",
  printability_certification: "print certification",
  target_height: "target height",
  boundary_edges: "open edges",
};

export function checkWords(id: string): string {
  return CHECK_WORDS[id] ?? id.replaceAll("_", " ");
}

export function notCheckedSentence(items: string[]): string | null {
  const words = [...new Set(items.map(checkWords))];
  return words.length ? `Not checked: ${words.join(", ")}` : null;
}

export interface CheckCounts { pass: number; fail: number; notChecked: number; failed: string[] }

export function countChecks(audit: PhysicalAudit): CheckCounts {
  const notCheckedIds = new Set(audit.notChecked);
  let pass = 0;
  const failed: string[] = [];
  for (const check of audit.checks) {
    if (check.status === "pass") pass += 1;
    else if (check.status === "fail") failed.push(check.id);
    else notCheckedIds.add(check.id);
  }
  return { pass, fail: failed.length, notChecked: notCheckedIds.size, failed };
}

/** Revisions in creation order; ties keep array order. */
export function orderedRevisions(session: DesignSession): Revision[] {
  return session.revisions
    .map((revision, index) => ({ revision, index }))
    .sort((a, b) => a.revision.createdAt.localeCompare(b.revision.createdAt) || a.index - b.index)
    .map(({ revision }) => revision);
}

export function latestOf<T extends { createdAt: string }>(items: T[]): T | undefined {
  let latest: T | undefined;
  for (const item of items) if (!latest || item.createdAt >= latest.createdAt) latest = item;
  return latest;
}

export function physicalAuditFor(session: DesignSession, revisionId: string): PhysicalAudit | undefined {
  const physical = session.evaluations.filter(
    (evaluation): evaluation is Extract<Evaluation, { kind: "physical" }> =>
      evaluation.kind === "physical" && evaluation.revisionId === revisionId,
  );
  return latestOf(physical)?.audit;
}

export function visualSummaryFor(session: DesignSession, revisionId: string): string | undefined {
  const visual = session.evaluations.filter(
    (evaluation): evaluation is Extract<Evaluation, { kind: "visual" }> =>
      evaluation.kind === "visual" && evaluation.revisionId === revisionId,
  );
  return latestOf(visual)?.summary;
}

/** The newest job that is still moving or stuck, by updatedAt; ties keep the later array entry. */
export function activeJobOf(session: DesignSession): GenerationJob | undefined {
  let found: GenerationJob | undefined;
  for (const job of session.jobs) {
    if (!isJobActive(job)) continue;
    if (!found || job.updatedAt >= found.updatedAt) found = job;
  }
  return found;
}

export function expiryTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Honest one-line explanations for API error codes. */
export function errorHint(code: ApiError["code"]): string {
  switch (code) {
    case "CONFIRM_COST_REQUIRED": return "This step costs money and needs cost approval first. Nothing was run.";
    case "BUDGET_EXCEEDED": return "This step would go over the budget. Nothing was run.";
    case "SUBMISSION_UNKNOWN": return "MakeReady can't confirm the request was sent. It was not resent automatically, so you are not charged twice.";
    case "PROVIDER_UNAVAILABLE":
    case "PROVIDER_FAILED": return "The generator failed. The previous version is kept.";
    case "NOT_READY": return "This is not ready yet. Check progress again in a moment.";
    case "CONFLICT": return "This conflicts with saved work, or it needs an approval first.";
    case "NOT_FOUND": return "MakeReady could not find this item.";
    case "ACCESS_REQUIRED": return "MakeReady access is required.";
    case "INVALID_INPUT": return "The request was not valid. Nothing was run.";
    case "ARTIFACT_UNAVAILABLE":
    case "INVALID_ARTIFACT":
    case "UNSUPPORTED_GEOMETRY":
    case "STORAGE_FAILED": return "A file is missing or could not be used. Nothing was marked as done.";
    case "INTERNAL_ERROR": return "Check the existing job before repeating paid work.";
  }
}
