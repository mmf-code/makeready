import type { ReactNode } from "react";
import type { AcceptanceResult, DesignSession, RevisionPlan } from "@/lib/contracts";
import { Hat, type HatKind } from "./brand";
import { ACTION_WORDS, isActive, jobProof, STATUS_WORDS, type RunModel } from "./run-model";

type Verdict = "fixed" | "off" | "working" | "waiting" | "failed";
const VERDICT: Record<Verdict, { word: string; tone: string }> = {
  fixed: { word: "Fixed and checked", tone: "border-go bg-[color-mix(in_srgb,var(--go)_16%,var(--panel))]" },
  off: { word: "Still off", tone: "border-stop bg-[color-mix(in_srgb,var(--stop)_14%,var(--panel))]" },
  working: { word: "Fixing now", tone: "border-wait bg-[color-mix(in_srgb,var(--wait)_14%,var(--panel))]" },
  waiting: { word: "Planned, not run", tone: "border-line bg-panel-2" },
  failed: { word: "Fix failed", tone: "border-stop bg-[color-mix(in_srgb,var(--stop)_14%,var(--panel))]" },
};
const METRIC = { height_mm: "Height", width_mm: "Width", depth_mm: "Depth" } as const;
const sizeLine = (a: AcceptanceResult) =>
  `${a.status === "met" ? "✓" : a.status === "not_met" ? "✗" : "–"} ${METRIC[a.metric]} ${a.actualMm === null ? "not measured" : `${a.actualMm.toFixed(1)} mm`}, asked ${a.value} mm`;

interface Loop {
  plan: RevisionPlan; co: string; parent: string; child: string | null; verdict: Verdict;
  caughtBy: { hat: HatKind; who: string; what: string }; planProof: string;
  fixWho: string; fixWhat: string; fixProof: string;
  checks: string[]; checkProof: string;
}

function loopsOf(session: DesignSession, model: RunModel): Loop[] {
  const plans = [...session.plans].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return plans.map((plan, i) => {
    const parent = model.versionOf(plan.parentRevisionId);
    const sentBack = [...session.decisions].reverse().find((d) => d.revisionId === plan.parentRevisionId && d.decision === "reject");
    const parentMissed = session.comparisons.find((c) => c.childRevisionId === plan.parentRevisionId)?.acceptance?.filter((a) => a.status === "not_met") ?? [];
    const caughtBy = parentMissed.length && !sentBack
      ? { hat: "inspect" as const, who: "Shape inspector", what: parentMissed.map(sizeLine).join(". ") }
      : { hat: "person" as const, who: sentBack ? `You sent ${parent} back` : `You asked for a change on ${parent}`, what: `“${plan.requestedChange}”` };
    const planner = session.jobs.find((j) => j.operation === "planning" && j.result?.planId === plan.id);
    const tries = session.jobs.filter((j) => j.planId === plan.id && j.operation !== "planning").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const job = tries.find((j) => j.status === "completed") ?? tries.at(-1);
    const childId = job?.result?.revisionId ?? null;
    const fixWho = plan.action === "edit_concept" ? "Concept agent" : plan.action === "regenerate_model" ? "Geometry agent" : "Prep agent";
    const fixWhat = !job ? "Waiting for someone to run the change order." : job.status === "completed" ? `${ACTION_WORDS[plan.action]}: made ${model.versionOf(childId)} next to ${parent}. ${parent} is kept.` : job.status === "failed" ? job.error?.message ?? "The provider reported a failure." : `${STATUS_WORDS[job.status]}${job.progress ? `, ${Math.round(job.progress)}%` : ""}.`;

    // Checks on the fixed version: the look inspector's findings and every measured size tied to this plan.
    const looked = childId ? model.visualFor(childId) : undefined;
    const realLook = looked && looked.engine !== "not_checked" ? looked : undefined;
    const sizes = session.comparisons.flatMap((c) => c.acceptance ?? []).filter((a) => a.planId === plan.id && a.status !== "not_checked");
    const checks = [
      ...(realLook ? realLook.changesObserved.slice(0, 3) : []),
      ...(realLook && !realLook.changesObserved.length ? [realLook.summary] : []),
      ...sizes.map(sizeLine),
    ];
    const verdict: Verdict = !job ? "waiting" : isActive(job) ? "working" : job.status !== "completed" ? "failed"
      : sizes.some((a) => a.status === "not_met") || realLook?.changesObserved.some((c) => /\((not_met|fail|missing)\)$/.test(c)) ? "off" : "fixed";
    return {
      plan, co: `CO-${i + 1}`, parent, child: childId ? model.versionOf(childId) : null, verdict, caughtBy,
      planProof: planner ? jobProof(planner) : "", fixWho, fixWhat, fixProof: job ? jobProof(job) : "",
      checks: checks.length ? checks : [job?.status === "completed" ? "No automatic check covers this change. Compare the two versions yourself." : "Runs after the fix."],
      checkProof: [realLook && `${realLook.engine} · vision`, sizes.length && "sizes measured on the server"].filter(Boolean).join(" · "),
    };
  });
}

