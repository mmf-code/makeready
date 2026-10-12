import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import JSZip from "jszip";
import { z } from "zod";
import { createClient, MakeReadyClientError } from "../src/lib/client/index";
import { PhysicalAuditSchema, type DesignSession, type GenerationJob, type Revision } from "../src/lib/contracts";

const usage = `MakeReady real photo/text → approved concept → fal GLB → verified make package

Required environment: APP_URL, DEMO_PASSWORD
Usage: pnpm exec tsx scripts/generate-live.mts --image /path/reference.png --confirm-cost
       pnpm exec tsx scripts/generate-live.mts --text --prompt "A shallow wooden coaster" --use "CNC 3-axis candidate" --confirm-cost
Options: --prompt "A figurine" --use "Paintable tabletop figurine" --height-mm 120 --feedback "Smaller ears, preserve face"
         --output /path/results --max-polls 180 --poll-ms 5000 --help
Read-only billing refresh: --collect-costs /path/run.json [--output /path/results]

Without --confirm-cost this command makes no HTTP requests, except explicit read-only --collect-costs.
No paid POST is retried. Billing reads use local FAL_BILLING_KEY, falling back to FAL_KEY.
Optional feedback invokes real configured AI planning/editing before model generation.`;

class RunError extends Error { constructor(readonly code: string) { super(code); } }
const JobEvidenceSchema = z.object({
  jobId: z.uuid(), operation: z.string().max(60), status: z.string().max(60),
  provider: z.enum(["fal", "openai", "local"]).nullable(),
  providerRequestId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/).nullable(),
  estimatedCostUsd: z.number().finite().nonnegative(), createdAt: z.iso.datetime(),
});
type JobEvidence = z.infer<typeof JobEvidenceSchema>;
const NullableAmount = z.number().finite().nonnegative().nullable().optional();
const BillingEventSchema = z.object({
  request_id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), endpoint_id: z.string().regex(/^[a-zA-Z0-9_./-]{1,250}$/),
  timestamp: z.iso.datetime({ offset: true }), quantity: NullableAmount, output_units: NullableAmount,
  unit: z.string().regex(/^[a-zA-Z0-9_ ./-]{0,100}$/).nullable().optional(), unit_price: NullableAmount,
  cost_subtotal: NullableAmount, cost_discount: NullableAmount, cost_total: NullableAmount,
  cost_estimate_nano_usd: z.number().safe().nonnegative().nullable().optional(),
});
const BillingPageSchema = z.object({
  billing_events: z.array(BillingEventSchema).max(1000), has_more: z.boolean(), next_cursor: z.string().max(8192).nullable(),
});
type BillingEvent = z.infer<typeof BillingEventSchema>;
type BillingReason = "VERIFIED" | "BILLING_KEY_UNAVAILABLE" | "BILLING_ACCESS_DENIED" | "BILLING_READ_UNAVAILABLE" | "BILLING_RESPONSE_INVALID" | "BILLING_PAGINATION_INCOMPLETE" | "BILLING_NOT_RECORDED" | "BILLED_USD_UNAVAILABLE" | "PROVIDER_REQUEST_ID_UNAVAILABLE";
type RequestBilling = {
  jobId: string; requestId: string | null; status: BillingReason; actualSpentUsd: number | null;
  events: { endpointId: string; timestamp: string; billedUnits: number | null; unit: string | null;
    unitPriceUsd: number | null; subtotalUsd: number | null; discountUsd: number | null;
    actualSpentUsd: number | null; chargedNanoUsd: number | null }[];
};
type CostEvidence = {
  collectedAt: string; totalActualSpentUsd: null; estimatedJobReservationsUsd: number;
  fal: { source: "https://api.fal.ai/v1/models/billing-events?source=billed"; coverage: "complete" | "partial" | "unavailable";
    actualSpentUsd: number | null; verifiedSubtotalUsd: number | null; requests: RequestBilling[] };
  limitations: string[];
};
type Receipt = { runId: string; createdAt: string; appOrigin?: string; stage: string; idempotencyKeys: Record<string,string>; ids: Record<string,string>; jobs: JobEvidence[]; costs?: CostEvidence };
const runId = randomUUID();
const receipt: Receipt = { runId, createdAt: new Date().toISOString(), stage: "preflight", idempotencyKeys: Object.fromEntries(["concept","planning","refinement","model"].map(stage => [stage,`${runId}:${stage}`])), ids: {}, jobs: [] };
let output: string | undefined;
let recoveryClient: ReturnType<typeof createClient> | undefined;
let refreshOnly = false;

