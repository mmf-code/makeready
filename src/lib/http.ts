import "server-only";
import { z } from "zod";
import { after } from "next/server";
import { AppError } from "./errors";
import { requireAccess } from "./access";
import { createServices } from "./services";

export async function api<T>(request:Request,action:(service:ReturnType<typeof createServices>)=>Promise<T>):Promise<Response> {
  try {
    const scope=await requireAccess(request);
    return Response.json({data:await action(createServices(scope))},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {
    if(error instanceof z.ZodError) return Response.json({error:{code:"INVALID_INPUT",message:error.issues.map(i=>`${i.path.join(".")}: ${i.message}`).join("; "),retryable:false}},{status:400});
    if(error instanceof AppError) return Response.json({error:error.toJSON()},{status:error.status});
    console.error("MakeReady request failed",error instanceof Error?error.name:"unknown");
    return Response.json({error:{code:"INTERNAL_ERROR",message:"MakeReady could not complete this request. Inspect existing jobs before repeating paid work.",retryable:false}},{status:500});
  }
}
export async function body(request:Request):Promise<unknown> {
  const declared=Number(request.headers.get("content-length")||0);
  if(declared>32_768) throw new AppError("INVALID_INPUT","Request body is too large.",413);
  const text=await request.text();
  if(text.length>32_768) throw new AppError("INVALID_INPUT","Request body is too large.",413);
  try {return JSON.parse(text);}catch{throw new AppError("INVALID_INPUT","Expected a JSON request body.");}
}
export function routeInput(value:unknown,key:string,id:string):Record<string,unknown> {
  if(typeof value!=="object"||value===null||Array.isArray(value)) throw new AppError("INVALID_INPUT","Expected a JSON object.");
  const input=value as Record<string,unknown>;
  if(key in input && input[key]!==id) throw new AppError("INVALID_INPUT","The body identifier does not match the route identifier.");
  return {...input,[key]:id};
}
export function kickJob(jobId:string) {
  // Latency optimization only: Supabase Cron remains the durable reconciler.
  after(async()=>{
    try { const {advanceJob}=await import("./executor");await advanceJob(jobId); }
    catch(error) {console.error("MakeReady executor deferred",error instanceof Error?error.name:"unknown");}
  });
}
