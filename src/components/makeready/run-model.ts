import type { ArtifactRef, DesignSession, Evaluation, GenerationJob, Revision, RevisionPlan } from "@/lib/contracts";
import type { HatKind, StationState } from "./brand";

export type BuilderId = "you" | "buyer" | "foreman" | "concept" | "look" | "geometry" | "shape" | "prep" | "network" | "print" | "printer" | "paint" | "qa" | "courier";

export const BUILDERS: Record<BuilderId, { name: string; kind: string; hat: HatKind; sandbox?: boolean }> = {
  you: { name: "You", kind: "Person", hat: "person" },
  buyer: { name: "Your assistant", kind: "Agent in ChatGPT", hat: "buyer" },
  foreman: { name: "Foreman", kind: "MakeReady planner agent", hat: "foreman" },
  concept: { name: "Concept agent", kind: "Image model agent", hat: "design" },
  look: { name: "Look inspector", kind: "Vision agent", hat: "inspect" },
  geometry: { name: "Geometry agent", kind: "3D model agent", hat: "tech" },
  shape: { name: "Shape inspector", kind: "Measuring software", hat: "inspect" },
  prep: { name: "Prep agent", kind: "Scaling and repair software", hat: "tech" },
  network: { name: "Maker network", kind: "Directory", hat: "foreman", sandbox: true },
  print: { name: "Kadıköy Print Studio", kind: "Print shop agent with a resin printer", hat: "maker", sandbox: true },
  printer: { name: "Resin printer 2", kind: "Machine", hat: "machine", sandbox: true },
  paint: { name: "Elif, hand painter", kind: "Person working through her agent", hat: "maker", sandbox: true },
  qa: { name: "Line QA", kind: "Inspection agent", hat: "inspect", sandbox: true },
  courier: { name: "Courier agent", kind: "Delivery agent", hat: "courier", sandbox: true },
};

export const ZONES: { name: string; stations: BuilderId[] }[] = [
  { name: "Plan", stations: ["foreman"] },
  { name: "Design", stations: ["concept", "look"] },
  { name: "Geometry", stations: ["geometry"] },
  { name: "Engineering", stations: ["shape", "prep"] },
  { name: "Physical", stations: ["print", "paint", "qa"] },
  { name: "Logistics", stations: ["courier"] },
];

export type EntryKind = "call" | "change" | "problem" | "human" | "running";
export interface Entry {
  id: string; at: string; from: BuilderId; to: BuilderId; tool: string; args: string; result: string;
  kind: EntryKind; cost?: number; sandbox?: boolean;
}
export interface Station { state: StationState; task: string }

const ACTIVE = new Set(["created", "planning", "submitting", "queued", "running", "ingesting", "preparing", "verifying"]);
export const isActive = (job: GenerationJob) => ACTIVE.has(job.status);
const byTime = <T extends { createdAt: string; id: string }>(a: T, b: T) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

export const STATUS_WORDS: Record<GenerationJob["status"], string> = {
  created: "Starting", planning: "Planning", submitting: "Sending to the provider", submission_unknown: "Can't confirm it was sent",
  queued: "In line at the provider", running: "Generating", ingesting: "Saving the files", preparing: "Scaling and preparing",
  verifying: "Checking the files", completed: "Done", failed: "Failed",
};

export const ACTION_WORDS: Record<RevisionPlan["action"], string> = {
  edit_concept: "Edit the concept image", scale_geometry: "Rescale the model", regenerate_model: "Make a new 3D model",
};

export interface RunModel {
  revisions: Revision[];
  versionOf: (id: string | null | undefined) => string;
  latest: Revision | null;
  latestConcept: Revision | null;
  latestManufacturing: Revision | null;
  activeJobs: GenerationJob[];
  troubledJobs: GenerationJob[];
  pendingPlan: RevisionPlan | null;
  entries: Entry[];
  stations: Record<BuilderId, Station>;
  tokenAt: BuilderId;
  spent: number;
  physicalFor: (revisionId: string) => Extract<Evaluation, { kind: "physical" }> | undefined;
  visualFor: (revisionId: string) => Extract<Evaluation, { kind: "visual" }> | undefined;
  approved: (revisionId: string) => boolean;
}

