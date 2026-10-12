import { api } from "@/lib/http";
import { z } from "zod";
export const runtime="nodejs";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {return api(request,async service=>service.getSession(z.uuid().parse((await params).id)));}
