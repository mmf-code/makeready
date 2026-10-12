import { NextRequest, NextResponse } from "next/server";
import { requireAccess } from "@/lib/access";

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (publicPath(path)) return NextResponse.next();
  try {
    await requireAccess(request);
    return NextResponse.next();
  } catch {
    if (path.startsWith("/api/")) return NextResponse.json({
      error: { code: "ACCESS_REQUIRED", message: "Demo access is required.", retryable: false },
    }, { status: 401, headers: { "Cache-Control": "no-store" } });
    const url = new URL("/access", request.url);
    url.searchParams.set("returnTo", `${path}${request.nextUrl.search}`);
    return NextResponse.redirect(url);
  }
}

function publicPath(path: string): boolean {
  if (path === "/access" || path === "/api/access") return true;
  if (path.startsWith("/_next/") || path === "/favicon.ico" || path === "/robots.txt" || path === "/sitemap.xml") return true;
  // These endpoints perform their own secret/signature validation.
  if (path.startsWith("/api/mcp/") || path === "/api/webhooks/fal" || path === "/api/internal/reconcile") return true;
  // Do not bypass a protected application route merely because it has a dot.
  if (["/window.svg", "/globe.svg", "/next.svg", "/vercel.svg", "/file.svg"].includes(path)) return true;
  return /^\/(?:assets|fonts|samples)\//.test(path)
    && /\.(?:svg|png|jpe?g|webp|gif|ico|woff2?|ttf|css|js|glb)$/i.test(path);
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
