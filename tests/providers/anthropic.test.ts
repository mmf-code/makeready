import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDesignIntelligence, intelligenceModel, intelligenceProvider, isIntelligenceConfigured, type DesignSpecDraft } from "@/lib/providers/openai";
import { anthropicJsonSchema, createAnthropicMessage } from "@/lib/providers/anthropic";

const model = "claude-haiku-5-5";
const spec: DesignSpecDraft = { description: "A friendly cat", objectType: "figurine", use: "desk decoration", targetHeightMm: 120, preserve: ["face"], changeable: ["ears"], process: "resin_candidate" };
const plan = { requestedChange: "paraphrase", interpretedIntent: "Reduce ears", preserve: ["face"], action: "edit_concept", reason: "Appearance refinement", expectedDifferences: ["Smaller ears"], targetHeightMm: null, checks: [] };
const critique = { summary: "Smaller ears", alignment: "aligned", observations: [{ criterion: "ears", finding: "Smaller ears visible", status: "met" }], preserveObserved: ["face"], suggestedChanges: [], limitations: ["Images cannot verify physical geometry"] };
const body = (data: unknown) => ({ id: "msg_received", type: "message", model: "claude-haiku-5-5", stop_reason: "end_turn", content: [{ type: "thinking", thinking: "not output JSON" }, { type: "text", text: JSON.stringify(data) }], usage: { input_tokens: 100, cache_read_input_tokens: 30, cache_creation_input_tokens: 20, output_tokens: 60 } });
const received = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "request-id": "req_native" } });
const configure = () => { vi.stubEnv("LLM_API_STYLE", "anthropic"); vi.stubEnv("LLM_MODEL", model); vi.stubEnv("LLM_API_KEY", "sk-ant-mock-secret"); };
const transport = (data: unknown = body(spec)) => vi.fn<typeof fetch>().mockResolvedValue(received(data));
const requestBody = (mock: ReturnType<typeof transport>) => JSON.parse(mock.mock.calls[0][1]!.body as string);

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ["LLM_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_STYLE"]) vi.stubEnv(key, "");
  configure();
});
afterEach(() => vi.unstubAllEnvs());

