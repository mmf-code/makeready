"use client";

import type { CSSProperties } from "react";
import type { DesignSession, GenerationJob, MakePackageResult, Revision } from "@/lib/contracts";
import { NotChecked } from "@/lib/contracts";
import {
  FIXTURE_LABEL, exampleArtifact, exampleDecision, exampleJobs, examplePlan, exampleAudit, exampleSession, exampleV1, exampleV2,
} from "@/lib/contracts/fixtures";
import { McpView, type ViewTheme } from "./cards";
import type { ActionHandler, ViewModel } from "./format";

/** Same list the MCP server attaches to every structuredContent. */
const notChecked = [...NotChecked, "regional_feature_measurements", "printability_certification"];
const appUrl = "https://makeready.example";
const noop: ActionHandler = async () => {};

function jobWith(status: GenerationJob["status"], patch: Partial<GenerationJob> = {}): GenerationJob {
  const base = exampleJobs.find((job) => job.status === status) ?? exampleJobs[0];
  return { ...base, ...patch };
}

const manufacturingRevision: Revision = { ...exampleV2, kind: "manufacturing" };
const manufacturingSession: DesignSession = {
  ...exampleSession,
  revisions: [exampleV1, manufacturingRevision],
  jobs: exampleSession.jobs.filter((job) => job.status === "completed"),
};
const conceptSession: DesignSession = {
  ...exampleSession,
  jobs: [jobWith("running", { progress: 40 })],
};
const makePackage: MakePackageResult = {
  revisionId: exampleV2.id,
  audit: exampleAudit,
  artifact: { ...exampleArtifact, kind: "make_package", mimeType: "application/zip" },
  downloadUrl: "https://makeready.example/fixture-package.zip",
  expiresAt: "2026-10-12T09:00:00.000Z",
  notChecked: exampleAudit.notChecked,
};

const cases: { label: string; model: ViewModel | null; appUrl?: string | null }[] = [
  { label: "Empty state", model: null },
  { label: "start_design", model: { kind: "start_design", result: { sessionId: exampleSession.id, job: jobWith("queued", { operation: "concept" }) } } },
  { label: "get_design, concept", model: { kind: "get_design", result: conceptSession } },
  { label: "get_design, manufacturing", model: { kind: "get_design", result: manufacturingSession } },
  { label: "plan_refinement", model: { kind: "plan_refinement", result: examplePlan } },
  { label: "apply_refinement, running", model: { kind: "job", tool: "apply_refinement", result: jobWith("running", { progress: 40 }) } },
  { label: "generate_model, checking", model: { kind: "job", tool: "generate_model", result: jobWith("verifying", { operation: "model" }) } },
  { label: "generate_model, submission unknown", model: { kind: "job", tool: "generate_model", result: jobWith("submission_unknown", { operation: "model" }) } },
  { label: "apply_refinement, failed", model: { kind: "job", tool: "apply_refinement", result: jobWith("failed") } },
  { label: "decide_revision, approved", model: { kind: "decide_revision", result: exampleDecision } },
  { label: "decide_revision, not approved, no app URL", model: { kind: "decide_revision", result: { ...exampleDecision, decision: "reject", note: "Ears still too large" } }, appUrl: null },
  { label: "get_make_package", model: { kind: "get_make_package", result: makePackage } },
  { label: "Tool error", model: { kind: "error", error: { code: "BUDGET_EXCEEDED", message: "This run would exceed the $90 budget.", retryable: false } } },
];

const frames: { width: number; theme: ViewTheme }[] = [
  { width: 380, theme: "light" },
  { width: 380, theme: "dark" },
  { width: 720, theme: "light" },
  { width: 720, theme: "dark" },
];

/** Widget frames use the system font stack, as inside the host iframe. */
const frameStyle = (width: number, theme: ViewTheme): CSSProperties => ({
  width,
  maxWidth: "100%",
  flex: "none",
  border: `1px solid ${theme === "dark" ? "#3a3c41" : "#d9d9d6"}`,
  borderRadius: 16,
  overflow: "hidden",
  ["--font-sans" as string]: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
});

export function McpViewPreview() {
  return (
    <main style={{ padding: 16, display: "flex", flexDirection: "column", gap: 32, fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif' }}>
      <p role="status" style={{ padding: "10px 14px", border: "2px solid #000", borderRadius: 8, background: "#ffd400", color: "#000", fontWeight: 600 }}>
        {FIXTURE_LABEL}. MCP View preview: buttons do nothing here.
      </p>
      {cases.map((item) => (
        <section key={item.label} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600 }}>{item.label}</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
            {frames.map((frame) => (
              <div key={`${frame.width}-${frame.theme}`} style={frameStyle(frame.width, frame.theme)} aria-label={`${frame.width}px ${frame.theme}`}>
                <McpView
                  model={item.model}
                  notChecked={notChecked}
                  appUrl={item.appUrl === undefined ? appUrl : item.appUrl}
                  theme={frame.theme}
                  onAction={noop}
                />
              </div>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
