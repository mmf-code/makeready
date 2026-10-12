"use client";

import { useState } from "react";
import { NotChecked, type DesignSession, type GenerationJob, type PhysicalAudit, type Revision } from "@/lib/contracts";
import {
  exampleArtifact, exampleAudit, exampleDecision, exampleEvaluations, exampleJobs, examplePlan, exampleSession, exampleV1, exampleV2,
} from "@/lib/contracts/fixtures";
import { McpView } from "../mcp-view/cards";
import type { ActionHandler, ViewModel, ViewToolName } from "../mcp-view/format";

/* Example data for one run, shaped exactly like real tool results. */

const at = (m: number) => `2026-10-12T08:${String(m).padStart(2, "0")}:00.000Z`;

/** A drawn example concept, not a generated one. */
function catImage(ears: "tall" | "short"): string {
  const earL = ears === "tall" ? "78,74 84,14 112,52" : "82,68 90,40 110,54";
  const earR = ears === "tall" ? "162,74 156,14 128,52" : "158,68 150,40 130,54";
  const inL = ears === "tall" ? "86,64 89,30 104,52" : "88,62 93,48 104,55";
  const inR = ears === "tall" ? "154,64 151,30 136,52" : "152,62 147,48 136,55";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><ellipse cx="120" cy="214" rx="58" ry="9" fill="#000" opacity=".35"/><path d="M166 196c26-6 34-30 22-46" fill="none" stroke="#d9cdb8" stroke-width="12" stroke-linecap="round"/><path d="M78 212c-10-48 6-92 42-94 36 2 52 46 42 94z" fill="#efe6d6"/><path d="M120 118c36 2 52 46 42 94h-20c6-40-2-78-22-94z" fill="#d9cdb8"/><polygon points="${earL}" fill="#efe6d6"/><polygon points="${earR}" fill="#e2d7c4"/><polygon points="${inL}" fill="#f2b8b0"/><polygon points="${inR}" fill="#e9a79e"/><circle cx="120" cy="92" r="46" fill="#efe6d6"/><path d="M120 46a46 46 0 0 1 0 92c18-14 26-60 0-92z" fill="#e2d7c4"/><circle cx="103" cy="92" r="5.5" fill="#1d1d1f"/><circle cx="137" cy="92" r="5.5" fill="#1d1d1f"/><circle cx="105" cy="90" r="1.8" fill="#fff"/><circle cx="139" cy="90" r="1.8" fill="#fff"/><path d="M115 104h10l-5 6z" fill="#e58f8a"/><path d="M112 114q8 6 16 0" fill="none" stroke="#1d1d1f" stroke-width="2" stroke-linecap="round"/><rect x="82" y="130" width="76" height="16" rx="8" fill="#d8342c"/><path d="M140 140l10 34 14-6-12-30z" fill="#b8271f"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const spec = { ...exampleSession.spec, description: "Cat figurine with a red scarf", objectType: "cat figurine", preserve: ["Face", "Scarf", "Pose"], changeable: ["Ear size"] };
const image = (id: string, url: string, sha: string) => ({ ...exampleArtifact, id, url, sha256: sha.repeat(64) });
const v1: Revision = { ...exampleV1, spec, createdAt: at(1), artifacts: [image(exampleArtifact.id, catImage("tall"), "a")] };
const v2: Revision = { ...exampleV2, spec, createdAt: at(4), artifacts: [image(exampleV2.artifacts[0].id, catImage("short"), "b")] };
const v3: Revision = {
  ...exampleV2, id: "00000000-0000-4000-8000-000000000030", parentRevisionId: v2.id, kind: "manufacturing", spec, createdAt: at(9),
  artifacts: (["model_glb", "model_stl", "audit"] as const).map((kind, i) => ({ ...exampleArtifact, id: `00000000-0000-4000-8000-00000000003${i + 1}`, kind, sha256: "c".repeat(64) })),
};
function job(status: GenerationJob["status"], patch: Partial<GenerationJob>): GenerationJob {
  return { ...(exampleJobs.find((j) => j.status === status) ?? exampleJobs[0]), ...patch };
}
const conceptJob = job("completed", { operation: "concept", parentRevisionId: null, planId: null, estimatedCostUsd: 0.04, updatedAt: at(1) });
const audit: PhysicalAudit = { ...exampleAudit, measuredBoundsMm: { width: 71.4, height: 120, depth: 58.2, min: [-35.7, 0, -29.1], max: [35.7, 120, 29.1] } };
const visual = { ...exampleEvaluations[0], revisionId: v2.id, summary: "Ears are shorter. Face, scarf and pose look the same.", limitations: [] };
const physical = { ...exampleEvaluations[1], revisionId: v3.id, audit };
const decision = { ...exampleDecision, revisionId: v2.id, note: "Ears look right now.", artifactHashes: v2.artifacts.map((a) => a.sha256), createdAt: at(6) };
const base: DesignSession = { ...exampleSession, title: "Pamuk, cat figurine", spec, plans: [], comparisons: [], evaluations: [], decisions: [], updatedAt: at(1) };
const plan = {
  ...examplePlan, parentRevisionId: v1.id, estimatedCostUsd: 0.04,
  requestedChange: "Make the ears smaller, keep the face",
  interpretedIntent: "Smaller ears, everything else as it is",
  preserve: ["Face", "Scarf", "Colors", "Pose"],
  reason: "Ear size is a look change, so editing the concept image is cheaper than a new 3D model.",
  expectedDifferences: ["Shorter ears", "Same face and scarf"],
};

type Line = { from: "user" | "assistant" | "event"; text: string };
interface Step { tool: ViewToolName; cost: string; lines: Line[]; model: ViewModel }

const STEPS: Step[] = [
  {
    tool: "start_design", cost: "Paid, asked first",
    lines: [
      { from: "user", text: "Make a 12 cm figurine of my cat Pamuk. Keep her red scarf." },
      { from: "assistant", text: "Drawing the first concept costs about $0.04. Should I start?" },
      { from: "user", text: "Yes." },
    ],
    model: { kind: "start_design", result: { sessionId: base.id, job: job("queued", { operation: "concept", parentRevisionId: null, planId: null, estimatedCostUsd: 0.04 }) } },
  },
  { tool: "get_design", cost: "Read only", lines: [{ from: "assistant", text: "Concept v1 is ready." }], model: { kind: "get_design", result: { ...base, revisions: [v1], jobs: [conceptJob] } } },
  {
    tool: "plan_refinement", cost: "Paid, small",
    lines: [
      { from: "user", text: "The ears are too big. Make them smaller but keep the face." },
      { from: "assistant", text: "Here is the change order. Nothing has run yet." },
    ],
    model: { kind: "plan_refinement", result: plan },
  },
  { tool: "apply_refinement", cost: "Paid", lines: [{ from: "event", text: "You tapped Apply change order." }], model: { kind: "job", tool: "apply_refinement", result: job("running", { operation: "refinement", progress: 40, estimatedCostUsd: 0.04 }) } },
  {
    tool: "get_design", cost: "Read only",
    lines: [{ from: "assistant", text: "v2 is ready. The visual inspector says the ears are shorter and the face looks the same." }],
    model: { kind: "get_design", result: { ...base, revisions: [v1, v2], jobs: [conceptJob], plans: [plan], evaluations: [visual], updatedAt: at(5) } },
  },
  { tool: "decide_revision", cost: "Free", lines: [{ from: "event", text: "You tapped Approve v2." }], model: { kind: "decide_revision", result: decision } },
  {
    tool: "generate_model", cost: "Paid, asked first",
    lines: [
      { from: "assistant", text: "Building the 3D model reserves up to $5.00. Go ahead?" },
      { from: "user", text: "Go." },
    ],
    model: { kind: "job", tool: "generate_model", result: job("verifying", { operation: "model", parentRevisionId: v2.id, planId: null, estimatedCostUsd: 5 }) },
  },
  {
    tool: "get_design", cost: "Read only",
    lines: [{ from: "assistant", text: "The model is 120.0 mm tall. One check failed: 3 open edges." }],
    model: { kind: "get_design", result: { ...base, revisions: [v1, v2, v3], jobs: [conceptJob], plans: [plan], evaluations: [visual, physical], decisions: [decision], updatedAt: at(10) } },
  },
  {
    tool: "get_make_package", cost: "Read only",
    lines: [{ from: "event", text: "You tapped Get make package." }],
    model: {
      kind: "get_make_package",
      result: { revisionId: v3.id, audit, artifact: { ...exampleArtifact, kind: "make_package", mimeType: "application/zip" }, downloadUrl: "https://makeready.example/package.zip", expiresAt: "2026-10-12T09:10:00.000Z", notChecked: audit.notChecked },
    },
  },
];
const notChecked = [...NotChecked, "regional_feature_measurements", "printability_certification"];

/** The real in-chat card stepping through one example run. Yellow card buttons and the arrows move the run. */
export function ChatPreview() {
  const [index, setIndex] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const step = STEPS[index];
  const last = index === STEPS.length - 1;

  function go(next: number) {
    setNote(null);
    setIndex(Math.max(0, Math.min(STEPS.length - 1, next)));
  }

  const onAction: ActionHandler = async (action) => {
    if (action.type === "call") {
      const next = STEPS[index + 1];
      go(index + 1);
      if (next && next.tool !== action.name) setNote("In this example the person asks for a change instead.");
      return;
    }
    setNote("Example data. In ChatGPT this opens the make package link, which expires after a short time.");
  };

  return (
    <figure className="m-0 flex flex-col gap-3 rounded-[22px] bg-white p-4 text-[#1f1f1f] shadow-[0_24px_60px_rgba(0,0,0,0.35)] sm:p-5" aria-label="Example run in a chat">
      <div className="flex min-h-[44px] flex-col gap-3" aria-live="polite">
        {step.lines.map((line) => (
          line.from === "user" ? (
            <p key={line.text} className="m-0 ml-auto max-w-[80%] rounded-[20px] bg-[#f1f1f1] px-4 py-2.5 text-[15px]">{line.text}</p>
          ) : line.from === "assistant" ? (
            <p key={line.text} className="m-0 text-[15px]">{line.text}</p>
          ) : (
            <p key={line.text} className="m-0 text-[13px] text-[#6b6b6b]">{line.text}</p>
          )
        ))}
        <p className="m-0 flex flex-wrap items-center gap-2 text-[13px] text-[#6b6b6b]">
          Called <code className="font-mono text-[#1f1f1f]">{step.tool}</code>
          <span className={`rounded-[5px] px-1.5 text-[12px] font-bold ${step.cost.startsWith("Paid") ? "bg-tape text-black" : "border border-[#d6d6d6] text-[#1f1f1f]"}`}>{step.cost}</span>
        </p>
      </div>
      <div className="rounded-[18px] border border-[#e3e3e3]">
        <McpView model={step.model} notChecked={notChecked} appUrl={null} theme="light" onAction={onAction} />
      </div>
      {note ? <p className="m-0 text-[13px] text-[#6b6b6b]" role="status">{note}</p> : null}
      <div className="flex items-center gap-2 border-t border-[#e3e3e3] pt-3">
        <button type="button" onClick={() => go(index - 1)} disabled={index === 0}
          className="inline-flex min-h-11 items-center rounded-full border-[1.5px] border-[#1f1f1f] px-4 text-[14px] font-bold disabled:cursor-not-allowed disabled:opacity-35">
          Back
        </button>
        <span className="flex-1 text-center text-[13px] tabular-nums text-[#6b6b6b]">Tool call {index + 1} of {STEPS.length}</span>
        <button type="button" onClick={() => go(last ? 0 : index + 1)}
          className="inline-flex min-h-11 items-center rounded-full border-[1.5px] border-black bg-tape px-4 text-[14px] font-extrabold text-black">
          {last ? "Start over" : "Next tool call"}
        </button>
      </div>
      <figcaption className="text-[12.5px] text-[#6b6b6b]">The real in-chat card with example data. The concept images are drawn examples.</figcaption>
    </figure>
  );
}
