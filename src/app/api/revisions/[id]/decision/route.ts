import { api,body,routeInput } from "@/lib/http";
import { DecisionInputSchema } from "@/lib/contracts";
export const runtime="nodejs";
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {return api(request,async service=>service.decideRevision(DecisionInputSchema.parse(routeInput(await body(request),"revisionId",(await params).id))));}
