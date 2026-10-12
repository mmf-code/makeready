import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  ApiErrorSchema, NotChecked,
  type DecisionInput, type DesignSession, type ExecutePlanInput, type GenerateModelInput,
  type GenerationJob, type HumanDecision, type MakePackageResult, type PlanRevisionInput,
  type RevisionPlan, type StartDesignInput, type StartDesignResult,
} from "../contracts";
import {
  McpApplyRefinementInputSchema, McpDecideRevisionInputSchema, McpGenerateModelInputSchema,
  McpGetDesignInputSchema, McpGetPackageInputSchema, McpPlanRefinementInputSchema,
  McpStartDesignInputSchema, McpToolOutputSchemas,
} from "../contracts/mcp";
import { getViewToolMetadata, registerViewResource, type ViewResourceOptions } from "./resource";
import { downloadMcpPhoto, type VerifiedMcpPhoto } from "./files";
import { AppError } from "../errors";

/** The same application service interface used by REST. No MCP-specific state. */
export interface MakeReadyMcpServices {
  startDesign(input: StartDesignInput): Promise<StartDesignResult>;
  startPhotoDesign?(input: StartDesignInput, image: VerifiedMcpPhoto): Promise<StartDesignResult>;
  getSession(sessionId: string): Promise<DesignSession>;
  planRevision(input: PlanRevisionInput): Promise<RevisionPlan>;
  executePlan(input: ExecutePlanInput): Promise<GenerationJob>;
  decideRevision(input: DecisionInput): Promise<HumanDecision>;
  generateModel(input: GenerateModelInput): Promise<GenerationJob>;
  getMakePackage(revisionId: string): Promise<MakePackageResult>;
}

const notChecked = [
  ...NotChecked,
  "regional_feature_measurements",
  "printability_certification",
];

