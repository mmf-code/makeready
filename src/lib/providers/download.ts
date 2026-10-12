import "server-only";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { ProviderError } from "./types";

const FAL_ASSET_HOSTS = ["fal.media", "fal.ai"];
export const MAX_GLB_BYTES = 128 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Only use with URLs returned by the provider, never a client download parameter. */
export function assertFalAssetUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError("Invalid asset URL", "unsafe_url"); }
  if (
    url.protocol !== "https:" || url.username || url.password ||
    (url.port && url.port !== "443") || isIP(url.hostname) ||
    !FAL_ASSET_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  ) throw new ProviderError("Asset origin is not an allowed fal origin", "unsafe_url");
  return url;
}

export async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new ProviderError("Invalid download byte limit", "configuration");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new ProviderError("Asset exceeds the download byte limit", "asset_too_large");
  }
  if (!response.body) throw new ProviderError("Asset has no response body", "invalid_result");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ProviderError("Asset exceeds the download byte limit", "asset_too_large");
      }
      parts.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts, bytes);
}

/** Preserves provider bytes exactly; validation does not rewrite or normalize GLB. */
export async function downloadOriginalGlb(
  providerResult: Pick<import("./types").ProviderResult, "glbUrl">,
  options: { fetch?: typeof fetch; maxBytes?: number } = {},
): Promise<{ bytes: Buffer; sha256: string }> {
  if (!providerResult.glbUrl) throw new ProviderError("Provider returned no GLB", "invalid_result");
  const url = assertFalAssetUrl(providerResult.glbUrl);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(60_000),
    });
  } catch { throw new ProviderError("Provider asset download connection failed", "transport"); }
  if (!response.ok) throw new ProviderError("Provider asset download failed", "transport", response.status);
  const bytes = await readBoundedBody(response, options.maxBytes ?? MAX_GLB_BYTES);
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "glTF" || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) {
    throw new ProviderError("Provider asset is not a complete GLB v2", "invalid_result");
  }
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Download only a normalized provider output, then store bytes in application storage. */
export async function downloadOriginalImage(
  result: Pick<import("./types").ProviderResult, "imageUrls">,
  options: { fetch?: typeof fetch; maxBytes?: number; index?: number } = {},
): Promise<{ bytes: Buffer; sha256: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }> {
  const value = result.imageUrls[options.index ?? 0];
  if (!value) throw new ProviderError("Provider returned no image", "invalid_result");
  const url = assertFalAssetUrl(value);
  let response: Response;
  try { response = await (options.fetch ?? fetch)(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) }); }
  catch { throw new ProviderError("Provider image download connection failed", "transport"); }
  if (!response.ok) throw new ProviderError("Provider image download failed", "transport", response.status);
  const bytes = await readBoundedBody(response, options.maxBytes ?? MAX_IMAGE_BYTES);
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png" :
    bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg" :
    bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : undefined;
  if (!mimeType) throw new ProviderError("Provider image has an unsupported file signature", "invalid_result");
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType };
}
