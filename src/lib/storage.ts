import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { ArtifactRefSchema, type ArtifactRef } from "./contracts";
import { getDb, checked } from "./db";
import { AppError } from "./errors";
import sharp from "sharp";

export const bucket = () => process.env.SUPABASE_STORAGE_BUCKET || "makeready";
export const hashBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export async function assertImage(bytes: Uint8Array, mime: string) {
  const png = bytes.length > 32 && Buffer.from(bytes.subarray(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpg = bytes.length > 32 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255 && bytes[bytes.length-2]===255 && bytes[bytes.length-1]===217;
  const webp = bytes.length > 20 && Buffer.from(bytes.subarray(0,4)).toString()==="RIFF" && Buffer.from(bytes.subarray(8,12)).toString()==="WEBP";
  if (!(mime==="image/png"&&png || mime==="image/jpeg"&&jpg || mime==="image/webp"&&webp)) throw new AppError("INVALID_ARTIFACT","The image file is corrupt or its type does not match.",422);
  try {
    const decoder=sharp(bytes,{failOn:"warning",limitInputPixels:16_777_216,pages:1});
    const metadata=await decoder.metadata();
    const expected=mime==="image/jpeg"?"jpeg":mime==="image/png"?"png":"webp";
    if(metadata.format!==expected || !metadata.width || !metadata.height || (metadata.pages||1)>1) throw new Error("Unsupported image");
    // Header inspection alone does not prove that compressed pixels can be read.
    await decoder.raw().toBuffer();
  } catch {throw new AppError("INVALID_ARTIFACT","The image cannot be fully decoded, exceeds 16 megapixels, or contains unsupported animation.",422);}
}
export async function storeArtifact(sessionId:string, kind:ArtifactRef["kind"], bytes:Uint8Array, mimeType:string, extension:string, units:ArtifactRef["units"]="none", axis:ArtifactRef["axis"]="none"):Promise<ArtifactRef> {
  if(bytes.length===0 || bytes.length>50*1024*1024) throw new AppError("INVALID_ARTIFACT","Artifact is empty or exceeds the 50 MB demo limit.",422);
  if(mimeType.startsWith("image/")) await assertImage(bytes,mimeType);
  const id=randomUUID(), sha256=hashBytes(bytes), path=`${sessionId}/${id}/${sha256}.${extension}`;
  const {error}=await getDb().storage.from(bucket()).upload(path,bytes,{contentType:mimeType,upsert:false});
  if(error) throw new AppError("STORAGE_FAILED","Could not persist generated artifact.",503,true);
  const {data:download,error:readError}=await getDb().storage.from(bucket()).download(path);
  if(readError || !download) throw new AppError("STORAGE_FAILED","Stored artifact could not be verified.",503,true);
  const verified=new Uint8Array(await download.arrayBuffer());
  if(verified.length!==bytes.length || hashBytes(verified)!==sha256) throw new AppError("INVALID_ARTIFACT","Stored artifact integrity mismatch.",422);
  const ref=ArtifactRefSchema.parse({id,sessionId,kind,storagePath:path,sha256,sizeBytes:bytes.length,mimeType,units,axis,createdAt:new Date().toISOString()});
  await checked(getDb().from("make_artifacts").insert({id,session_id:sessionId,data:ref,verified:true}).select("id").single());
  return ref;
}
export async function readArtifact(ref:ArtifactRef):Promise<Uint8Array> {
  const {data,error}=await getDb().storage.from(bucket()).download(ref.storagePath);
  if(error || !data) throw new AppError("ARTIFACT_UNAVAILABLE","The stored artifact is unavailable.",503,true);
  const bytes=new Uint8Array(await data.arrayBuffer());
  if(hashBytes(bytes)!==ref.sha256 || bytes.length!==ref.sizeBytes) throw new AppError("INVALID_ARTIFACT","Stored artifact integrity mismatch.",422);
  return bytes;
}
export async function signedArtifact(ref:ArtifactRef):Promise<ArtifactRef> {
  const {data,error}=await getDb().storage.from(bucket()).createSignedUrl(ref.storagePath,3600);
  if(error || !data) throw new AppError("ARTIFACT_UNAVAILABLE","Could not issue an artifact download URL.",503,true);
  return {...ref,url:data.signedUrl,expiresAt:new Date(Date.now()+3600_000).toISOString()};
}
