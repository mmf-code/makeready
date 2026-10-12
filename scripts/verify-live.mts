import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AccessResultSchema, ApiErrorSchema, DesignSessionSchema } from "../src/lib/contracts";
import { McpToolOutputSchemas } from "../src/lib/contracts/mcp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(join(root, ".env.local"))) process.loadEnvFile(join(root, ".env.local"));
const requireView = process.argv.includes("--require-view");
const transportOnly = process.argv.includes("--transport-only");
let step = "configuration";

async function main() {
  if (!process.env.APP_URL || !process.env.DEMO_PASSWORD || !process.env.MCP_SECRET) fail("configuration_missing");
  const app = new URL(process.env.APP_URL);
  if (app.username || app.password || app.pathname !== "/" || app.search || app.hash
    || (app.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(app.hostname))) fail("invalid_app_origin");
  const headers = new Headers({ Accept: "application/json" });
  if (process.env.VERCEL_PROTECTION_BYPASS) headers.set("x-vercel-protection-bypass", process.env.VERCEL_PROTECTION_BYPASS);
  const api = (path: string, init: RequestInit = {}) => fetch(new URL(path, app), {
    ...init, headers: mergedHeaders(headers, init.headers), signal: AbortSignal.timeout(60_000), redirect: "manual",
  });

  step = "access_gate";
  const deniedResponse = await api("/api/sessions/00000000-0000-4000-8000-000000000001");
  if (deniedResponse.status !== 401) fail(`unexpected_http_${deniedResponse.status}`);
  const denied = ApiErrorSchema.parse((await deniedResponse.json()).error);
  if (denied.code !== "ACCESS_REQUIRED") fail("unexpected_error_code");
  console.info("access_gate: PASS 401");

  step = "access_cookie";
  const access = await api("/api/access", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.DEMO_PASSWORD, returnTo: "/" }),
  });
  if (access.status !== 200) fail(`unexpected_http_${access.status}`);
  const result = AccessResultSchema.parse((await access.json()).data);
  if (result.redirectTo !== "/") fail("invalid_access_result");
  const cookies = access.headers.getSetCookie();
  if (cookies.length === 0 || !cookies.some((value) => /HttpOnly/i.test(value) && /SameSite=Lax/i.test(value))) fail("missing_signed_cookie");
  headers.set("Cookie", cookies.map((value) => value.split(";")[0]).join("; "));
  console.info("access_cookie: PASS 200");

  let createdId: string | undefined;
  if (!transportOnly) {
    step = "session_create";
    const createdResponse = await api("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "MakeReady live acceptance" }),
    });
    if (createdResponse.status !== 200) await apiFailure(createdResponse);
    const created = DesignSessionSchema.parse((await createdResponse.json()).data);
    if (created.revisions.length !== 0 || created.jobs.length !== 0) fail("new_session_contains_invented_results");
    createdId = created.id;
    console.info(`session_create: PASS ${created.id}`);

    step = "session_reload";
    const restoredResponse = await api(`/api/sessions/${created.id}`);
    if (restoredResponse.status !== 200) await apiFailure(restoredResponse);
    const restored = DesignSessionSchema.parse((await restoredResponse.json()).data);
    if (restored.id !== created.id || restored.title !== created.title || restored.createdAt !== created.createdAt) fail("session_persistence_mismatch");
    console.info(`session_reload: PASS ${restored.id}`);
  } else console.info("database: NOT_EXERCISED (transport-only mode)");

  step = "mcp_tools";
  const endpoint = `/api/mcp/${encodeURIComponent(process.env.MCP_SECRET)}`;
  const callMcp = async (method: string, params: unknown = {}) => {
    const response = await api(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (response.status !== 200) fail(`unexpected_http_${response.status}`);
    const raw = await response.text();
    const parsed: unknown = response.headers.get("Content-Type")?.includes("text/event-stream")
      ? raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim())).find((item) => item.id === 1)
      : JSON.parse(raw);
    const envelope = z.object({ result: z.unknown(), error: z.unknown().optional() }).parse(parsed);
    if (envelope.error) fail("mcp_protocol_error");
    return envelope.result;
  };
  const tools = z.object({ tools: z.array(z.object({ name: z.string(), inputSchema: z.object({}).passthrough(), outputSchema: z.object({}).passthrough(), _meta: z.record(z.string(), z.unknown()).optional() })) }).parse(await callMcp("tools/list")).tools;
  const expected = Object.keys(McpToolOutputSchemas).sort();
  if (JSON.stringify(tools.map((tool) => tool.name).sort()) !== JSON.stringify(expected)) fail("mcp_tool_contract_mismatch");
  console.info(`mcp_tools: PASS ${tools.length}`);

  step = "mcp_model_provider_contract";
  const model = tools.find((tool) => tool.name === "generate_model");
  const providers = z.object({ properties: z.object({ provider: z.object({ enum: z.array(z.string()) }) }) }).parse(model?.inputSchema).properties.provider.enum;
  if (JSON.stringify([...providers].sort()) !== '["fal","meshy"]') fail("model_provider_schema_mismatch");
  console.info("mcp_model_provider_contract: PASS (no paid submission)");

  step = "mcp_photo_contract";
  const start = tools.find((tool) => tool.name === "start_design");
  if (JSON.stringify(start?._meta?.["openai/fileParams"]) !== '["photo"]') fail("file_parameter_metadata_missing");
  const photo = z.object({ properties: z.object({ photo: z.object({
    properties: z.record(z.string(), z.unknown()), required: z.array(z.string()),
  }) }) }).parse(start?.inputSchema).properties.photo;
  if (!["download_url", "file_id", "mime_type", "file_name"].every((key) => key in photo.properties)
    || JSON.stringify([...photo.required].sort()) !== '["download_url","file_id"]') fail("photo_input_schema_mismatch");
  console.info("mcp_photo_contract: PASS (attachment download not exercised)");

  if (createdId) {
    step = "mcp_shared_session";
    const toolResult = z.object({ isError: z.boolean().optional(), structuredContent: McpToolOutputSchemas.get_design }).parse(await callMcp("tools/call", { name: "get_design", arguments: { sessionId: createdId } }));
    if (toolResult.isError || toolResult.structuredContent.result.id !== createdId) fail("mcp_web_store_mismatch");
    console.info(`mcp_shared_session: PASS ${createdId}`);
  }

  step = "mcp_view";
  const ui = tools.find((tool) => typeof tool._meta?.["openai/outputTemplate"] === "string");
  if (ui) {
    const uri = ui._meta!["openai/outputTemplate"] as string;
    const resource = z.object({ contents: z.array(z.object({ uri: z.string(), mimeType: z.string(), text: z.string() })) }).parse(await callMcp("resources/read", { uri }));
    if (!resource.contents.some((item) => item.uri === uri && item.mimeType === "text/html;profile=mcp-app" && item.text.includes("<script") && item.text.includes('id="root"'))) fail("mcp_view_resource_invalid");
    const view = resource.contents.find((item) => item.uri === uri)!;
    const digest = createHash("sha256").update(view.text).digest("hex");
    if (uri !== `ui://makeready/view-${digest.slice(0, 12)}.html`) fail("mcp_view_hash_mismatch");
    console.info("mcp_view: PASS");
  } else {
    if (requireView) fail("mcp_view_missing");
    console.info("mcp_view: UNAVAILABLE (frontend bundle not published)");
  }
  console.info(`${transportOnly ? "transport_verification" : "verification"}: PASS (no generation, editing, or planning calls)`);
}

function mergedHeaders(base: Headers, extra?: HeadersInit): Headers {
  const next = new Headers(base);
  new Headers(extra).forEach((value, name) => next.set(name, value));
  return next;
}

async function apiFailure(response: Response): Promise<never> {
  const payload: unknown = await response.json();
  const envelope = z.object({ error: ApiErrorSchema }).safeParse(payload);
  fail(`http_${response.status}_${envelope.success ? envelope.data.error.code : "invalid_response"}`);
}

function fail(code: string): never { throw new VerificationError(code); }
class VerificationError extends Error {}

main().catch((error: unknown) => {
  // Never print fetch errors, request URLs (the MCP path is a credential), cookie values, or bodies.
  console.error(`${step}: FAIL ${error instanceof VerificationError ? error.message : "unreadable_or_unreachable_response"}`);
  process.exitCode = 1;
});
