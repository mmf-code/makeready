import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_GLB_BYTES } from "@/lib/providers/download";
import { assertMeshyAssetUrl, createMeshyProvider, normalizeMeshyResult } from "@/lib/providers/meshy";
import { MESHY_ENDPOINT_ID, MESHY_MODEL_ID, type MeshyProviderJobRef, type ProviderJobRef, type ProviderResult } from "@/lib/providers/types";

const requestId = "018a210d-8ba4-705c-b111-1f1776f7f578";
const taskUrl = `https://api.meshy.ai/openapi/v1/image-to-3d/${requestId}`;
const job: MeshyProviderJobRef = {
  provider: "meshy", operation: "model", endpointId: MESHY_ENDPOINT_ID, modelId: MESHY_MODEL_ID,
  requestId, statusUrl: taskUrl, responseUrl: taskUrl, submittedAt: "2026-10-12T09:00:00.000Z",
};
const glbUrl = `https://assets.meshy.ai/account/tasks/${requestId}/output/model.glb?Expires=123`;
const thumbnailUrl = `https://assets.meshy.ai/account/tasks/${requestId}/output/preview.png?Expires=123`;
const completeTask = { id: requestId, status: "SUCCEEDED", model_urls: { glb: glbUrl }, thumbnail_url: thumbnailUrl, consumed_credits: 30 };
const result: ProviderResult = { job, imageUrls: [], glbUrl, thumbnailUrl, consumedCredits: 30 };
const json = (data: unknown, init?: ResponseInit) => new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json", ...init?.headers } });
afterEach(() => vi.unstubAllEnvs());

describe("Meshy image-to-3D adapter", () => {
  it("submits one pinned textured 80k triangle request and persists its canonical receipt", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ result: requestId }));
    const provider = createMeshyProvider({ apiKey: "mock-key", fetch: fetchMock, now: () => new Date(job.submittedAt) });
    const receipt = await provider.submitModel({ imageUrl: "https://reference.example/image.png", webhookUrl: "https://app.example/api/webhooks/fal" });
    expect(receipt).toEqual(job);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.meshy.ai/openapi/v1/image-to-3d");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mock-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      image_url: "https://reference.example/image.png", ai_model: "meshy-7.1", model_type: "standard",
      geometry_resolution: "standard", texture_resolution: "2k", should_remesh: true,
      topology: "triangle", target_polycount: 80_000, target_formats: ["glb"],
      should_texture: true, enable_pbr: false, image_enhancement: false,
    });
  });

  it.each(["network", "http500", "http408", "unreadable_receipt", "missing_id", "oversized_receipt"])("never retries an ambiguous paid submission (%s)", async (failure) => {
    const fetchMock = vi.fn<typeof fetch>();
    if (failure === "network") fetchMock.mockRejectedValue(new TypeError("private network details"));
    else if (failure === "http500" || failure === "http408") fetchMock.mockResolvedValue(new Response("private vendor body", { status: failure === "http500" ? 500 : 408 }));
    else if (failure === "oversized_receipt") fetchMock.mockResolvedValue(new Response("body", { headers: { "content-length": String(3 * 1024 * 1024) } }));
    else fetchMock.mockResolvedValue(failure === "unreadable_receipt" ? new Response("truncated-json") : json({ result: "not-a-task-id" }));
    await expect(createMeshyProvider({ apiKey: "mock-key", fetch: fetchMock }).submitModel({ imageUrl: "https://reference.example/image.png" })).rejects.toMatchObject({ kind: "submission_unknown" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 402, 422, 429])("keeps rejected HTTP %s distinct from ambiguous submissions and hides vendor bodies", async (status) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("private source prompt and signed URL", { status }));
    try {
      await createMeshyProvider({ apiKey: "mock-key", fetch: fetchMock }).submitModel({ imageUrl: "https://reference.example/image.png" });
      throw new Error("Expected a rejected submission");
    } catch (error) {
      expect(error).toMatchObject({ kind: "provider_failure", httpStatus: status });
      expect(String(error)).not.toContain("private source");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not submit without credentials or with an unsafe image reference", async () => {
    vi.stubEnv("MESHY_API_KEY", "");
    const fetchMock = vi.fn<typeof fetch>();
    await expect(createMeshyProvider({ fetch: fetchMock }).submitModel({ imageUrl: "https://reference.example/image.png" })).rejects.toMatchObject({ kind: "configuration" });
    await expect(createMeshyProvider({ apiKey: "mock-key", fetch: fetchMock }).submitModel({ imageUrl: "http://127.0.0.1/image.png" })).rejects.toMatchObject({ kind: "unsafe_url" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels rejected response streams without parsing vendor bodies", async () => {
    const response = new Response("private vendor body", { status: 402 });
    const cancel = vi.spyOn(response.body!, "cancel");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(createMeshyProvider({ apiKey: "mock-key", fetch: fetchMock }).submitModel({ imageUrl: "https://reference.example/image.png" })).rejects.toMatchObject({ kind: "provider_failure", httpStatus: 402 });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["PENDING", "queued"], ["IN_PROGRESS", "running"], ["SUCCEEDED", "completed"], ["FAILED", "failed"], ["CANCELED", "failed"],
  ])("maps %s without exposing task_error body", async (status, state) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ id: requestId, status, task_error: { message: "private signed URL and input" }, consumed_credits: status === "FAILED" ? 0 : 30 }, { headers: { "retry-after": "7" } }));
    const outcome = await createMeshyProvider({ apiKey: "mock-key", fetch: fetchMock }).poll(job);
    expect(outcome).toMatchObject({ job, state, rawStatus: status, retryAfterSeconds: 7 });
    expect(outcome.consumedCredits).toBe(status === "FAILED" ? 0 : 30);
    expect(JSON.stringify(outcome)).not.toContain("private signed URL");
    expect(fetchMock.mock.calls[0][0]).toBe(taskUrl);
    expect(fetchMock.mock.calls[0][1]?.method).toBe("GET");
  });

  it("retains the same receipt after a polling outage", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(json({ id: requestId, status: "IN_PROGRESS" }));
    const provider = createMeshyProvider({ apiKey: "mock-key", fetch: fetchMock });
    await expect(provider.poll(job)).rejects.toMatchObject({ kind: "transport" });
    await expect(provider.poll(job)).resolves.toMatchObject({ job, state: "running" });
    expect(fetchMock.mock.calls.every(([url, init]) => url === taskUrl && init?.method === "GET")).toBe(true);
  });

  it.each([
    { statusUrl: "https://attacker.example/task" }, { responseUrl: "https://attacker.example/task" },
    { requestId: "../secrets" }, { provider: "fal" }, { modelId: "latest" }, { endpointId: "other" },
  ])("rejects a forged durable reference before sending credentials: %j", async (patch) => {
    const fetchMock = vi.fn<typeof fetch>();
    const forged = { ...job, ...patch } as ProviderJobRef;
    const provider = createMeshyProvider({ apiKey: "mock-key", fetch: fetchMock });
    await expect(provider.poll(forged)).rejects.toThrow();
    await expect(provider.getResult(forged)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a status or result belonging to another task", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ ...completeTask, id: "018a210d-8ba4-705c-b111-1f1776f7f579" }));
    await expect(createMeshyProvider({ apiKey: "mock-key", fetch: fetchMock }).poll(job)).rejects.toMatchObject({ kind: "invalid_result" });
    expect(() => normalizeMeshyResult(job, { ...completeTask, id: "018a210d-8ba4-705c-b111-1f1776f7f579" })).toThrow();
  });

  it("requires a succeeded real GLB and preserves reported credits without inventing USD", async () => {
    expect(normalizeMeshyResult(job, completeTask)).toEqual(result);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(completeTask));
    await expect(createMeshyProvider({ apiKey: "mock-key", fetch: fetchMock }).getResult(job)).resolves.toEqual(result);
    expect(result).not.toHaveProperty("actualUsd");
    expect(() => normalizeMeshyResult(job, { id: requestId, status: "SUCCEEDED", model_urls: {} })).toThrow("GLB");
    expect(() => normalizeMeshyResult(job, { ...completeTask, status: "FAILED" })).toThrow("did not succeed");
    expect(() => normalizeMeshyResult(job, { ...completeTask, model_urls: { glb: "https://attacker.example/model.glb" } })).toThrow("allowed Meshy origin");
  });
});