export function createMakeReadyMcpServer(services: MakeReadyMcpServices, options: ViewResourceOptions = {}): McpServer {
  const server = new McpServer({ name: "MakeReady", version: "0.1.0" }, {
    instructions: "Design, Critique, Refine, Make. Show the saved change/preserve/action/reason plan before applying it. Paid operations require explicit confirmation and a stable idempotencyKey. A submission_unknown job must never be automatically resubmitted. Poll with get_design. Separate visual, physical, and human evaluations; never claim printability certification or regional measurements. Approve exact revisions before generate_model.",
  });
  const ui = getViewToolMetadata();

  function register<Input, Output>(
    name: string,
    title: string,
    description: string,
    inputSchema: z.ZodType<Input>,
    outputSchema: z.ZodType<{ result: Output; notChecked: string[] }>,
    action: (input: Input) => Promise<Output>,
    annotations: { readOnlyHint: boolean; openWorldHint: boolean; idempotentHint?: boolean },
  ) {
    server.registerTool(name, {
      title, description, inputSchema, outputSchema,
      annotations: { idempotentHint: true, ...annotations, destructiveHint: false },
      _meta: {
        ...ui,
        ...(name === "start_design" ? { "openai/fileParams": ["photo"] } : {}),
        "openai/toolInvocation/invoking": `MakeReady: ${title}`,
        "openai/toolInvocation/invoked": `${title} ready`,
      },
    }, async (input): Promise<CallToolResult> => {
      try {
        const result = await action(input);
        const resultNotChecked = typeof result === "object" && result !== null && "notChecked" in result && Array.isArray(result.notChecked)
          ? result.notChecked.filter((value): value is string => typeof value === "string") : [];
        const structuredContent = outputSchema.parse({ result, notChecked: [...new Set([...notChecked, ...resultNotChecked])] });
        return {
          structuredContent,
          _meta: { "makeready/appUrl": options.appUrl ?? null },
          content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        };
      } catch (cause) {
        const parsed = ApiErrorSchema.safeParse(cause);
        const error = parsed.success ? parsed.data : {
          code: "INTERNAL_ERROR" as const,
          message: "MakeReady could not complete this request. Inspect the existing job before repeating paid work.",
          retryable: false,
        };
        return {
          isError: true,
          structuredContent: { error, notChecked },
          content: [{ type: "text", text: JSON.stringify({ error, notChecked }) }],
        };
      }
    });
  }

  register("start_design", "Start design",
    "Create a session from a user photo or text. Pass an attached photo in photo; it is downloaded, fully decoded, and persisted as the real source image. Without photo, creates a paid concept generation job from text. Only call with confirm_cost:true after cost approval; reuse the same idempotencyKey when retrying. Returns a durable job, not an invented completed revision.",
    McpStartDesignInputSchema, McpToolOutputSchemas.start_design,
    async ({ confirm_cost, photo, ...input }) => {
      const start = { ...input, confirmCost: confirm_cost };
      if (!photo) return services.startDesign(start);
      if (!services.startPhotoDesign) throw new AppError("PROVIDER_UNAVAILABLE", "Photo ingestion is not configured. Use the MakeReady web upload or start from text.", 503);
      return services.startPhotoDesign(start, await downloadMcpPhoto(photo));
    },
    { readOnlyHint: false, openWorldHint: true });

  register("get_design", "Get design",
    "Read the complete saved session tree including jobs, revisions, plans, evaluations, comparisons, and human decisions. Use for polling. This never submits generation or advances jobs.",
    McpGetDesignInputSchema, McpToolOutputSchemas.get_design,
    ({ sessionId }) => services.getSession(sessionId),
    { readOnlyHint: true, openWorldHint: false });

  register("plan_refinement", "Plan refinement",
    "Interpret feedback and save a change/preserve/action/reason plan. Makes a paid request to the configured LLM, but does not execute image editing or 3D generation. Display this exact plan before apply_refinement. Requires confirm_cost:true and a stable idempotencyKey.",
    McpPlanRefinementInputSchema, McpToolOutputSchemas.plan_refinement,
    ({ confirm_cost, ...input }) => services.planRevision({ ...input, confirmCost: confirm_cost }),
    { readOnlyHint: false, openWorldHint: true });

  register("apply_refinement", "Apply refinement",
    "Execute the previously displayed saved plan without replanning. Costs money when generation is required. Preserves the parent revision and returns a durable child job. Requires confirm_cost:true and a stable idempotencyKey.",
    McpApplyRefinementInputSchema, McpToolOutputSchemas.apply_refinement,
    ({ confirm_cost, ...input }) => services.executePlan({ ...input, confirmCost: confirm_cost }),
    { readOnlyHint: false, openWorldHint: true });

  register("decide_revision", "Decide revision",
    "Append a human approval or rejection for one completed revision and its exact artifact hashes. Does not mutate or delete the revision. Approval does not transfer automatically to a child.",
    McpDecideRevisionInputSchema, McpToolOutputSchemas.decide_revision,
    (input) => services.decideRevision(input),
    { readOnlyHint: false, openWorldHint: false, idempotentHint: false });

  register("generate_model", "Generate model",
    "Generate a real textured GLB and measured manufacturing package from an approved concept revision. Optional provider: fal (default Hunyuan3D v3) or meshy (fixed Meshy 7.1). Costs money. Returns a durable job; server preparation continues without a browser. Requires confirm_cost:true and a stable idempotencyKey. No automatic provider fallback. Physical checks do not certify printability.",
    McpGenerateModelInputSchema, McpToolOutputSchemas.generate_model,
    ({ confirm_cost, ...input }) => services.generateModel({ ...input, confirmCost: confirm_cost }),
    { readOnlyHint: false, openWorldHint: true });

  register("get_make_package", "Get Make Package",
    "Read the server audit and a short-lived ZIP download link for a completed manufacturing revision. GLB retains materials/textures in meters/Y-up; STL is geometry in millimeters/Z-up. Lists checks that were not performed.",
    McpGetPackageInputSchema, McpToolOutputSchemas.get_make_package,
    ({ revisionId }) => services.getMakePackage(revisionId),
    { readOnlyHint: true, openWorldHint: false });

  registerViewResource(server, options);
  return server;
}
