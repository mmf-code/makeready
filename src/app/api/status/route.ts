import { api } from "@/lib/http";
import { z } from "zod";
export const runtime="nodejs";
export async function GET(request:Request) {return api(request,async service=>service.getJob(z.uuid().parse(new URL(request.url).searchParams.get("jobId"))));}
