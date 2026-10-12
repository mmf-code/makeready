import { timingSafeEqual } from "node:crypto";
import { reconcileJobs } from "@/lib/executor";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const secret = process.env.EXECUTOR_SECRET;
  if (!secret) return Response.json({ error: { code: "PROVIDER_UNAVAILABLE", message: "Executor authentication is not configured.", retryable: false } }, { status: 503 });
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return Response.json({ error: { code: "ACCESS_REQUIRED", message: "Executor access required.", retryable: false } }, { status: 401 });
  }
  try { return Response.json({ data: await reconcileJobs() }, { headers: { "Cache-Control": "no-store" } }); }
  catch { return Response.json({ error: { code: "STORAGE_FAILED", message: "Reconciliation is temporarily unavailable.", retryable: true } }, { status: 503 }); }
}

export const GET = POST;
