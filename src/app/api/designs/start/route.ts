import { api,body,kickJob } from "@/lib/http";
import { StartDesignInputSchema } from "@/lib/contracts";
export const runtime="nodejs";
export const maxDuration=300;
export async function POST(request:Request) {return api(request,async service=>{const result=await service.startDesign(StartDesignInputSchema.parse(await body(request)));kickJob(result.job.id);return result;});}
