import { test, expect, type APIRequestContext } from "@playwright/test";
import { ApiErrorSchema, DesignSessionSchema } from "../../src/lib/contracts";

const baseURL = process.env.MAKEREADY_E2E_BASE_URL;
const password = process.env.MAKEREADY_E2E_PASSWORD;
test.skip(!baseURL, "Configure MAKEREADY_E2E_BASE_URL for a running real application.");

test("unauthenticated API is gated and the MCP path performs its own authentication", async ({ request }) => {
  const session = await request.get("/api/sessions/00000000-0000-4000-8000-000000000001");
  expect(session.status()).toBe(401);
  const denied = ApiErrorSchema.parse((await session.json()).error);
  expect(denied.code).toBe("ACCESS_REQUIRED");
  const mcp = await request.post("/api/mcp/invalid-test-secret", {
    data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    headers: { Accept: "application/json, text/event-stream" },
  });
  expect(mcp.status()).toBe(404);
  expect(ApiErrorSchema.parse((await mcp.json()).error).code).toBe("NOT_FOUND");
});

test("an access form contract rejects invalid input without issuing a cookie", async ({ request }) => {
  const response = await request.post("/api/access", { data: {} });
  expect(response.status()).toBe(400);
  expect(ApiErrorSchema.parse((await response.json()).error).code).toBe("INVALID_INPUT");
  expect(response.headers()["set-cookie"]).toBeUndefined();
});

test("a real session persists when a client reconnects with its signed cookie", async ({ request, playwright }) => {
  test.skip(!password, "Set MAKEREADY_E2E_PASSWORD to test authenticated persistence against configured Supabase.");
  await unlock(request);
  const createdResponse = await request.post("/api/sessions", { data: { title: "E2E persistence acceptance" } });
  expect(createdResponse.status()).toBe(200);
  const created = DesignSessionSchema.parse((await createdResponse.json()).data);
  expect(created.revisions).toEqual([]);
  expect(created.jobs).toEqual([]);
  const secondClient = await playwright.request.newContext({ baseURL, storageState: await request.storageState() });
  try {
    const reloadedResponse = await secondClient.get(`/api/sessions/${created.id}`);
    expect(reloadedResponse.status()).toBe(200);
    const reloaded = DesignSessionSchema.parse((await reloadedResponse.json()).data);
    expect(reloaded.id).toBe(created.id);
    expect(reloaded.title).toBe(created.title);
    expect(reloaded.revisions).toEqual([]);
    expect(reloaded.jobs).toEqual([]);
  } finally { await secondClient.dispose(); }
});

test("paid generation is rejected before dispatch when confirmation is absent", async ({ request }) => {
  test.skip(!password, "Set MAKEREADY_E2E_PASSWORD to test an authenticated validation failure.");
  await unlock(request);
  const response = await request.post("/api/designs/start", {
    data: { prompt: "Never dispatch this unconfirmed request", heightMm: 120, use: "Test", idempotencyKey: "e2e-unconfirmed-no-paid-call" },
  });
  expect(response.status()).toBe(400);
  expect(ApiErrorSchema.parse((await response.json()).error).code).toBe("INVALID_INPUT");
});

test("an existing genuine session reconstructs its revision and job identities after reconnect", async ({ request, playwright }) => {
  const sessionId = process.env.MAKEREADY_E2E_SESSION_ID;
  test.skip(!password || !sessionId, "Configure MAKEREADY_E2E_PASSWORD and a genuine MAKEREADY_E2E_SESSION_ID; no test generation is submitted.");
  await unlock(request);
  const firstResponse = await request.get(`/api/sessions/${sessionId}`);
  expect(firstResponse.status()).toBe(200);
  const first = DesignSessionSchema.parse((await firstResponse.json()).data);
  expect(first.jobs.length).toBeGreaterThan(0);
  const reconnected = await playwright.request.newContext({ baseURL, storageState: await request.storageState() });
  try {
    const response = await reconnected.get(`/api/sessions/${sessionId}`);
    expect(response.status()).toBe(200);
    const restored = DesignSessionSchema.parse((await response.json()).data);
    for (const job of first.jobs) expect(restored.jobs.some((item) => item.id === job.id)).toBe(true);
    for (const revision of first.revisions) {
      const persisted = restored.revisions.find((item) => item.id === revision.id);
      expect(persisted?.artifacts.map((item) => item.sha256)).toEqual(revision.artifacts.map((item) => item.sha256));
    }
  } finally { await reconnected.dispose(); }
});

async function unlock(request: APIRequestContext) {
  const response = await request.post("/api/access", { data: { password, returnTo: "/" } });
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ data: { redirectTo: "/" } });
}