/** Every change order from the problem to the check, built only from stored jobs, plans and evaluations. */
export function FixLoop({ session, model }: { session: DesignSession; model: RunModel }) {
  const loops = loopsOf(session, model);
  if (!loops.length) return null;
  const fixed = loops.filter((l) => l.verdict === "fixed").length;
  return (
    <section className="flex flex-col gap-3 rounded-[22px] border-[1.5px] border-line bg-panel p-4 sm:p-5" aria-labelledby="fix-loop-title">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="fix-loop-title" className="mr-heading text-[22px]">Caught and fixed</h2>
        <span className="text-[13px] text-ink-2">
          {loops.length} change order{loops.length > 1 ? "s" : ""}, {fixed} fixed and checked. Every step below is a stored call with its own request id.
        </span>
      </header>
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {loops.map((l) => (
          <li key={l.plan.id} className={`rounded-2xl border-[1.5px] p-3 ${VERDICT[l.verdict].tone}`}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full border-[1.5px] border-black bg-tape px-2.5 py-px text-[12px] font-extrabold text-black">{l.co}</span>
              <b className="text-[15px]">{l.parent} → {l.child ?? "…"}</b>
              <span className="ml-auto text-[13px] font-extrabold">{VERDICT[l.verdict].word}</span>
            </div>
            <div className="grid gap-2 md:grid-cols-4">
              <Step n="1" title="Caught" hat={l.caughtBy.hat} who={l.caughtBy.who}>{l.caughtBy.what}</Step>
              <Step n="2" title="Planned" hat="foreman" who="Foreman" proof={l.planProof}>
                {l.plan.interpretedIntent}.{l.plan.preserve.length ? ` Keep ${l.plan.preserve.join(", ")}.` : ""}
                {l.plan.checks?.length ? ` ${l.plan.checks.length} measurable check${l.plan.checks.length > 1 ? "s" : ""}.` : ""}
              </Step>
              <Step n="3" title="Fixed" hat={l.fixWho === "Concept agent" ? "design" : "tech"} who={l.fixWho} proof={l.fixProof}>{l.fixWhat}</Step>
              <Step n="4" title="Checked" hat="inspect" who="Look and shape inspectors" proof={l.checkProof}>
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{l.checks.map((c) => <li key={c}>{c}</li>)}</ul>
              </Step>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Step({ n, title, hat, who, proof, children }: { n: string; title: string; hat: HatKind; who: string; proof?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl bg-panel p-2.5">
      <div className="flex items-center gap-1.5 text-[12px] font-bold text-ink-2">
        <span className="grid size-5 place-items-center rounded-full bg-ink text-[11px] text-panel">{n}</span>
        {title}
        <span className="ml-auto inline-flex min-w-0 items-center gap-1 truncate text-ink"><Hat kind={hat} className="size-4 shrink-0" />{who}</span>
      </div>
      <div className="text-[13px] leading-snug break-words">{children}</div>
      {proof && <p className="m-0 mt-auto pt-1 font-mono text-[11px] text-ink-2 break-all">{proof}</p>}
    </div>
  );
}
