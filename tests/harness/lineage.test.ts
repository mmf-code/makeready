import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactRef, Comparison, DesignSpec, PhysicalAudit, Revision, RevisionPlan } from "@/lib/contracts";

const mock=vi.hoisted(()=>({ getDb:vi.fn(),read:vi.fn() }));
vi.mock("@/lib/db",async original=>({...await original<typeof import("@/lib/db")>(),getDb:mock.getDb}));
vi.mock("@/lib/storage",()=>({readArtifact:mock.read}));
import { evaluateRevision } from "@/lib/harness/evaluate";

const sessionId="11111111-1111-4111-8111-111111111111";
const otherSessionId="22222222-2222-4222-8222-222222222222";
const timestamp="2026-10-12T10:00:00.000Z";
const spec:DesignSpec={description:"A cat figurine",objectType:"figurine",use:"desk decoration",targetHeightMm:120,preserve:["face"],changeable:["ears"],process:"resin_candidate"};
type StoredRecord={id:string;session_id:string;kind:string;data:Record<string,unknown>};
const records=new Map<string,StoredRecord>();
const bytes=new Map<string,Uint8Array>();
let selections:Record<string,unknown>[]=[];

function query() {
  const filters:Record<string,unknown>={};
  const result=()=>{
    selections.push({...filters});
    return [...records.values()].find(row=>Object.entries(filters).every(([key,value])=>row[key as keyof StoredRecord]===value));
  };
  const chain={
    select:()=>chain,
    eq:(key:string,value:unknown)=>{filters[key]=value;return chain;},
    single:async()=>{const row=result();return {data:row??null,error:row?null:{message:"NOT_FOUND"}};},
    maybeSingle:async()=>({data:result()??null,error:null}),
    insert:async(row:StoredRecord)=>{
      if(records.has(row.id)) return {data:null,error:{code:"23505",message:"duplicate key"}};
      records.set(row.id,structuredClone(row));
      return {data:null,error:null};
    },
  };
  return chain;
}

function artifact(kind:ArtifactRef["kind"],session=sessionId,data:Uint8Array=new Uint8Array([1])):ArtifactRef {
  const id=randomUUID(); bytes.set(id,data);
  return {id,sessionId:session,kind,storagePath:`${session}/${id}`,sha256:createHash("sha256").update(data).digest("hex"),sizeBytes:data.byteLength,mimeType:kind==="audit"?"application/json":"application/octet-stream",units:"none",axis:"none",createdAt:timestamp};
}
function keep(revision:Revision):Revision {
  records.set(revision.id,{id:revision.id,session_id:revision.sessionId,kind:"revision",data:revision as unknown as Record<string,unknown>});
  return revision;
}
function concept(parent:Revision|null,session=sessionId):Revision {
  return keep({id:randomUUID(),sessionId:session,parentRevisionId:parent?.id??null,kind:"concept",spec,artifacts:[artifact("concept_image",session)],sourceJobId:null,createdAt:timestamp});
}
function manufacturing(parent:Revision|null,measurements:{width:number;depth:number;triangles:number;boundary:number},session=sessionId):Revision {
  const source=artifact("source_glb",session),glb=artifact("model_glb",session),stl=artifact("model_stl",session);
  const audit:PhysicalAudit={
    engineVersion:"makeready.geometry.v1",measuredBy:"server",inputSha256:source.sha256,outputSha256:{glb:glb.sha256,stl:stl.sha256},targetHeightMm:120,
    measuredBoundsMm:{width:measurements.width,height:120,depth:measurements.depth,min:[0,0,0],max:[measurements.width,120,measurements.depth]},
    triangleCount:measurements.triangles,weldToleranceMm:.0001,
    checks:[{id:"boundary_edges",status:measurements.boundary?"fail":"pass",actual:measurements.boundary,threshold:0,method:"Measured edge incidence",limitation:null}],
    notChecked:["wall_thickness","regional_feature_measurements"],manufacturingStatus:"preparation_only",createdAt:timestamp,
  };
  return keep({id:randomUUID(),sessionId:session,parentRevisionId:parent?.id??null,kind:"manufacturing",spec,artifacts:[source,glb,stl,artifact("audit",session,new TextEncoder().encode(JSON.stringify(audit)))],sourceJobId:null,createdAt:timestamp});
}
const comparisons=(child:Revision)=>[...records.values()].filter(row=>row.kind==="comparison"&&row.data.childRevisionId===child.id).map(row=>row.data as unknown as Comparison);

beforeEach(()=>{
  vi.clearAllMocks();records.clear();bytes.clear();selections=[];
  mock.getDb.mockReturnValue({from:(table:string)=>{expect(table).toBe("design_records");return query();}});
  mock.read.mockImplementation(async(ref:ArtifactRef)=>{
    const stored=bytes.get(ref.id);
    if(!stored) throw new Error("No actual stored audit bytes");
    expect(createHash("sha256").update(stored).digest("hex")).toBe(ref.sha256);
    return stored;
  });
});

