import { api,body,kickJob,routeInput } from "@/lib/http";
import { GenerateModelInputSchema } from "@/lib/contracts";
export const runtime="nodejs";
export const maxDuration=300;
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {return api(request,async service=>{const result=await service.generateModel(GenerateModelInputSchema.parse(routeInput(await body(request),"revisionId",(await params).id)));kickJob(result.id);return result;});}
