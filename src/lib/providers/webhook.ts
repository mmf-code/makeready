import "server-only";
import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { readBoundedBody } from "./download";
import { ProviderError } from "./types";

const JWKS_URL = "https://rest.fal.ai/.well-known/jwks.json";
const SigningKey = z.object({ x: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const Jwks = z.object({ keys: z.array(SigningKey).min(1).max(20) });
const WebhookPayload = z.object({
  request_id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  gateway_request_id: z.string().optional(),
  status: z.enum(["OK", "ERROR"]),
  payload: z.unknown().optional(),
  error: z.string().nullable().optional(),
  payload_error: z.string().nullable().optional(),
});
let cachedKeys: { keys: z.infer<typeof SigningKey>[]; expires: number } | undefined;

export type VerifiedFalWebhook = {
  requestId: string;
  gatewayRequestId?: string;
  userId: string;
  status: "OK" | "ERROR";
  payload: unknown;
  error?: string;
  payloadError?: string;
};

/** Verify raw bytes before consuming the payload. Main must deduplicate by requestId. */
export async function verifyFalWebhook(
  input: { headers: Headers; rawBody: Uint8Array; expectedRequestId?: string; expectedUserId?: string },
  options: { fetch?: typeof fetch; now?: () => number; jwks?: unknown } = {},
): Promise<VerifiedFalWebhook> {
  if (input.rawBody.byteLength > 2 * 1024 * 1024) throw new ProviderError("Webhook payload is too large", "asset_too_large");
  const requestId = input.headers.get("x-fal-webhook-request-id");
  const userId = input.headers.get("x-fal-webhook-user-id");
  const timestamp = input.headers.get("x-fal-webhook-timestamp");
  const signature = input.headers.get("x-fal-webhook-signature");
  const now = (options.now ?? Date.now)();
  if (!requestId || !userId || !timestamp || !signature ||
    !/^[a-zA-Z0-9_-]{1,200}$/.test(requestId) || /[\r\n]/.test(userId) ||
    !/^\d{1,13}$/.test(timestamp) || Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 300 ||
    !/^[a-fA-F0-9]{128}$/.test(signature) ||
    (input.expectedRequestId !== undefined && requestId !== input.expectedRequestId) ||
    (input.expectedUserId !== undefined && userId !== input.expectedUserId)) {
    throw new ProviderError("Invalid fal webhook headers or timestamp", "invalid_result");
  }

  let keys: z.infer<typeof SigningKey>[];
  if (options.jwks !== undefined) {
    keys = Jwks.parse(options.jwks).keys;
  } else if (!options.fetch && cachedKeys && cachedKeys.expires > now) {
    keys = cachedKeys.keys;
  } else {
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(JWKS_URL, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    } catch { throw new ProviderError("Unable to verify webhook signing keys", "transport"); }
    if (!response.ok) throw new ProviderError("Unable to verify webhook signing keys", "transport", response.status);
    let parsed: unknown;
    try { parsed = JSON.parse((await readBoundedBody(response, 64 * 1024)).toString("utf8")); }
    catch { throw new ProviderError("Invalid fal signing key response", "invalid_result"); }
    const result = Jwks.safeParse(parsed);
    if (!result.success) throw new ProviderError("Invalid fal signing keys", "invalid_result");
    keys = result.data.keys;
    if (!options.fetch) cachedKeys = { keys, expires: now + 60 * 60 * 1000 };
  }
  const message = Buffer.from([requestId, userId, timestamp, createHash("sha256").update(input.rawBody).digest("hex")].join("\n"));
  const valid = keys.some(({ x }) => {
    try {
      const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
      return verify(null, message, key, Buffer.from(signature, "hex"));
    } catch { return false; }
  });
  if (!valid) throw new ProviderError("Invalid fal webhook signature", "invalid_result");
  let raw: unknown;
  try { raw = JSON.parse(Buffer.from(input.rawBody).toString("utf8")); }
  catch { throw new ProviderError("Webhook is not valid JSON", "invalid_result"); }
  const result = WebhookPayload.safeParse(raw);
  if (!result.success || result.data.request_id !== requestId) throw new ProviderError("Webhook request identity does not match signature", "invalid_result");
  return {
    requestId, userId, gatewayRequestId: result.data.gateway_request_id,
    status: result.data.status, payload: result.data.payload,
    error: result.data.error?.slice(0, 500), payloadError: result.data.payload_error?.slice(0, 500),
  };
}