describe("manufacturing revision comparisons across concept refinements",()=>{
  it("keeps the direct concept comparison and separately compares real old/new 3D audits",async()=>{
    const first=manufacturing(null,{width:80,depth:50,triangles:1000,boundary:4});
    const revised=concept(first);
    const second=manufacturing(revised,{width:76,depth:48,triangles:900,boundary:0});
    const original=structuredClone(second);
    await evaluateRevision(first);
    await evaluateRevision(revised);
    await evaluateRevision(second,undefined,{summary:"Ears appear smaller in the supplied image",alignment:"aligned",observations:[{criterion:"ears",finding:"Appear smaller",status:"met"}],preserveObserved:["face"],suggestedChanges:[],limitations:["Image-only evaluation"]},"test-vision-model");
    const saved=comparisons(second);
    expect(saved).toHaveLength(2);
    const direct=saved.find(row=>row.parentRevisionId===revised.id)!;
    const measured=saved.find(row=>row.parentRevisionId===first.id)!;
    expect(direct.geometryDelta).toBeNull();
    expect(direct.visualEvaluationIds).toHaveLength(1);
    expect(direct.preservationFindings).toEqual(["face"]);
    expect(measured.geometryDelta).toEqual({widthMm:-4,heightMm:0,depthMm:-2,triangles:-100,boundaryEdges:-4});
    expect(measured.planId).toBeNull();
    expect(measured.visualEvaluationIds).toEqual([]);
    expect(measured.differences).toEqual([]);expect(measured.preservationFindings).toEqual([]);
    expect(measured.physicalEvaluationIds).toHaveLength(1);
    expect(records.get(measured.physicalEvaluationIds[0])?.kind).toBe("evaluation");
    expect(measured.limitations).toContain("wall_thickness");
    expect(measured.limitations.join(" ")).toContain("No visual comparison");
    expect(second).toEqual(original);expect(second.parentRevisionId).toBe(revised.id);
    expect(selections.every(filters=>filters.session_id===sessionId&&filters.kind==="revision")).toBe(true);
  });

  it("chooses the nearest manufacturing ancestor and appends deterministic comparisons only once",async()=>{
    const older=manufacturing(null,{width:100,depth:60,triangles:1200,boundary:10});
    const nearest=manufacturing(older,{width:80,depth:50,triangles:1000,boundary:4});
    const revised=concept(concept(nearest));
    const second=manufacturing(revised,{width:76,depth:48,triangles:900,boundary:0});
    const plan:RevisionPlan={id:randomUUID(),sessionId,parentRevisionId:revised.id,requestedChange:"Regenerate the mesh",interpretedIntent:"Repair mesh",preserve:["face"],action:"regenerate_model",reason:"Mesh defect",expectedDifferences:["Fewer boundary edges"],targetHeightMm:null,maxAttempts:2,estimatedCostUsd:5,createdAt:timestamp};
    await evaluateRevision(second,plan);
    const firstProjection=comparisons(second);
    await evaluateRevision(second,plan);
    expect(comparisons(second)).toEqual(firstProjection);
    expect(firstProjection).toHaveLength(2);
    expect(firstProjection.find(row=>row.geometryDelta)?.parentRevisionId).toBe(nearest.id);
    expect(firstProjection.every(row=>row.planId===plan.id)).toBe(true);
    expect(selections.some(filters=>filters.id===older.id)).toBe(false);
    expect(mock.read.mock.calls.some(call=>(call[0] as ArtifactRef).id===older.artifacts.find(a=>a.kind==="audit")!.id)).toBe(false);
  });

  it("does not add a second comparison when the direct parent is already a manufacturing revision",async()=>{
    const first=manufacturing(null,{width:80,depth:50,triangles:1000,boundary:4});
    const second=manufacturing(first,{width:76,depth:48,triangles:900,boundary:0});
    await evaluateRevision(second);
    expect(comparisons(second)).toHaveLength(1);
    expect(comparisons(second)[0]).toMatchObject({parentRevisionId:first.id,geometryDelta:{widthMm:-4,triangles:-100}});
  });

  it.each(["cycle","cross-session"])("stops %s ancestry without creating unrelated manufacturing evidence",async(kind)=>{
    const parent=concept(null);
    const child=manufacturing(parent,{width:76,depth:48,triangles:900,boundary:0});
    const foreign=manufacturing(null,{width:80,depth:50,triangles:1000,boundary:4},otherSessionId);
    parent.parentRevisionId=kind==="cycle"?child.id:foreign.id;
    await evaluateRevision(child);
    expect(comparisons(child)).toHaveLength(1);
    expect(comparisons(child)[0]).toMatchObject({parentRevisionId:parent.id,geometryDelta:null});
    expect(selections.length).toBeLessThanOrEqual(2);
    expect(selections.every(filters=>filters.session_id===sessionId)).toBe(true);
    expect(mock.read).toHaveBeenCalledTimes(1);
  });

  it("bounds deep lineage traversal without guessing an ancestor outside the bound",async()=>{
    const first=manufacturing(null,{width:80,depth:50,triangles:1000,boundary:4});
    let parent=first;
    for(let depth=0;depth<32;depth++) parent=concept(parent);
    const child=manufacturing(parent,{width:76,depth:48,triangles:900,boundary:0});
    await evaluateRevision(child);
    expect(comparisons(child)).toHaveLength(1);
    expect(selections).toHaveLength(30);
    expect(mock.read).toHaveBeenCalledTimes(1);
  });
});
