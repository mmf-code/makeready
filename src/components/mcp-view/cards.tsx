import { useState, type ReactNode } from "react";
import { Check, Download, ExternalLink, ImageOff, Lock, RefreshCw, TriangleAlert, CircleAlert, FileBox, Info } from "lucide-react";
import type {
  ApiError, DesignSession, GenerationJob, HumanDecision, MakePackageResult, RevisionPlan, StartDesignResult,
} from "@/lib/contracts";
import {
  JOB_STEPS, actionWords, activeJobOf, checkWords, countChecks, errorHint, expiryTime, jobStepIndex, mm,
  notCheckedSentence, orderedRevisions, physicalAuditFor, runUrl, statusWords, usd, visualSummaryFor,
  type ActionHandler, type ViewAction, type ViewModel,
} from "./format";
import "./mcp-view.css";

export type ViewTheme = "light" | "dark";
type Tone = "foreman" | "tech" | "inspect" | "problem" | "attention";

export interface CardProps<T> {
  result: T;
  notChecked: string[];
  appUrl: string | null;
  onAction: ActionHandler;
}

interface ButtonSpec {
  label: string;
  action: ViewAction;
  primary?: boolean;
  icon?: ReactNode;
}

/* ---------- Root ---------- */

export interface McpViewProps {
  model: ViewModel | null;
  notChecked: string[];
  appUrl: string | null;
  theme: ViewTheme;
  onAction: ActionHandler;
}

/** Pure presentational root. The entry passes App-bridge handlers; the preview passes no-ops. */
export function McpView({ model, notChecked, appUrl, theme, onAction }: McpViewProps) {
  return (
    <div className="mrv" data-theme={theme}>
      <ViewBody key={modelKey(model)} model={model} notChecked={notChecked} appUrl={appUrl} onAction={onAction} />
    </div>
  );
}

function ViewBody({ model, notChecked, appUrl, onAction }: Omit<McpViewProps, "theme">) {
  if (!model) return <WaitingCard />;
  const common = { notChecked, appUrl, onAction };
  switch (model.kind) {
    case "start_design": return <StartDesignCard result={model.result} {...common} />;
    case "get_design": return <DesignCard result={model.result} {...common} />;
    case "plan_refinement": return <ChangeOrderCard result={model.result} {...common} />;
    case "job": return <JobCard result={model.result} tool={model.tool} {...common} />;
    case "decide_revision": return <DecisionCard result={model.result} {...common} />;
    case "get_make_package": return <PackageCard result={model.result} {...common} />;
    case "error": return <ErrorCard result={model.error} notChecked={notChecked} />;
    case "unknown": return <UnknownCard notChecked={notChecked} />;
  }
}

function modelKey(model: ViewModel | null): string {
  if (!model) return "waiting";
  switch (model.kind) {
    case "start_design": return `start-${model.result.job.id}-${model.result.job.status}`;
    case "get_design": return `design-${model.result.id}-${model.result.updatedAt}`;
    case "plan_refinement": return `plan-${model.result.id}`;
    case "job": return `job-${model.result.id}-${model.result.status}`;
    case "decide_revision": return `decision-${model.result.id}`;
    case "get_make_package": return `package-${model.result.revisionId}-${model.result.expiresAt}`;
    case "error": return `error-${model.error.code}-${model.error.message}`;
    case "unknown": return "unknown";
  }
}

/* ---------- Shared pieces ---------- */