function argumentsFor(argv: string[]) {
  const values = new Map<string,string>(); let confirmed = false; let textInput = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--confirm-cost") { confirmed = true; continue; }
    if (argument === "--text") { if (textInput) throw new RunError("INVALID_ARGUMENT"); textInput = true; continue; }
    if (argument === "--help") return { help: true, confirmed, textInput, values };
    if (!["--image","--prompt","--use","--height-mm","--feedback","--output","--max-polls","--poll-ms","--collect-costs"].includes(argument) || !argv[index+1] || argv[index+1].startsWith("--") || values.has(argument)) throw new RunError("INVALID_ARGUMENT");
    values.set(argument,argv[++index]);
  }
  return { help: false, confirmed, textInput, values };
}
function numberOption(values: Map<string,string>, key: string, fallback: number, min: number, max: number) {
  const number = Number(values.get(key) ?? fallback);
  if (!Number.isFinite(number) || number < min || number > max) throw new RunError("INVALID_ARGUMENT");
  return number;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function save() {
  if (output) await writeFile(resolve(output,"run.json"),`${JSON.stringify(receipt,null,2)}\n`,{ mode: 0o600 });
}
async function stage(name: string, ids: Record<string,string> = {}) {
  receipt.stage = name; Object.assign(receipt.ids,ids); await save();
  console.log(JSON.stringify({ event: name, runId, ...ids }));
}
function revisionFor(session: DesignSession, job: GenerationJob): Revision {
  const revision = session.revisions.find(value => value.id === job.result?.revisionId);
  if (!revision) throw new RunError("COMPLETED_REVISION_MISSING");
  return revision;
}

function rememberJobs(jobs: GenerationJob[]) {
  for (const job of jobs) {
    const value = JobEvidenceSchema.parse({ jobId: job.id, operation: job.operation, status: job.status, provider: job.provider,
      providerRequestId: job.providerRequestId, estimatedCostUsd: job.estimatedCostUsd, createdAt: job.createdAt });
    const index = receipt.jobs.findIndex(item => item.jobId === job.id);
    if (index < 0) receipt.jobs.push(value); else receipt.jobs[index] = value;
  }
}

/** Billing source=billed is authoritative; prices/allowances/usage estimates are never substituted. */
async function collectCosts(jobs: JobEvidence[]): Promise<CostEvidence> {
  const falJobs = jobs.filter(job => job.provider === "fal");
  const requests: RequestBilling[] = falJobs.map(job => ({ jobId: job.jobId, requestId: job.providerRequestId,
    status: job.providerRequestId ? "BILLING_NOT_RECORDED" : "PROVIDER_REQUEST_ID_UNAVAILABLE", actualSpentUsd: null, events: [] }));
  const requestIds = [...new Set(requests.flatMap(request => request.requestId ? [request.requestId] : []))];
  const key = process.env.FAL_BILLING_KEY || process.env.FAL_KEY;
  let failure: BillingReason | undefined;
  const events: BillingEvent[] = [];
  if (requestIds.length && !key) failure = "BILLING_KEY_UNAVAILABLE";
  else if (requestIds.length) {
    try {
      for (let offset = 0; offset < requestIds.length; offset += 50) {
        const batch = requestIds.slice(offset, offset + 50);
        let cursor: string | null = null;
        for (let page = 0; page < 10; page++) {
          const url = new URL("https://api.fal.ai/v1/models/billing-events");
          url.searchParams.set("source", "billed"); url.searchParams.set("limit", "1000");
          // Exact request filtering avoids collecting unrelated account usage or user metadata.
          batch.forEach(id => url.searchParams.append("request_id", id));
          const start = Math.min(...falJobs.filter(job => batch.includes(job.providerRequestId ?? "")).map(job => Date.parse(job.createdAt))) - 60_000;
          if (!Number.isFinite(start) || start < Date.now() - 89 * 24 * 3600_000) { failure = "BILLING_READ_UNAVAILABLE"; break; }
          url.searchParams.set("start", new Date(start).toISOString());
          if (cursor) url.searchParams.set("cursor", cursor);
          const response = await fetch(url, { method: "GET", headers: { Authorization: `Key ${key}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(20_000) });
          if (!response.ok) { await response.body?.cancel(); failure = response.status === 401 || response.status === 403 ? "BILLING_ACCESS_DENIED" : "BILLING_READ_UNAVAILABLE"; break; }
          const parsed = BillingPageSchema.safeParse(await response.json());
          if (!parsed.success || parsed.data.billing_events.some(event => !batch.includes(event.request_id))) { failure = "BILLING_RESPONSE_INVALID"; break; }
          events.push(...parsed.data.billing_events);
          if (!parsed.data.has_more) break;
          if (!parsed.data.next_cursor || parsed.data.next_cursor === cursor || page === 9) { failure = "BILLING_PAGINATION_INCOMPLETE"; break; }
          cursor = parsed.data.next_cursor;
        }
        if (failure) break;
      }
    } catch { failure = "BILLING_READ_UNAVAILABLE"; }
  }
  for (const request of requests) {
    if (!request.requestId) continue;
    if (failure) { request.status = failure; continue; }
    const matched = events.filter(event => event.request_id === request.requestId);
    if (!matched.length) continue; // A missing event is pending/unavailable, never zero spending.
    const identities = matched.map(event => JSON.stringify(event));
    if (new Set(identities).size !== matched.length) { request.status = "BILLING_RESPONSE_INVALID"; continue; }
    request.events = matched.map(event => {
      const nano = event.cost_estimate_nano_usd ?? null;
      const total = event.cost_total ?? null;
      // The official schema calls nano USD the precision-preserving amount CHARGED.
      const agree = (nano === null || total === null || Math.abs(nano / 1e9 - total) <= 1e-9) &&
        (event.cost_subtotal == null || event.cost_discount == null || total === null || Math.abs(event.cost_subtotal - event.cost_discount - total) <= 1e-9) &&
        (event.quantity == null || event.output_units == null || event.quantity === event.output_units);
      return { endpointId: event.endpoint_id, timestamp: event.timestamp, billedUnits: event.quantity ?? event.output_units ?? null,
        unit: event.unit ?? null, unitPriceUsd: event.unit_price ?? null, subtotalUsd: event.cost_subtotal ?? null,
        discountUsd: event.cost_discount ?? null, actualSpentUsd: agree ? nano === null ? total : nano / 1e9 : null, chargedNanoUsd: agree ? nano : null };
    });
    if (request.events.some(event => event.actualSpentUsd === null)) { request.status = "BILLED_USD_UNAVAILABLE"; continue; }
    request.status = "VERIFIED";
    const nanos = request.events.map(event => event.chargedNanoUsd);
    request.actualSpentUsd = nanos.every((value): value is number => value !== null) && Number.isSafeInteger(nanos.reduce((sum, value) => sum + value, 0))
      ? nanos.reduce((sum, value) => sum + value, 0) / 1e9 : request.events.reduce((sum, event) => sum + event.actualSpentUsd!, 0);
  }
  const allVerified = requests.filter(request => request.status === "VERIFIED");
  const verified = allVerified.filter((request, index) => allVerified.findIndex(value => value.requestId === request.requestId) === index);
  const complete = requests.length > 0 && allVerified.length === requests.length;
  const nanoAmounts = verified.flatMap(request => request.events.map(event => event.chargedNanoUsd));
  const totalNanoUsd = nanoAmounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0);
  const verifiedSubtotalUsd = verified.length ? nanoAmounts.every(value => value !== null) && Number.isSafeInteger(totalNanoUsd)
    ? totalNanoUsd / 1e9 : verified.reduce((sum, request) => sum + request.actualSpentUsd!, 0) : null;
  return {
    collectedAt: new Date().toISOString(), totalActualSpentUsd: null,
    estimatedJobReservationsUsd: jobs.reduce((sum, job) => sum + job.estimatedCostUsd, 0),
    fal: { source: "https://api.fal.ai/v1/models/billing-events?source=billed", coverage: complete ? "complete" : verified.length ? "partial" : "unavailable",
      actualSpentUsd: complete ? verifiedSubtotalUsd : null, verifiedSubtotalUsd, requests },
    limitations: [
      "Only exact fal request IDs in the saved job receipts are queried. Missing IDs/events or denied billing access are not zero spending.",
      "Job budget reservations are estimates, not billed amounts. Credits, prepaid balance and top-ups are not request spending.",
      "Total spending across all providers is unverified: LLM design, planning and visual-critique charges are not collected here.",
      "Billing events may arrive after the model finishes. Refresh with --collect-costs; never rerun generation to obtain billing evidence.",
    ],
  };
}

async function refreshBilling(path: string, destination?: string) {
  refreshOnly = true;
  const saved = z.object({ runId: z.uuid(), jobs: z.array(JobEvidenceSchema) }).parse(JSON.parse(await readFile(resolve(path), "utf8")));
  const costs = await collectCosts(saved.jobs);
  const folder = resolve(destination ?? dirname(resolve(path)));
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(resolve(folder, "billing.json"), `${JSON.stringify({ runId: saved.runId, ...costs }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ event: "billing_collected", runId: saved.runId, ...costs }));
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) { console.log(usage); return; }
  const billingReceipt = options.values.get("--collect-costs");
  if (billingReceipt) {
    if (options.confirmed || options.textInput || [...options.values.keys()].some(key => !["--collect-costs", "--output"].includes(key))) throw new RunError("INVALID_ARGUMENT");
    await refreshBilling(billingReceipt, options.values.get("--output")); return;
  }
  if (!options.confirmed) throw new RunError("CONFIRM_COST_REQUIRED");
  const imagePath = options.values.get("--image");
  if (Boolean(imagePath) === options.textInput) throw new RunError("INVALID_ARGUMENT");
  const prompt = options.values.get("--prompt") ?? (options.textInput ? "" : "Create a physical figurine from this reference. Preserve its recognizable features.");
  const use = options.values.get("--use") ?? "Paintable tabletop figurine";
  if (!prompt.trim() || prompt.length > 6000 || !use.trim()) throw new RunError("INVALID_ARGUMENT");
  const password = process.env.DEMO_PASSWORD;
  if (!process.env.APP_URL || !password) throw new RunError("CONFIGURATION_REQUIRED");
  let app: URL;
  try { app = new URL(process.env.APP_URL); } catch { throw new RunError("INVALID_APP_URL"); }
  if (app.username || app.password || app.search || app.hash || app.pathname !== "/" || !(app.protocol === "https:" || app.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(app.hostname))) throw new RunError("INVALID_APP_URL");
  const heightMm = numberOption(options.values,"--height-mm",120,.01,2000);
  const maxPolls = numberOption(options.values,"--max-polls",180,1,360);
  const intervalMs = numberOption(options.values,"--poll-ms",5000,500,30_000);
  if (!Number.isInteger(maxPolls) || !Number.isInteger(intervalMs)) throw new RunError("INVALID_ARGUMENT");
  let original: Buffer | undefined;
  let mime: string | undefined;
  if (imagePath) {
    mime = new Map([[".png","image/png"],[".jpg","image/jpeg"],[".jpeg","image/jpeg"],[".webp","image/webp"]]).get(extname(imagePath).toLowerCase());
    if (!mime) throw new RunError("UNSUPPORTED_IMAGE_TYPE");
    original = await readFile(resolve(imagePath));
    if (!original.length || original.length > 10 * 1024 * 1024) throw new RunError("INVALID_IMAGE_SIZE");
  }
  output = resolve(options.values.get("--output") ?? `artifacts/live/${runId}`);
  await mkdir(output,{ recursive: true, mode: 0o700 });
  receipt.appOrigin = app.origin; await save();

  const cookies = new Map<string,string>();
  const transport: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const apiRequest = url.origin === app.origin && url.pathname.startsWith("/api/");
    const headers = new Headers(init.headers);
    if (apiRequest) {
      headers.set("Origin",app.origin);
      if (cookies.size) headers.set("Cookie",[...cookies].map(([key,value]) => `${key}=${value}`).join("; "));
    }
    const timeout = AbortSignal.timeout(150_000);
    const signal = init.signal ? AbortSignal.any([init.signal,timeout]) : timeout;
    const response = await fetch(input,{ ...init, headers, signal, redirect: "error" });
    if (apiRequest) for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";",1)[0], equals = pair.indexOf("=");
      if (equals > 0) cookies.set(pair.slice(0,equals),pair.slice(equals+1));
    }
    return response;
  };
  const client = createClient({ baseUrl: app.origin, fetch: transport, cache: false });
  recoveryClient = client;
  async function wait(jobId: string): Promise<GenerationJob> {
    let lastStatus = "";
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      const job = await client.getJob(jobId);
      rememberJobs([job]); await save();
      if (job.status !== lastStatus) { console.log(JSON.stringify({ event: "job_status", jobId, status: job.status, progress: job.progress })); lastStatus = job.status; }
      if (job.status === "completed") return job;
      if (job.status === "failed" || job.status === "submission_unknown") throw new RunError(job.status === "submission_unknown" ? "SUBMISSION_UNKNOWN" : "JOB_FAILED");
      if (attempt + 1 < maxPolls) await delay(intervalMs);
    }
    throw new RunError("POLL_LIMIT_REACHED");
  }

  await stage("unlocking"); await client.unlock({ password, returnTo: "/" });
  if (!cookies.size) throw new RunError("ACCESS_COOKIE_MISSING");
  const session = await client.createSession({ title: options.textInput ? "Live text-to-make run" : "Live photo-to-make run" });
  await stage("session_created",{ sessionId: session.id });
  let imageArtifactId: string | undefined;
  if (imagePath && original && mime) {
    const uploaded = await client.uploadSourceImage(session.id,new Blob([new Uint8Array(original)],{ type: mime }),{ fileName: basename(imagePath) });
    if (uploaded.sha256 !== sha256(original)) throw new RunError("UPLOAD_HASH_MISMATCH");
    imageArtifactId = uploaded.id;
    await stage("photo_verified",{ sourceImageArtifactId: uploaded.id });
  }
  const started = await client.startDesign({ sessionId: session.id, ...(imageArtifactId ? { imageArtifactId } : {}), prompt, heightMm, use, confirmCost: true, idempotencyKey: receipt.idempotencyKeys.concept });
  rememberJobs([started.job]);
  await stage("concept_started",{ conceptJobId: started.job.id });
  const completedConcept = await wait(started.job.id);
  let concept = revisionFor(await client.getSession(session.id),completedConcept);
  await stage("concept_completed",{ conceptRevisionId: concept.id });

  const feedback = options.values.get("--feedback");
  if (feedback) {
    await client.decideRevision({ revisionId: concept.id, decision: "reject", note: feedback });
    await stage("planning_revision");
    const plan = await client.planRevision({ sessionId: session.id, revisionId: concept.id, feedback, confirmCost: true, idempotencyKey: receipt.idempotencyKeys.planning });
    await stage("plan_saved",{ planId: plan.id });
    const refinement = await client.executePlan({ planId: plan.id, confirmCost: true, idempotencyKey: receipt.idempotencyKeys.refinement });
    rememberJobs([refinement]);
    await stage("refinement_started",{ refinementJobId: refinement.id });
    const completed = await wait(refinement.id);
    concept = revisionFor(await client.getSession(session.id),completed);
    if (concept.parentRevisionId !== receipt.ids.conceptRevisionId) throw new RunError("REVISION_LINEAGE_MISMATCH");
    await stage("refinement_completed",{ refinedRevisionId: concept.id });
  }
  if (concept.kind !== "concept") throw new RunError("EXPECTED_CONCEPT_REVISION");
  const decision = await client.decideRevision({ revisionId: concept.id, decision: "approve", note: "Live runner approval of this exact stored revision for model generation." });
  if (JSON.stringify([...decision.artifactHashes].sort()) !== JSON.stringify(concept.artifacts.map(value => value.sha256).sort())) throw new RunError("APPROVAL_HASH_MISMATCH");
  await stage("exact_revision_approved",{ approvedRevisionId: concept.id, decisionId: decision.id });
  const generation = await client.generateModel({ revisionId: concept.id, confirmCost: true, idempotencyKey: receipt.idempotencyKeys.model });
  rememberJobs([generation]);
  await stage("model_started",{ modelJobId: generation.id });
  const completed = await wait(generation.id);
  const finalSession = await client.getSession(session.id), manufacturing = revisionFor(finalSession,completed);
  rememberJobs(finalSession.jobs);
  if (manufacturing.kind !== "manufacturing") throw new RunError("EXPECTED_MANUFACTURING_REVISION");
  await stage("model_completed",{ manufacturingRevisionId: manufacturing.id });
  const pack = await client.getMakePackage(manufacturing.id);
  const zipBytes = new Uint8Array(await (await client.getArtifactBlob(pack.artifact)).arrayBuffer());
  const zip = await JSZip.loadAsync(zipBytes,{ checkCRC32: true });
  const required = [["source.glb","source_glb"],["normalized.glb","model_glb"],["model.stl","model_stl"]] as const;
  const verifiedFiles: Record<string,{ sha256: string; bytes: number }> = {};
  for (const [file,kind] of required) {
    const entry = zip.file(file), expected = manufacturing.artifacts.find(value => value.kind === kind);
    if (!entry || !expected) throw new RunError("PACKAGE_FILE_MISSING");
    const bytes = await entry.async("uint8array");
    if (sha256(bytes) !== expected.sha256 || bytes.length !== expected.sizeBytes) throw new RunError("PACKAGE_HASH_MISMATCH");
    verifiedFiles[file] = { sha256: expected.sha256, bytes: bytes.length };
    await writeFile(resolve(output,file),bytes,{ mode: 0o600 });
  }
  const auditFile = zip.file("audit.json"); if (!auditFile) throw new RunError("PACKAGE_AUDIT_MISSING");
  const audit = PhysicalAuditSchema.parse(JSON.parse(await auditFile.async("string")));
  if (audit.inputSha256 !== verifiedFiles["source.glb"].sha256 || audit.outputSha256.glb !== verifiedFiles["normalized.glb"].sha256 || audit.outputSha256.stl !== verifiedFiles["model.stl"].sha256 || JSON.stringify(audit) !== JSON.stringify(pack.audit)) throw new RunError("PACKAGE_AUDIT_MISMATCH");
  await writeFile(resolve(output,"make-package.zip"),zipBytes,{ mode: 0o600 });
  await writeFile(resolve(output,"audit.json"),`${JSON.stringify(audit,null,2)}\n`,{ mode: 0o600 });
  await stage("package_verified",{ packageArtifactId: pack.artifact.id });
  receipt.costs = await collectCosts(receipt.jobs); await save();
  const report = {
    ...receipt, package: { sha256: pack.artifact.sha256, bytes: zipBytes.length, verifiedFiles },
    physical: { manufacturingStatus: audit.manufacturingStatus, dimensionsMm: audit.measuredBoundsMm, targetHeightMm: audit.targetHeightMm, triangleCount: audit.triangleCount, checks: audit.checks.map(({ id,status,actual,threshold }) => ({ id,status,actual,threshold })), notChecked: audit.notChecked },
    visual: finalSession.evaluations.filter(value => value.revisionId === manufacturing.id && value.kind === "visual").map(value => ({ engine: value.engine, method: value.method, limitations: value.limitations })),
    human: { approvedRevisionId: concept.id, decisionId: decision.id },
  };
  await writeFile(resolve(output,"result.json"),`${JSON.stringify(report,null,2)}\n`,{ mode: 0o600 });
  console.log(JSON.stringify({ event: "result", ...report },null,2));
}

main().catch(async error => {
  const candidate = error instanceof RunError || error instanceof MakeReadyClientError ? error.code : "RUN_FAILED";
  const code = /^[A-Z][A-Z0-9_]{1,60}$/.test(candidate) ? candidate : "RUN_FAILED";
  if (!refreshOnly && output) {
    if (recoveryClient && receipt.ids.sessionId) {
      try { rememberJobs((await recoveryClient.getSession(receipt.ids.sessionId)).jobs); } catch { /* No paid retry or invented receipt. */ }
    }
    receipt.costs = await collectCosts(receipt.jobs);
  }
  await save().catch(() => {});
  console.error(JSON.stringify({ event: "stopped", code, ...receipt, recovery: "Inspect the saved session and job IDs. No paid request was retried. For an ambiguous response, reconcile its saved idempotency key before any new submission." }));
  process.exitCode = 1;
});
