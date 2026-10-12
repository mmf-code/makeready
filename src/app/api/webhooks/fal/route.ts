import { after } from "next/server";
import { getDb } from "@/lib/db";
import { advanceJob } from "@/lib/executor";
import { ProviderError, readBoundedBody, verifyFalWebhook } from "@/lib/providers";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const rawBody = await readBoundedBody(new Response(request.body, { headers: request.headers }), 2 * 1024 * 1024);
    const verified = await verifyFalWebhook({ headers: request.headers, rawBody, expectedUserId: process.env.FAL_WEBHOOK_USER_ID || undefined });
    // No database lookup or payload consumption happens before signature verification.
    const { data, error } = await getDb().from("generation_jobs").select("id").eq("provider_ref->>requestId", verified.requestId).limit(1).maybeSingle();
    if (error) return Response.json({ error: { code: "STORAGE_FAILED", message: "Webhook could not be checkpointed.", retryable: true } }, { status: 503 });
    if (data) after(async () => { try { await advanceJob(data.id); } catch { /* Cron is the durable recovery path. */ } });
    return Response.json({ data: { accepted: true } }, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const unavailable = error instanceof ProviderError && error.kind === "transport";
    const tooLarge = error instanceof ProviderError && error.kind === "asset_too_large";
    return Response.json({ error: { code: unavailable ? "PROVIDER_UNAVAILABLE" : "INVALID_INPUT", message: unavailable ? "Webhook verification is temporarily unavailable." : "Invalid webhook.", retryable: unavailable } }, { status: unavailable ? 503 : tooLarge ? 413 : 401 });
  }
}
