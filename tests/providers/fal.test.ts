import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createFalProvider, normalizeFalResult } from "@/lib/providers/fal";
import { assertFalAssetUrl, downloadOriginalGlb, downloadOriginalImage, readBoundedBody } from "@/lib/providers/download";
import { FAL_ENDPOINTS, type ProviderJobRef } from "@/lib/providers/types";

const job: ProviderJobRef = {
  provider: "fal", operation: "model", endpointId: FAL_ENDPOINTS.model, requestId: "request-123",
  statusUrl: "https://queue.fal.run/fal-ai/hunyuan3d-v3/requests/request-123/status",
  responseUrl: "https://queue.fal.run/fal-ai/hunyuan3d-v3/requests/request-123", submittedAt: "2026-10-12T09:00:00.000Z",
};
const json = (data: unknown, init?: ResponseInit) => new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json", ...init?.headers } });
afterEach(() => vi.unstubAllEnvs());

describe("fal queue adapter", () => {
  it("submits exactly one 80k face model request and retains the canonical request ID", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ request_id: "request-123", gateway_request_id: "attempt-123" }));
    const provider = createFalProvider({ apiKey: "mock-key", fetch: fetchMock, now: () => new Date(job.submittedAt) });
    const result = await provider.submitModel({ imageUrl: "https://v3.fal.media/files/reference.png", webhookUrl: "https://example.com/api/webhooks/fal" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe("/fal-ai/hunyuan3d-v3/image-to-3d");
    expect(new URL(String(url)).searchParams.get("fal_webhook")).toBe("https://example.com/api/webhooks/fal");
    expect(new Headers(init?.headers).get("x-fal-no-retry")).toBe("1");
    expect(JSON.parse(String(init?.body))).toMatchObject({ face_count: 80000, generate_type: "Normal", polygon_type: "triangle", enable_pbr: false });
    expect(result).toMatchObject({ ...job, gatewayRequestId: "attempt-123" });
  });

  it("sends the parent's image with editing instructions without mutating its reference", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ request_id: "edit-1" }));
    const parent = "https://v3.fal.media/files/parent.png";
    const edited = await createFalProvider({ apiKey: "mock-key", fetch: fetchMock }).submitConceptEdit({ imageUrl: parent, prompt: "Smaller ears; preserve face and clothes" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ image_urls: [parent], prompt: "Smaller ears; preserve face and clothes", limit_generations: true, num_images: 1 });
    expect(edited.statusUrl).toBe("https://queue.fal.run/fal-ai/nano-banana/requests/edit-1/status");
    expect(edited.operation).toBe("edit");
  });

  it.each(["connection", "http500", "receipt"])("never retries an ambiguous paid submission (%s)", async (failure) => {
    const fetchMock = vi.fn<typeof fetch>();
    if (failure === "connection") fetchMock.mockRejectedValue(new TypeError("network"));
    else fetchMock.mockResolvedValue(failure === "http500" ? new Response("error", { status: 500 }) : new Response("truncated-json"));
    await expect(createFalProvider({ apiKey: "mock-key", fetch: fetchMock }).submitConcept({ prompt: "A small cat figurine" })).rejects.toMatchObject({ kind: "submission_unknown" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 422, 429])("classifies a rejected HTTP %s submission as known failure without retry", async (status) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("rejected", { status }));
    await expect(createFalProvider({ apiKey: "mock-key", fetch: fetchMock }).submitConcept({ prompt: "A cat" })).rejects.toMatchObject({ kind: "provider_failure", httpStatus: status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps an HTTP 408 submission ambiguous and does not retry it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("timeout", { status: 408 }));
    await expect(createFalProvider({ apiKey: "mock-key", fetch: fetchMock }).submitConcept({ prompt: "A cat" })).rejects.toMatchObject({ kind: "submission_unknown", httpStatus: 408 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creates no network request with missing credentials", async () => {
    vi.stubEnv("FAL_KEY", "");
    const fetchMock = vi.fn<typeof fetch>();
    const provider = createFalProvider({ fetch: fetchMock });
    await expect(provider.submitConcept({ prompt: "A cat" })).rejects.toMatchObject({ kind: "configuration" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps polling transport failures distinct from terminal provider errors", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(json({ status: "COMPLETED", error: "Generation failed" }))
      .mockResolvedValueOnce(json({ status: "IN_PROGRESS" }));
    const provider = createFalProvider({ apiKey: "mock-key", fetch: fetchMock });
    await expect(provider.poll(job)).rejects.toMatchObject({ kind: "transport" });
    await expect(provider.poll(job)).resolves.toMatchObject({ state: "failed", error: "Generation failed", job: { requestId: job.requestId } });
    await expect(provider.poll(job)).resolves.toMatchObject({ state: "running" });
    expect(fetchMock.mock.calls.every(([url]) => url === job.statusUrl)).toBe(true);
  });

  it("does not confuse an HTTP 422 final model failure with a polling outage", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("invalid generation", { status: 422 }));
    await expect(createFalProvider({ apiKey: "mock-key", fetch: fetchMock }).getResult(job)).rejects.toMatchObject({ kind: "provider_failure", httpStatus: 422 });
  });

  it("rejects a forged queue reference before sending its API credentials", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(createFalProvider({ apiKey: "mock-key", fetch: fetchMock }).poll({ ...job, statusUrl: "https://attacker.example/status" })).rejects.toMatchObject({ kind: "unsafe_url" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a real GLB output and rejects untrusted artifact origins", () => {
    expect(() => normalizeFalResult(job, { images: [{ url: "https://v3.fal.media/a.png" }] })).toThrow("GLB");
    expect(() => normalizeFalResult(job, { model_glb: { url: "https://attacker.example/model.glb" } })).toThrow("allowed fal origin");
    expect(normalizeFalResult(job, { model_glb: { url: "https://v3.fal.media/files/model.glb" } }).glbUrl).toBe("https://v3.fal.media/files/model.glb");
  });
});

describe("controlled artifact download", () => {
  it.each([
    "http://v3.fal.media/model.glb", "https://127.0.0.1/model.glb", "https://[::1]/model.glb",
    "https://fal.media.attacker.example/model.glb", "https://attackerfal.media/model.glb",
    "https://user:password@v3.fal.media/model.glb", "https://v3.fal.media:444/model.glb",
    "https://169.254.169.254/latest/meta-data", "file:///etc/passwd",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => assertFalAssetUrl(url)).toThrow();
  });

  it("retains original GLB bytes and calculates their actual hash", async () => {
    const original = Buffer.alloc(20);
    original.write("glTF", 0); original.writeUInt32LE(2, 4); original.writeUInt32LE(original.length, 8);
    original.writeUInt32LE(0, 12); original.writeUInt32LE(0x4e4f534a, 16);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(original));
    const result = await downloadOriginalGlb({ glbUrl: "https://v3.fal.media/files/model.glb" }, { fetch: fetchMock });
    expect(result.bytes.equals(original)).toBe(true);
    expect(result.sha256).toBe(createHash("sha256").update(original).digest("hex"));
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe("error");
  });

  it("rejects a truncated GLB even if it has the expected extension", async () => {
    const bytes = Buffer.alloc(12); bytes.write("glTF"); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(100, 8);
    await expect(downloadOriginalGlb({ glbUrl: "https://v3.fal.media/model.glb" }, { fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes)) })).rejects.toMatchObject({ kind: "invalid_result" });
  });

  it("enforces a streaming byte cap without trusting Content-Length", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(9)); controller.enqueue(new Uint8Array(9)); }, cancel });
    await expect(readBoundedBody(new Response(body), 10)).rejects.toMatchObject({ kind: "asset_too_large" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects a declared oversized asset before reading it", async () => {
    await expect(readBoundedBody(new Response("x", { headers: { "content-length": "1000" } }), 10)).rejects.toMatchObject({ kind: "asset_too_large" });
  });

  it("rejects HTML disguised as a generated image", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>error</html>", { headers: { "content-type": "image/png" } }));
    await expect(downloadOriginalImage({ imageUrls: ["https://v3.fal.media/image.png"] }, { fetch: fetchMock })).rejects.toMatchObject({ kind: "invalid_result" });
  });
});
