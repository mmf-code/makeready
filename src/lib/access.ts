import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors";

export const ACCESS_COOKIE = "makeready_session";
export const ACCESS_MAX_AGE_SECONDS = 24 * 60 * 60;
const DEMO_SCOPE = "demo" as const;

interface AccessConfiguration {
  password: string;
  secret: string;
}

function configuration(): AccessConfiguration | undefined {
  const password = process.env.DEMO_PASSWORD;
  const secret = process.env.SESSION_SECRET;
  if (!password || !secret || secret.length < 32) return;
  return { password, secret };
}

export function acceptsPassword(input: string): boolean {
  const config = configuration();
  if (!config || input.length > 4096) return false;
  return timingSafeEqual(passwordDigest(input, config.secret), passwordDigest(config.password, config.secret));
}

export function createAccessToken(now = Date.now()): string {
  const config = configuration();
  if (!config) throw new AppError("ACCESS_REQUIRED", "Demo access is unavailable.", 503);
  const issuedAt = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    scope: DEMO_SCOPE,
    issuedAt,
    expiresAt: issuedAt + ACCESS_MAX_AGE_SECONDS,
    credential: passwordDigest(config.password, config.secret).toString("base64url"),
  })).toString("base64url");
  return `${payload}.${signature(payload, config.secret).toString("base64url")}`;
}

export function verifyAccessToken(token?: string, now = Date.now()): boolean {
  const config = configuration();
  if (!config || !token || token.length > 2048) return false;
  const segments = token.split(".");
  if (segments.length !== 2) return false;
  const [payload, signed] = segments;
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signed)) return false;
  const supplied = Buffer.from(signed, "base64url");
  const expected = signature(payload, config.secret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return false;
    const value = decoded as Record<string, unknown>;
    const current = Math.floor(now / 1000);
    return value.version === 1 && value.scope === DEMO_SCOPE
      && typeof value.issuedAt === "number" && Number.isInteger(value.issuedAt)
      && typeof value.expiresAt === "number" && Number.isInteger(value.expiresAt)
      && value.issuedAt <= current && value.expiresAt > current
      && value.expiresAt - value.issuedAt === ACCESS_MAX_AGE_SECONDS
      && value.credential === passwordDigest(config.password, config.secret).toString("base64url");
  } catch { return false; }
}

/** REST handlers call this even when Proxy already checked the cookie. */
export async function requireAccess(request?: Request): Promise<typeof DEMO_SCOPE> {
  let token: string | undefined;
  if (request) {
    if (!trustedRequestOrigin(request)) throw new AppError("ACCESS_REQUIRED", "Demo access is required.", 401);
    token = cookieFromHeader(request.headers.get("cookie"));
  } else {
    const { cookies } = await import("next/headers");
    token = (await cookies()).get(ACCESS_COOKIE)?.value;
  }
  if (!verifyAccessToken(token)) throw new AppError("ACCESS_REQUIRED", "Demo access is required.", 401);
  return DEMO_SCOPE;
}

export function trustedRequestOrigin(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true; // Non-browser clients can supply a signed cookie.
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}

export function safeReturnTo(value?: string): string {
  if (!value || value.length > 2048 || !value.startsWith("/") || value.startsWith("//")
    || /[\\\u0000-\u001f\u007f]/.test(value) || /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return "/";
  try {
    const base = "https://makeready.invalid";
    const url = new URL(value, base);
    if (url.origin !== base || url.pathname === "/access" || url.pathname === "/api/access") return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return "/"; }
}

function cookieFromHeader(header: string | null): string | undefined {
  for (const cookie of header?.split(";") ?? []) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== ACCESS_COOKIE) continue;
    const value = cookie.slice(separator + 1).trim();
    try { return decodeURIComponent(value); } catch { return; }
  }
}

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`makeready-access/v1:${payload}`).digest();
}

function passwordDigest(password: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`makeready-password/v1:${password}`).digest();
}
