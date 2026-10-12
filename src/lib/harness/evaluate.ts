import "server-only";
import { createHash } from "node:crypto";
import { evaluateChecks, specChecks } from "./acceptance";
import { ComparisonSchema, EvaluationSchema, PhysicalAuditSchema, RevisionPlanSchema, RevisionSchema,type Revision, type RevisionPlan, type PhysicalAudit, type Evaluation } from "../contracts";
import { checked, getDb } from "../db";
import { readArtifact } from "../storage";
import { databaseError } from "../errors";
import type { VisualCritique } from "../providers/openai";

function stableId(key:string) {
  const hex=createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export function compareGeometry(parent:PhysicalAudit|null,child:PhysicalAudit|null) {
  if(!parent||!child) return null;
  const boundary=(audit:PhysicalAudit) => {
    const check=audit.checks.find(c=>c.id==="boundary_edges");
    return typeof check?.actual==="number" ? check.actual : null;
  };
  const before=boundary(parent),after=boundary(child);
  return {widthMm:child.measuredBoundsMm.width-parent.measuredBoundsMm.width,heightMm:child.measuredBoundsMm.height-parent.measuredBoundsMm.height,depthMm:child.measuredBoundsMm.depth-parent.measuredBoundsMm.depth,triangles:child.triangleCount-parent.triangleCount,boundaryEdges:before===null||after===null?null:after-before};
}
async function auditOf(revision:Revision) {
  const ref=revision.artifacts.find(a=>a.kind==="audit");
  return ref?PhysicalAuditSchema.parse(JSON.parse(Buffer.from(await readArtifact(ref)).toString("utf8"))):null;
}
async function append(kind:"evaluation"|"comparison",sessionId:string,data:{id:string}) {
  const {error}=await getDb().from("design_records").insert({id:data.id,session_id:sessionId,kind,data});
  // Deterministic IDs make repeated post-finalization projections safe.
  if(error&&error.code!=="23505") databaseError(error);
}
/** Follow only this session's immutable lineage, stopping on cycles or 30 revisions. */
async function manufacturingAncestor(revision:Revision,parent:Revision):Promise<Revision|null> {
  const visited=new Set([revision.id]);
  let cursor=parent;
  for(let depth=0;depth<30;depth++) {
    if(cursor.sessionId!==revision.sessionId||visited.has(cursor.id)) return null;
    visited.add(cursor.id);
    if(cursor.kind==="manufacturing") return cursor;
    if(!cursor.parentRevisionId||visited.has(cursor.parentRevisionId)||depth===29) return null;
    const {data,error}=await getDb().from("design_records").select("data").eq("id",cursor.parentRevisionId).eq("session_id",revision.sessionId).eq("kind","revision").maybeSingle();
    if(error) databaseError(error);
    if(!data) return null;
    cursor=RevisionSchema.parse(data.data);
  }
  return null;
}
/** A 3D revision made from a refined concept is judged against the plan that produced that concept. */
async function planBehind(revision:Revision,parent:Revision):Promise<RevisionPlan|null> {
  if(revision.kind!=="manufacturing"||parent.kind!=="concept"||!parent.sourceJobId) return null;
  const {data:job,error}=await getDb().from("generation_jobs").select("data").eq("id",parent.sourceJobId).eq("session_id",revision.sessionId).maybeSingle();
  if(error) databaseError(error);
  const planId=(job?.data as {planId?:unknown}|undefined)?.planId;
  if(typeof planId!=="string") return null;
  const {data:row,error:planError}=await getDb().from("design_records").select("data").eq("id",planId).eq("session_id",revision.sessionId).eq("kind","plan").maybeSingle();
  if(planError) databaseError(planError);
  return row?RevisionPlanSchema.parse(row.data):null;
}
/** Materialized observations are append-only and independently recoverable after finalization. */
export async function evaluateRevision(revision:Revision,plan?:RevisionPlan,visual?:VisualCritique,visualModel?:string):Promise<void> {
  const timestamp=revision.createdAt,hashes=revision.artifacts.map(a=>a.sha256);
  const base={sessionId:revision.sessionId,revisionId:revision.id,artifactHashes:hashes,createdAt:timestamp};
  const audit=await auditOf(revision);
  const evaluations:Evaluation[]=[];
  if(audit) evaluations.push(EvaluationSchema.parse({...base,id:stableId(`${revision.id}:physical`),kind:"physical",engine:audit.engineVersion,method:"Server-side decoded world-space triangles; positional welding; exact stored artifact hashes",limitations:audit.notChecked,audit}));
  evaluations.push(EvaluationSchema.parse({...base,id:stableId(`${revision.id}:visual`),kind:"visual",engine:visual?(visualModel||"configured_llm"):"not_checked",method:visual?(revision.kind==="manufacturing"?"Multimodal comparison of actual stored provider preview and concept images":"Multimodal comparison of actual stored concept images"):"No independent visual model evaluation performed",summary:visual?.summary||"Visual fidelity of the 3D result has not been evaluated. Inspect matching camera views and provide a human decision.",changesObserved:visual?.observations.map(o=>`${o.criterion}: ${o.finding} (${o.status})`)||[],preservationFindings:visual?.preserveObserved||[],uncertainties:visual?.limitations||["No automated regional measurements or rendered 3D comparison."],limitations:[...(visual?.limitations||[]),"Image appearance does not verify the generated 3D geometry.","Regional feature dimensions were not measured."]}));
  for(const evaluation of evaluations) await append("evaluation",revision.sessionId,evaluation);
  if(!revision.parentRevisionId) return;
  const row=await checked(getDb().from("design_records").select("data").eq("id",revision.parentRevisionId).eq("session_id",revision.sessionId).eq("kind","revision").single());
  const parent=RevisionSchema.parse(row.data),parentAudit=await auditOf(parent);
  const acceptancePlan=plan??await planBehind(revision,parent);
  const auditRef=revision.artifacts.find(a=>a.kind==="audit");
  const acceptance=evaluateChecks([...(revision.kind==="manufacturing"?specChecks(revision.spec):[]),...(acceptancePlan?.checks??[])],audit,auditRef?.sha256??null,acceptancePlan?.id??null);
  const comparison=ComparisonSchema.parse({id:stableId(`${revision.id}:comparison`),sessionId:revision.sessionId,parentRevisionId:parent.id,childRevisionId:revision.id,planId:plan?.id||null,visualEvaluationIds:evaluations.filter(e=>e.kind==="visual").map(e=>e.id),physicalEvaluationIds:evaluations.filter(e=>e.kind==="physical").map(e=>e.id),summary:visual?.summary||"Compare the preserved parent with this separately stored child. Geometry measurements and visual judgement remain separate.",differences:visual?.observations.filter(o=>o.status!=="uncertain").map(o=>`${o.criterion}: ${o.finding}`)||[],preservationFindings:visual?.preserveObserved||[],limitations:["Bounding-box differences do not prove regional changes or preserved facial features.","Camera preset specifies matched front, side and three-quarter views; automated render comparison was not performed.",...(visual?.limitations||[])],geometryDelta:compareGeometry(parentAudit,audit),cameraPreset:"matched_front_side_three_quarter",createdAt:timestamp,acceptance});
  await append("comparison",revision.sessionId,comparison);
  if(revision.kind!=="manufacturing"||parent.kind!=="concept"||!audit) return;
  const ancestor=await manufacturingAncestor(revision,parent);
  if(!ancestor) return;
  const ancestorAudit=await auditOf(ancestor);
  if(!ancestorAudit) return;
  const manufacturingComparison=ComparisonSchema.parse({
    id:stableId(`${revision.id}:manufacturing-comparison:${ancestor.id}`),sessionId:revision.sessionId,
    parentRevisionId:ancestor.id,childRevisionId:revision.id,planId:plan?.id||null,
    visualEvaluationIds:[],physicalEvaluationIds:evaluations.filter(e=>e.kind==="physical").map(e=>e.id),
    summary:"Compared actual stored geometry audits with the nearest earlier 3D revision in this lineage. This is a separate comparison; the direct parent remains the concept revision.",
    differences:[],preservationFindings:[],limitations:[
      "Only measured bounds, triangle counts and boundary-edge counts were compared.",
      "Bounding-box differences do not prove regional changes or preserved facial features.",
      "No visual comparison between these manufacturing revisions or automated matched-view rendering was performed.",
      ...new Set([...ancestorAudit.notChecked,...audit.notChecked]),
    ],geometryDelta:compareGeometry(ancestorAudit,audit),cameraPreset:"matched_front_side_three_quarter",createdAt:timestamp,acceptance,
  });
  await append("comparison",revision.sessionId,manufacturingComparison);
}
