import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import JSZip from "jszip";
import { createClient, MakeReadyClientError } from "../src/lib/client/index";
import { PhysicalAuditSchema, type DesignSession, type GenerationJob, type Revision } from "../src/lib/contracts";

const usage = `MakeReady real photo → approved concept → fal GLB → verified make package

Required environment: APP_URL, DEMO_PASSWORD
Usage: pnpm exec tsx scripts/generate-live.mts --image /path/reference.png --confirm-cost
Options: --prompt "A figurine" --height-mm 120 --feedback "Smaller ears, preserve face"
         --output /path/results --max-polls 180 --poll-ms 5000 --help

Without --confirm-cost this command makes no HTTP requests. No paid POST is retried.
Optional feedback invokes real configured AI planning/editing before model generation.`;

class RunError extends Error { constructor(readonly code: string) { super(code); } }
type Receipt = { runId: string; appOrigin?: string; stage: string; idempotencyKeys: Record<string,string>; ids: Record<string,string> };
const runId = randomUUID();
const receipt: Receipt = { runId, stage: "preflight", idempotencyKeys: Object.fromEntries(["concept","planning","refinement","model"].map(stage => [stage,`${runId}:${stage}`])), ids: {} };
let output: string | undefined;

function argumentsFor(argv: string[]) {
  const values = new Map<string,string>(); let confirmed = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--confirm-cost") { confirmed = true; continue; }
    if (argument === "--help") return { help: true, confirmed, values };
    if (!["--image","--prompt","--height-mm","--feedback","--output","--max-polls","--poll-ms"].includes(argument) || !argv[index+1] || argv[index+1].startsWith("--") || values.has(argument)) throw new RunError("INVALID_ARGUMENT");
    values.set(argument,argv[++index]);
  }
  return { help: false, confirmed, values };
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

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) { console.log(usage); return; }
  if (!options.confirmed) throw new RunError("CONFIRM_COST_REQUIRED");
  const imagePath = options.values.get("--image");
  const password = process.env.DEMO_PASSWORD;
  if (!imagePath || !process.env.APP_URL || !password) throw new RunError("CONFIGURATION_REQUIRED");
  let app: URL;
  try { app = new URL(process.env.APP_URL); } catch { throw new RunError("INVALID_APP_URL"); }
  if (app.username || app.password || app.search || app.hash || app.pathname !== "/" || !(app.protocol === "https:" || app.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(app.hostname))) throw new RunError("INVALID_APP_URL");
  const heightMm = numberOption(options.values,"--height-mm",120,.01,2000);
  const maxPolls = numberOption(options.values,"--max-polls",180,1,360);
  const intervalMs = numberOption(options.values,"--poll-ms",5000,500,30_000);
  if (!Number.isInteger(maxPolls) || !Number.isInteger(intervalMs)) throw new RunError("INVALID_ARGUMENT");
  const mime = new Map([[".png","image/png"],[".jpg","image/jpeg"],[".jpeg","image/jpeg"],[".webp","image/webp"]]).get(extname(imagePath).toLowerCase());
  if (!mime) throw new RunError("UNSUPPORTED_IMAGE_TYPE");
  const original = await readFile(resolve(imagePath));
  if (!original.length || original.length > 10 * 1024 * 1024) throw new RunError("INVALID_IMAGE_SIZE");
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
  async function wait(jobId: string): Promise<GenerationJob> {
    let lastStatus = "";
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      const job = await client.getJob(jobId);
      if (job.status !== lastStatus) { console.log(JSON.stringify({ event: "job_status", jobId, status: job.status, progress: job.progress })); lastStatus = job.status; }
      if (job.status === "completed") return job;
      if (job.status === "failed" || job.status === "submission_unknown") throw new RunError(job.status === "submission_unknown" ? "SUBMISSION_UNKNOWN" : "JOB_FAILED");
      if (attempt + 1 < maxPolls) await delay(intervalMs);
    }
    throw new RunError("POLL_LIMIT_REACHED");
  }

  await stage("unlocking"); await client.unlock({ password, returnTo: "/" });
  if (!cookies.size) throw new RunError("ACCESS_COOKIE_MISSING");
  const session = await client.createSession({ title: "Live photo-to-make run" });
  await stage("session_created",{ sessionId: session.id });
  const uploaded = await client.uploadSourceImage(session.id,new Blob([original],{ type: mime }),{ fileName: basename(imagePath) });
  if (uploaded.sha256 !== sha256(original)) throw new RunError("UPLOAD_HASH_MISMATCH");
  await stage("photo_verified",{ sourceImageArtifactId: uploaded.id });
  const started = await client.startDesign({ sessionId: session.id, imageArtifactId: uploaded.id, prompt: options.values.get("--prompt") ?? "Create a physical figurine from this reference. Preserve its recognizable features.", heightMm, use: "Paintable tabletop figurine", confirmCost: true, idempotencyKey: receipt.idempotencyKeys.concept });
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
  await stage("model_started",{ modelJobId: generation.id });
  const completed = await wait(generation.id);
  const finalSession = await client.getSession(session.id), manufacturing = revisionFor(finalSession,completed);
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
  await save().catch(() => {});
  console.error(JSON.stringify({ event: "stopped", code, ...receipt, recovery: "Inspect the saved session and job IDs. No paid request was retried. For an ambiguous response, reconcile its saved idempotency key before any new submission." }));
  process.exitCode = 1;
});
