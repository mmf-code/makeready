import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { McpPhotoInputSchema } from "../../src/lib/contracts/mcp";
import {
  assertOpenAiPhotoUrl, downloadMcpPhoto, isPublicPhotoAddress, MCP_PHOTO_MAX_BYTES,
  type PhotoDownloadDependencies,
} from "../../src/lib/mcp/files";

const photo = { download_url: "https://files.oaiusercontent.com/photo?signature=private", file_id: "file_transport_only" };
const resolvePublic = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
const image = () => sharp({ create: { width: 2, height: 2, channels: 4, background: "white" } }).png().toBuffer();

function response(chunks: Uint8Array[], headers: Record<string, string> = { "content-type": "image/png" }, statusCode = 200) {
  return Object.assign(Readable.from(chunks), { statusCode, headers });
}
function dependencies(bytes: Uint8Array, headers?: Record<string, string>, statusCode?: number): PhotoDownloadDependencies {
  return { resolve: resolvePublic, open: vi.fn(async () => response([bytes], headers, statusCode)) };
}

describe("OpenAI photo file transport", () => {
  it("declares the official four properties with only the two transport identifiers required", () => {
    expect(McpPhotoInputSchema.parse(photo)).toEqual(photo);
    expect(McpPhotoInputSchema.safeParse({ file_id: "file_missing_url" }).success).toBe(false);
    expect(McpPhotoInputSchema.safeParse({ download_url: photo.download_url }).success).toBe(false);
  });

  it("rejects non-HTTPS, private, credentialed, lookalike, and alternate origins", () => {
    for (const url of [
      "http://files.oaiusercontent.com/photo", "https://127.0.0.1/photo", "https://[::1]/photo",
      "https://user:secret@files.oaiusercontent.com/photo", "https://files.oaiusercontent.com:8443/photo",
      "https://files.oaiusercontent.com.evil.test/photo", "https://oaiusercontent.com/photo",
      "https://example.test/photo", "https://files.oaiusercontent.com/photo#fragment",
    ]) expect(() => assertOpenAiPhotoUrl(url)).toThrow();
    expect(assertOpenAiPhotoUrl(photo.download_url).hostname).toBe("files.oaiusercontent.com");
  });

  it("blocks private, loopback, link-local, reserved and IPv6 DNS addresses", async () => {
    for (const address of ["0.1.2.3", "10.1.2.3", "100.64.1.1", "127.0.0.1", "169.254.169.254", "172.16.1.1", "192.168.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.1.1.1", "255.255.255.255", "::1", "::ffff:127.0.0.1"]) {
      expect(isPublicPhotoAddress(address)).toBe(false);
    }
    const open = vi.fn();
    await expect(downloadMcpPhoto(photo, { resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }], open })).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
    expect(open).not.toHaveBeenCalled();
  });

  it("pins the checked public address, fully decodes bytes and hashes content independently of file_id", async () => {
    const bytes = await image();
    const deps = dependencies(bytes, { "content-type": "image/png", "content-length": String(bytes.length) });
    const first = await downloadMcpPhoto({ ...photo, mime_type: "image/png", file_name: "reference.png" }, deps);
    const second = await downloadMcpPhoto({ ...photo, file_id: "different_file_id", download_url: photo.download_url.replace("private", "renewed") }, deps);
    expect(first.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(second.sha256).toBe(first.sha256);
    expect(first.bytes).toEqual(bytes);
    expect(first.mimeType).toBe("image/png");
    expect(deps.open).toHaveBeenCalledWith(expect.any(URL), "93.184.216.34", expect.any(AbortSignal));
    expect(JSON.stringify(first)).not.toContain("file_transport_only");
    expect(JSON.stringify(first)).not.toContain("signature");
  });

  it("rejects redirects instead of fetching their destination", async () => {
    const deps = dependencies(new Uint8Array(), { location: "http://169.254.169.254/" }, 302);
    await expect(downloadMcpPhoto(photo, deps)).rejects.toMatchObject({ code: "ARTIFACT_UNAVAILABLE" });
    expect(deps.open).toHaveBeenCalledTimes(1);
  });

  it("enforces both declared and streamed byte limits", async () => {
    await expect(downloadMcpPhoto(photo, dependencies(new Uint8Array(), { "content-type": "image/png", "content-length": String(MCP_PHOTO_MAX_BYTES + 1) }))).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
    await expect(downloadMcpPhoto(photo, dependencies(Buffer.alloc(MCP_PHOTO_MAX_BYTES + 1)))).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
  });

  it("rejects HTML, MIME mismatch, incomplete downloads and corrupt compressed pixels", async () => {
    const bytes = await image();
    await expect(downloadMcpPhoto(photo, dependencies(bytes, { "content-type": "text/html" }))).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
    await expect(downloadMcpPhoto({ ...photo, mime_type: "image/jpeg" }, dependencies(bytes))).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
    await expect(downloadMcpPhoto(photo, dependencies(bytes, { "content-type": "image/jpeg" }))).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
    await expect(downloadMcpPhoto(photo, dependencies(bytes, { "content-type": "image/png", "content-length": String(bytes.length + 1) }))).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
    await expect(downloadMcpPhoto(photo, dependencies(bytes.subarray(0, 40)))).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
  });

  it("suppresses signed download URLs from transport errors", async () => {
    const failure = downloadMcpPhoto(photo, { resolve: resolvePublic, open: async () => { throw new Error(photo.download_url); } });
    await expect(failure).rejects.toMatchObject({ code: "ARTIFACT_UNAVAILABLE" });
    await expect(failure).rejects.not.toThrow("signature");
  });
});
