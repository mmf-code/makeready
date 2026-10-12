import { describe, expect, it, vi } from "vitest";
import { createDesignIntelligence, INTELLIGENCE_MODEL, type DesignSpecDraft, type IntelligenceResponseMetadata } from "@/lib/providers/openai";

const spec: DesignSpecDraft = { description: "A friendly cat", objectType: "figurine", use: "desk decoration", targetHeightMm: 120, preserve: ["face", "clothing"], changeable: ["ears"], process: "resin_candidate" };
const response = (data: unknown) => ({ id: "resp_123", _request_id: "req_123", model: INTELLIGENCE_MODEL, status: "completed", output_text: JSON.stringify(data), output: [], usage: { input_tokens: 150, output_tokens: 100, total_tokens: 250, input_tokens_details: { cached_tokens: 20 } } });

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
});
