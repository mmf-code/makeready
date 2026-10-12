import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyFalWebhook } from "@/lib/providers/webhook";

const now = Date.parse("2026-10-12T09:00:00Z");
const pair = generateKeyPairSync("ed25519");
const jwks = { keys: [pair.publicKey.export({ format: "jwk" })] };
function signed(body: object, seconds = Math.floor(now / 1000)) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const message = ["request-123", "fal-user", String(seconds), createHash("sha256").update(rawBody).digest("hex")].join("\n");
  const signature = sign(null, Buffer.from(message), pair.privateKey).toString("hex");
  const headers = new Headers({
    "x-fal-webhook-request-id": "request-123", "x-fal-webhook-user-id": "fal-user",
    "x-fal-webhook-timestamp": String(seconds), "x-fal-webhook-signature": signature,
  });
  return { rawBody, headers };
}

describe("fal webhook authentication", () => {
  it("verifies raw bytes and retains both canonical and attempt IDs", async () => {
    const input = signed({ request_id: "request-123", gateway_request_id: "attempt-2", status: "OK", payload: { model_glb: { url: "https://v3.fal.media/model.glb" } } });
    const result = await verifyFalWebhook({ ...input, expectedRequestId: "request-123", expectedUserId: "fal-user" }, { jwks, now: () => now });
    expect(result).toMatchObject({ requestId: "request-123", gatewayRequestId: "attempt-2", status: "OK", userId: "fal-user" });
  });

  it("does not trust an altered payload with an otherwise valid signature", async () => {
    const input = signed({ request_id: "request-123", status: "OK", payload: { value: 1 } });
    await expect(verifyFalWebhook({ ...input, rawBody: Buffer.from(input.rawBody.toString().replace('"value":1', '"value":2')) }, { jwks, now: () => now })).rejects.toThrow("signature");
  });

  it("rejects a timestamp outside the five minute replay window without fetching keys", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const input = signed({ request_id: "request-123", status: "OK", payload: {} }, Math.floor(now / 1000) - 301);
    await expect(verifyFalWebhook(input, { fetch: fetchMock, now: () => now })).rejects.toThrow("timestamp");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a signed body whose canonical request ID differs from the signed header", async () => {
    const input = signed({ request_id: "another-request", status: "OK", payload: {} });
    await expect(verifyFalWebhook(input, { jwks, now: () => now })).rejects.toThrow("identity");
  });

  it("preserves explicit provider errors rather than treating them as model success", async () => {
    const input = signed({ request_id: "request-123", status: "ERROR", error: "Invalid status code: 422", payload: { detail: "invalid input" } });
    await expect(verifyFalWebhook(input, { jwks, now: () => now })).resolves.toMatchObject({ status: "ERROR", error: "Invalid status code: 422" });
  });

  it("marks signing-key network failures as transport errors", async () => {
    const input = signed({ request_id: "request-123", status: "OK", payload: {} });
    await expect(verifyFalWebhook(input, { fetch: vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network")), now: () => now })).rejects.toMatchObject({ kind: "transport" });
  });
});