describe("Meshy artifact ingestion", () => {
  it.each([
    "http://assets.meshy.ai/model.glb", "https://127.0.0.1/model.glb", "https://[::1]/model.glb",
    "https://assets.meshy.ai.attacker.example/model.glb", "https://sub.assets.meshy.ai/model.glb",
    "https://user:password@assets.meshy.ai/model.glb", "https://assets.meshy.ai:444/model.glb", "file:///etc/passwd",
  ])("rejects unsafe asset URL %s", (url) => { expect(() => assertMeshyAssetUrl(url)).toThrow(); });

  it("retains GLB bytes and hash without forwarding API authorization", async () => {
    const bytes = Buffer.alloc(20);
    bytes.write("glTF"); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
    bytes.writeUInt32LE(0, 12); bytes.writeUInt32LE(0x4e4f534a, 16);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes));
    const downloaded = await createMeshyProvider({ apiKey: "mock-key", fetch: fetchMock }).downloadGlb(result);
    expect(downloaded.bytes).toEqual(bytes);
    expect(downloaded.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe("error");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has("authorization")).toBe(false);
  });

  it("enforces the asset byte cap and rejects a truncated GLB", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("body", { headers: { "content-length": String(MAX_GLB_BYTES + 1) } })).mockResolvedValueOnce(new Response("glTFbroken"));
    const provider = createMeshyProvider({ apiKey: "mock-key", fetch: fetchMock });
    await expect(provider.downloadGlb(result)).rejects.toMatchObject({ kind: "asset_too_large" });
    await expect(provider.downloadGlb(result)).rejects.toMatchObject({ kind: "invalid_result" });
  });

  it("rejects redirects and wrong origins without leaking API credentials", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("redirect rejected"));
    const provider = createMeshyProvider({ apiKey: "mock-key", fetch: fetchMock });
    await expect(provider.downloadGlb(result)).rejects.toMatchObject({ kind: "transport" });
    expect(fetchMock.mock.calls[0][1]?.redirect).toBe("error");
    await expect(provider.downloadGlb({ ...result, glbUrl: "https://attacker.example/model.glb" })).rejects.toMatchObject({ kind: "unsafe_url" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("downloads a signed thumbnail with a verified image signature and exact hash", async () => {
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yN2cAAAAASUVORK5CYII=", "base64");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes));
    const downloaded = await createMeshyProvider({ fetch: fetchMock }).downloadImage({ ...result, imageUrls: [thumbnailUrl] });
    expect(downloaded).toEqual({ bytes, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "image/png" });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has("authorization")).toBe(false);
  });

  it("rejects HTML disguised as a thumbnail", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>vendor error</html>", { headers: { "content-type": "image/png" } }));
    await expect(createMeshyProvider({ fetch: fetchMock }).downloadImage({ ...result, imageUrls: [thumbnailUrl] })).rejects.toMatchObject({ kind: "invalid_result" });
  });
});
