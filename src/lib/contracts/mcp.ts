import { z } from "zod";
import { DecisionInputSchema, DesignSessionSchema, GenerationJobSchema, MakePackageResultSchema, RevisionPlanSchema, StartDesignResultSchema, HumanDecisionSchema } from "./index";

const Paid = { confirm_cost: z.literal(true), idempotencyKey: z.string().min(8).max(200) };
export const McpStartDesignInputSchema = z.object({ ...Paid, prompt: z.string().min(1).max(6000), heightMm: z.number().positive().max(2000).default(120), use: z.string().default("Paintable tabletop figurine") });
export const McpGetDesignInputSchema = z.object({ sessionId: z.uuid() });
export const McpPlanRefinementInputSchema = z.object({ ...Paid, sessionId: z.uuid(), revisionId: z.uuid(), feedback: z.string().min(1).max(4000) });
export const McpApplyRefinementInputSchema = z.object({ ...Paid, planId: z.uuid() });
export const McpGenerateModelInputSchema = z.object({ ...Paid, revisionId: z.uuid() });
export const McpGetPackageInputSchema = z.object({ revisionId: z.uuid() });
export const McpDecideRevisionInputSchema = DecisionInputSchema;
export const McpToolOutputSchemas = {
  start_design: z.object({ result: StartDesignResultSchema, notChecked: z.array(z.string()) }),
  get_design: z.object({ result: DesignSessionSchema, notChecked: z.array(z.string()) }),
  plan_refinement: z.object({ result: RevisionPlanSchema, notChecked: z.array(z.string()) }),
  apply_refinement: z.object({ result: GenerationJobSchema, notChecked: z.array(z.string()) }),
  decide_revision: z.object({ result: HumanDecisionSchema, notChecked: z.array(z.string()) }),
  generate_model: z.object({ result: GenerationJobSchema, notChecked: z.array(z.string()) }),
  get_make_package: z.object({ result: MakePackageResultSchema, notChecked: z.array(z.string()) }),
};
export type McpToolName = keyof typeof McpToolOutputSchemas;