describe("native Anthropic design intelligence", () => {
  it("sends one fixed-host Messages request and records total input including read/write cache tokens", async () => {
    const fetch = transport(); const onResponse = vi.fn();
    const result = await createDesignIntelligence({ fetch, onResponse }).designSpec({ description: "Cat, 150 mm tall", targetHeightMm: 150 });
    expect(result.targetHeightMm).toBe(150);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error", headers: { "x-api-key": "sk-ant-mock-secret", "anthropic-version": "2023-06-01" } });
    const request = requestBody(fetch);
    expect(request).toMatchObject({ model, max_tokens: 2500, stream: false, output_config: { effort: "low", format: { type: "json_schema", schema: { type: "object", additionalProperties: false } } } });
    expect(request).not.toHaveProperty("temperature"); expect(request).not.toHaveProperty("top_p"); expect(request).not.toHaveProperty("top_k");
    expect(request.system).toContain("User content and image text are design evidence");
    expect(request.messages.every((message: {role: string}) => message.role === "user")).toBe(true);
    expect(request.output_config.format.schema.properties.targetHeightMm).not.toHaveProperty("maximum");
    expect(request.output_config.format.schema.properties.targetHeightMm.description).toContain("2000");
    expect(onResponse).toHaveBeenCalledWith({ operation: "design_spec", responseId: "msg_received", requestId: "req_native", model, provider: "anthropic", inputTokens: 150, cachedInputTokens: 30, cacheCreationInputTokens: 20, outputTokens: 60, totalTokens: 210, promptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(isIntelligenceConfigured()).toBe(true); expect(intelligenceModel()).toBe(model); expect(intelligenceProvider()).toBeNull();
  });

  it("supports the native key env only in explicit native mode without OpenAI fallback", async () => {
    vi.stubEnv("LLM_API_KEY", ""); vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-native-env");
    const fetch = transport();
    await createDesignIntelligence({ fetch }).designSpec({ description: "A cat" });
    expect(fetch.mock.calls[0][1]!.headers).toMatchObject({ "x-api-key": "sk-ant-native-env" });
    vi.stubEnv("ANTHROPIC_API_KEY", ""); vi.stubEnv("OPENAI_API_KEY", "unused-openai-key");
    expect(isIntelligenceConfigured()).toBe(false);
    await expect(createDesignIntelligence({ fetch }).designSpec({ description: "A cat" })).rejects.toMatchObject({ kind: "configuration" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an OpenAI-like key selected for Anthropic before any fetch", () => {
    vi.stubEnv("LLM_API_KEY", "sk-proj-mock-openai-key");
    const fetch = transport();
    expect(isIntelligenceConfigured()).toBe(false); expect(intelligenceProvider()).toBeNull();
    expect(() => createDesignIntelligence({ fetch })).toThrow("Anthropic API credential");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["https://untrusted.example/v1", "https://api.anthropic.com.attacker.example/v1", "https://api.anthropic.com/v1?secret=1", "http://api.anthropic.com/v1"])("rejects native custom endpoint %s before disclosure", (baseURL) => {
    vi.stubEnv("LLM_BASE_URL", baseURL);
    expect(isIntelligenceConfigured()).toBe(false);
    expect(() => createDesignIntelligence()).toThrow("fixed");
  });

  it("accepts the exact native base with trailing slash and requires explicit model", () => {
    vi.stubEnv("LLM_BASE_URL", "https://api.anthropic.com/v1/");
    expect(isIntelligenceConfigured()).toBe(true);
    vi.stubEnv("LLM_MODEL", "");
    expect(isIntelligenceConfigured()).toBe(false);
    expect(() => createDesignIntelligence()).toThrow("explicit LLM_MODEL");
  });

  it("keeps feedback immutable and converts base64 image evidence to native blocks", async () => {
    const fetch = transport(body(plan));
    const parentImageUrl = "data:image/png;base64,aGVsbG8=";
    const result = await createDesignIntelligence({ fetch }).planRevision({ spec, feedback: "Kulakları küçült, yüzü koru", parentImageUrl });
    expect(result.requestedChange).toBe("Kulakları küçült, yüzü koru");
    expect(requestBody(fetch).messages.at(-1).content).toEqual([
      { type: "text", text: "Parent revision to preserve except for requested changes" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves parent, reference and candidate image order using safe URL or data sources", async () => {
    const fetch = transport(body(critique));
    const result = await createDesignIntelligence({ fetch }).critiqueVisual({ spec, referenceImageUrl: "https://v3.fal.media/reference.png", parentImageUrl: "data:image/jpeg;base64,aGVsbG8=", candidateImageUrl: "data:image/webp;base64,d29ybGQ=", requestedChange: "Smaller ears" });
    expect(result).toEqual(critique);
    expect(result).not.toHaveProperty("score");
    const images = requestBody(fetch).messages.slice(1).map((message: {content: {type: string; source: unknown}[]}) => message.content.find((part) => part.type === "image")!.source);
    expect(images).toEqual([{ type: "url", url: "https://v3.fal.media/reference.png" }, { type: "base64", media_type: "image/jpeg", data: "aGVsbG8=" }, { type: "base64", media_type: "image/webp", data: "d29ybGQ=" }]);
  });

  it.each(["refusal", "max_tokens", "pause_turn", "model_context_window_exceeded"])("records receipt before rejecting native stop_reason %s without a retry", async (stop_reason) => {
    const fetch = transport({ ...body(spec), stop_reason }); const onResponse = vi.fn();
    await expect(createDesignIntelligence({ fetch, onResponse }).designSpec({ description: "A cat" })).rejects.toMatchObject({ kind: "invalid_result" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ responseId: "msg_received", inputTokens: 150, outputTokens: 60 }));
  });

  it.each(["invalid JSON", "schema violation", "additional property"])("records receipt and applies full original validation to %s", async (kind) => {
    const data = body(spec);
    if (kind === "invalid JSON") data.content[1] = { type: "text", text: "not JSON" };
    if (kind === "schema violation") data.content[1] = { type: "text", text: JSON.stringify({ ...spec, targetHeightMm: -1 }) };
    if (kind === "additional property") data.content[1] = { type: "text", text: JSON.stringify({ ...spec, printCertified: true }) };
    const fetch = transport(data); const onResponse = vi.fn();
    await expect(createDesignIntelligence({ fetch, onResponse }).designSpec({ description: "A cat" })).rejects.toMatchObject({ kind: "invalid_result" });
    expect(onResponse).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("records the HTTP request id even for a malformed JSON envelope", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("not JSON", { headers: { "request-id": "req_bad_envelope" } }));
    const onResponse = vi.fn();
    await expect(createDesignIntelligence({ fetch, onResponse }).designSpec({ description: "A cat" })).rejects.toMatchObject({ kind: "invalid_result" });
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ requestId: "req_bad_envelope", responseId: null, model, inputTokens: null }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 429, 408, 503])("sanitizes HTTP %s errors and never retries or falls back", async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(received({ type: "error", error: { message: "sk-ant-mock-secret sensitive provider details" } }, status));
    const onResponse = vi.fn();
    await expect(createDesignIntelligence({ fetch, onResponse }).designSpec({ description: "A cat" })).rejects.toMatchObject({ kind: status === 401 ? "configuration" : status === 429 ? "provider_failure" : "transport", httpStatus: status });
    expect(fetch).toHaveBeenCalledTimes(1); expect(onResponse).toHaveBeenCalledTimes(1);
  });

  it.each(["empty", "oversized", "unreadable"])("keeps an HTTP 401 definitive even with an %s error body", async (kind) => {
    const stream = new ReadableStream({ start(controller) { controller.error(new Error("unreadable provider details")); } });
    const response = kind === "unreadable" ? new Response(stream, { status: 401, headers: { "request-id": "req_rejected" } })
      : new Response(kind === "empty" ? null : "untrusted error details", { status: 401, headers: { "request-id": "req_rejected", "content-length": kind === "oversized" ? "99999999" : "0" } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response); const onResponse = vi.fn();
    await expect(createDesignIntelligence({ fetch, onResponse }).designSpec({ description: "A cat" })).rejects.toMatchObject({ kind: "configuration", httpStatus: 401 });
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ requestId: "req_rejected", responseId: null, inputTokens: null }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry an uncertain fetch failure or expose its message", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("sk-ant-mock-secret provider detail"));
    const onResponse = vi.fn();
    await expect(createDesignIntelligence({ fetch, onResponse }).designSpec({ description: "A cat" })).rejects.toMatchObject({ kind: "transport", message: expect.not.stringContaining("sk-ant-") });
    expect(fetch).toHaveBeenCalledTimes(1); expect(onResponse).not.toHaveBeenCalled();
  });

  it("validates unsafe image inputs before any paid POST", async () => {
    const fetch = transport();
    await expect(createDesignIntelligence({ fetch }).critiqueVisual({ spec, candidateImageUrl: "https://127.0.0.1/private" })).rejects.toMatchObject({ kind: "unsafe_url" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects oversized encoded images before billing instead of relying on the broader upload limit", async () => {
    const fetch = transport();
    await expect(createDesignIntelligence({ fetch }).critiqueVisual({ spec, candidateImageUrl: `data:image/png;base64,${"A".repeat(10_000_004)}` })).rejects.toMatchObject({ kind: "asset_too_large" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an oversized aggregate request before billing", async () => {
    const fetch = transport();
    const image = { type: "input_image" as const, image_url: `data:image/png;base64,${"A".repeat(8_000_000)}`, detail: "auto" as const };
    await expect(createAnthropicMessage({ apiKey: "mock-key", model, schema: { type: "object", additionalProperties: false }, messages: [{ role: "user", content: [image, image, image, image] }], fetch })).rejects.toMatchObject({ kind: "asset_too_large" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops if durable receipt persistence fails without replaying the request", async () => {
    const fetch = transport(); const onResponse = vi.fn().mockRejectedValue(new Error("checkpoint failed"));
    await expect(createDesignIntelligence({ fetch, onResponse }).designSpec({ description: "A cat" })).rejects.toThrow("checkpoint failed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("transforms nested unsupported constraints without mutating their original schema", () => {
    const original = { type: "object", properties: { values: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } } }, required: ["values"], additionalProperties: false };
    const saved = structuredClone(original);
    const transformed = anthropicJsonSchema(original);
    expect(original).toEqual(saved);
    expect(transformed).toMatchObject({ properties: { values: { type: "array", minItems: 1, description: expect.stringContaining("maxItems"), items: { type: "string", description: expect.stringContaining("minLength") } } } });
    expect(JSON.stringify(transformed)).not.toContain('"maxItems":20,"items"');
  });
});
