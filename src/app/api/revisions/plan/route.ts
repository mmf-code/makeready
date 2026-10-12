import { api,body } from "@/lib/http";
import { PlanRevisionInputSchema } from "@/lib/contracts";
export const runtime="nodejs";
export const maxDuration=120;
export async function POST(request:Request) {return api(request,async service=>service.planRevision(PlanRevisionInputSchema.parse(await body(request))));}