export function artifactOf(revision: Revision | null | undefined, ...kinds: ArtifactRef["kind"][]) {
  if (!revision) return undefined;
  for (const kind of kinds) { const a = revision.artifacts.find((x) => x.kind === kind); if (a) return a; }
  return undefined;
}

export function buildRunModel(session: DesignSession): RunModel {
  const revisions = [...session.revisions].sort(byTime);
  const vIndex = new Map(revisions.map((r, i) => [r.id, `v${i + 1}`]));
  const versionOf = (id: string | null | undefined) => (id && vIndex.get(id)) || "earlier version";
  const plans = [...session.plans].sort(byTime);
  const coIndex = new Map(plans.map((p, i) => [p.id, `CO-${i + 1}`]));
  const jobs = [...session.jobs].sort(byTime);
  const evaluations = [...session.evaluations].sort(byTime);
  const latest = revisions.at(-1) ?? null;
  const latestConcept = [...revisions].reverse().find((r) => r.kind === "concept") ?? null;
  const latestManufacturing = [...revisions].reverse().find((r) => r.kind === "manufacturing") ?? null;
  const activeJobs = jobs.filter(isActive);
  const troubledJobs = jobs.filter((j) => j.status === "failed" || j.status === "submission_unknown");
  const executedPlanIds = new Set(jobs.map((j) => j.planId).filter(Boolean));
  const pendingPlan = [...plans].reverse().find((p) => !executedPlanIds.has(p.id) && p.parentRevisionId === latest?.id) ?? null;
  const physicalFor = (rid: string) => [...evaluations].reverse().find((e): e is Extract<Evaluation, { kind: "physical" }> => e.kind === "physical" && e.revisionId === rid);
  const visualFor = (rid: string) => [...evaluations].reverse().find((e): e is Extract<Evaluation, { kind: "visual" }> => e.kind === "visual" && e.revisionId === rid);
  // Only the latest decision counts, and only for the exact files it was made on.
  const approved = (rid: string) => {
    const rev = revisions.find((r) => r.id === rid);
    const last = [...session.decisions].filter((d) => d.revisionId === rid).sort(byTime).at(-1);
    if (!rev || !last || last.decision !== "approve") return false;
    const hashes = new Set(rev.artifacts.map((a) => a.sha256));
    return last.artifactHashes.length === 0 || last.artifactHashes.every((h) => hashes.has(h));
  };
  const spec = session.spec;

  const entries: Entry[] = [];
  const jobResult = (job: GenerationJob, done: string) => {
    if (job.status === "completed") return done;
    if (job.status === "failed") return job.error?.message ?? "The provider reported a failure.";
    if (job.status === "submission_unknown") return "Can't confirm the provider received it. MakeReady will not send it again on its own.";
    return `${STATUS_WORDS[job.status]}${job.progress ? `, ${Math.round(job.progress)}%` : ""}.`;
  };
  const jobKind = (job: GenerationJob): EntryKind => (job.status === "failed" || job.status === "submission_unknown" ? "problem" : isActive(job) ? "running" : "call");

  for (const job of jobs) {
    const made = job.result?.revisionId ? versionOf(job.result.revisionId) : "";
    const base = { id: job.id, at: job.createdAt, kind: jobKind(job), cost: job.estimatedCostUsd };
    if (job.operation === "concept") {
      entries.push({ ...base, from: "foreman", to: "concept", tool: "concept.generate", args: `{ height_mm: ${spec.targetHeightMm}, use: "${spec.use}" }`, result: jobResult(job, `Concept ${made} saved.${job.result?.revisionId && visualFor(job.result.revisionId) ? " The look inspector compared it to the request." : " No visual check ran on it."}`) });
    } else if (job.operation === "refinement") {
      const plan = plans.find((p) => p.id === job.planId);
      const co = job.planId ? coIndex.get(job.planId) ?? "change order" : "change order";
      const parent = versionOf(job.parentRevisionId);
      if (plan?.action === "regenerate_model") entries.push({ ...base, from: "foreman", to: "geometry", tool: "geometry.image_to_3d", args: `{ from: "${parent}", change_order: "${co}" }`, result: jobResult(job, `Model ${made} saved and measured.`) });
      else if (plan?.action === "scale_geometry") entries.push({ ...base, from: "foreman", to: "prep", tool: "prep.rescale", args: `{ revision: "${parent}", height_mm: ${plan.targetHeightMm ?? spec.targetHeightMm} }`, result: jobResult(job, `${made} rescaled and measured.`) });
      else entries.push({ ...base, from: "foreman", to: "concept", tool: "concept.edit", args: `{ revision: "${parent}", change_order: "${co}" }`, result: jobResult(job, `Concept ${made} saved from ${co}.`) });
    } else if (job.operation === "model") {
      entries.push({ ...base, from: "foreman", to: "geometry", tool: "geometry.image_to_3d", args: `{ revision: "${versionOf(job.parentRevisionId)}", faces: 80000 }`, result: jobResult(job, `Model ${made} saved, scaled to ${spec.targetHeightMm} mm and measured.`) });
    } else if (job.operation === "scale") {
      entries.push({ ...base, from: "foreman", to: "prep", tool: "prep.rescale", args: `{ revision: "${versionOf(job.parentRevisionId)}" }`, result: jobResult(job, `${made} rescaled and measured.`) });
    } else if (job.operation === "import") {
      entries.push({ ...base, from: "foreman", to: "prep", tool: "prep.import", args: "{ }", result: jobResult(job, `${made} imported and measured.`) });
    } else if (job.operation === "planning" && job.status !== "completed") {
      entries.push({ ...base, from: "foreman", to: "foreman", tool: "plan_refinement", args: `{ revision: "${versionOf(job.parentRevisionId)}" }`, result: jobResult(job, "Change order saved.") });
    }
  }
  for (const plan of plans) {
    const keep = plan.preserve.length ? ` Keep: ${plan.preserve.join(", ")}.` : "";
    entries.push({
      id: plan.id, at: plan.createdAt, from: "foreman", to: "foreman", kind: "change", cost: plan.estimatedCostUsd,
      tool: "plan_refinement", args: `{ revision: "${versionOf(plan.parentRevisionId)}",\n  feedback: ${JSON.stringify(plan.requestedChange)} }`,
      result: `${coIndex.get(plan.id)}: ${plan.interpretedIntent}.${keep} ${ACTION_WORDS[plan.action]}.${executedPlanIds.has(plan.id) ? "" : " Not run yet."}`,
    });
  }
  for (const e of evaluations) {
    if (e.kind === "visual") {
      entries.push({ id: e.id, at: e.createdAt, from: "foreman", to: "look", kind: "call", tool: "look.compare", args: `{ revision: "${versionOf(e.revisionId)}" }`, result: e.summary });
    } else if (e.kind === "physical") {
      const checks = e.audit.checks;
      const fail = checks.filter((c) => c.status === "fail").length;
      entries.push({
        id: e.id, at: e.createdAt, from: "foreman", to: "shape", kind: fail ? "problem" : "call", tool: "shape.audit",
        args: `{ revision: "${versionOf(e.revisionId)}", target_height_mm: ${e.audit.targetHeightMm} }`,
        result: `${e.audit.measuredBoundsMm.height.toFixed(1)} mm tall. ${checks.filter((c) => c.status === "pass").length} passed, ${fail} failed, ${e.audit.notChecked.length} not checked.`,
      });
    }
  }
  for (const c of session.comparisons) {
    entries.push({ id: c.id, at: c.createdAt, from: "foreman", to: "look", kind: "call", tool: "look.compare", args: `{ parent: "${versionOf(c.parentRevisionId)}", child: "${versionOf(c.childRevisionId)}" }`, result: c.summary });
  }
  for (const d of session.decisions) {
    entries.push({ id: d.id, at: d.createdAt, from: "buyer", to: "foreman", kind: "human", tool: "decide_revision", args: `{ revision: "${versionOf(d.revisionId)}", decision: "${d.decision}" }`, result: d.decision === "approve" ? `${versionOf(d.revisionId)} approved${d.note ? `: ${d.note}` : "."}` : `${versionOf(d.revisionId)} sent back${d.note ? `: ${d.note}` : "."}` });
  }
  entries.sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));

  const stations = {} as Record<BuilderId, Station>;
  (Object.keys(BUILDERS) as BuilderId[]).forEach((id) => { stations[id] = { state: "idle", task: "Not started" }; });
  const active = (op: GenerationJob["operation"], filter: (j: GenerationJob) => boolean = () => true) => activeJobs.find((j) => j.operation === op && filter(j));
  const planOf = (j: GenerationJob) => plans.find((p) => p.id === j.planId);
  const lastJob = (pred: (j: GenerationJob) => boolean) => [...jobs].reverse().find(pred);
  let tokenAt: BuilderId = "foreman";

  if (plans.length || revisions.length) stations.foreman = { state: "done", task: plans.length ? `${plans.length} change order${plans.length > 1 ? "s" : ""} written` : "Plan in place" };
  if (active("planning")) { stations.foreman = { state: "working", task: "Writing a change order" }; tokenAt = "foreman"; }
  if (pendingPlan) stations.foreman = { state: "attention", task: `${coIndex.get(pendingPlan.id)} ready to run` };

  const conceptJob = lastJob((j) => j.operation === "concept" || (j.operation === "refinement" && planOf(j)?.action === "edit_concept"));
  if (latestConcept) stations.concept = { state: "done", task: `Made ${versionOf(latestConcept.id)}` };
  if (conceptJob && isActive(conceptJob)) { stations.concept = { state: "working", task: STATUS_WORDS[conceptJob.status] }; tokenAt = "concept"; }
  else if (conceptJob && !isActive(conceptJob) && conceptJob.status !== "completed") stations.concept = { state: "problem", task: STATUS_WORDS[conceptJob.status] };

  const lastVisual = [...evaluations].reverse().find((e) => e.kind === "visual");
  if (lastVisual?.kind === "visual") { stations.look = { state: lastVisual.uncertainties.length ? "attention" : "done", task: lastVisual.summary }; if (!activeJobs.length) tokenAt = "look"; }

  const modelJob = lastJob((j) => j.operation === "model" || (j.operation === "refinement" && planOf(j)?.action === "regenerate_model"));
  if (latestManufacturing) stations.geometry = { state: "done", task: `Made ${versionOf(latestManufacturing.id)}` };
  if (modelJob && isActive(modelJob)) {
    const prepPhase = ["ingesting", "preparing", "verifying"].includes(modelJob.status);
    stations.geometry = { state: prepPhase ? "done" : "working", task: prepPhase ? "Shape delivered" : STATUS_WORDS[modelJob.status] };
    if (prepPhase) { stations.prep = { state: "working", task: STATUS_WORDS[modelJob.status] }; tokenAt = "prep"; } else tokenAt = "geometry";
  } else if (modelJob && modelJob.status !== "completed") stations.geometry = { state: "problem", task: STATUS_WORDS[modelJob.status] };

  if (latestManufacturing) {
    stations.prep = { state: "done", task: `Scaled to ${spec.targetHeightMm} mm and grounded` };
    const phys = physicalFor(latestManufacturing.id);
    if (phys) {
      const fail = phys.audit.checks.filter((c) => c.status === "fail").length;
      stations.shape = { state: fail ? "attention" : "done", task: `${phys.audit.measuredBoundsMm.height.toFixed(1)} mm. ${fail ? `${fail} check${fail > 1 ? "s" : ""} failed` : "Measured checks passed"}` };
    }
    if (!activeJobs.length) tokenAt = "shape";
    stations.print = { state: "idle", task: "Ready for a maker" };
  }
  for (const id of ["print", "paint", "qa", "courier"] as BuilderId[]) if (stations[id].task === "Not started") stations[id] = { state: "idle", task: latestManufacturing ? "Waiting for the sandbox run" : "Waiting for a make package" };

  const spent = jobs.reduce((sum, j) => sum + (j.status === "failed" ? 0 : j.estimatedCostUsd), 0);
  return { revisions, versionOf, latest, latestConcept, latestManufacturing, activeJobs, troubledJobs, pendingPlan, entries, stations, tokenAt, spent, physicalFor, visualFor, approved };
}

