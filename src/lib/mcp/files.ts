import "server-only";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import { isIP, type LookupFunction } from "node:net";
import type { McpPhotoInput } from "../contracts/mcp";
import { AppError } from "../errors";
import { assertImage } from "../storage";

export const MCP_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const acceptedMimeTypes = ["image/png", "image/jpeg", "image/webp"] as const;
type ImageMime = typeof acceptedMimeTypes[number];
export interface VerifiedMcpPhoto {
  bytes: Uint8Array;
  sha256: string;
  mimeType: ImageMime;
  fileName?: string;
}

/** Signed host URLs are transport credentials; never persist or include them in errors. */
export function assertOpenAiPhotoUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw invalid("The photo download URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443") || isIP(url.hostname) ||
    !(url.hostname === "files.oaiusercontent.com" || url.hostname.endsWith(".oaiusercontent.com"))) {
    throw invalid("Photo downloads must use the OpenAI HTTPS file host.");
  }
  return url;
}

/** IPv4-only connections are intentional: every DNS answer is checked and one address is pinned. */
export function isPublicPhotoAddress(value: string): boolean {
  if (isIP(value) !== 4) return false;
  const [a, b, c] = value.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}

type PhotoResponse = Pick<IncomingMessage, "statusCode" | "headers"> & {
  destroy(error?: Error): void;
} & AsyncIterable<Uint8Array | string>;
export interface PhotoDownloadDependencies {
  resolve?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  open?: (url: URL, pinnedAddress: string, signal: AbortSignal) => Promise<PhotoResponse>;
}

/** Download, sniff, and fully decode bytes before the shared service persists a source_image. */
export async function downloadMcpPhoto(input: McpPhotoInput, dependencies: PhotoDownloadDependencies = {}): Promise<VerifiedMcpPhoto> {
  const url = assertOpenAiPhotoUrl(input.download_url);
  const signal = AbortSignal.timeout(30_000);
  let response: PhotoResponse;
  try {
    const addresses = await withinSignal((dependencies.resolve ?? ((hostname) => lookup(hostname, { all: true, family: 4 })))(url.hostname), signal);
    if (!addresses.length || addresses.some((answer) => answer.family !== 4 || !isPublicPhotoAddress(answer.address))) {
      throw invalid("The photo download host did not resolve to a public address.");
    }
    signal.throwIfAborted();
    response = await (dependencies.open ?? openPinned)(url, addresses[0].address, signal);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("ARTIFACT_UNAVAILABLE", "The photo could not be downloaded. Reattach it to obtain a fresh file link.", 503, true);
  }
  try {
    // Native HTTPS performs no redirect following; even same-host redirects are rejected.
    if (response.statusCode !== 200) throw new AppError("ARTIFACT_UNAVAILABLE", "The photo link expired or could not be read. Reattach the photo.", 422);
    const declared = response.headers["content-length"];
    if (declared !== undefined && (!/^\d+$/.test(String(declared)) || Number(declared) > MCP_PHOTO_MAX_BYTES)) throw invalid("Photo exceeds the 10 MB limit.");
    const encoding = response.headers["content-encoding"];
    if (encoding && encoding !== "identity") throw invalid("Compressed photo transport is unsupported.");
    const contentType = String(response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (![...acceptedMimeTypes, "application/octet-stream"].includes(contentType)) throw invalid("Photo must be PNG, JPEG, or WebP.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MCP_PHOTO_MAX_BYTES) throw invalid("Photo exceeds the 10 MB limit.");
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks, size);
    if (declared !== undefined && Number(declared) !== size) throw invalid("Photo download was incomplete.");
    const mimeType = sniffImage(bytes);
    if (!mimeType || contentType !== "application/octet-stream" && contentType !== mimeType || input.mime_type && input.mime_type.toLowerCase() !== mimeType) {
      throw invalid("Photo bytes do not match their declared image type.");
    }
    await assertImage(bytes, mimeType);
    return { bytes, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType, ...(input.file_name ? { fileName: input.file_name } : {}) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("ARTIFACT_UNAVAILABLE", "The photo download was interrupted. Reattach the photo and reuse the original idempotency key.", 503, true);
  } finally { response.destroy(); }
}

function sniffImage(bytes: Buffer): ImageMime | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function openPinned(url: URL, address: string, signal: AbortSignal): Promise<PhotoResponse> {
  return new Promise((resolve, reject) => {
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address, family: 4 }]);
      else callback(null, address, 4);
    };
    const connection = request(url, {
      method: "GET", agent: false, family: 4, lookup: pinnedLookup, signal,
      headers: { Accept: acceptedMimeTypes.join(", "), "Accept-Encoding": "identity" },
    }, resolve);
    connection.on("error", reject);
    connection.end();
  });
}

function withinSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function invalid(message: string) { return new AppError("INVALID_ARTIFACT", message, 422); }
