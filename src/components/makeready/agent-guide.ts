/**
 * The guide for AI agents, as data. /agents renders it for people and agents,
 * /llms.txt serves it as plain text. Inputs mirror src/lib/contracts/mcp.ts.
 */
export interface ToolDoc { name: string; paid: boolean; readOnly: boolean; does: string; input: string; returns: string; when: string }

export const INTRO =
  "MakeReady turns one message about a physical object into a measured 3D model and a make package. Agents plan the work, critique it through change orders and prepare files a maker can print. Every tool result is {result, notChecked}; notChecked lists what MakeReady did not verify.";

export const CONNECT = [
  "MakeReady is a remote MCP server over Streamable HTTP. The server address is private; get it from the person who runs your MakeReady.",
  "In ChatGPT: Settings, Apps & Connectors, turn on developer mode, create a connector named MakeReady with that address, then pick it in a chat.",
  "The same session is visible on the web at /runs/{sessionId}. Tool results carry the web base URL in _meta[\"makeready/appUrl\"].",
];

export const RULES = [
  "Ask the person before any paid tool. Send confirm_cost: true only after they agreed to that step and its cost.",
  "Give every paid call a stable idempotencyKey. If a call fails or times out, retry with the same key; never invent a new key to resend.",
  "If a job is submission_unknown, do not start another generation. Read it again with get_design and tell the person.",
  "Concept images have no real size. Only manufacturing revisions are measured, and only in millimeters after scaling.",
  "Read notChecked on every result and tell the person what was not verified. Never call a model print-ready.",
  "Approvals are per revision and per file. A new revision needs its own approval before generate_model.",
  "Makers in this demo are sandbox agents. Do not tell anyone their object has been printed or shipped.",
];

export const TOOLS: ToolDoc[] = [
  { name: "start_design", paid: true, readOnly: false, does: "Opens a session and makes concept v1 from a message and an optional photo.",
    input: "{ prompt: string, heightMm?: number = 120, use?: string, photo?: { download_url, file_id, mime_type?, file_name? }, confirm_cost: true, idempotencyKey: string }",
    returns: "{ sessionId, job }", when: "The person describes something they want made." },
  { name: "get_design", paid: false, readOnly: true, does: "Reads the whole session: versions, jobs, change orders, checks and decisions.",
    input: "{ sessionId: uuid }", returns: "DesignSession", when: "To follow progress, after any paid call, and before deciding the next step." },
  { name: "plan_refinement", paid: true, readOnly: false, does: "Turns feedback into a change order: what changes, what must stay, how and why. Runs nothing else.",
    input: "{ sessionId: uuid, revisionId: uuid, feedback: string, confirm_cost: true, idempotencyKey: string }",
    returns: "RevisionPlan", when: "The person, or your own review, says something about a version should change." },
  { name: "apply_refinement", paid: true, readOnly: false, does: "Runs exactly one saved change order and creates a new version when its files are verified.",
    input: "{ planId: uuid, confirm_cost: true, idempotencyKey: string }", returns: "GenerationJob", when: "The person approved that change order." },
  { name: "decide_revision", paid: false, readOnly: false, does: "Records the person's approval or rejection of one version.",
    input: "{ revisionId: uuid, decision: \"approve\" | \"reject\", note?: string }", returns: "HumanDecision", when: "The person says yes or no to a version." },
  { name: "generate_model", paid: true, readOnly: false, does: "Builds the 3D model from an approved concept, scales it to the height, grounds it and measures it.",
    input: "{ revisionId: uuid, provider?: \"fal\" | \"meshy\", confirm_cost: true, idempotencyKey: string }", returns: "GenerationJob", when: "A concept version is approved." },
  { name: "get_make_package", paid: false, readOnly: true, does: "Returns the measured checks and a short-lived link to the make package.",
    input: "{ revisionId: uuid }", returns: "{ revisionId, audit, artifact, downloadUrl, expiresAt, notChecked }", when: "A manufacturing version exists." },
];

export const FLOW = [
  "start_design with the person's words and photo, after they approve the cost.",
  "get_design until the concept job completes. Show concept v1.",
  "If something is off, plan_refinement with the feedback. Show the change order. apply_refinement only after approval.",
  "decide_revision approve on the version the person accepts, then generate_model after they approve that cost.",
  "get_design until the model is measured. get_make_package and share the download link with what was not checked.",
];

export function llmsText(): string {
  const tool = (t: ToolDoc) => [
    `### ${t.name}${t.paid ? " (paid, ask first)" : t.readOnly ? " (read only)" : ""}`,
    t.does, `When: ${t.when}`, `Input: ${t.input}`, `Returns: ${t.returns}`,
  ].join("\n");
  return [
    "# MakeReady", "", `> ${INTRO}`, "",
    "## Connect", ...CONNECT.map((c) => `- ${c}`), "",
    "## Rules for agents", ...RULES.map((r) => `- ${r}`), "",
    "## A good run", ...FLOW.map((f, i) => `${i + 1}. ${f}`), "",
    "## Tools", "", TOOLS.map(tool).join("\n\n"), "",
    "## Web", "- Live run: /runs/{sessionId}", "- Scripted full run with sandbox makers: /demo", "- This guide for people: /agents", "",
  ].join("\n");
}
