import { useState, type ReactNode } from "react";
import {
  Check, CircleAlert, CircleCheck, CircleDashed, CircleX, Download, ExternalLink, FileBox, HardHat, ImageOff, Lock,
  RefreshCw, TriangleAlert, UserRound,
} from "lucide-react";
import type {
  ApiError, DesignSession, GenerationJob, HumanDecision, MakePackageResult, PhysicalAudit, RevisionPlan, StartDesignResult,
} from "@/lib/contracts";
import {
  JOB_STEPS, STATIONS, actionWords, activeJobOf, countChecks, deltaMm, errorHint, expiryTime, failedCheckWords, isApproved,
  jobStepIndex, mm, notCheckedList, orderedRevisions, physicalAuditFor, runUrl, stationOfJob, toneOfJob, usd,
  visualSummaryFor, type ActionHandler, type StationTone, type ViewAction, type ViewModel,
} from "./format";
import "./mcp-view.css";

export type ViewTheme = "light" | "dark";

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

/** The production line. Stations before this card are passed; the card's own station is marked. */
function Line({ at, tone }: { at: number; tone?: StationTone }) {
  return (
    <ol className="mrv-line" aria-label="Production line">
      {STATIONS.map((station, index) => {
        const state = index < at ? "done" : index === at ? "current" : "next";
        return (
          <li key={station} data-state={state} data-tone={index === at ? tone : undefined} aria-current={index === at ? "step" : undefined}>
            <span className="mrv-line-bar" aria-hidden="true" />
            <span className="mrv-line-label">{station}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Who acted, in the line's own words: a role badge, then what the role did. */
function Byline({ role, person, children }: { role: string; person?: boolean; children: ReactNode }) {
  return (
    <p className="mrv-by">
      <span className="mrv-role">
        {person ? <UserRound size={14} aria-hidden="true" /> : <HardHat size={14} aria-hidden="true" />}
        {role}
      </span>
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
  const list = notCheckedList(items);
  if (!list) return null;
  return (
    <p className="mrv-foot">
      <span className="mrv-strong">Not checked:</span> {list}
    </p>
  );
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

function jobVerb(job: GenerationJob): string {
  const { doing, done } = ACTORS[job.operation];
  if (job.status === "completed") return done;
  if (job.status === "failed") return "could not finish";
  if (job.status === "submission_unknown") return "can't confirm the request was sent";
  return doing;
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

function Note({ tone, title, children }: { tone: StationTone; title: ReactNode; children: ReactNode }) {
  return (
    <div className="mrv-note" data-tone={tone}>
      {tone === "problem" ? <CircleAlert size={16} aria-hidden="true" /> : <TriangleAlert size={16} aria-hidden="true" />}
      <div className="mrv-note-body">
        <p className="mrv-strong">{title}</p>
        <p className="mrv-muted">{children}</p>
      </div>
    </div>
  );
}

/** Honest explanations for failed and unconfirmed jobs. */
function JobProblem({ job }: { job: GenerationJob }) {
  if (job.status === "submission_unknown") {
    return (
      <Note tone="attention" title="Not resent automatically">
        MakeReady lost the confirmation from the generator. Sending again could charge twice, so it waits. Check progress before asking for a new run.
      </Note>
    );
  }
  if (job.status === "failed") {
    return (
      <Note tone="problem" title={job.error?.message ?? "The job failed."}>
        {job.error ? errorHint(job.error.code) : "The previous version is kept."} Nothing was resubmitted.
      </Note>
    );
  }
  return null;
}

/** Height on a dimension line, then the target and the footprint. Server-measured numbers only. */
function Measure({ audit, label = "Height, measured" }: { audit: PhysicalAudit; label?: string }) {
  const bounds = audit.measuredBoundsMm;
  return (
    <div className="mrv-measure">
      <span className="mrv-dim" aria-hidden="true" />
      <div className="mrv-measure-text">
        <span className="mrv-small mrv-muted">{label}</span>
        <span className="mrv-big">{mm(bounds.height)}</span>
        <span className="mrv-small mrv-muted">Target {audit.targetHeightMm} mm, off by {deltaMm(bounds.height, audit.targetHeightMm)}</span>
        <span className="mrv-small mrv-muted">Footprint {bounds.width.toFixed(1)} × {bounds.depth.toFixed(1)} mm</span>
      </div>
    </div>
  );
}

function sentenceCase(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** Passed, failed and not checked, with the failed checks spelled out. Not checked counts the footer's list too. */
function Checks({ audit, notChecked }: { audit: PhysicalAudit; notChecked: string[] }) {
  const counts = countChecks(audit, notChecked);
  const failed = audit.checks.filter((check) => check.status === "fail");
  return (
    <div className="mrv-checks">
      <ul className="mrv-tally" aria-label="Measured checks">
        <li data-state="pass"><span className="mrv-tally-num"><CircleCheck size={16} aria-hidden="true" />{counts.pass}</span><span className="mrv-tally-label">passed</span></li>
        <li data-state="fail"><span className="mrv-tally-num"><CircleX size={16} aria-hidden="true" />{counts.fail}</span><span className="mrv-tally-label">failed</span></li>
        <li data-state="none"><span className="mrv-tally-num"><CircleDashed size={16} aria-hidden="true" />{counts.notChecked}</span><span className="mrv-tally-label">not checked</span></li>
      </ul>
      {failed.length ? (
        <ul className="mrv-facts">
          {failed.map((check) => (
            <li key={check.id}><CircleX size={14} aria-hidden="true" data-tone="problem" /><span>{sentenceCase(failedCheckWords(check))}</span></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* ---------- Cards ---------- */

export function WaitingCard() {
  return (
    <div className="mrv-card" aria-busy="true">
      <div className="mrv-line mrv-skel-line" aria-hidden="true">
        {STATIONS.map((station) => <span key={station} className="mrv-skeleton" />)}
      </div>
      <p className="mrv-muted mrv-small">Waiting for MakeReady</p>
      <div className="mrv-skeleton mrv-skel-title" aria-hidden="true" />
      <div className="mrv-skeleton mrv-skel-block" aria-hidden="true" />
      <div className="mrv-skeleton mrv-skel-button" aria-hidden="true" />
    </div>
  );
}

function UnknownCard({ notChecked }: { notChecked: string[] }) {
  return (
    <div className="mrv-card">
      <TitleRow title="This result has no card" />
      <p className="mrv-muted">MakeReady sent a result this view can&apos;t show. The full result is in the chat.</p>
      <NotCheckedFoot items={notChecked} />
    </div>
  );
}

export function StartDesignCard({ result, notChecked, appUrl, onAction }: CardProps<StartDesignResult>) {
  const { job, sessionId } = result;
  const done = job.status === "completed";
  return (
    <div className="mrv-card">
      <Line at={0} tone={toneOfJob(job)} />
      <Byline role="Foreman">{done ? "started the design" : "started the design and handed it to the concept artist"}</Byline>
      <TitleRow title="Concept v1" meta={`Est. ${usd(job.estimatedCostUsd)}`} />
      <JobSteps job={job} />
      <JobProblem job={job} />
      {done ? <p className="mrv-muted">Concept v1 is drawn. Check progress to see it.</p> : null}
      <Actions onAction={onAction} buttons={[progressButton(sessionId, done ? "Show concept" : "Check progress"), openButton(appUrl, sessionId)]} />
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
  const approved = latest ? isApproved(session, latest) : false;
  const concept = latest?.kind === "concept"
    ? latest.artifacts.find((artifact) => artifact.kind === "concept_image") ?? latest.artifacts.find((artifact) => artifact.kind === "source_image")
    : undefined;

  const at = activeJob ? stationOfJob(activeJob) : !latest ? 0 : latest.kind === "manufacturing" ? 3 : 2;

  let byline: { role: string; person?: boolean; text: string };
  if (activeJob) byline = { role: ACTORS[activeJob.operation].actor, text: jobVerb(activeJob) };
  else if (!latest) byline = { role: "Foreman", text: "is setting up the design" };
  else if (latest.kind === "manufacturing") byline = audit ? { role: "Shape inspector", text: `measured v${version}` } : { role: "Geometry agent", text: `built v${version}` };
  else if (approved) byline = { role: "Reviewer", person: true, text: `approved v${version}` };
  else if (visual) byline = { role: "Visual inspector", text: `looked at v${version}` };
  else byline = { role: "Concept artist", text: `drew v${version}` };

  let context: ButtonSpec | null = null;
  if (activeJob) context = progressButton(session.id);
  else if (latest?.kind === "manufacturing" && audit) {
    context = {
      label: "Get make package", primary: true,
      action: { type: "call", name: "get_make_package", arguments: { revisionId: latest.id } },
      icon: <FileBox size={16} aria-hidden="true" />,
    };
  } else if (latest?.kind === "concept" && !approved) {
    // The person's own tap is the approval. It covers these exact files only.
    context = {
      label: `Approve v${version}`, primary: true,
      action: { type: "call", name: "decide_revision", arguments: { revisionId: latest.id, decision: "approve" } },
      icon: <Check size={16} aria-hidden="true" />,
    };
  }

  let body: ReactNode = null;
  if (latest?.kind === "concept") {
    body = (
      <div className="mrv-split">
        <figure className="mrv-stage">
          {concept?.url ? (
            // eslint-disable-next-line @next/next/no-img-element -- The widget runs in the host iframe, outside Next.js.
            <img src={concept.url} alt={`Concept image, v${version}: ${latest.spec.description}`} />
          ) : (
            <div className="mrv-stage-empty">
              <ImageOff size={22} aria-hidden="true" />
              <span>Image link not included in this result</span>
            </div>
          )}
          <figcaption className="mrv-tag">v{version}</figcaption>
        </figure>
        <ul className="mrv-facts">
          {visual ? <li><HardHat size={14} aria-hidden="true" /><span>Visual inspector: {visual}</span></li> : null}
          <li><CircleDashed size={14} aria-hidden="true" /><span>Concept only. It has no real size until the 3D model is measured.</span></li>
          {approved
            ? <li><Check size={14} aria-hidden="true" /><span>Approved for these files. A new version needs its own approval.</span></li>
            : <li><UserRound size={14} aria-hidden="true" /><span>Waiting for your call: approve it, or ask for a change.</span></li>}
        </ul>
      </div>
    );
  } else if (audit) {
    body = (
      <div className="mrv-split">
        <Measure audit={audit} />
        <Checks audit={audit} notChecked={notChecked} />
      </div>
    );
  } else if (latest) {
    body = <p className="mrv-muted">The 3D model is saved. No measurement is saved yet.</p>;
  }

  return (
    <div className="mrv-card">
      <Line at={at} tone={activeJob ? toneOfJob(activeJob) : undefined} />
      <Byline role={byline.role} person={byline.person}>{byline.text}</Byline>
      <TitleRow title={session.title || session.spec.description} meta={latest ? `v${version}` : "No versions yet"} />
      {body}
      {activeJob ? <JobSteps job={activeJob} /> : null}
      {activeJob ? <JobProblem job={activeJob} /> : null}
      <Actions onAction={onAction} buttons={[context, openButton(appUrl, session.id)]} />
      <NotCheckedFoot items={notChecked} />
    </div>
  );
}

export function ChangeOrderCard({ result: plan, notChecked, appUrl, onAction }: CardProps<RevisionPlan>) {
  const change = plan.requestedChange || plan.interpretedIntent;
  return (
    <div className="mrv-card">
      <Line at={1} />
      <Byline role="Foreman">wrote a change order</Byline>
      <TitleRow title="Change order" />
      <div className="mrv-order">
        <section className="mrv-order-part">
          <h3 className="mrv-label">Changes</h3>
          <p className="mrv-change"><mark>{change}</mark></p>
          {plan.interpretedIntent && plan.interpretedIntent !== change ? <p className="mrv-muted mrv-small">Read as: {plan.interpretedIntent}</p> : null}
        </section>
        {plan.preserve.length ? (
          <section className="mrv-order-part">
            <h3 className="mrv-label">Stays the same</h3>
            <ul className="mrv-chips">
              {plan.preserve.map((item) => (
                <li key={item} className="mrv-chip"><Lock size={12} aria-hidden="true" />{item}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      <dl className="mrv-rows">
        <div className="mrv-row">
          <dt>How</dt>
          <dd>{actionWords(plan.action)}</dd>
        </div>
        <div className="mrv-row">
          <dt>Why</dt>
          <dd className="mrv-muted">{plan.reason}</dd>
        </div>
        {plan.expectedDifferences.length ? (
          <div className="mrv-row">
            <dt>Expect</dt>
            <dd className="mrv-muted">{plan.expectedDifferences.join(". ")}</dd>
          </div>
        ) : null}
      </dl>
      <p className="mrv-status">
        <span className="mrv-dot" data-tone="attention" aria-hidden="true" />
        <span>Saved, not run yet. Applying costs about {usd(plan.estimatedCostUsd)}.</span>
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
  const done = job.status === "completed";
  const model = tool === "generate_model";
  return (
    <div className="mrv-card">
      <Line at={model ? 3 : 1} tone={toneOfJob(job)} />
      <Byline role={ACTORS[job.operation].actor}>{jobVerb(job)}</Byline>
      <TitleRow title={model ? "3D model" : "Change order"} meta={`Est. ${usd(job.estimatedCostUsd)}`} />
      <JobSteps job={job} />
      <JobProblem job={job} />
      {done ? (
        <p className="mrv-muted">
          {model ? "Built, scaled and measured. Check progress to see the numbers." : "Applied. Check progress to see the new version."}
        </p>
      ) : null}
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
      <Line at={2} tone={approved ? undefined : "attention"} />
      <Byline role="Reviewer" person>{approved ? "approved this version" : "sent this version back"}</Byline>
      <TitleRow title={approved ? "Approved" : "Sent back"} />
      {decision.note ? <blockquote className="mrv-quote">{decision.note}</blockquote> : null}
      <p className="mrv-muted">
        {approved
          ? "The approval covers these exact files. A later version needs its own approval."
          : "The version is kept as it is. The agent can write another change order."}
      </p>
      <Actions onAction={onAction} buttons={[openButton(appUrl, decision.sessionId)]} />
      <NotCheckedFoot items={notChecked} />
    </div>
  );
}

export function PackageCard({ result: pack, notChecked, appUrl, onAction }: CardProps<MakePackageResult>) {
  const expires = expiryTime(pack.expiresAt);
  return (
    <div className="mrv-card">
      <Line at={4} />
      <Byline role="Foreman">packed the files for a maker</Byline>
      <TitleRow title="Make package" meta={expires ? `Link expires ${expires}` : undefined} />
      <div className="mrv-split">
        <Measure audit={pack.audit} />
        <div className="mrv-checks">
          <Checks audit={pack.audit} notChecked={[...notChecked, ...pack.notChecked]} />
          <ul className="mrv-facts">
            <li><FileBox size={14} aria-hidden="true" /><span>GLB in meters, STL in millimeters</span></li>
            <li><CircleDashed size={14} aria-hidden="true" /><span>Preparation only. No maker has accepted an order.</span></li>
          </ul>
        </div>
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
      <TitleRow title="MakeReady stopped this step" />
      <Note tone="problem" title={error.message}>{errorHint(error.code)}</Note>
      <NotCheckedFoot items={notChecked} />
    </div>
  );
}
