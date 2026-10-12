import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ reconcile: vi.fn(), advance: vi.fn(), verify: vi.fn(), getDb: vi.fn(), after: vi.fn() }));
vi.mock("@/lib/executor", () => ({ reconcileJobs: mock.reconcile, advanceJob: mock.advance }));
vi.mock("@/lib/db", () => ({ getDb: mock.getDb }));
vi.mock("next/server", () => ({ after: mock.after }));
vi.mock("@/lib/providers", async (original) => ({ ...await original<typeof import("@/lib/providers")>(), verifyFalWebhook: mock.verify }));
import { POST as reconcile } from "@/app/api/internal/reconcile/route";
import { POST as webhook } from "@/app/api/webhooks/fal/route";

beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("EXECUTOR_SECRET", "test-executor-secret"); });

describe("executor HTTP boundaries", () => {
  it("rejects an unauthorized cron request before touching jobs", async () => {
    const response = await reconcile(new Request("https://example.com/api/internal/reconcile", { method: "POST", headers: { authorization: "Bearer wrong" } }));
    expect(response.status).toBe(401); expect(mock.reconcile).not.toHaveBeenCalled();
  });
  it("runs authorized reconciliation", async () => {
    mock.reconcile.mockResolvedValue({ processed: 2 });
    const response = await reconcile(new Request("https://example.com/api/internal/reconcile", { method: "POST", headers: { authorization: "Bearer test-executor-secret" } }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ data: { processed: 2 } });
  });
  it("verifies the webhook before any database lookup", async () => {
    mock.verify.mockRejectedValue(new Error("Invalid signature"));
    const response = await webhook(new Request("https://example.com/api/webhooks/fal", { method: "POST", body: "{}" }));
    expect(response.status).toBe(401); expect(mock.getDb).not.toHaveBeenCalled(); expect(mock.after).not.toHaveBeenCalled();
  });
  it("acknowledges a verified event and schedules work after the response", async () => {
    mock.verify.mockResolvedValue({ requestId: "fal-123", status: "OK" });
    const query: Record<string, unknown> = {};
    for (const key of ["select", "eq", "limit"]) query[key] = () => query;
    query.maybeSingle = async () => ({ data: { id: "22222222-2222-4222-8222-222222222222" }, error: null });
    mock.getDb.mockReturnValue({ from: () => query });
    const response = await webhook(new Request("https://example.com/api/webhooks/fal", { method: "POST", body: "{}" }));
    expect(response.status).toBe(202); expect(mock.advance).not.toHaveBeenCalled();
    await mock.after.mock.calls[0][0]();
    expect(mock.advance).toHaveBeenCalledWith("22222222-2222-4222-8222-222222222222");
  });
});