function Header({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <p className="mrv-head">
      <span className="mrv-dot" data-tone={tone} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function TitleRow({ title, meta }: { title: ReactNode; meta?: ReactNode }) {
  return (
    <div className="mrv-titlerow">
      <h2 className="mrv-title">{title}</h2>
      {meta ? <span className="mrv-meta">{meta}</span> : null}
    </div>
  );
}

function NotCheckedFoot({ items }: { items: string[] }) {
  const sentence = notCheckedSentence(items);
  return sentence ? <p className="mrv-foot">{sentence}</p> : null;
}

function ActionButton({ spec, onAction }: { spec: ButtonSpec; onAction: ActionHandler }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAction(spec.action);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "MakeReady could not complete this action.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mrv-action">
      <button
        type="button"
        className="mrv-btn"
        data-primary={spec.primary ? "" : undefined}
        disabled={busy}
        aria-busy={busy}
        onClick={run}
      >
        {spec.icon}
        <span>{spec.label}</span>
      </button>
      {error ? <p className="mrv-error" role="alert">{error}</p> : null}
    </div>
  );
}

/** At most two buttons; the primary one is listed first. */
function Actions({ buttons, onAction }: { buttons: (ButtonSpec | null)[]; onAction: ActionHandler }) {
  const visible = buttons.filter((button): button is ButtonSpec => button !== null).slice(0, 2);
  if (!visible.length) return null;
  return (
    <div className="mrv-actions">
      {visible.map((spec) => <ActionButton key={spec.label} spec={spec} onAction={onAction} />)}
    </div>
  );
}

function openButton(appUrl: string | null, sessionId: string | null): ButtonSpec | null {
  const url = runUrl(appUrl, sessionId);
  return url ? { label: "Open in MakeReady", action: { type: "open", url }, icon: <ExternalLink size={16} aria-hidden="true" /> } : null;
}

function progressButton(sessionId: string, label = "Check progress"): ButtonSpec {
  return {
    label, primary: true,
    action: { type: "call", name: "get_design", arguments: { sessionId } },
    icon: <RefreshCw size={16} aria-hidden="true" />,
  };
}

const ACTORS: Record<GenerationJob["operation"], { actor: string; doing: string; done: string }> = {
  model: { actor: "Geometry agent", doing: "is building the model", done: "built the model" },
  refinement: { actor: "Technician", doing: "is applying the change order", done: "applied the change order" },
  scale: { actor: "Technician", doing: "is rescaling the model", done: "rescaled the model" },
  concept: { actor: "Concept artist", doing: "is drawing the concept", done: "drew the concept" },
  planning: { actor: "Foreman", doing: "is planning the change", done: "planned the change" },
  import: { actor: "Technician", doing: "is importing the file", done: "imported the file" },
};

function jobHeader(job: GenerationJob): { tone: Tone; text: string } {
  const { actor, doing, done } = ACTORS[job.operation];
  if (job.status === "completed") return { tone: "inspect", text: `${actor} ${done}` };
  if (job.status === "failed") return { tone: "problem", text: `${actor} could not finish` };
  if (job.status === "submission_unknown") return { tone: "attention", text: `${actor} can't confirm the request was sent` };
  return { tone: "tech", text: `${actor} ${doing}` };
}

function jobTitle(job: GenerationJob): string {
  if (job.status === "submission_unknown") return "Can't confirm it was sent";
  return statusWords(job.status);
}

function JobSteps({ job }: { job: GenerationJob }) {
  const current = jobStepIndex(job.status);
  if (current < 0) return null;
  const stuck = job.status === "submission_unknown";
  return (
    <ol className="mrv-steps" aria-label="Job progress">
      {JOB_STEPS.map((label, index) => {
        const state = index < current ? "done" : index === current ? (stuck ? "stuck" : "current") : "next";
        return (
          <li key={label} className="mrv-step" data-state={state} aria-current={index === current ? "step" : undefined}>
            <span className="mrv-step-mark" aria-hidden="true">{state === "done" ? <Check size={11} strokeWidth={3} /> : null}</span>
            <span>{label}</span>
            {index === current && job.progress !== null && !stuck ? <span className="mrv-step-note">{Math.round(job.progress)}%</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Honest explanations for failed and unconfirmed jobs. */
function JobProblem({ job }: { job: GenerationJob }) {
  if (job.status === "submission_unknown") {
    return (
      <div className="mrv-note" data-tone="attention">
        <TriangleAlert size={16} aria-hidden="true" />
        <div className="mrv-note-body">
          <p className="mrv-strong">Not resent automatically</p>
          <p className="mrv-muted">MakeReady lost the confirmation from the generator. Sending again could charge twice, so it waits. Check progress before asking for a new run.</p>
        </div>
      </div>
    );
  }
  if (job.status === "failed") {
    return (
      <div className="mrv-note" data-tone="problem">
        <CircleAlert size={16} aria-hidden="true" />
        <div className="mrv-note-body">
          <p className="mrv-strong">{job.error?.message ?? "The job failed."}</p>
          <p className="mrv-muted">{job.error ? errorHint(job.error.code) : "The previous version is kept."} Nothing was resubmitted.</p>
        </div>
      </div>
    );
  }
  return null;
}

/* ---------- Cards ---------- */

export function WaitingCard() {
  return (
    <div className="mrv-card" aria-busy="true">
      <p className="mrv-muted">Waiting for MakeReady</p>
      <div className="mrv-skeleton" aria-hidden="true" />
    </div>
  );
}

function UnknownCard({ notChecked }: { notChecked: string[] }) {
  return (
    <div className="mrv-card">
      <Header tone="attention">MakeReady sent a result this view can&apos;t show</Header>
      <p className="mrv-muted">The full result is in the chat.</p>
      <NotCheckedFoot items={notChecked} />
    </div>
  );
}

export function StartDesignCard({ result, notChecked, appUrl, onAction }: CardProps<StartDesignResult>) {
  const { job, sessionId } = result;
  const problem = job.status === "failed" ? "problem" : job.status === "submission_unknown" ? "attention" : null;
  return (
    <div className="mrv-card">
      <Header tone={problem ?? "foreman"}>Foreman started the design</Header>
      <TitleRow title="Design started" meta={`Est. ${usd(job.estimatedCostUsd)}`} />
      <p className="mrv-status">
        <span className="mrv-dot" data-tone={problem ?? (job.status === "completed" ? "inspect" : "tech")} aria-hidden="true" />
        <span>{statusWords(job.status)}</span>
      </p>
      <JobProblem job={job} />
      <Actions onAction={onAction} buttons={[progressButton(sessionId), openButton(appUrl, sessionId)]} />
      <NotCheckedFoot items={notChecked} />
    </div>
  );
}

export function DesignCard({ result: session, notChecked, appUrl, onAction }: CardProps<DesignSession>) {
  const revisions = orderedRevisions(session);
  const latest = revisions.at(-1);
  const version = revisions.length;
  const activeJob = activeJobOf(session);
  const audit = latest?.kind === "manufacturing" ? physicalAuditFor(session, latest.id) : undefined;
  const visual = latest ? visualSummaryFor(session, latest.id) : undefined;
  const concept = latest?.kind === "concept"
    ? latest.artifacts.find((artifact) => artifact.kind === "concept_image") ?? latest.artifacts.find((artifact) => artifact.kind === "source_image")
    : undefined;

  let header: { tone: Tone; text: string };
  if (!latest) header = { tone: "foreman", text: "Foreman is setting up the design" };
  else if (latest.kind === "manufacturing") header = audit ? { tone: "inspect", text: `Shape inspector measured v${version}` } : { tone: "tech", text: `Geometry agent built v${version}` };
  else header = visual ? { tone: "inspect", text: `Visual inspector reviewed v${version}` } : { tone: "tech", text: `Concept artist drew v${version}` };

  let context: ButtonSpec | null = null;
  if (activeJob) context = progressButton(session.id);
  else if (latest?.kind === "manufacturing" && audit) {
    context = {
      label: "Get make package", primary: true,
      action: { type: "call", name: "get_make_package", arguments: { revisionId: latest.id } },
      icon: <FileBox size={16} aria-hidden="true" />,
    };
  }

  const counts = audit ? countChecks(audit) : null;
  const stage = latest?.kind === "concept" ? (
    <div className="mrv-stage">
      {concept?.url ? (
        <img src={concept.url} alt={`Concept image, v${version}: ${latest.spec.description}`} />
      ) : (
        <div className="mrv-stage-empty">
          <ImageOff size={22} aria-hidden="true" />
          <span>Image link not included in this result</span>
        </div>
      )}
    </div>
  ) : audit ? (
    <div className="mrv-measure">
      <span className="mrv-big">{mm(audit.measuredBoundsMm.height)}</span>
      <span className="mrv-muted mrv-small">Measured height, target {audit.targetHeightMm} mm</span>
    </div>
  ) : null;

  return (
    <div className="mrv-card">
      <Header tone={header.tone}>{header.text}</Header>
      <TitleRow title={session.title || session.spec.description} meta={latest ? `v${version} of ${version}` : "No versions yet"} />
      <div className={stage ? "mrv-split" : undefined}>
        {stage}
        <ul className="mrv-facts">
          {counts ? (
            <li><Check size={14} aria-hidden="true" /><span>{counts.pass} passed, {counts.fail} failed, {counts.notChecked} not checked</span></li>
          ) : null}
          {counts && counts.failed.length ? (
            <li><CircleAlert size={14} aria-hidden="true" /><span>Failed: {counts.failed.map(checkWords).join(", ")}</span></li>
          ) : null}
          {visual ? (
            <li><Info size={14} aria-hidden="true" /><span>Visual inspector: {visual}</span></li>
          ) : null}
          {activeJob ? (
            <li><RefreshCw size={14} aria-hidden="true" /><span>{ACTORS[activeJob.operation].actor}: {statusWords(activeJob.status)}</span></li>
          ) : null}
          {latest && !counts && !visual && !activeJob ? (
            <li><Info size={14} aria-hidden="true" /><span>{latest.kind === "concept" ? "Concept only. No 3D model yet." : "No measurement saved yet."}</span></li>
          ) : null}
        </ul>
      </div>
      <Actions onAction={onAction} buttons={[context, openButton(appUrl, session.id)]} />
      <NotCheckedFoot items={notChecked} />
    </div>
  );
}

export function ChangeOrderCard({ result: plan, notChecked, appUrl, onAction }: CardProps<RevisionPlan>) {
  const change = plan.requestedChange || plan.interpretedIntent;
  return (
    <div className="mrv-card">
      <Header tone="foreman">Foreman planned a change</Header>
      <TitleRow title="Change order" meta={usd(plan.estimatedCostUsd)} />
      <dl className="mrv-rows">
        <div className="mrv-row">
          <dt>Change</dt>
          <dd>
            <p className="mrv-strong">{change}</p>
            {plan.interpretedIntent && plan.interpretedIntent !== change ? <p className="mrv-muted mrv-small">{plan.interpretedIntent}</p> : null}
          </dd>
        </div>
        {plan.preserve.length ? (
          <div className="mrv-row">
            <dt>Keep</dt>
            <dd>
              <ul className="mrv-chips">
                {plan.preserve.map((item) => (
                  <li key={item} className="mrv-chip"><Lock size={12} aria-hidden="true" />{item}</li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
        <div className="mrv-row">
          <dt>How</dt>
          <dd>{actionWords(plan.action)}</dd>
        </div>
        <div className="mrv-row">
          <dt>Why</dt>
          <dd className="mrv-muted">{plan.reason}</dd>
        </div>
      </dl>
      <p className="mrv-status">
        <span className="mrv-dot" data-tone="attention" aria-hidden="true" />
        <span>Saved, not run yet</span>
      </p>
      <Actions
        onAction={onAction}
        buttons={[
          {
            label: "Apply change order", primary: true,
            // Stable key from the plan id: a double tap or retry cannot double-charge.
            action: { type: "call", name: "apply_refinement", arguments: { planId: plan.id, confirm_cost: true, idempotencyKey: `apply-${plan.id}` } },
            icon: <Check size={16} aria-hidden="true" />,
          },
          openButton(appUrl, plan.sessionId),
        ]}
      />
      <NotCheckedFoot items={notChecked} />
    </div>
  );
}

export function JobCard({ result: job, tool, notChecked, appUrl, onAction }: CardProps<GenerationJob> & { tool: "apply_refinement" | "generate_model" }) {
  const header = jobHeader(job);
  const done = job.status === "completed";
  const kind = tool === "generate_model" ? "3D model" : "Change order";
  return (
    <div className="mrv-card">
      <Header tone={header.tone}>{header.text}</Header>
      <TitleRow title={jobTitle(job)} meta={`${kind}, est. ${usd(job.estimatedCostUsd)}`} />
      <JobSteps job={job} />
      <JobProblem job={job} />
      {done ? <p className="mrv-muted">Finished. Check progress to see the new version and its checks.</p> : null}
      <Actions
        onAction={onAction}
        buttons={[progressButton(job.sessionId, done ? "Show result" : "Check progress"), openButton(appUrl, job.sessionId)]}
      />
      <NotCheckedFoot items={notChecked} />
    </div>
  );
}

export function DecisionCard({ result: decision, notChecked, appUrl, onAction }: CardProps<HumanDecision>) {
  const approved = decision.decision === "approve";
  return (
    <div className="mrv-card">
      <Header tone={approved ? "inspect" : "problem"}>
        {approved ? "Human reviewer approved the revision" : "Human reviewer did not approve the revision"}
      </Header>
      <TitleRow title={approved ? "Approved" : "Not approved"} />
      {decision.note ? <p>&ldquo;{decision.note}&rdquo;</p> : null}
      <p className="mrv-muted mrv-small">
        {approved
          ? "Applies to this exact revision only. A later version needs its own approval."
          : "The revision is kept unchanged. The agent can plan another change."}
      </p>
      <Actions onAction={onAction} buttons={[openButton(appUrl, decision.sessionId)]} />
      <NotCheckedFoot items={notChecked} />
    </div>
  );
}

export function PackageCard({ result: pack, notChecked, appUrl, onAction }: CardProps<MakePackageResult>) {
  const counts = countChecks(pack.audit);
  const expires = expiryTime(pack.expiresAt);
  return (
    <div className="mrv-card">
      <Header tone="inspect">Shape inspector measured the package</Header>
      <TitleRow title="Make package" meta={expires ? `Link expires ${expires}` : undefined} />
      <div className="mrv-split">
        <div className="mrv-measure">
          <span className="mrv-big">{mm(pack.audit.measuredBoundsMm.height)}</span>
          <span className="mrv-muted mrv-small">Measured height, target {pack.audit.targetHeightMm} mm</span>
        </div>
        <ul className="mrv-facts">
          <li><Check size={14} aria-hidden="true" /><span>{counts.pass} {counts.pass === 1 ? "check" : "checks"} passed{counts.fail ? `, ${counts.fail} failed` : ""}</span></li>
          {counts.failed.length ? (
            <li><CircleAlert size={14} aria-hidden="true" /><span>Failed: {counts.failed.map(checkWords).join(", ")}</span></li>
          ) : null}
          <li><FileBox size={14} aria-hidden="true" /><span>GLB in meters, STL in millimeters</span></li>
          <li><Info size={14} aria-hidden="true" /><span>Preparation only. No maker has accepted an order.</span></li>
        </ul>
      </div>
      <Actions
        onAction={onAction}
        buttons={[
          { label: "Download package", primary: true, action: { type: "open", url: pack.downloadUrl }, icon: <Download size={16} aria-hidden="true" /> },
          openButton(appUrl, pack.artifact.sessionId),
        ]}
      />
      <NotCheckedFoot items={[...notChecked, ...pack.notChecked]} />
    </div>
  );
}

export function ErrorCard({ result: error, notChecked }: Pick<CardProps<ApiError>, "result" | "notChecked">) {
  return (
    <div className="mrv-card">
      <Header tone="problem">MakeReady stopped</Header>
      <TitleRow title="Couldn't finish this step" />
      <div className="mrv-note" data-tone="problem">
        <CircleAlert size={16} aria-hidden="true" />
        <div className="mrv-note-body">
          <p className="mrv-strong">{error.message}</p>
          <p className="mrv-muted">{errorHint(error.code)}</p>
        </div>
      </div>
      <NotCheckedFoot items={notChecked} />
    </div>
  );
}

