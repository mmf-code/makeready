import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const sdk = vi.hoisted(() => ({ constructor: vi.fn(), responses: vi.fn(), chat: vi.fn() }));
vi.mock("openai", () => ({ default: class MockOpenAI {
  responses = { create: sdk.responses };
  chat = { completions: { create: sdk.chat } };
  constructor(options: unknown) { sdk.constructor(options); }
} }));
import { createDesignIntelligence, intelligenceModel, intelligenceProvider, isIntelligenceConfigured, INTELLIGENCE_MODEL, type DesignSpecDraft, type IntelligenceResponseMetadata } from "@/lib/providers/openai";

const spec: DesignSpecDraft = { description: "A friendly cat", objectType: "figurine", use: "desk decoration", targetHeightMm: 120, preserve: ["face", "clothing"], changeable: ["ears"], process: "resin_candidate" };
const response = (data: unknown) => ({ id: "resp_123", _request_id: "req_123", model: INTELLIGENCE_MODEL, status: "completed", output_text: JSON.stringify(data), output: [], usage: { input_tokens: 150, output_tokens: 100, total_tokens: 250, input_tokens_details: { cached_tokens: 20 } } });
const chatResponse = (data: unknown) => ({ id: "chatcmpl_123", _request_id: "req_chat", model: "compatible-vision-model", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(data), refusal: null as string | null } }], usage: { prompt_tokens: 200, completion_tokens: 90, total_tokens: 290, prompt_tokens_details: { cached_tokens: 30 } } });

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ["LLM_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_STYLE"]) vi.stubEnv(key, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("bounded design intelligence", () => {
  it("uses strict Responses output, preserves explicit dimensions, and exposes billed usage", async () => {
    const createResponse = vi.fn().mockResolvedValue(response({ ...spec, targetHeightMm: 80 }));
    const onResponse = vi.fn<(metadata: IntelligenceResponseMetadata) => void>();
    const result = await createDesignIntelligence({ createResponse, onResponse }).designSpec({ description: "Friendly cat 120 mm tall", targetHeightMm: 120 });
    expect(result.targetHeightMm).toBe(120);
    expect(createResponse).toHaveBeenCalledTimes(1);
    expect(createResponse.mock.calls[0][0]).toMatchObject({ model: INTELLIGENCE_MODEL, store: false, text: { format: { type: "json_schema", strict: true, name: "makeready_design_spec" } } });
    expect(onResponse).toHaveBeenCalledWith({ operation: "design_spec", responseId: "resp_123", requestId: "req_123", model: INTELLIGENCE_MODEL, inputTokens: 150, cachedInputTokens: 20, outputTokens: 100, totalTokens: 250 });
  });

  it("does not repair or retry an invalid or incomplete paid answer and records its usage", async () => {
    const createResponse = vi.fn().mockResolvedValue({ ...response({}), status: "incomplete" });
    const onResponse = vi.fn();
    await expect(createDesignIntelligence({ createResponse, onResponse }).designSpec({ description: "A cat" })).rejects.toMatchObject({ kind: "invalid_result" });
    expect(createResponse).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledTimes(1);
  });

  it("keeps original human feedback and the requested preserved features in a separate draft", async () => {
    const original = structuredClone(spec);
    const createResponse = vi.fn().mockResolvedValue(response({ requestedChange: "paraphrased", interpretedIntent: "Reduce ears", preserve: ["face", "clothing"], action: "edit_concept", reason: "Appearance refinement", expectedDifferences: ["Smaller ears"], targetHeightMm: null }));
    const feedback = "Kulakları küçült, yüzü ve kıyafetleri koru";
    const plan = await createDesignIntelligence({ createResponse }).planRevision({ spec, feedback, parentImageUrl: "https://v3.fal.media/parent.png" });
    expect(plan.requestedChange).toBe(feedback);
    expect(plan.preserve).toEqual(["face", "clothing"]);
    expect(spec).toEqual(original);
    expect(plan).not.toHaveProperty("id");
    expect(createResponse.mock.calls[0][0].input).toEqual(expect.arrayContaining([expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ type: "input_image", image_url: "https://v3.fal.media/parent.png" })]) })]));
  });

  it("refuses a geometry scale plan without a measurable target", async () => {
    const createResponse = vi.fn().mockResolvedValue(response({ requestedChange: "Make bigger", interpretedIntent: "Increase height", preserve: [], action: "scale_geometry", reason: "Requested size", expectedDifferences: ["Larger"], targetHeightMm: null }));
    await expect(createDesignIntelligence({ createResponse }).planRevision({ spec, feedback: "Make bigger" })).rejects.toThrow("dimensions");
    expect(createResponse).toHaveBeenCalledTimes(1);
  });

  it("does not turn a refusal into a successful design", async () => {
    const createResponse = vi.fn().mockResolvedValue({ ...response(spec), output: [{ type: "message", content: [{ type: "refusal", refusal: "Unable" }] }] });
    await expect(createDesignIntelligence({ createResponse }).designSpec({ description: "A cat" })).rejects.toMatchObject({ kind: "invalid_result" });
  });

  it("keeps a visual critique separate from physical certification", async () => {
    const critique = { summary: "Ears are smaller, expression is retained", alignment: "partially_aligned", observations: [{ criterion: "ears", finding: "Smaller ears visible", status: "met" }], preserveObserved: ["expression"], suggestedChanges: [], limitations: ["Images cannot verify mesh integrity or printability"] };
    const createResponse = vi.fn().mockResolvedValue(response(critique));
    const result = await createDesignIntelligence({ createResponse }).critiqueVisual({ spec, candidateImageUrl: "https://v3.fal.media/child.png", parentImageUrl: "https://v3.fal.media/parent.png", requestedChange: "Smaller ears" });
    expect(result).toEqual(critique);
    expect(result).not.toHaveProperty("score");
    expect(result).not.toHaveProperty("physical");
    expect(createResponse.mock.calls[0][0].input[0].content).toContain("Human approval remains separate");
  });

  it("keeps the default OpenAI Responses transport and disables SDK retries", async () => {
    vi.stubEnv("OPENAI_API_KEY", "mock-openai-key");
    sdk.responses.mockResolvedValue(response(spec));
    await createDesignIntelligence().designSpec({ description: "A cat" });
    expect(sdk.constructor).toHaveBeenCalledWith({ apiKey: "mock-openai-key", baseURL: undefined, maxRetries: 0, timeout: 45000 });
    expect(sdk.responses).toHaveBeenCalledTimes(1); expect(sdk.chat).not.toHaveBeenCalled();
    expect(intelligenceModel()).toBe(INTELLIGENCE_MODEL); expect(isIntelligenceConfigured()).toBe(true);
    expect(intelligenceProvider()).toBe("openai");
  });

  it("uses the selected compatible endpoint, model and key with chat completions", async () => {
    vi.stubEnv("LLM_API_KEY", "mock-compatible-key"); vi.stubEnv("OPENAI_API_KEY", "unused-openai-key");
    vi.stubEnv("LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai/");
    vi.stubEnv("LLM_MODEL", "compatible-vision-model");
    sdk.chat.mockResolvedValue(chatResponse(spec));
    const onResponse = vi.fn();
    await createDesignIntelligence({ onResponse }).designSpec({ description: "A cat", referenceImageUrl: "https://v3.fal.media/reference.png" });
    expect(sdk.constructor).toHaveBeenCalledWith({ apiKey: "mock-compatible-key", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", maxRetries: 0, timeout: 45000 });
    expect(sdk.chat).toHaveBeenCalledTimes(1); expect(sdk.responses).not.toHaveBeenCalled();
    expect(sdk.chat.mock.calls[0][0]).toMatchObject({ model: "compatible-vision-model", max_tokens: 2500, stream: false, response_format: { type: "json_schema", json_schema: { name: "makeready_design_spec", strict: true } } });
    expect(sdk.chat.mock.calls[0][0].messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: expect.arrayContaining([{ type: "image_url", image_url: { url: "https://v3.fal.media/reference.png", detail: "auto" } }]) })]));
    expect(onResponse).toHaveBeenCalledWith({ operation: "design_spec", responseId: "chatcmpl_123", requestId: "req_chat", model: "compatible-vision-model", inputTokens: 200, cachedInputTokens: 30, outputTokens: 90, totalTokens: 290 });
    expect(intelligenceModel()).toBe("compatible-vision-model");
    expect(intelligenceProvider()).toBeNull();
  });

  it("supports explicit Responses style on a custom compatible endpoint", async () => {
    const createResponse = vi.fn().mockResolvedValue({ ...response(spec), model: "custom-responses-model" });
    const createChatCompletion = vi.fn();
    await createDesignIntelligence({ apiKey: "mock-key", baseURL: "https://compatible.example/v1", model: "custom-responses-model", apiStyle: "responses", createResponse, createChatCompletion }).designSpec({ description: "A cat" });
    expect(createResponse.mock.calls[0][0].model).toBe("custom-responses-model");
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it.each(["invalid-json", "refusal", "length"])("records compatible usage before rejecting %s without retry", async (kind) => {
    const completion = chatResponse(spec);
    if (kind === "invalid-json") completion.choices[0].message.content = "not JSON";
    if (kind === "refusal") completion.choices[0].message.refusal = "Refused";
    if (kind === "length") completion.choices[0].finish_reason = "length";
    const createChatCompletion = vi.fn().mockResolvedValue(completion);
    const createResponse = vi.fn();
    const onResponse = vi.fn();
    await expect(createDesignIntelligence({ apiKey: "mock-key", baseURL: "https://compatible.example/v1", model: "compatible-vision-model", createChatCompletion, createResponse, onResponse }).designSpec({ description: "A cat" })).rejects.toMatchObject({ kind: "invalid_result" });
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ responseId: "chatcmpl_123", inputTokens: 200, outputTokens: 90 }));
    expect(createChatCompletion).toHaveBeenCalledTimes(1); expect(createResponse).not.toHaveBeenCalled();
  });

  it("never falls back to Responses after a compatible provider transport failure", async () => {
    const createChatCompletion = vi.fn().mockRejectedValue(new TypeError("network"));
    const createResponse = vi.fn();
    await expect(createDesignIntelligence({ apiKey: "mock-key", model: "compatible-vision-model", baseURL: "https://compatible.example/v1", createChatCompletion, createResponse }).designSpec({ description: "A cat" })).rejects.toMatchObject({ kind: "transport" });
    expect(createChatCompletion).toHaveBeenCalledTimes(1); expect(createResponse).not.toHaveBeenCalled();
  });

  it.each([401, 429, 408, 503])("distinguishes rejected SDK requests from uncertain HTTP %s outcomes", async (status) => {
    const createResponse = vi.fn().mockRejectedValue({ status });
    await expect(createDesignIntelligence({ createResponse }).designSpec({ description: "A cat" })).rejects.toMatchObject({ kind: status === 401 ? "configuration" : status === 429 ? "provider_failure" : "transport", httpStatus: status });
    expect(createResponse).toHaveBeenCalledTimes(1);
  });

  it("reports missing credentials or invalid configuration without calling a provider", async () => {
    expect(isIntelligenceConfigured()).toBe(false);
    await expect(createDesignIntelligence().designSpec({ description: "A cat" })).rejects.toMatchObject({ kind: "configuration" });
    expect(sdk.constructor).not.toHaveBeenCalled();
    vi.stubEnv("LLM_API_KEY", "mock-key"); vi.stubEnv("LLM_API_STYLE", "invalid-style");
    expect(isIntelligenceConfigured()).toBe(false);
    expect(() => createDesignIntelligence()).toThrow("LLM_API_STYLE");
    expect(sdk.chat).not.toHaveBeenCalled(); expect(sdk.responses).not.toHaveBeenCalled();
  });

  it("does not forward an OpenAI key or default model to an alternative endpoint", () => {
    vi.stubEnv("OPENAI_API_KEY", "unused-openai-key");
    vi.stubEnv("LLM_BASE_URL", "https://compatible.example/v1");
    expect(isIntelligenceConfigured()).toBe(false);
    expect(() => createDesignIntelligence()).toThrow("explicit LLM_API_KEY");
    vi.stubEnv("LLM_API_KEY", "mock-compatible-key");
    expect(isIntelligenceConfigured()).toBe(false);
    expect(() => createDesignIntelligence()).toThrow("explicit LLM_MODEL");
    vi.stubEnv("LLM_MODEL", "compatible-vision-model");
    expect(isIntelligenceConfigured()).toBe(true);
    expect(sdk.constructor).not.toHaveBeenCalled();
  });

  it.each(["", "responses", "chat_completions"])("rejects an Anthropic credential in non-native style %s before any SDK call", (style) => {
    vi.stubEnv("LLM_API_KEY", "sk-ant-mock-secret"); vi.stubEnv("LLM_API_STYLE", style);
    expect(isIntelligenceConfigured()).toBe(false);
    expect(intelligenceProvider()).toBeNull();
    expect(() => createDesignIntelligence()).toThrow("LLM_API_STYLE=anthropic");
    expect(sdk.constructor).not.toHaveBeenCalled();
  });
});
