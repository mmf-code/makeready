/**
 * Render an existing real model without generating a replacement.
 * Default: read + local evidence only. --apply --confirm-cost authorizes exactly one
 * recorded vision request. A durable budget/dispatch marker prevents paid reruns,
 * including after an ambiguous response or interrupted process. No migrations/cron/deploy.
 * NODE_OPTIONS=--conditions=react-server pnpm exec tsx scripts/review-live-model.mts \
 *   --env-file /path/to/.env.local --session UUID --revision UUID [--apply --confirm-cost]
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { z } from "zod";
import { validateTarget, connectionConfig, verifiedCertificate } from "./setup-database.mjs";
import { checked, getDb } from "../src/lib/db";
import { readArtifact, storeArtifact } from "../src/lib/storage";
import { RevisionSchema, type Revision } from "../src/lib/contracts";
import { createDesignIntelligence, isIntelligenceConfigured, type IntelligenceResponseMetadata } from "../src/lib/providers/openai";
import { renderModelViews, RENDERER_VERSION } from "../src/lib/geometry/render";
import { appendModelReview, modelReviewId } from "../src/lib/harness/evaluate";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
export type ReviewDatabase={query:(sql:string,values?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>};
const RESERVE=100_000; // Bounded application estimate, not a provider invoice.

export async function claimReview(db:ReviewDatabase,input:{scope:string;jobId:string;sessionId:string;reviewId:string;revisionId:string}) {
  await db.query("BEGIN");
  try {
    const budget=await db.query("SELECT scope FROM public.make_budgets WHERE scope=$1 FOR UPDATE",[input.scope]);
    if(!budget.rows.length) throw new Error("BUDGET_NOT_FOUND");
    const job=await db.query("SELECT id FROM public.generation_jobs WHERE id=$1 AND session_id=$2 AND scope=$3 AND data->>'status'='completed'",[input.jobId,input.sessionId,input.scope]);
    if(!job.rows.length) throw new Error("COMPLETED_MODEL_JOB_REQUIRED");
    const previous=await db.query("SELECT id FROM public.generation_job_events WHERE job_id=$1 AND kind='model_review_requested' AND data->>'reviewId'=$2",[input.jobId,input.reviewId]);
    if(previous.rows.length) {await db.query("COMMIT");return false;}
    const reserved=await db.query("UPDATE public.make_budgets SET reserved_micros=reserved_micros+$2 WHERE scope=$1 AND cap_micros-spent_micros-reserved_micros >= $2 RETURNING scope",[input.scope,RESERVE]);
    if(!reserved.rows.length) throw new Error("BUDGET_EXCEEDED");
    await db.query("INSERT INTO public.generation_job_events(job_id,kind,data) VALUES($1,'model_review_requested',$2::jsonb)",[input.jobId,JSON.stringify({reviewId:input.reviewId,revisionId:input.revisionId,state:"dispatching",reservedMicros:RESERVE})]);
    await db.query("COMMIT");return true;
  } catch(error) {await db.query("ROLLBACK");throw error;}
}
export async function settleReview(db:ReviewDatabase,input:{scope:string;jobId:string;reviewId:string;state:string}) {
  await db.query("BEGIN");
  try {
    await db.query("SELECT scope FROM public.make_budgets WHERE scope=$1 FOR UPDATE",[input.scope]);
    const previous=await db.query("SELECT id FROM public.generation_job_events WHERE job_id=$1 AND kind='model_review_settled' AND data->>'reviewId'=$2",[input.jobId,input.reviewId]);
    if(!previous.rows.length) {
      const requested=await db.query("SELECT id FROM public.generation_job_events WHERE job_id=$1 AND kind='model_review_requested' AND data->>'reviewId'=$2",[input.jobId,input.reviewId]);
      if(!requested.rows.length)throw new Error("REVIEW_NOT_RESERVED");
      await db.query("INSERT INTO public.generation_job_events(job_id,kind,data) VALUES($1,'model_review_settled',$2::jsonb)",[input.jobId,JSON.stringify({reviewId:input.reviewId,state:input.state})]);
      await db.query("UPDATE public.make_budgets SET reserved_micros=reserved_micros-$2,spent_micros=spent_micros+$2 WHERE scope=$1",[input.scope,RESERVE]);
    }
    await db.query("COMMIT");
  } catch(error) {await db.query("ROLLBACK");throw error;}
}
async function main() {
  const flags=new Map<string,string>();let apply=false,confirmed=false;
  for(let i=2;i<process.argv.length;i++) {const key=process.argv[i];if(key==="--apply")apply=true;else if(key==="--confirm-cost")confirmed=true;else if(["--session","--revision","--env-file"].includes(key)&&process.argv[i+1])flags.set(key,process.argv[++i]);else throw new Error("INVALID_ARGUMENT");}
  if(apply&&!confirmed)throw new Error("CONFIRM_COST_REQUIRED");
  if(flags.get("--env-file"))process.loadEnvFile(resolve(flags.get("--env-file")!));
  const sessionId=z.uuid().parse(flags.get("--session")),revisionId=z.uuid().parse(flags.get("--revision"));
  const target=validateTarget(process.env);
  const row=await checked(getDb().from("design_records").select("data").eq("id",revisionId).eq("session_id",sessionId).eq("kind","revision").single());
  const revision:Revision=RevisionSchema.parse(row.data);
  const model=revision.artifacts.find(a=>a.kind==="model_glb"),reference=revision.artifacts.find(a=>a.kind==="concept_image")??revision.artifacts.find(a=>a.kind==="source_image");
  if(revision.kind!=="manufacturing"||!model||!reference||!revision.sourceJobId)throw new Error("MODEL_AND_REFERENCE_REQUIRED");
  const reviewId=modelReviewId(revision,{renderer:RENDERER_VERSION,modelSha256:model.sha256,referenceSha256:reference.sha256});
  const existing=await checked(getDb().from("design_records").select("id").eq("session_id",sessionId).eq("kind","evaluation"));
  if(existing.some(e=>e.id===reviewId)){console.info(`model_review: ALREADY_RECORDED ${reviewId} (no paid request)`);return;}
  if(apply) {
    const dispatches=await checked(getDb().from("generation_job_events").select("id").eq("job_id",revision.sourceJobId).eq("kind","model_review_requested").eq("data->>reviewId",reviewId));
    if(dispatches.length){console.info(`model_review: DISPATCH_ALREADY_RECORDED ${reviewId} (no paid request; inspect the existing receipt)`);return;}
  }
  const rendered=await renderModelViews(await readArtifact(model));
  const directory=join(root,"artifacts/live",`model-review-${revisionId}`);await mkdir(directory,{recursive:true});
  await writeFile(join(directory,"views.png"),rendered.sheet);
  await writeFile(join(directory,"render-evidence.json"),JSON.stringify({...rendered.manifest,referenceSha256:reference.sha256},null,2));
  console.info(`model_render: PASS ${directory}`);
  if(!apply){console.info("model_review: CHECK_ONLY (no paid request or database writes)");return;}
  if(!isIntelligenceConfigured())throw new Error("INTELLIGENCE_NOT_CONFIGURED");
  // Resolve and verify all input bytes before reserving budget or dispatching.
  const referenceBytes=await readArtifact(reference);
  const sheet=await storeArtifact(sessionId,"concept_image",rendered.sheet,"image/png","png");
  const manifest=await storeArtifact(sessionId,"manifest",Buffer.from(JSON.stringify({...rendered.manifest,referenceSha256:reference.sha256})),"application/json","json");
  const evidence={renderer:RENDERER_VERSION,modelSha256:model.sha256,referenceSha256:reference.sha256,renderImage:sheet,manifest};
  const session=await checked(getDb().from("design_sessions").select("scope").eq("id",sessionId).single());
  const client=new Client(connectionConfig(target,verifiedCertificate(await readFile(join(root,"supabase/certs/supabase-root-2021.pem"),"utf8"))));
  await client.connect();const db:ReviewDatabase={query:async(sql,values)=>client.query(sql,values)};
  const identity={scope:session.scope as string,jobId:revision.sourceJobId,sessionId,reviewId,revisionId};
  let claimed=false;
  try {
    claimed=await claimReview(db,identity);
    if(!claimed){console.info(`model_review: DISPATCH_ALREADY_RECORDED ${reviewId} (no paid request; inspect the existing receipt)`);return;}
    let receipt:IntelligenceResponseMetadata|undefined;
    const visual=await createDesignIntelligence({onResponse:async metadata=>{
      receipt=metadata;
      await db.query("INSERT INTO public.generation_job_events(job_id,kind,data) VALUES($1,'model_review_response',$2::jsonb)",[identity.jobId,JSON.stringify({reviewId,receipt:metadata})]);
    }}).critiqueVisual({spec:revision.spec,candidateKind:"model_views",renderLimitations:rendered.manifest.limitations,
      candidateImageUrl:`data:image/png;base64,${rendered.sheet.toString("base64")}`,referenceImageUrl:`data:${reference.mimeType};base64,${Buffer.from(referenceBytes).toString("base64")}`});
    const evaluation=await appendModelReview(revision,visual,receipt!.model,evidence);
    await writeFile(join(directory,"review.json"),JSON.stringify({evaluation,receipt},null,2));
    await settleReview(db,{...identity,state:"completed"});claimed=false;
    console.info(`model_review: RECORDED ${evaluation.id} alignment=${visual.alignment} observations=${visual.observations.length}`);
  } catch(error) {
    if(claimed)await settleReview(db,{...identity,state:"failed_or_unknown"}).catch(()=>{});
    throw error;
  } finally {await client.end().catch(()=>{});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(()=>{console.error("model_review: FAILED (no automatic paid retry; inspect stored dispatch/receipt)");process.exitCode=1;});
