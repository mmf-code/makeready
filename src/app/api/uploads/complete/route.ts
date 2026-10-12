import { api,body } from "@/lib/http";
import { CompleteUploadInputSchema } from "@/lib/contracts";
export const runtime="nodejs";
export async function POST(request:Request) {return api(request,async service=>service.completeUpload(CompleteUploadInputSchema.parse(await body(request))));}
