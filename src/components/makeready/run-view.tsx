"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { DesignSession, MakePackageResult, Revision, RevisionPlan } from "@/lib/contracts";
import { decideRevision, executePlan, generateModel, getMakePackage, getSession, MakeReadyClientError, planRevision } from "@/lib/client";
import { explain } from "./explain";
import { Andon, Hat, Wordmark } from "./brand";
import { Hamur, PAINT_ON_DARK } from "./hamur/hamur";
import {
  ACTION_WORDS, artifactOf, BUILDERS, buildRunModel, SANDBOX_END, sandboxSteps, STATUS_WORDS, ZONES,
  type BuilderId, type Entry, type RunModel, type SandboxLook, type Station,
} from "./run-model";
import type { CellSubject } from "./three/work-cell";

const WorkCell = dynamic(() => import("./three/work-cell").then((m) => m.WorkCell), {
  ssr: false,
  loading: () => <div className="absolute inset-0 grid place-items-center text-sm text-stage-2">Setting up the work cell</div>,
});

const money = (n: number) => (n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`);
const clock = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });

/* ---------- live session ---------- */
function useLiveSession(sessionId: string, enabled = true) {
  const router = useRouter();
  const [session, setSession] = useState<DesignSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const next = await getSession(sessionId);
      setSession(next); setError(null); setUpdatedAt(Date.now());
    } catch (e) {
      if (e instanceof MakeReadyClientError && e.code === "ACCESS_REQUIRED") router.replace(`/access?returnTo=${encodeURIComponent(`/runs/${sessionId}`)}`);
      else setError(explain(e));
    } finally { busy.current = false; }
  }, [sessionId, router]);

  const hasActive = !!session?.jobs.some((j) => !["completed", "failed", "submission_unknown"].includes(j.status));
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    let alive = true;
    const loop = async () => { await refresh(); if (alive) timer = setTimeout(loop, hasActive || !session ? 2500 : 8000); };
    loop();
    return () => { alive = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, hasActive, enabled]);

  return { session, error, updatedAt, refresh };
}

/* ---------- sandbox maker run ---------- */
function useSandbox(heightMm: number) {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [startedAt]);
  const elapsed = startedAt === null ? 0 : Math.max(0, (now - startedAt) / 1000);
  const steps = useMemo(() => sandboxSteps(heightMm), [heightMm]);
  const done = startedAt === null ? [] : steps.filter((s) => s.at <= elapsed);
  const stations: Partial<Record<BuilderId, Station>> = {};
  let token: BuilderId | null = null, look: SandboxLook = "original", printRange: [number, number] | null = null, quotes = 0;
  for (const s of done) {
    Object.assign(stations, s.stations); if (s.token) token = s.token; if (s.look) look = s.look;
    if (s.print) printRange = s.print; if (s.quote) quotes += s.quote;
  }
  const print = printRange && look === "resin" ? Math.min(1, (elapsed - printRange[0]) / (printRange[1] - printRange[0])) : null;
  const entries: Entry[] = startedAt === null ? [] : done.map((s, i) => ({
    id: `sandbox-${i}`, at: new Date(startedAt + s.at * 1000).toISOString(), from: s.from, to: s.to, tool: s.tool, args: s.args,
    result: s.result, kind: s.kind ?? "call", sandbox: true,
  }));
  return {
    running: startedAt !== null && elapsed < SANDBOX_END, started: startedAt !== null, finished: startedAt !== null && elapsed >= SANDBOX_END,
    start: () => { setStartedAt(Date.now()); setNow(Date.now()); }, stations, token, look, print, entries, quotes,
  };
}

/* ---------- page ---------- */
export function RunView({ sessionId, fixture, fixtureLabel }: { sessionId: string; fixture?: DesignSession; fixtureLabel?: string }) {
  const live = useLiveSession(sessionId, !fixture);
  const session = fixture ?? live.session;
  const { error, updatedAt } = live;
  const refresh = fixture ? async () => {} : live.refresh;
  const model = useMemo(() => (session ? buildRunModel(session) : null), [session]);
  const sandbox = useSandbox(session?.spec.targetHeightMm ?? 120);
  const [selected, setSelected] = useState<string | null>(null);

  if (!session || !model) {
    return (
      <div className="mx-auto flex max-w-[1480px] flex-col gap-4 px-4 py-6 sm:px-8">
        <TopBar title="Loading the run" sub={error ?? "Reading the session from the server"} />
        {error && <p className="rounded-2xl border border-line bg-panel p-5 text-ink">{error}</p>}
      </div>
    );
  }

  const stations = { ...model.stations, ...sandbox.stations };
  const tokenAt = sandbox.token ?? model.tokenAt;
  const entries = [...sandbox.entries.slice().reverse(), ...model.entries];
  const calls = entries.filter((e) => e.kind !== "human").length;
  const status = updatedAt ? `Live. Updated ${new Date(updatedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : "Live";

  return (
    <div className="mx-auto flex max-w-[1480px] flex-col gap-[18px] px-4 pb-10 sm:px-8">
      <TopBar title={`Run ${session.id.slice(0, 8).toUpperCase()}, ${session.title}`} sub={fixture ? "Fixture data, nothing here was generated" : error ? `${status}. ${error}` : status} />
      {fixtureLabel && <p className="m-0 rounded-xl border-[1.5px] border-dashed border-ink bg-panel px-4 py-2 text-sm font-bold">{fixtureLabel}</p>}

      <section className="grid items-stretch gap-[18px] lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.25fr)]">
        <div className="flex min-w-0 flex-col gap-3.5">
          <IntentPanel session={session} model={model} calls={calls} />
          <CallLog entries={entries} />
        </div>
        <Stage session={session} model={model} sandbox={sandbox} selected={selected} onSelect={setSelected} />
      </section>

      <NextStep session={session} model={model} refresh={refresh} sandbox={sandbox} />
      <ProductionLine stations={stations} tokenAt={tokenAt} sandboxStarted={sandbox.started} sandboxFinished={sandbox.finished} />
    </div>
  );
}

function TopBar({ title, sub }: { title: string; sub: string }) {
  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b-[1.5px] border-line py-3.5">
      <Link href="/" aria-label="MakeReady home"><Wordmark /></Link>
      <div className="flex min-w-0 flex-col border-l-[1.5px] border-line pl-4 leading-tight">
        <strong className="truncate text-[15px]">{title}</strong>
        <span className="text-[13px] text-ink-2 tabular-nums" aria-live="polite">{sub}</span>
      </div>
      <nav className="ml-auto flex flex-wrap gap-2" aria-label="Run">
        <Link href="/demo" className="inline-flex min-h-11 items-center rounded-full border-[1.5px] border-clay bg-panel px-4 font-bold text-clay">Scripted full run</Link>
        <Link href="/" className="inline-flex min-h-11 items-center rounded-full border-[1.5px] border-tape-ink bg-tape px-4 font-bold text-tape-ink">New run</Link>
      </nav>
    </header>
  );
}

function IntentPanel({ session, model, calls }: { session: DesignSession; model: RunModel; calls: number }) {
  const spec = session.spec;
  return (
    <div className="flex flex-col gap-3.5 rounded-[22px] border-[1.5px] border-line bg-panel p-5">
      <div className="flex items-center gap-2 text-[13px] font-bold text-ink-2"><Hat kind="person" className="size-5 text-ink" />The one message that started this run</div>
      <p className="m-0 text-[clamp(20px,1.9vw,25px)] font-semibold leading-tight">{session.title}</p>
      <dl className="m-0 grid grid-cols-2 gap-2">
        <Term label="Height" value={`${spec.targetHeightMm} mm`} />
        <Term label="Made for" value={spec.use} />
        <Term label="Process" value={spec.process === "resin_candidate" ? "Resin print candidate" : "Filament print candidate"} />
        <Term label="Must stay the same" value={spec.preserve.length ? spec.preserve.slice(0, 3).join(", ") : "Decided from the concept"} />
      </dl>
      <div className="grid grid-cols-2 gap-2 border-t-[1.5px] border-dashed border-line pt-3 sm:grid-cols-4">
        <Count n="1" label="message from you" />
        <Count n={String(calls)} label="tool calls between agents" />
        <Count n={String(model.revisions.length)} label={model.revisions.length === 1 ? "saved version" : "saved versions"} />
        <Count n={money(model.spent)} label="estimated provider spend" />
      </div>
    </div>
  );
}
function Term({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-[10px] bg-panel-2 px-2.5 py-2"><dt className="text-xs text-ink-2">{label}</dt><dd className="m-0 truncate text-[15px] font-bold">{value}</dd></div>;
}
function Count({ n, label }: { n: string; label: string }) {
  return <div className="flex min-w-0 flex-col"><b className="mr-heading text-[clamp(28px,2.4vw,36px)] text-clay tabular-nums">{n}</b><span className="text-[12.5px] leading-tight text-ink-2">{label}</span></div>;
}

function CallLog({ entries }: { entries: Entry[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-[22px] border-[1.5px] border-line bg-panel">
      <header className="flex items-baseline justify-between gap-2.5 border-b-[1.5px] border-line px-[18px] pt-3.5 pb-2.5">
        <h2 className="mr-heading text-[22px]">Tool calls</h2>
        <span className="text-[13px] text-ink-2">How the builders talk to each other</span>
      </header>
      <ol className="m-0 flex max-h-[380px] min-h-[220px] list-none flex-col gap-1.5 overflow-auto p-2.5">
        {entries.length === 0 && <li className="rounded-xl bg-panel-2 p-3 text-sm text-ink-2">No calls yet. The first one appears as soon as the foreman starts.</li>}
        {entries.map((e, i) => <CallRow key={e.id} entry={e} fresh={i === 0} />)}
      </ol>
    </div>
  );
}
function CallRow({ entry: e, fresh }: { entry: Entry; fresh: boolean }) {
  const from = BUILDERS[e.from], to = BUILDERS[e.to];
  const bar = e.kind === "change" ? "mr-hazard" : e.kind === "problem" ? "bg-stop" : "";
  return (
    <li className={`relative flex flex-col gap-1 rounded-xl p-2.5 pl-3 ${e.kind === "human" ? "border-[1.5px] border-ink" : fresh ? "bg-[color-mix(in_srgb,var(--tape)_22%,var(--panel))]" : "bg-panel-2"}`}>
      {bar && <span aria-hidden="true" className={`absolute top-2.5 bottom-2.5 left-0 w-1 rounded-r ${bar}`} />}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] font-semibold">
        <span className="inline-flex items-center gap-1"><Hat kind={from.hat} className="size-4 text-ink" />{from.name}</span>
        {e.to !== e.from && <><span className="font-medium text-ink-2">to</span><span className="inline-flex items-center gap-1"><Hat kind={to.hat} className="size-4 text-ink" />{to.name}</span></>}
        <time className="ml-auto font-medium text-ink-2 tabular-nums" dateTime={e.at}>{clock(e.at)}</time>
      </div>
      <code className="font-mono text-xs leading-normal break-words whitespace-pre-wrap">{e.tool}({e.args})</code>
      <p className="m-0 text-[13px] text-ink-2">{e.result}</p>
      {(e.kind === "change" || e.kind === "problem" || e.kind === "running" || e.cost || e.sandbox) && (
        <div className="flex flex-wrap gap-1.5">
          {e.kind === "change" && <Tag className="border-black bg-tape text-black">Change order</Tag>}
          {e.kind === "problem" && <Tag className="border-stop bg-stop text-white">Problem</Tag>}
          {e.kind === "running" && <Tag className="border-go text-ink">Running</Tag>}
          {!!e.cost && <Tag>{`~${money(e.cost)}`}</Tag>}
          {e.sandbox && <Tag className="border-dashed">sandbox</Tag>}
        </div>
      )}
    </li>
  );
}
function Tag({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`rounded-full border-[1.2px] border-line bg-panel px-2 py-px text-[11.5px] font-bold ${className}`}>{children}</span>;
}

/* ---------- stage ---------- */
function useStableUrl() {
  const urls = useRef(new Map<string, string>());
  return (id: string | undefined, url: string | undefined) => {
    if (!id || !url) return undefined;
    if (!urls.current.has(id)) urls.current.set(id, url);
    return urls.current.get(id);
  };
}

function Stage({ session, model, sandbox, selected, onSelect }: {
  session: DesignSession; model: RunModel; sandbox: ReturnType<typeof useSandbox>; selected: string | null; onSelect: (id: string | null) => void;
}) {
  const stable = useStableUrl();
  const view = (selected && model.revisions.find((r) => r.id === selected)) || model.latest;
  const manufacturing = model.latestManufacturing;
  const sandboxOn = sandbox.started && !!manufacturing && (!selected || selected === manufacturing.id);
  const shown: Revision | null = sandboxOn ? manufacturing : view;
  const glb = shown?.kind === "manufacturing" ? artifactOf(shown, "model_glb") : undefined;
  const glbUrl = stable(glb?.id, glb?.url);
  const image = shown?.kind === "concept" ? artifactOf(shown, "concept_image", "source_image") : undefined;
  const imageUrl = stable(image?.id, image?.url);
  const phys = shown ? model.physicalFor(shown.id) : undefined;
  const visual = shown ? model.visualFor(shown.id) : undefined;
  const active = model.activeJobs.at(-1);

  let subject: CellSubject = { kind: "none" };
  let label = "Waiting for the first version";
  let sub = active ? `${STATUS_WORDS[active.status]}. The concept appears here when it is saved.` : "Start a run to see it here.";
  let dims: { height: string; width: string } | null = null;
  if (glbUrl && shown) {
    const look = sandboxOn ? sandbox.look : "original";
    subject = { kind: "glb", url: glbUrl, id: glb!.id, look };
    const b = phys?.audit.measuredBoundsMm;
    if (b && !sandboxOn) dims = { height: `${b.height.toFixed(1)} mm`, width: `${b.width.toFixed(1)} mm` };
    label = `${model.versionOf(shown.id)}, measured model`;
    sub = b ? `${b.height.toFixed(1)} mm tall, ${b.width.toFixed(1)} × ${b.depth.toFixed(1)} mm base. Prepared for printing, not certified.` : "Saved 3D model.";
    if (sandboxOn) {
      if (sandbox.look === "resin") { label = "Printing (sandbox)"; sub = `Layer ${Math.round((sandbox.print ?? 0) * 2400).toLocaleString("en-US")} of 2,400, cured with 405 nm light. Simulated.`; }
      else if (sandbox.look === "primer") { label = "Printed and primed (sandbox)"; sub = "Supports removed, ready for paint. Simulated."; }
      else if (sandbox.finished) { label = "Delivered (sandbox)"; sub = "The make package went through simulated makers. Nothing was really printed."; }
      else { label = "With the makers (sandbox)"; sub = "Simulated maker agents are working on this model."; }
    }
  } else if (shown?.kind === "concept") {
    label = `Concept ${model.versionOf(shown.id)}`;
    sub = "An image from the concept agent. It has no real size until the 3D model is made.";
  }

  return (
    <div className="relative min-h-[460px] overflow-hidden rounded-[22px] mr-stage border-[1.5px] border-stage-line lg:min-h-[620px]">
      <div className="absolute inset-0">
        <WorkCell subject={subject} print={sandboxOn ? sandbox.print : null} dims={dims} label={`${label}. ${sub}`} />
      </div>
      {!shown && (
        <div className="absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-[38%] flex-col items-center gap-2">
          <Hamur size={280} mood={active ? "working" : "idle"} playful paint={PAINT_ON_DARK} label="Hamur" />
          <span className="text-[14px] text-stage-2">{active ? "Shaping the first concept" : "Nothing to show yet"}</span>
        </div>
      )}
      {!imageUrl && shown?.kind === "concept" && (
        <p className="absolute inset-x-6 top-1/2 m-0 -translate-y-1/2 text-center text-sm text-stage-2">The concept image link is refreshing. It appears with the next update.</p>
      )}
      {imageUrl && subject.kind === "none" && (
        <figure className="absolute top-1/2 left-1/2 m-0 w-[min(70%,380px)] -translate-x-1/2 -translate-y-[46%] rotate-[-1.5deg] rounded-lg bg-white p-3 shadow-[0_18px_40px_rgba(0,0,0,0.5)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt={`Concept image ${model.versionOf(shown!.id)}`} className="block aspect-square w-full rounded object-cover" />
          {visual && <figcaption className="pt-2 text-[13px] leading-snug text-black">{visual.summary}</figcaption>}
        </figure>
      )}
      <div className="pointer-events-none absolute inset-x-[18px] top-4 flex justify-between gap-3">
        <div>
          <h2 className="mr-heading text-[clamp(22px,2vw,28px)]">{label}</h2>
          <p className="mt-1 mb-0 max-w-[34em] text-sm text-stage-2 tabular-nums">{sub}</p>
        </div>
        {active && !sandboxOn && (
          <span className="h-fit rounded-full border border-go px-3 py-1 text-[12.5px] whitespace-nowrap text-stage-ink">{STATUS_WORDS[active.status]}</span>
        )}
      </div>
      {model.revisions.length > 0 && (
        <div className="absolute inset-x-3 bottom-3 flex gap-1.5 overflow-x-auto p-1" aria-label="Versions. Select one to look at it.">
          {model.revisions.map((r) => {
            const on = (selected ?? model.latest?.id) === r.id;
            const plan = session.plans.find((p) => session.jobs.some((j) => j.planId === p.id && j.result?.revisionId === r.id));
            const why = r.kind === "manufacturing" ? "3D model, measured" : plan ? plan.requestedChange : r.parentRevisionId ? "Revised concept" : "First concept";
            return (
              <button key={r.id} type="button" aria-pressed={on} onClick={() => onSelect(r.id === model.latest?.id ? null : r.id)}
                className={`flex min-h-11 max-w-[220px] shrink-0 flex-col items-start gap-px rounded-xl border-[1.2px] bg-[rgba(23,25,28,0.82)] px-2.5 py-1.5 text-left ${on ? "border-tape shadow-[inset_0_0_0_1px_var(--tape)]" : "border-stage-line"}`}>
                <b className="text-[13px]">{model.versionOf(r.id)}{model.approved(r.id) ? ", approved" : ""}</b>
                <span className="max-w-[200px] truncate text-xs text-stage-2">{why}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------- step in ---------- */
function useIdempotency() {
  const keys = useRef(new Map<string, string>());
  return (scope: string) => {
    let key = keys.current.get(scope);
    if (!key) { key = `${scope.split(":")[0]}-${crypto.randomUUID()}`; keys.current.set(scope, key); }
    return key;
  };
}

function NextStep({ session, model, refresh, sandbox }: {
  session: DesignSession; model: RunModel; refresh: () => Promise<void>; sandbox: ReturnType<typeof useSandbox>;
}) {
  const keyFor = useIdempotency();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [pkg, setPkg] = useState<MakePackageResult | null>(null);
  // Autopilot is off for now: every paid step waits here for an explicit approval.
  const [pending, setPending] = useState<{ name: string; title: string; cost: string; detail: string; go: () => Promise<void> } | null>(null);

  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name); setError(null);
    try { await fn(); await refresh(); } catch (e) { setError(explain(e)); } finally { setBusy(null); }
  };
  const latest = model.latest;
  const trouble = model.troubledJobs.at(-1);
  const troubleIsCurrent = trouble && (!latest || trouble.createdAt > latest.createdAt) && !model.activeJobs.length;
  const active = model.activeJobs.at(-1);

  const askForeman = (revision: Revision) => {
    const feedback = note.trim();
    setPending({
      name: "plan", title: "Ask the foreman for a change order", cost: "$0.10",
      detail: "The foreman reads your note and writes what changes and what stays. Nothing else runs until you approve that change order too.",
      go: () => run("plan", () => planRevision({ sessionId: session.id, revisionId: revision.id, feedback, confirmCost: true, idempotencyKey: keyFor(`plan:${revision.id}:${feedback}`) }).then(() => setNote(""))),
    });
  };
  const apply = (plan: RevisionPlan) => setPending({
    name: "apply", title: "Run this change order", cost: money(plan.estimatedCostUsd),
    detail: `${ACTION_WORDS[plan.action]}. Only this change order runs. If it fails, the earlier version stays as it is.`,
    go: () => run("apply", () => executePlan({ planId: plan.id, confirmCost: true, idempotencyKey: keyFor(`apply:${plan.id}`) })),
  });
  const approveAndMake = (revision: Revision) => setPending({
    name: "model", title: `Approve ${model.versionOf(revision.id)} and make the 3D model`, cost: "up to $5.00",
    detail: "Records your approval, then the geometry agent builds, scales and measures the model. $5.00 is reserved from the budget; the provider usually charges less.",
    go: () => run("model", async () => {
      if (!model.approved(revision.id)) await decideRevision({ revisionId: revision.id, decision: "approve" });
      await generateModel({ revisionId: revision.id, confirmCost: true, idempotencyKey: keyFor(`model:${revision.id}`) });
    }),
  });
  const fetchPackage = (revision: Revision) => run("package", async () => setPkg(await getMakePackage(revision.id)));

  let body: ReactNode;
  if (troubleIsCurrent && trouble) {
    body = (
      <Row title={trouble.status === "submission_unknown" ? "Can't confirm a paid request was received" : "A step failed"}>
        <p className="m-0 max-w-[60em]">
          {trouble.status === "submission_unknown"
            ? "The provider may have the request, or it may not. MakeReady will not send it again on its own, because that could charge twice. The server keeps checking it."
            : `${trouble.error?.message ?? "The provider reported a failure."} Earlier versions are unchanged.`}
          {` Job ${trouble.id.slice(0, 8)}.`}
        </p>
        <Btn onClick={() => refresh()} disabled={!!busy}>Check again</Btn>
      </Row>
    );
  } else if (model.pendingPlan) {
    const p = model.pendingPlan;
    body = (
      <Row title="Change order ready: what changes, what stays">
        <dl className="m-0 grid min-w-0 flex-1 grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[15px]">
          <dt className="font-bold">Change</dt><dd className="m-0">{p.interpretedIntent}</dd>
          <dt className="font-bold">Keep</dt>
          <dd className="m-0 flex flex-wrap gap-1.5">{p.preserve.map((k) => <span key={k} className="rounded-full border-[1.5px] border-ink px-2.5 text-sm">{k}</span>)}</dd>
          <dt className="font-bold">How</dt><dd className="m-0">{ACTION_WORDS[p.action]}, about {money(p.estimatedCostUsd)}</dd>
          <dt className="font-bold">Why</dt><dd className="m-0 text-ink-2">{p.reason}</dd>
          {p.expectedDifferences.length > 0 && <><dt className="font-bold">Expect</dt><dd className="m-0 text-ink-2">{p.expectedDifferences.join(". ")}</dd></>}
        </dl>
        <Btn primary onClick={() => apply(p)} disabled={!!busy || !!pending}>{busy === "apply" ? "Sending" : "Apply change order"}</Btn>
      </Row>
    );
  } else if (active) {
    const who = active.operation === "model" ? "Geometry and prep agents are" : active.operation === "planning" ? "The foreman is" : "The concept agent is";
    body = (
      <Row title={`${who} working`}>
        <p className="m-0">{STATUS_WORDS[active.status]}{active.progress ? `, ${Math.round(active.progress)}%` : ""}. You can close this tab. The job keeps going on the server and this page catches up when you return.</p>
      </Row>
    );
  } else if (latest?.kind === "concept") {
    body = (
      <Row title={`Concept ${model.versionOf(latest.id)} is ready`}>
        <form className="flex min-w-[min(100%,380px)] flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) askForeman(latest); }}>
          <label htmlFor="note" className="sr-only">What should change</label>
          <input id="note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Say what to change and what to keep"
            className="min-h-12 min-w-0 flex-1 rounded-xl border-[1.5px] border-line bg-panel px-3.5 text-ink" />
          <Btn type="submit" disabled={!!busy || !!pending || !note.trim()}>{busy === "plan" ? "Planning" : "Ask the foreman"}</Btn>
        </form>
        <Btn primary onClick={() => approveAndMake(latest)} disabled={!!busy || !!pending}>{busy === "model" ? "Starting" : `Approve ${model.versionOf(latest.id)} and make 3D`}</Btn>
      </Row>
    );
  } else if (latest?.kind === "manufacturing") {
    body = (
      <Row title={`${model.versionOf(latest.id)} is measured and packed`}>
        {pkg ? (
          <a href={pkg.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-12 items-center rounded-full border-[1.5px] border-tape-ink bg-tape px-5 font-extrabold text-tape-ink">Download the make package</a>
        ) : (
          <Btn primary onClick={() => fetchPackage(latest)} disabled={!!busy}>{busy === "package" ? "Preparing the link" : "Get the make package"}</Btn>
        )}
        <Btn onClick={sandbox.start} disabled={sandbox.running}>{sandbox.started ? (sandbox.running ? "Makers are working" : "Run the makers again") : "Hand to sandbox makers"}</Btn>
        <p className="m-0 basis-full text-[13.5px] text-ink-2">
          Not checked: {session.notChecked.map((n) => n.replaceAll("_", " ")).join(", ")}. Preparation only, no maker has accepted a real order.
        </p>
      </Row>
    );
  } else {
    body = <Row title="Nothing here yet"><Link className="font-bold underline" href="/">Start a run</Link></Row>;
  }

  return (
    <section aria-labelledby="step-title" className="flex flex-col gap-3 rounded-[22px] border-[1.5px] border-ink bg-panel px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <h2 id="step-title" className="mr-heading text-[22px] text-ink">Your call</h2>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-clay-soft px-3 py-1 text-[13px] font-bold text-clay-deep">
          <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
          Autopilot off: paid steps wait for you
        </span>
        <span className="text-[13px] text-ink-2">Agents prepare every step through tool calls. Driving this from ChatGPT updates this page too.</span>
      </div>
      {body}
      {pending && (
        <div role="group" aria-label="Approve spending" className="flex flex-wrap items-center gap-3 rounded-2xl border-[1.5px] border-clay bg-clay-soft px-4 py-3">
          <p className="m-0 min-w-[16em] flex-1 text-[15px] text-ink"><b>{pending.title}, {pending.cost}.</b> {pending.detail}</p>
          <Btn primary onClick={() => { const go = pending.go; setPending(null); void go(); }}>{`Approve ${pending.cost}`}</Btn>
          <Btn onClick={() => setPending(null)}>Not now</Btn>
        </div>
      )}
      {error && <p role="alert" className="m-0 rounded-xl bg-[color-mix(in_srgb,var(--stop)_14%,var(--panel))] px-3 py-2 text-[14px]">{error}</p>}
    </section>
  );
}
function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="m-0 text-[17px] font-bold">{title}</h3>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}
function Btn({ children, primary, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button type="button" {...props}
      className={`inline-flex min-h-12 items-center rounded-full border-[1.5px] px-5 font-bold disabled:cursor-wait disabled:opacity-55 ${primary ? "border-tape-ink bg-tape font-extrabold text-tape-ink" : "border-ink bg-panel text-ink"}`}>
      {children}
    </button>
  );
}

/* ---------- production line ---------- */
function ProductionLine({ stations, tokenAt, sandboxStarted, sandboxFinished }: { stations: Record<BuilderId, Station>; tokenAt: BuilderId; sandboxStarted: boolean; sandboxFinished: boolean }) {
  const states = Object.values(stations).map((s) => s.state);
  const mood = states.includes("problem") ? "worried" : sandboxFinished ? "happy" : states.includes("working") ? "working" : "idle";
  const track = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<BuilderId, HTMLElement>());
  const [left, setLeft] = useState<number | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const el = refs.current.get(tokenAt), tr = track.current;
      if (el && tr) { const r = el.getBoundingClientRect(), t = tr.getBoundingClientRect(); setLeft(r.left - t.left + r.width / 2); }
    };
    place();
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, [tokenAt]);
  return (
    <section aria-labelledby="line-title" className="flex flex-col gap-3 rounded-[22px] border-[1.5px] border-line bg-panel px-[18px] pt-4 pb-3.5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
        <h2 id="line-title" className="mr-heading text-[22px]">Production line</h2>
        <p className="m-0 max-w-[62em] text-[13.5px] text-ink-2">Every station is a builder with its own agent. They take jobs, push work back when something will not make, and report problems through tool calls. Hamur carries your idea, the stone it holds, to whichever station has it now.</p>
      </div>
      <div className="overflow-x-auto pb-1">
        <div ref={track} className="relative flex min-w-[1240px] gap-2.5 pb-[30px]">
          {ZONES.map((z) => (
            <div key={z.name} className="flex min-w-0 flex-col gap-2" style={{ flex: `${z.stations.length} 1 0` }}>
              <h3 className="px-0.5 text-[13px] font-bold text-ink-2">{z.name}</h3>
              <div className="flex gap-2">
                {z.stations.map((id) => {
                  const b = BUILDERS[id], s = stations[id];
                  const border = s.state === "working" ? "border-go bg-panel" : s.state === "attention" ? "border-wait bg-panel" : s.state === "problem" ? "border-stop bg-panel" : "border-transparent bg-panel-2";
                  return (
                    <article key={id} ref={(el) => { if (el) refs.current.set(id, el); }} aria-label={`${b.name}: ${s.task}`}
                      className={`relative flex min-w-0 flex-1 flex-col gap-1.5 rounded-[14px] border-[1.5px] p-2.5 pb-3 transition-colors ${border}`}>
                      {s.state === "problem" && <span aria-hidden="true" className="mr-hazard absolute -top-px right-2.5 left-2.5 h-[5px] rounded-b" />}
                      <div className="flex items-center justify-between gap-1.5"><Hat kind={b.hat} className="size-7 text-ink" /><Andon state={s.state} /></div>
                      <h4 className="m-0 text-sm leading-tight">{b.name}</h4>
                      <span className="text-xs leading-tight text-ink-2">{b.kind}</span>
                      <span className={`line-clamp-3 min-h-[3.9em] text-[12.5px] leading-snug ${s.state === "idle" ? "text-ink-2" : ""}`}>{s.task}</span>
                      {b.sandbox && <span className="absolute right-2 -bottom-2.5 rounded-full border-[1.2px] border-dashed border-ink-2 bg-panel px-1.5 text-[10.5px] font-bold text-ink-2">sandbox</span>}
                    </article>
                  );
                })}
              </div>
            </div>
          ))}
          <div aria-hidden="true" className="mr-tape absolute inset-x-0 bottom-2 h-2.5 rounded-sm" />
          {left !== null && <div aria-hidden="true" className="absolute -bottom-2 -ml-[29px] transition-[left] duration-700" style={{ left }}><Hamur size={58} mood={mood} cue={{ act: "hop", key: tokenAt }} /></div>}
        </div>
      </div>
      <p className="m-0 text-[13px] text-ink-2">
        <b className="text-ink">Sandbox makers.</b> The print shop, painter, line QA and courier are simulated agents using the real job contract: offer, accept, report a problem, pass QA, ship.
        {sandboxStarted ? " This run handed its real make package to them." : " Design, 3D and measuring are real in this run."}
      </p>
    </section>
  );
}
