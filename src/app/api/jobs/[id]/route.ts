import { api } from "@/lib/http";
import { z } from "zod";
export const runtime="nodejs";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {return api(request,async service=>service.getJob(z.uuid().parse((await params).id)));}
