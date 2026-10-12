import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  ACCESS_COOKIE, ACCESS_MAX_AGE_SECONDS, acceptsPassword, createAccessToken,
  requireAccess, safeReturnTo, verifyAccessToken,
} from "../../src/lib/access";
import { proxy } from "../../src/proxy";
import { POST } from "../../src/app/api/access/route";

const password = "test-demo-password";
const secret = "s".repeat(48);
const now = Date.parse("2026-10-12T08:00:00.000Z");

beforeEach(() => {
  vi.stubEnv("DEMO_PASSWORD", password);
  vi.stubEnv("SESSION_SECRET", secret);
});
afterEach(() => vi.unstubAllEnvs());

describe("signed demo access", () => {
  it("verifies a signed fixed-scope token and expires after 24 hours", () => {
    const token = createAccessToken(now);
    expect(verifyAccessToken(token, now)).toBe(true);
    expect(verifyAccessToken(token, now - 1000)).toBe(false);
    expect(verifyAccessToken(token, now + ACCESS_MAX_AGE_SECONDS * 1000 - 1)).toBe(true);
    expect(verifyAccessToken(token, now + ACCESS_MAX_AGE_SECONDS * 1000)).toBe(false);
    expect(verifyAccessToken(`${token}x`, now)).toBe(false);
    const [payload, signature] = token.split(".");
    const tampered = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    tampered.scope = "other";
    expect(verifyAccessToken(`${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${signature}`, now)).toBe(false);
  });

  it("fails closed with missing configuration and after secret/password rotation", () => {
    const token = createAccessToken(now);
    expect(acceptsPassword(password)).toBe(true);
    expect(acceptsPassword(`${password}!`)).toBe(false);
    vi.stubEnv("DEMO_PASSWORD", "changed-password");
    expect(verifyAccessToken(token, now)).toBe(false);
    vi.stubEnv("DEMO_PASSWORD", password);
    vi.stubEnv("SESSION_SECRET", "changed-secret".repeat(4));
    expect(verifyAccessToken(token, now)).toBe(false);
    vi.stubEnv("SESSION_SECRET", "short");
    expect(acceptsPassword(password)).toBe(false);
    expect(() => createAccessToken(now)).toThrow();
    vi.stubEnv("SESSION_SECRET", secret);
    vi.stubEnv("DEMO_PASSWORD", "");
    expect(verifyAccessToken(token, now)).toBe(false);
  });

  it("keeps the shared scope constant and rejects cross-origin mutations", async () => {
    const cookie = `${ACCESS_COOKIE}=${createAccessToken()}`;
    await expect(requireAccess(new Request("https://app.example.test/api/sessions", { headers: { cookie } }))).resolves.toBe("demo");
    await expect(requireAccess(new Request("https://app.example.test/api/sessions", { method: "POST", headers: { cookie, Origin: "https://attacker.example.test" } }))).rejects.toMatchObject({ code: "ACCESS_REQUIRED", status: 401 });
    await expect(requireAccess(new Request("https://app.example.test/api/sessions"))).rejects.toMatchObject({ code: "ACCESS_REQUIRED" });
  });
});

describe("access route and local redirects", () => {
  it("rejects external, encoded, backslash and looping return targets", () => {
    for (const input of [undefined, "https://evil.test", "//evil.test", "/\\evil.test", "/%2f%2fevil.test", "/\nevil.test", "/access?returnTo=/", "/api/access"]) {
      expect(safeReturnTo(input)).toBe("/");
    }
    expect(safeReturnTo("/?sessionId=123#compare")).toBe("/?sessionId=123#compare");
  });

  it("sets a secure HttpOnly Lax 24-hour production cookie and a safe result", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await POST(new Request("https://app.example.test/api/access", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://app.example.test" },
      body: JSON.stringify({ password, returnTo: "//evil.test" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { redirectTo: "/" } });
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain(`${ACCESS_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).toContain(`Max-Age=${ACCESS_MAX_AGE_SECONDS}`);
    expect(cookie).not.toContain(password);
    expect(cookie).not.toContain(secret);
  });

  it("does not issue a cookie for invalid passwords or cross-origin requests", async () => {
    for (const [inputPassword, origin] of [["wrong", "https://app.example.test"], [password, "https://evil.test"]]) {
      const response = await POST(new Request("https://app.example.test/api/access", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ password: inputPassword }),
      }));
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.json()).toMatchObject({ error: { code: "ACCESS_REQUIRED", retryable: false } });
    }
  });
});

describe("Next.js access proxy", () => {
  it("returns API401 and page redirect while preserving a local return path", async () => {
    const api = await proxy(new NextRequest("https://app.example.test/api/sessions/abc"));
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ error: { code: "ACCESS_REQUIRED" } });
    const page = await proxy(new NextRequest("https://app.example.test/?sessionId=abc"));
    expect(page.status).toBe(307);
    expect(new URL(page.headers.get("location")!).pathname).toBe("/access");
    expect(new URL(page.headers.get("location")!).searchParams.get("returnTo")).toBe("/?sessionId=abc");
  });

  it("permits valid sessions and only the explicitly independent auth routes", async () => {
    const authorized = await proxy(new NextRequest("https://app.example.test/api/sessions", { headers: { cookie: `${ACCESS_COOKIE}=${createAccessToken()}` } }));
    expect(authorized.headers.get("x-middleware-next")).toBe("1");
    for (const path of ["/access", "/api/access", "/api/mcp/unguessable", "/api/webhooks/fal", "/api/internal/reconcile", "/globe.svg"]) {
      expect((await proxy(new NextRequest(`https://app.example.test${path}`))).headers.get("x-middleware-next")).toBe("1");
    }
    for (const path of ["/api/sessions/report.svg", "/api/webhooks/fal/other", "/private.svg"]) {
      expect((await proxy(new NextRequest(`https://app.example.test${path}`))).headers.get("x-middleware-next")).toBeNull();
    }
  });
});