/* ---------- sandbox maker run (simulated, clearly labeled) ---------- */
export type SandboxLook = "original" | "resin" | "primer";
export interface SandboxStep {
  at: number; from: BuilderId; to: BuilderId; tool: string; args: string; result: string; kind?: EntryKind;
  stations?: Partial<Record<BuilderId, Station>>; token?: BuilderId; look?: SandboxLook; print?: [number, number]; quote?: number;
}

export function sandboxSteps(heightMm: number): SandboxStep[] {
  const caliper = (heightMm + 0.2).toFixed(1);
  return [
    { at: 0, from: "foreman", to: "network", tool: "makers.find", args: '{ needs: ["RESIN_PRINT", "HAND_PAINT"], near: "Istanbul" }', result: "6 makers found, 3 free this week.", stations: { foreman: { state: "working", task: "Hiring makers" } }, token: "foreman" },
    { at: 2, from: "foreman", to: "print", tool: "job.offer", args: '{ spec: "make package", role: "PHYSICAL_PRODUCTION" }', result: "Quote $24, ready in 2 days. Checking the file first.", stations: { print: { state: "working", task: "Checking the file" } }, token: "print" },
    { at: 4, from: "print", to: "printer", tool: "slicer.check", args: "{ file: \"model.stl\", min_wall_mm: 1.2 }", result: "Thin areas near the top. The shop adds supports there.", kind: "problem", stations: { print: { state: "attention", task: "Adding supports" } } },
    { at: 6, from: "print", to: "foreman", tool: "job.accept", args: '{ spec: "make package", due: "in 2 days" }', result: "MAKER_ACCEPTED. Print slot booked.", quote: 24, stations: { print: { state: "done", task: "Accepted, $24" } } },
    { at: 8, from: "foreman", to: "paint", tool: "job.offer", args: '{ role: "PAINT_FINISH", palette: "from the concept" }', result: "Quote $38, 3 days. Accepted.", quote: 38, stations: { paint: { state: "done", task: "Accepted, $38" }, foreman: { state: "done", task: "Makers hired, on budget" } }, token: "paint" },
    { at: 10, from: "print", to: "printer", tool: "printer.start", args: "{ layer_mm: 0.05 }", result: "Printing.", look: "resin", print: [10, 18], stations: { print: { state: "working", task: "Printing on resin printer 2" } }, token: "print" },
    { at: 18, from: "print", to: "foreman", tool: "job.report_progress", args: '{ note: "printed, washed, cured, supports removed" }', result: "Ready for paint.", look: "primer", stations: { print: { state: "done", task: "Printed and cleaned" } } },
    { at: 20, from: "foreman", to: "courier", tool: "courier.local_move", args: '{ from: "Kadıköy Print Studio", to: "Elif" }', result: "Handed to the painter.", stations: { courier: { state: "done", task: "Moved print to painter" } }, token: "courier" },
    { at: 22, from: "paint", to: "foreman", tool: "job.start", args: '{ reference: "concept" }', result: "Painting started.", stations: { paint: { state: "working", task: "Painting" } }, token: "paint" },
    { at: 24, from: "paint", to: "foreman", tool: "job.report_problem", args: '{ issue: "one blue is out of stock", offer: "closest match" }', result: "Problem logged.", kind: "problem", stations: { paint: { state: "problem", task: "A paint is out of stock" } } },
    { at: 25.5, from: "foreman", to: "look", tool: "look.match_color", args: "{ tolerance_de: 3 }", result: "ΔE 2.1, within tolerance. Use the match. Nobody was asked.", stations: { paint: { state: "working", task: "Painting with the match" } }, token: "look" },
    { at: 27, from: "paint", to: "foreman", tool: "job.report_progress", args: `{ note: "painted and varnished", caliper_mm: ${caliper} }`, result: "Painting done.", look: "original", stations: { paint: { state: "done", task: "Painted and varnished" } }, token: "paint" },
    { at: 29, from: "foreman", to: "qa", tool: "qa.inspect", args: `{ caliper_mm: ${caliper}, limit_mm: 0.5 }`, result: `Pass. ${caliper} mm, colors match the concept.`, stations: { qa: { state: "done", task: `Passed, ${caliper} mm` } }, token: "qa" },
    { at: 31, from: "foreman", to: "courier", tool: "courier.book", args: '{ to: "Kadıköy" }', result: "Booked.", quote: 9, stations: { courier: { state: "working", task: "On the way" } }, token: "courier" },
    { at: 33, from: "courier", to: "foreman", tool: "delivery.confirm", args: '{ photo: "doorstep.jpg" }', result: "Delivered. In this sandbox, nothing was really printed or shipped.", stations: { courier: { state: "done", task: "Delivered (sandbox)" } } },
  ];
}
export const SANDBOX_END = 35;
