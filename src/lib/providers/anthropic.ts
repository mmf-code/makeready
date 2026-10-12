import "server-only";
import { assertImageInput } from "./fal";
import { readBoundedBody } from "./download";
import { ProviderError } from "./types";

export const ANTHROPIC_API_BASE = "https://api.anthropic.com/v1";
export type AnthropicInputMessage = { role: "system"; content: string } | {
  role: "user";
  content: string | ({ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "auto" })[];
};
export type AnthropicEnvelope = {
  id?: string; model?: string; _request_id?: string | null;
  status: "completed" | "incomplete"; output_text?: string; httpStatus: number;
  usage?: {
    input_tokens: number | null; output_tokens: number | null; total_tokens: number | null;
    input_tokens_details: { cached_tokens: number | null; cache_creation_tokens: number | null };
  };
};

/** Transform only the schema, then validate the answer with the unchanged Zod contract. */
export function anthropicJsonSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderError("Invalid intelligence JSON schema", "configuration");
  const schema = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const constraints: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(schema)) {
    if (key === "$schema") continue;
    if (key === "properties" || key === "$defs" || key === "definitions") {
      result[key] = Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([name, child]) => [name, anthropicJsonSchema(child)]));
    } else if (key === "items") result[key] = anthropicJsonSchema(item);
    else if (key === "anyOf" || key === "allOf") result[key] = (item as unknown[]).map(anthropicJsonSchema);
    else if (["type", "enum", "const", "required", "description", "$ref", "default"].includes(key)) result[key] = item;
    else if (key === "additionalProperties") result[key] = false;
    else if (key === "minItems" && (item === 0 || item === 1)) result[key] = item;
    else constraints[key] = item;
  }
  if (schema.type === "object" || schema.properties) result.additionalProperties = false;
  if (Object.keys(constraints).length) {
    result.description = [result.description, `Additional validation constraints: ${JSON.stringify(constraints)}`].filter(Boolean).join("\n");
  }
  return result;
}

function imageSource(value: string) {
  const safe = assertImageInput(value);
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=]+)$/.exec(safe);
  if (match) {
    // Claude API documents a 10 MB base64-encoded per-image limit.
    if (match[2].length > 10_000_000) throw new ProviderError("Anthropic image exceeds the 10 MB encoded limit", "asset_too_large");
    return { type: "base64", media_type: match[1], data: match[2] };
  }
  return { type: "url", url: safe };
}

const tokens = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

/** Exactly one POST, no redirects, retries, provider fallback, tools, or assistant prefill. */
export async function createAnthropicMessage(input: {
  apiKey: string; model: string; schema: Record<string, unknown>; messages: AnthropicInputMessage[]; fetch?: typeof fetch;
}): Promise<AnthropicEnvelope> {
  const system = input.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  const messages = input.messages.filter((message) => message.role === "user").map((message) => ({
    role: "user", content: typeof message.content === "string" ? message.content : message.content.map((part) =>
      part.type === "input_text" ? { type: "text", text: part.text } : { type: "image", source: imageSource(part.image_url) }),
  }));
  const payload = JSON.stringify({ model: input.model, max_tokens: 2500, stream: false, system, messages,
    output_config: { effort: "low", format: { type: "json_schema", schema: anthropicJsonSchema(input.schema) } },
  });
  if (Buffer.byteLength(payload, "utf8") > 32_000_000) throw new ProviderError("Anthropic request exceeds the 32 MB limit", "asset_too_large");
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(`${ANTHROPIC_API_BASE}/messages`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(45_000),
      headers: { "content-type": "application/json", "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" },
      body: payload,
    });
  } catch {
    throw new ProviderError("Design intelligence request outcome is uncertain; no automatic retry or provider fallback was made", "transport");
  }
  // The status already proves a rejection. Its untrusted body must not turn a 401/429
  // into an ambiguous submission if reading it fails, and its details are never surfaced.
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* HTTP classification remains authoritative. */ }
    return { _request_id: response.headers.get("request-id"), httpStatus: response.status, status: "incomplete" };
  }
  let body: unknown;
  try {
    const bytes = await readBoundedBody(response, 1024 * 1024);
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { body = null; }
  } catch {
    throw new ProviderError("Design intelligence response could not be read; no automatic retry or provider fallback was made", "transport");
  }
  const data = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const usage = data.usage && typeof data.usage === "object" ? data.usage as Record<string, unknown> : undefined;
  const inputTokens = tokens(usage?.input_tokens);
  const outputTokens = tokens(usage?.output_tokens);
  const cacheRead = tokens(usage?.cache_read_input_tokens) ?? (usage ? 0 : null);
  const cacheCreation = tokens(usage?.cache_creation_input_tokens) ?? (usage ? 0 : null);
  const totalInput = inputTokens === null ? null : inputTokens + (cacheRead ?? 0) + (cacheCreation ?? 0);
  const blocks = Array.isArray(data.content) ? data.content : [];
  const output = blocks.filter((block): block is { type: "text"; text: string } =>
    !!block && typeof block === "object" && block.type === "text" && typeof block.text === "string").map((block) => block.text).join("");
  return {
    id: text(data.id), model: text(data.model), _request_id: response.headers.get("request-id"), httpStatus: response.status,
    status: response.ok && data.type === "message" && data.stop_reason === "end_turn" && !blocks.some((block) => block?.type === "refusal" || block?.type === "tool_use") ? "completed" : "incomplete",
    output_text: output || undefined,
    usage: usage ? {
      input_tokens: totalInput, output_tokens: outputTokens,
      total_tokens: totalInput === null || outputTokens === null ? null : totalInput + outputTokens,
      input_tokens_details: { cached_tokens: cacheRead, cache_creation_tokens: cacheCreation },
    } : undefined,
  };
}
