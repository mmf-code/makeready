import "server-only";
import { createHash, randomUUID } from "node:crypto";
import {
  ArtifactRefSchema, DesignSessionSchema, DesignSpecSchema, GenerationJobSchema,
  HumanDecisionSchema, NotChecked, RevisionPlanSchema, RevisionSchema, PhysicalAuditSchema,
  StartDesignInputSchema, PlanRevisionInputSchema, ExecutePlanInputSchema, GenerateModelInputSchema,
  DecisionInputSchema, UploadInputSchema, CompleteUploadInputSchema, CreateSessionInputSchema,
  type ArtifactRef, type DesignSession, type GenerationJob, type Revision, type RevisionPlan,
  type StartDesignInput, type PlanRevisionInput, type ExecutePlanInput, type GenerateModelInput,
  type DecisionInput, type UploadInput, type CompleteUploadInput, type CreateSessionInput,
} from "./contracts";
import { checked, getDb, rpc } from "./db";
import { AppError } from "./errors";
import { assertImage, bucket, hashBytes, readArtifact, signedArtifact, storeArtifact } from "./storage";
import { createDesignIntelligence, intelligenceProvider, isIntelligenceConfigured, ProviderError } from "./providers";

const now = () => new Date().toISOString();
const emptySpec = () => DesignSpecSchema.parse({description:"Describe the object you want to make.",objectType:"Unspecified object",use:"Paintable tabletop figurine",targetHeightMm:120,preserve:[],changeable:[],process:"resin_candidate"});
const fingerprint = (input:unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
function sessionIdFor(scope:string,key:string) {
  const hex=fingerprint({namespace:"makeready-session-v1",scope,key});
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
function requireProviders(fal:boolean,openai:boolean) {
  if(fal&&!process.env.FAL_KEY || openai&&!isIntelligenceConfigured()) throw new AppError("PROVIDER_UNAVAILABLE","Required generation provider credentials are not configured.",503);
}
export function budgetMicros() {
  const usd=Number(process.env.MAKE_BUDGET_USD || 50);
  if(!Number.isFinite(usd)||usd<=0||usd>50) throw new AppError("PROVIDER_UNAVAILABLE","MAKE_BUDGET_USD must be between 0 and 50 for this demo.",503);
  return Math.floor(usd*1_000_000);
}
export function assertApproved(revision:Revision, decisions:{decision:string;artifactHashes:string[]}[]) {
  const latest=decisions.at(-1);
  const hashes=revision.artifacts.map(a=>a.sha256).sort();
  if(!latest || latest.decision!=="approve" || JSON.stringify([...latest.artifactHashes].sort())!==JSON.stringify(hashes))
    throw new AppError("CONFLICT","Approve this exact revision before generating its model.",409);
}

/** Shared application service. Transport-specific authentication supplies the scope. */
export function createServices(scopeId="demo") {
  async function sessionRow(id:string) {
    const row=await checked(getDb().from("design_sessions").select("data,updated_at").eq("id",id).eq("scope",scopeId).maybeSingle());
    return row as {data:DesignSession;updated_at:string};
  }
  async function ownedRecord(id:string,kind:"revision"|"plan") {
    const row=await checked(getDb().from("design_records").select("session_id,data").eq("id",id).eq("kind",kind).maybeSingle());
    await sessionRow(row.session_id);
    return row;
  }
  async function revision(id:string) { return RevisionSchema.parse((await ownedRecord(id,"revision")).data); }
  async function artifact(id:string,sessionId:string,verified=true):Promise<ArtifactRef> {
    let query=getDb().from("make_artifacts").select("data,verified").eq("id",id).eq("session_id",sessionId);
    if(verified) query=query.eq("verified",true);
    return ArtifactRefSchema.parse((await checked(query.maybeSingle())).data);
  }
  async function putSession(raw:CreateSessionInput,id:string=randomUUID()) {
    const input=CreateSessionInputSchema.parse(raw),timestamp=now();
    const data=DesignSessionSchema.parse({id,title:input.title||"Untitled design",spec:emptySpec(),createdAt:timestamp,updatedAt:timestamp,revisions:[],jobs:[],plans:[],evaluations:[],comparisons:[],decisions:[],notChecked:[...NotChecked,"regional_feature_measurements"]});
    const {error}=await getDb().from("design_sessions").insert({id:data.id,scope:scopeId,data});
    if(error?.code==="23505") return (await sessionRow(id)).data;
    if(error) throw new AppError("STORAGE_FAILED","Could not create the design session.",503,true);
    return data;
  }
  async function createSession(raw:CreateSessionInput) {return putSession(raw);}
  async function getSession(id:string):Promise<DesignSession> {
    const row=await sessionRow(id);
    const [records,jobs]=await Promise.all([
      checked(getDb().from("design_records").select("kind,data").eq("session_id",id).order("created_at")),
      checked(getDb().from("generation_jobs").select("data").eq("session_id",id).eq("scope",scopeId).order("created_at")),
    ]);
    const revisions=await Promise.all(records.filter(r=>r.kind==="revision").map(async r=>{
      const rev=RevisionSchema.parse(r.data);
      return {...rev,artifacts:await Promise.all(rev.artifacts.map(signedArtifact))};
    }));
    const byKind=(kind:string)=>records.filter(r=>r.kind===kind).map(r=>r.data);
    const evaluations=byKind("evaluation");
    const notChecked=[...new Set([...row.data.notChecked,...evaluations.flatMap(e=>e.kind==="physical"?e.audit.notChecked:[])])];
    // PostgREST returns timestamptz with a numeric offset; public contracts use UTC Z.
    return DesignSessionSchema.parse({...row.data,updatedAt:new Date(row.updated_at).toISOString(),spec:revisions.at(-1)?.spec||row.data.spec,revisions,jobs:jobs.map(j=>j.data),plans:byKind("plan"),evaluations,comparisons:byKind("comparison"),decisions:byKind("decision"),notChecked});
  }
  async function existingJob(key:string,input:unknown) {
    const {data,error}=await getDb().from("generation_jobs").select("data,input_hash").eq("scope",scopeId).eq("idempotency_key",key).maybeSingle();
    if(error) throw new AppError("STORAGE_FAILED","Could not check existing job.",503,true);
    if(data && data.input_hash!==fingerprint(input)) throw new AppError("CONFLICT","This idempotency key belongs to a different request.",409);
    return data ? GenerationJobSchema.parse(data.data) : null;
  }
  async function enqueue(sessionId:string,input:{idempotencyKey:string},operation:GenerationJob["operation"],cost:number,payload:Record<string,unknown>,parentRevisionId:string|null=null,planId:string|null=null) {
    await sessionRow(sessionId);
    const timestamp=now();
    const job=GenerationJobSchema.parse({id:randomUUID(),sessionId,parentRevisionId,planId,operation,status:"created",progress:0,provider:operation==="planning"?intelligenceProvider():operation==="scale"||operation==="concept"&&payload.sourceImage?"local":"fal",providerRequestId:null,attempts:0,estimatedCostUsd:cost,result:null,error:null,createdAt:timestamp,updatedAt:timestamp});
    return GenerationJobSchema.parse(await rpc("mr_create_job",{p_scope:scopeId,p_job:job,p_payload:payload,p_key:input.idempotencyKey,p_input_hash:fingerprint(input),p_reserve_micros:Math.ceil(cost*1_000_000),p_cap_micros:budgetMicros()}));
  }
  async function startDesign(raw:StartDesignInput) {
    const input=StartDesignInputSchema.parse(raw);
    const previous=await existingJob(input.idempotencyKey,input);
    if(previous) return {sessionId:previous.sessionId,job:previous};
    requireProviders(!input.imageArtifactId,!input.imageArtifactId);
    // Stable root identity also deduplicates concurrent first submissions before the job exists.
    const session=input.sessionId ? (await sessionRow(input.sessionId)).data : await putSession({title:input.prompt.slice(0,80)},sessionIdFor(scopeId,input.idempotencyKey));
    const sourceImage=input.imageArtifactId ? await artifact(input.imageArtifactId,session.id) : undefined;
    if(sourceImage && sourceImage.kind!=="source_image") throw new AppError("INVALID_INPUT","Use a verified source image upload.");
    const job=await enqueue(session.id,input,"concept",sourceImage?0:.50,{input,...(sourceImage?{sourceImage}: {})});
    return {sessionId:job.sessionId,job};
  }
  /** MCP attachments enter the same verified storage and durable job workflow as web uploads. */
  async function startPhotoDesign(raw:StartDesignInput,image:{bytes:Uint8Array;sha256:string;mimeType:"image/png"|"image/jpeg"|"image/webp";fileName?:string}) {
    const input=StartDesignInputSchema.parse(raw);
    if(input.imageArtifactId) throw new AppError("INVALID_INPUT","Supply either an uploaded artifact or an attachment, not both.");
    if(!image.bytes.byteLength||image.bytes.byteLength>10*1024*1024||hashBytes(image.bytes)!==image.sha256)
      throw new AppError("INVALID_ARTIFACT","Attachment bytes do not match the image receipt.",422);
    // Signed URLs and host file IDs are delivery details, not paid request identity.
    const identity={...input,photo:{sha256:image.sha256,mimeType:image.mimeType}};
    const previous=await existingJob(input.idempotencyKey,identity);
    if(previous) return {sessionId:previous.sessionId,job:previous};
    const session=input.sessionId?(await sessionRow(input.sessionId)).data:await putSession({title:input.prompt.slice(0,80)},sessionIdFor(scopeId,input.idempotencyKey));
    const ext=image.mimeType==="image/jpeg"?"jpg":image.mimeType==="image/webp"?"webp":"png";
    const sourceImage=await storeArtifact(session.id,"source_image",image.bytes,image.mimeType,ext);
    const job=await enqueue(session.id,identity,"concept",0,{input,sourceImage});
    return {sessionId:job.sessionId,job};
  }
  async function getJob(id:string) {
    const row=await checked(getDb().from("generation_jobs").select("data").eq("id",id).eq("scope",scopeId).maybeSingle());
    return GenerationJobSchema.parse(row.data);
  }
  async function planRevision(raw:PlanRevisionInput):Promise<RevisionPlan> {
    const input=PlanRevisionInputSchema.parse(raw),parent=await revision(input.revisionId);
    if(parent.sessionId!==input.sessionId) throw new AppError("NOT_FOUND","Revision not found.",404);
    if(!await existingJob(input.idempotencyKey,input)) requireProviders(false,true);
    const job=await enqueue(input.sessionId,input,"planning",.10,{input,parent},parent.id);
    if(job.result?.planId) return RevisionPlanSchema.parse((await ownedRecord(job.result.planId,"plan")).data);
    if(job.status==="submission_unknown") throw new AppError("SUBMISSION_UNKNOWN","Planning request outcome is unknown. Inspect this existing job; do not repeat it.",409);
    if(job.status==="failed") throw new AppError(job.error?.code||"PROVIDER_FAILED",job.error?.message||"Planning failed.",422);
    const claim=await rpc<{fence:number;payload:{plan?:RevisionPlan}}|null>("mr_claim_job",{p_id:job.id,p_owner:randomUUID()});
    if(!claim) {
      // Claiming can quarantine a previously interrupted paid dispatch, or lose to
      // another worker that has just completed the existing plan.
      const current=await getJob(job.id);
      if(current.result?.planId) return RevisionPlanSchema.parse((await ownedRecord(current.result.planId,"plan")).data);
      if(current.status==="submission_unknown") throw new AppError("SUBMISSION_UNKNOWN","Planning request outcome is unknown. Inspect this existing job; do not repeat it.",409);
      if(current.status==="failed") throw new AppError(current.error?.code||"PROVIDER_FAILED",current.error?.message||"Planning failed.",422);
      throw new AppError("NOT_READY","The existing planning job is still running. Poll the session timeline.",409,true);
    }
    const fence=claim.fence;
    let dispatchInFlight=false;
    try {
      if(claim.payload.plan) {
        const plan=RevisionPlanSchema.parse(claim.payload.plan);
        await rpc("mr_finish_job",{p_id:job.id,p_fence:fence,p_record:plan,p_kind:"plan"});
        return plan;
      }
      const image=parent.artifacts.find(a=>a.kind==="concept_image"||a.kind==="source_image");
      const parentImageUrl=image?`data:${image.mimeType};base64,${Buffer.from(await readArtifact(image)).toString("base64")}`:undefined;
      await rpc("mr_patch_job",{p_id:job.id,p_fence:fence,p_patch:{status:"planning",provider:intelligenceProvider(),attempts:1},p_payload:{dispatchInFlight:true}});
      dispatchInFlight=true;
      const intelligence=createDesignIntelligence({onResponse:async metadata=>{
        await rpc("mr_patch_job",{p_id:job.id,p_fence:fence,p_patch:{providerRequestId:metadata.responseId},p_payload:{intelligenceReceipt:metadata}});
      }});
      const draft=await intelligence.planRevision({spec:parent.spec,feedback:input.feedback,parentImageUrl});
      if(draft.action==="scale_geometry" && parent.kind!=="manufacturing") throw new AppError("CONFLICT","Scaling requires a completed 3D revision. Generate a model first.",409);
      const plan=RevisionPlanSchema.parse({...draft,id:randomUUID(),sessionId:parent.sessionId,parentRevisionId:parent.id,maxAttempts:2,estimatedCostUsd:draft.action==="scale_geometry"?0:draft.action==="regenerate_model"?5:.50,createdAt:now()});
      await rpc("mr_patch_job",{p_id:job.id,p_fence:fence,p_patch:{status:"verifying"},p_payload:{dispatchInFlight:false,plan}});
      dispatchInFlight=false;
      await rpc("mr_finish_job",{p_id:job.id,p_fence:fence,p_record:plan,p_kind:"plan"});
      return plan;
    } catch(error) {
      const knownTermination=error instanceof ProviderError && ["configuration","invalid_result","unsafe_url","asset_too_large","provider_failure"].includes(error.kind);
      const unknown=error instanceof ProviderError && error.kind==="submission_unknown" || dispatchInFlight&&!knownTermination;
      const mapped=unknown?new AppError("SUBMISSION_UNKNOWN","Planning submission outcome could not be checkpointed; do not repeat the paid request.",409):error instanceof AppError?error:new AppError("PROVIDER_FAILED","The design planner could not produce a valid plan.",502);
      // A saved plan or a pre-dispatch storage read can resume safely. Never turn
      // a transient finalization failure into a new paid planning request.
      if(!unknown&&mapped.retryable) {
        await rpc("mr_patch_job",{p_id:job.id,p_fence:fence,p_patch:{error:mapped.toJSON()}}).catch(()=>{});
        throw mapped;
      }
      await rpc("mr_fail_job",{p_id:job.id,p_fence:fence,p_error:mapped.toJSON(),p_unknown:unknown}).catch(()=>{});
      throw mapped;
    } finally {await rpc("mr_release_job",{p_id:job.id,p_fence:fence}).catch(()=>{});}
  }
  async function sourceImageFor(parent:Revision):Promise<ArtifactRef> {
    let cursor=parent;
    for(let depth=0;depth<30;depth++) {
      const image=cursor.artifacts.find(a=>a.kind==="concept_image"||a.kind==="source_image");
      if(image) return image;
      if(!cursor.parentRevisionId) break;
      cursor=await revision(cursor.parentRevisionId);
    }
    throw new AppError("ARTIFACT_UNAVAILABLE","No stored concept image is available for this revision.",422);
  }
  async function executePlan(raw:ExecutePlanInput) {
    const input=ExecutePlanInputSchema.parse(raw);
    const previous=await existingJob(input.idempotencyKey,input);if(previous) return previous;
    const plan=RevisionPlanSchema.parse((await ownedRecord(input.planId,"plan")).data),parent=await revision(plan.parentRevisionId);
    if(plan.action==="scale_geometry"&&(parent.kind!=="manufacturing"||!plan.targetHeightMm)) throw new AppError("CONFLICT","Scaling requires a completed 3D revision and target height.",409);
    requireProviders(plan.action!=="scale_geometry",plan.action==="edit_concept");
    const sourceImage=plan.action==="scale_geometry"?undefined:await sourceImageFor(parent);
    const operation=plan.action==="scale_geometry"?"scale":plan.action==="regenerate_model"?"model":"refinement";
    return enqueue(parent.sessionId,input,operation,plan.estimatedCostUsd,{input,plan,parent,...(sourceImage?{sourceImage}:{}),spec:parent.spec},parent.id,plan.id);
  }
  async function decideRevision(raw:DecisionInput) {
    const input=DecisionInputSchema.parse(raw),parent=await revision(input.revisionId);
    const decision=HumanDecisionSchema.parse({id:randomUUID(),sessionId:parent.sessionId,revisionId:parent.id,decision:input.decision,note:input.note||null,artifactHashes:parent.artifacts.map(a=>a.sha256),createdAt:now()});
    const evaluation={...decision,id:randomUUID(),kind:"human",engine:"human",method:"Explicit decision on exact immutable artifact hashes",limitations:["Approval is subjective and does not certify manufacturability."]};
    await checked(getDb().from("design_records").insert([{id:decision.id,session_id:parent.sessionId,kind:"decision",data:decision},{id:evaluation.id,session_id:parent.sessionId,kind:"evaluation",data:evaluation}]).select("id"));
    return decision;
  }
  async function generateModel(raw:GenerateModelInput) {
    const input=GenerateModelInputSchema.parse(raw);
    const previous=await existingJob(input.idempotencyKey,input);if(previous) return previous;
    requireProviders(true,false);
    const parent=await revision(input.revisionId);
    if(parent.kind!=="concept") throw new AppError("CONFLICT","Generate a model from an approved concept revision.",409);
    const rows=await checked(getDb().from("design_records").select("data").eq("session_id",parent.sessionId).eq("kind","decision").order("created_at"));
    assertApproved(parent,rows.map(r=>HumanDecisionSchema.parse(r.data)).filter(d=>d.revisionId===parent.id));
    return enqueue(parent.sessionId,input,"model",5,{input,parent,sourceImage:await sourceImageFor(parent),spec:parent.spec},parent.id);
  }
  async function getMakePackage(revisionId:string) {
    const parent=await revision(revisionId);
    const auditRef=parent.artifacts.find(a=>a.kind==="audit"),packageRef=parent.artifacts.find(a=>a.kind==="make_package");
    if(!auditRef||!packageRef) throw new AppError("NOT_READY","This revision has no manufacturing package yet.",409);
    const audit=PhysicalAuditSchema.parse(JSON.parse(Buffer.from(await readArtifact(auditRef)).toString("utf8")));
    const artifact=await signedArtifact(packageRef);
    return {revisionId,audit,artifact,downloadUrl:artifact.url!,expiresAt:artifact.expiresAt!,notChecked:audit.notChecked};
  }
  async function requestUpload(raw:UploadInput) {
    const input=UploadInputSchema.parse(raw);await sessionRow(input.sessionId);
    const id=randomUUID(),ext=input.mimeType==="image/jpeg"?"jpg":input.mimeType==="image/png"?"png":"webp";
    const path=`${input.sessionId}/${id}/${input.sha256}.${ext}`;
    const ref=ArtifactRefSchema.parse({id,sessionId:input.sessionId,kind:"source_image",storagePath:path,sha256:input.sha256,sizeBytes:input.sizeBytes,mimeType:input.mimeType,units:"none",axis:"none",createdAt:now()});
    await checked(getDb().from("make_artifacts").insert({id,session_id:input.sessionId,data:ref,verified:false}).select("id").single());
    const {data,error}=await getDb().storage.from(bucket()).createSignedUploadUrl(path,{upsert:false});
    if(error||!data) throw new AppError("STORAGE_FAILED","Could not create a direct image upload.",503,true);
    return {artifactId:id,sessionId:input.sessionId,storagePath:path,signedUrl:data.signedUrl,token:data.token,expiresAt:new Date(Date.now()+2*3600_000).toISOString()};
  }
  async function completeUpload(raw:CompleteUploadInput) {
    const input=CompleteUploadInputSchema.parse(raw);await sessionRow(input.sessionId);
    const ref=await artifact(input.artifactId,input.sessionId,false);
    const bytes=await readArtifact(ref);await assertImage(bytes,ref.mimeType);
    if(hashBytes(bytes)!==ref.sha256) throw new AppError("INVALID_ARTIFACT","Upload hash mismatch.",422);
    const existing=await checked(getDb().from("make_artifacts").select("verified").eq("id",ref.id).single());
    if(!existing.verified) await checked(getDb().from("make_artifacts").update({verified:true}).eq("id",ref.id).eq("verified",false).select("id"));
    return signedArtifact(ref);
  }
  return {createSession,getSession,startDesign,startPhotoDesign,getJob,planRevision,executePlan,decideRevision,generateModel,getMakePackage,requestUpload,completeUpload};
}

/** Cron recovery for a planning request interrupted outside its paid dispatch window. */
export async function resumePlanningJob(jobId:string):Promise<void> {
  const row=await checked(getDb().from("generation_jobs").select("scope,payload").eq("id",jobId).single());
  await createServices(row.scope).planRevision(PlanRevisionInputSchema.parse(row.payload.input));
}
