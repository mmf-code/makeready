import { describe, expect, it, vi } from "vitest";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/server";
import {
  exampleAudit, exampleDecision, exampleJobs, examplePlan, exampleSession, exampleV1,
} from "../../src/lib/contracts/fixtures";
import { McpToolOutputSchemas } from "../../src/lib/contracts/mcp";
import { handleMakeReadyMcp } from "../../src/lib/mcp/http";
import type { MakeReadyMcpServices } from "../../src/lib/mcp/server";
import { AppError } from "../../src/lib/errors";
import { accelerateMcpJobs } from "../../src/lib/mcp/execution";

const secret = "x".repeat(48);
const job = exampleJobs.find((item) => item.status === "queued")!;

function services() {
  return {
    startDesign: vi.fn().mockResolvedValue({ sessionId: exampleSession.id, job }),
    getSession: vi.fn().mockResolvedValue(exampleSession),
    planRevision: vi.fn().mockResolvedValue(examplePlan),
    executePlan: vi.fn().mockResolvedValue(job),
    decideRevision: vi.fn().mockResolvedValue(exampleDecision),
    generateModel: vi.fn().mockResolvedValue(job),
    getMakePackage: vi.fn().mockResolvedValue({
      revisionId: exampleV1.id, audit: exampleAudit,
      artifact: { ...exampleV1.artifacts[0], kind: "make_package", mimeType: "application/zip" },
      downloadUrl: "https://storage.example.test/package.zip", expiresAt: "2026-10-12T10:00:00.000Z",
      notChecked: exampleAudit.notChecked,
    }),
  } satisfies MakeReadyMcpServices;
}

async function rpc(service: MakeReadyMcpServices, method: string, params: unknown = {}) {
  const request = new Request(`https://makeready.example.test/api/mcp/${secret}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const response = await handleMakeReadyMcp(request, secret, { secret, createServices: () => service });
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const body = await response.text();
  const json = response.headers.get("Content-Type")?.includes("text/event-stream")
    ? body.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5).trim())).find((value) => value.id === 1)
    : JSON.parse(body);
  expect(json.error).toBeUndefined();
  return json.result as unknown;
}

describe("MakeReady Streamable HTTP MCP", () => {
  it("rejects missing/incorrect secrets before creating a service", async () => {
    const factory = vi.fn(services);
    for (const configured of [undefined, "short", secret]) {
      const response = await handleMakeReadyMcp(new Request("https://example.test/api/mcp/wrong"), "wrong", { secret: configured, createServices: factory });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(secret);
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it("discovers exactly seven tools with honest annotations", async () => {
    const list = await rpc(services(), "tools/list") as ListToolsResult;
    expect(list.tools.map((tool) => tool.name).sort()).toEqual(Object.keys(McpToolOutputSchemas).sort());
    for (const tool of list.tools) {
      expect(tool.annotations?.readOnlyHint).toBe(["get_design", "get_make_package"].includes(tool.name));
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.outputSchema).toBeTruthy();
    }
    expect(list.tools.find((tool) => tool.name === "decide_revision")?.annotations?.idempotentHint).toBe(false);
  });

  it("dispatches typed tools to the shared application service and preserves the saved plan", async () => {
    const service = services();
    const inputs = {
      start_design: { prompt: "A paintable cat", confirm_cost: true, idempotencyKey: "start-key-123" },
      get_design: { sessionId: exampleSession.id },
      plan_refinement: { sessionId: exampleSession.id, revisionId: exampleV1.id, feedback: "Kulakları küçült, yüzü koru", confirm_cost: true, idempotencyKey: "plan-key-123" },
      apply_refinement: { planId: examplePlan.id, confirm_cost: true, idempotencyKey: "apply-key-123" },
      decide_revision: { revisionId: exampleV1.id, decision: "approve" },
      generate_model: { revisionId: exampleV1.id, confirm_cost: true, idempotencyKey: "model-key-123" },
      get_make_package: { revisionId: exampleV1.id },
    };
    for (const name of Object.keys(inputs) as (keyof typeof inputs)[]) {
      const result = await rpc(service, "tools/call", { name, arguments: inputs[name] }) as CallToolResult;
      expect(result.isError).not.toBe(true);
      expect(McpToolOutputSchemas[name].safeParse(result.structuredContent).success).toBe(true);
      expect((result.structuredContent as { notChecked?: string[] } | undefined)?.notChecked).toContain("wall_thickness");
    }
    expect(service.startDesign).toHaveBeenCalledWith(expect.objectContaining({ heightMm: 120, confirmCost: true }));
    expect(service.executePlan).toHaveBeenCalledWith({ planId: examplePlan.id, confirmCost: true, idempotencyKey: "apply-key-123" });
    expect(service.planRevision).toHaveBeenCalledTimes(1);
    expect(service.getSession).toHaveBeenCalledTimes(1);
  });

  it("does not leak unexpected provider error messages or secrets", async () => {
    const service = services();
    service.startDesign.mockRejectedValue(new Error(`Private upstream URL /api/mcp/${secret}`));
    const result = await rpc(service, "tools/call", { name: "start_design", arguments: { prompt: "Cat", confirm_cost: true, idempotencyKey: "error-key-123" } }) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).toContain("INTERNAL_ERROR");
    expect(service.startDesign).toHaveBeenCalledTimes(1);
  });

  it("surfaces the actual application error code without flattening it", async () => {
    const service = services();
    service.startDesign.mockRejectedValue(new AppError("BUDGET_EXCEEDED", "The project budget is exhausted.", 402));
    const result = await rpc(service, "tools/call", { name: "start_design", arguments: { prompt: "Cat", confirm_cost: true, idempotencyKey: "budget-key-123" } }) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "BUDGET_EXCEEDED", message: "The project budget is exhausted.", retryable: false } });
  });

  it("accelerates only job-producing tools and keeps get_design read-only", async () => {
    const service = services();
    const kickJob = vi.fn();
    const accelerated = accelerateMcpJobs(service, kickJob);
    await rpc(accelerated, "tools/call", { name: "get_design", arguments: { sessionId: exampleSession.id } });
    expect(kickJob).not.toHaveBeenCalled();
    await rpc(accelerated, "tools/call", { name: "start_design", arguments: { prompt: "Cat", confirm_cost: true, idempotencyKey: "accelerate-start" } });
    await rpc(accelerated, "tools/call", { name: "apply_refinement", arguments: { planId: examplePlan.id, confirm_cost: true, idempotencyKey: "accelerate-refine" } });
    await rpc(accelerated, "tools/call", { name: "generate_model", arguments: { revisionId: exampleV1.id, confirm_cost: true, idempotencyKey: "accelerate-model" } });
    expect(kickJob).toHaveBeenCalledTimes(3);
    expect(kickJob.mock.calls.every(([id]) => id === job.id)).toBe(true);
  });
});
