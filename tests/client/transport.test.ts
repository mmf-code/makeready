import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTransport } from "../../src/lib/client/http";
import { createIndexedDbCache } from "../../src/lib/client/cache";
import { MakeReadyClientError } from "../../src/lib/client/errors";
import { pollExisting } from "../../src/lib/client/polling";

describe("typed client transport", () => {
  it("unwraps and validates the server envelope", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ data: { id: "job-1" } }));
    const transport = createTransport({ fetch });
    expect(await transport("/api/jobs/job-1", z.object({ id: z.string() }))).toEqual({ id: "job-1" });
    expect(fetch.mock.calls[0][1].credentials).toBe("include");
  });

  it("surfaces server error codes and never retries paid submissions", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: { code: "BUDGET_EXCEEDED", message: "Budget is exhausted.", retryable: false } }, { status: 402 }));
    const transport = createTransport({ fetch });
    await expect(transport("/api/designs/start", z.unknown(), { method: "POST", body: {}, submission: true })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("marks a lost paid acknowledgement ambiguous", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Network disconnected"));
    const transport = createTransport({ fetch });
    await expect(transport("/api/designs/start", z.unknown(), { method: "POST", body: {}, submission: true })).rejects.toMatchObject({ code: "TRANSPORT_AMBIGUOUS", retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects contract drift instead of inventing a successful result", async () => {
    const transport = createTransport({ fetch: vi.fn().mockResolvedValue(Response.json({ data: { id: 7 } })) });
    await expect(transport("/api/jobs/job-1", z.object({ id: z.string() }))).rejects.toMatchObject({ code: "CONTRACT_MISMATCH" });
  });

  it("can be imported during SSR without opening IndexedDB", async () => {
    const cache = createIndexedDbCache();
    expect(cache).toHaveProperty("get");
    if (typeof indexedDB === "undefined") await expect(cache.get("sessions", "session-1")).rejects.toMatchObject({ code: "CACHE_UNAVAILABLE" });
  });
});

describe("existing job polling", () => {
  it("retries transient reads without dispatching a new job", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(new MakeReadyClientError("NETWORK_ERROR", "Offline", { retryable: true }))
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "completed" });
    const updates = vi.fn();
    await expect(pollExisting(read, (job) => job.status === "completed", { intervalMs: 0, onUpdate: updates })).resolves.toEqual({ status: "completed" });
    expect(read).toHaveBeenCalledTimes(3);
    expect(updates).toHaveBeenCalledTimes(2);
  });

  it("aborts only polling, leaving the durable job untouched", async () => {
    const controller = new AbortController();
    const read = vi.fn().mockResolvedValue({ status: "running" });
    const result = pollExisting(read, () => false, {
      signal: controller.signal,
      onUpdate: () => controller.abort(),
    });
    await expect(result).rejects.toMatchObject({ code: "POLLING_INTERRUPTED" });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
