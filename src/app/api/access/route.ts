import { NextResponse } from "next/server";
import { AccessInputSchema, AccessResultSchema } from "@/lib/contracts";
import {
  ACCESS_COOKIE, ACCESS_MAX_AGE_SECONDS, acceptsPassword, createAccessToken,
  safeReturnTo, trustedRequestOrigin,
} from "@/lib/access";
import { AppError } from "@/lib/errors";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!trustedRequestOrigin(request)) return denied();
  let input: unknown;
  try { input = await request.json(); }
  catch { return NextResponse.json({ error: { code: "INVALID_INPUT", message: "Expected an access request as JSON.", retryable: false } }, { status: 400 }); }
  const parsed = AccessInputSchema.safeParse(input);
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_INPUT", message: "Invalid access request.", retryable: false } }, { status: 400 });
  if (!acceptsPassword(parsed.data.password)) return denied();
  try {
    const data = AccessResultSchema.parse({ redirectTo: safeReturnTo(parsed.data.returnTo) });
    const response = NextResponse.json({ data }, { headers: { "Cache-Control": "no-store" } });
    response.cookies.set(ACCESS_COOKIE, createAccessToken(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: ACCESS_MAX_AGE_SECONDS,
      expires: new Date(Date.now() + ACCESS_MAX_AGE_SECONDS * 1000),
    });
    return response;
  } catch (cause) {
    if (cause instanceof AppError) return NextResponse.json({ error: cause.toJSON() }, { status: cause.status });
    return denied();
  }
}

function denied(): Response {
  return NextResponse.json({ error: { code: "ACCESS_REQUIRED", message: "Demo access is required.", retryable: false } }, {
    status: 401, headers: { "Cache-Control": "no-store" },
  });
}
