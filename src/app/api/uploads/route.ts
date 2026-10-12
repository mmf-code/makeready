import { api,body } from "@/lib/http";
import { UploadInputSchema } from "@/lib/contracts";
export const runtime="nodejs";
export async function POST(request:Request) {return api(request,async service=>service.requestUpload(UploadInputSchema.parse(await body(request))));}
