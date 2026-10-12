import { api,body } from "@/lib/http";
import { CreateSessionInputSchema } from "@/lib/contracts";
export const runtime="nodejs";
export async function POST(request:Request) {return api(request,async service=>service.createSession(CreateSessionInputSchema.parse(await body(request))));}
