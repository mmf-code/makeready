import { describe, expect, it, vi } from "vitest";
import { createClient } from "../../src/lib/client";
import { exampleArtifact, exampleJobs, examplePlan, exampleSession } from "../../src/lib/contracts/fixtures";

describe("MakeReady typed route client", () => {
  it("passes the frozen saved plan unchanged and does not replan", async () => {
    const job = exampleJobs.find((item) => item.status === "queued")!;
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: job }));
    const client = createClient({ fetch, cache: false });
    const input = { planId: examplePlan.id, confirmCost: true as const, idempotencyKey: "execute-plan-test" };
    expect(await client.executePlan(input)).toEqual(job);
    expect(fetch.mock.calls[0][0]).toBe(`/api/plans/${examplePlan.id}/execute`);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(input);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("requires cost confirmation before dispatch", async () => {
    const fetch = vi.fn();
    const client = createClient({ fetch, cache: false });
    await expect(client.startDesign({ prompt: "Cat", confirmCost: false as unknown as true, idempotencyKey: "client-test-key" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps online session recovery working if the optional cache fails", async () => {
    const onCacheError = vi.fn();
    const cache = { get: vi.fn(), put: vi.fn().mockRejectedValue(new Error("Quota exhausted")), remove: vi.fn(), clear: vi.fn() };
    const client = createClient({ fetch: vi.fn().mockResolvedValue(Response.json({ data: exampleSession })), cache, onCacheError });
    expect(await client.getSession(exampleSession.id)).toEqual(exampleSession);
    expect(onCacheError).toHaveBeenCalledTimes(1);
  });

  it("stops polling an ambiguous paid submission without dispatching anything", async () => {
    const job = exampleJobs.find((item) => item.status === "submission_unknown")!;
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: job }));
    const client = createClient({ fetch, cache: false });
    expect((await client.pollJob(job.id)).status).toBe("submission_unknown");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].method).toBe("GET");
  });

  it("uploads original bytes directly then completes server verification", async () => {
    const blob = new Blob(["source image bytes"], { type: "image/png" });
    const hash = await digest(blob);
    const artifact = { ...exampleArtifact, kind: "source_image" as const, sha256: hash, sizeBytes: blob.size };
    const signedUrl = "https://storage.example.test/upload?token=signed-upload-token";
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: { artifactId: artifact.id, sessionId: artifact.sessionId, storagePath: artifact.storagePath, signedUrl, token: "signed-upload-token", expiresAt: "2026-10-12T12:00:00.000Z" } }))
      .mockResolvedValueOnce(Response.json({ Key: artifact.storagePath }))
      .mockResolvedValueOnce(Response.json({ data: artifact }));
    const client = createClient({ fetch, cache: false });
    const onProgress = vi.fn();
    expect(await client.uploadSourceImage(artifact.sessionId, blob, { fileName: "cat.png", onProgress })).toEqual(artifact);
    expect(fetch.mock.calls[1][0]).toBe(signedUrl);
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: "PUT", body: blob, credentials: "omit" });
    expect(fetch.mock.calls[2][0]).toBe("/api/uploads/complete");
    expect(onProgress.mock.calls.at(-1)?.[0]).toMatchObject({ stage: "completed", progress: 100 });
  });

  it("rejects artifact bytes that disagree with immutable provenance", async () => {
    const client = createClient({ fetch: vi.fn().mockResolvedValue(new Response("corrupt bytes")), cache: false });
    await expect(client.getArtifactBlob({ ...exampleArtifact, url: "https://storage.example.test/model.glb" })).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
  });
});

async function digest(blob: Blob) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
