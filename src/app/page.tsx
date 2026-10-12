import Link from "next/link";
import type { ReactNode } from "react";
import { Hat, Wordmark } from "@/components/makeready/brand";
import { ChatPreview } from "@/components/makeready/chat-preview";
import { Hamur } from "@/components/makeready/hamur/hamur";
import { HeroCell } from "@/components/makeready/hero-cell";
import { RecentRuns, StartForm } from "@/components/makeready/start-form";

const DESIGN_TOOLS = [
  { name: "start_design", does: "Turns one message and an optional photo into a run", cost: "Paid" },
  { name: "get_design", does: "Reads every version, job, check and decision", cost: "Read only" },
  { name: "plan_refinement", does: "Writes a change order: what changes, what stays", cost: "Paid, small" },
  { name: "apply_refinement", does: "Runs that exact change order, nothing else", cost: "Paid" },
  { name: "decide_revision", does: "Records an approval or a rejection", cost: "Free" },
  { name: "generate_model", does: "Builds, scales and measures the 3D model", cost: "Paid" },
  { name: "get_make_package", does: "Returns the checks and the download link", cost: "Read only" },
];
const MAKER_TOOLS = ["job.offer", "job.accept", "makeready.request_change", "job.report_problem", "qa.inspect", "delivery.confirm"];

const HANDOFFS = [
  { title: "Turn words into a concept", body: "A concept image from your message or photo.", who: "Agents, live" },
  { title: "Change only what you asked", body: "A change order names what changes and what must stay.", who: "Agents, live" },
  { title: "Make it a real size", body: "A 3D model scaled to your height, grounded and measured.", who: "Agents, live" },
  { title: "Brief a maker", body: "Print shops and painters bid, push back and accept.", who: "Sandbox makers" },
  { title: "Follow it to your door", body: "Print, paint, inspection and delivery, reported by agents.", who: "Sandbox makers" },
];

const TIMELINE = [
  { at: "10:55", who: "Codex", what: "Scaffolded the app and installed every dependency up front" },
  { at: "10:59", who: "Codex", what: "Froze the contracts and validated fixtures for the interface" },
  { at: "11:18", who: "Codex", what: "Real provider adapters, server geometry preparation, typed client" },
  { at: "11:46", who: "Codex", what: "Durable paid jobs and one shared service for web and MCP" },
  { at: "11:52", who: "Codex", what: "A photo-to-package acceptance runner against real providers" },
  { at: "12:02", who: "Claude", what: "Live run view, approval-gated paid steps, the in-chat card" },
  { at: "12:03", who: "Codex", what: "ChatGPT photos ingested into verified, durable design jobs" },
  { at: "12:50", who: "Codex", what: "Durable deployment checks and honest CNC candidate runs" },
  { at: "13:20", who: "Claude", what: "Hamur, the character, drawn and animated in code" },
  { at: "13:23", who: "Codex", what: "Comparisons validated across immutable version history" },
];

const LANES = [
  { lane: "Plan", today: "A foreman agent turns one message into steps", next: "Plans for parts, props and small batches" },
  { lane: "Design", today: "Concept images and change orders", next: "Several directions to choose from" },
  { lane: "Geometry", today: "Image to 3D model", next: "Parametric parts from dimensions" },
  { lane: "Engineering", today: "Scale, ground, measure, package", next: "Wall thickness, supports, CNC toolpaths" },
  { lane: "Physical", today: "Sandbox print shop, painter, QA", next: "Real makers with their own agents" },
  { lane: "Logistics", today: "Sandbox courier", next: "Quotes, payment with approval, delivery proof" },
];

export default function Home() {
  return (
    <div id="top" className="mx-auto flex max-w-[1480px] flex-col px-4 pb-16 sm:px-8">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b-[1.5px] border-line py-3.5">
        <Wordmark />
        <nav className="ml-auto flex flex-wrap gap-1" aria-label="Main">
          <a href="#how" className="inline-flex min-h-11 items-center rounded-full px-3.5 font-semibold">How it works</a>
          <a href="#agents" className="inline-flex min-h-11 items-center rounded-full px-3.5 font-semibold">Connect ChatGPT</a>
          <Link href="/agents" className="inline-flex min-h-11 items-center rounded-full px-3.5 font-semibold">For agents</Link>
          <Link href="/demo" className="inline-flex min-h-11 items-center rounded-full border-[1.5px] border-ink bg-panel px-4 font-bold">Watch a full run</Link>
        </nav>
      </header>

      {/* 1. The one message */}
      <section className="grid items-stretch gap-6 pt-6 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-4">
            <h1 className="mr-display m-0 text-[clamp(52px,6.6vw,96px)] text-ink">Give your idea a shape.</h1>
            <p className="m-0 max-w-[34em] text-[19px] leading-relaxed text-ink">
              Describe an object once. Agents design it, critique it, keep what matters and reshape the rest, then hand print-ready files to makers. Every step is a tool call you can follow, and anything that costs money waits for your approval.
            </p>
          </div>
          <StartForm />
          <RecentRuns />
        </div>
        <HeroCell />
      </section>

      {/* 2. The gap: problem and value */}
      <section aria-labelledby="gap-title" className="mt-24 flex flex-col gap-8">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-end">
          <h2 id="gap-title" className="mr-display m-0 text-[clamp(40px,4.6vw,68px)]">An image is not an object.</h2>
          <p className="m-0 max-w-[36em] text-[18px] leading-relaxed text-ink-2">
            Image and 3D generators stop at a file. Getting a thing made still means someone sets the real size, fixes what will not print, writes the brief, finds a maker and chases every reply. MakeReady hands that work to agents, and keeps you in charge of the money and the final say.
          </p>
        </div>
        <ol className="relative m-0 grid list-none gap-6 p-0 md:grid-cols-5 md:gap-4">
          <span aria-hidden="true" className="mr-tape absolute top-[26px] right-8 left-8 hidden h-2.5 md:block" />
          {HANDOFFS.map((h, i) => (
            <li key={h.title} className="relative flex flex-col gap-3">
              <span className="relative z-10 grid size-[62px] place-items-center rounded-full border-[2px] border-ink bg-panel text-[22px] font-black">{i + 1}</span>
              <h3 className="m-0 text-[19px] font-extrabold leading-snug">{h.title}</h3>
              <p className="m-0 text-[15px] text-ink-2">{h.body}</p>
              <span className={`self-start rounded-full px-2.5 py-0.5 text-[12.5px] font-bold ${h.who.startsWith("Agents") ? "bg-tape text-black" : "border-[1.5px] border-dashed border-ink-2 text-ink-2"}`}>{h.who}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* 3. How a run works: execution and quality */}
      <section id="how" aria-labelledby="how-title" className="mt-24 flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 id="how-title" className="mr-heading m-0 text-[clamp(30px,3vw,42px)]">How a run works</h2>
          <p className="m-0 max-w-[40em] text-[16px] text-ink-2">The same pieces you see in a live run, filled with example data.</p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Step n="1" title="You say it once" body="Words, a photo, a height. That is the only message a person has to write.">
            <div className="flex flex-col gap-3 p-5">
              <div className="flex items-start gap-3">
                <span className="grid size-14 shrink-0 place-items-center rounded-xl border-[1.5px] border-line bg-panel-2 text-[11px] text-ink-2">cat.jpg</span>
                <p className="m-0 rounded-2xl rounded-tl-sm bg-panel-2 px-4 py-3 text-[17px] font-semibold">A 12 cm hand-painted figurine of my cat, wearing a blue scarf.</p>
              </div>
              <dl className="m-0 grid grid-cols-3 gap-2 text-[14px]">
                <Fact k="Height" v="120 mm" /><Fact k="Process" v="Resin" /><Fact k="Spending" v="You approve" />
              </dl>
            </div>
          </Step>
          <Step n="2" title="Agents send back what is off" body="A change order names what changes and what must stay. Nothing paid runs until you approve it.">
            <div className="flex flex-col gap-2.5 p-5 text-[15px]">
              <div className="flex items-center justify-between border-b-[1.5px] border-dashed border-line pb-2">
                <b className="text-[17px]">Change order CO-1</b><span className="text-[13px] text-ink-2">Saved, not run</span>
              </div>
              <Row k="Change">Smaller ears</Row>
              <Row k="Keep"><span className="flex flex-wrap gap-1.5">{["Face", "Scarf", "Colors", "Pose"].map((t) => <span key={t} className="rounded-full border-[1.5px] border-ink px-2.5 text-[13.5px]">{t}</span>)}</span></Row>
              <Row k="How">Edit the concept image, about $0.04</Row>
            </div>
          </Step>
          <Step n="3" title="A real size, measured" body="The 3D model is scaled to your height, set flat on its base and checked by software. What is not checked says so.">
            <div className="flex flex-wrap items-start gap-5 p-5">
              <div className="flex flex-col"><span className="text-[13px] text-ink-2">Height</span><b className="mr-heading text-[36px] tabular-nums">120.0 mm</b></div>
              <ul className="m-0 flex min-w-[220px] flex-1 list-none flex-col gap-1.5 p-0 text-[14.5px]">
                <li className="flex items-center gap-2"><Dot />Size matches the request</li>
                <li className="flex items-center gap-2"><Dot />Sits flat, one piece</li>
                <li className="mr-hatch rounded-lg px-2 py-1"><span className="rounded bg-panel-2 px-1">Not checked: wall thickness, supports, strength</span></li>
              </ul>
            </div>
          </Step>
          <Step n="4" title="Files a maker can use" body="A textured model for looks, a print shape in millimeters, the checks and where every file came from.">
            <ul className="m-0 flex list-none flex-col gap-1.5 p-5 text-[14.5px]">
              {[["model.glb", "Painted model, in meters"], ["model.stl", "Print shape, millimeters, Z up"], ["audit.json", "Every check with its method"], ["manifest.json", "File fingerprints and origins"]].map(([f, d]) => (
                <li key={f} className="flex justify-between gap-3 border-b border-line pb-1.5 last:border-0"><code className="font-mono text-[13.5px]">{f}</code><span className="text-right text-ink-2">{d}</span></li>
              ))}
            </ul>
          </Step>
        </div>
      </section>

      {/* 4. Agents: the connector */}
      <section id="agents" aria-labelledby="agents-title" className="mt-24 grid gap-8 rounded-[28px] bg-[#17191c] p-6 text-[#f2f2ee] sm:p-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <h2 id="agents-title" className="mr-display m-0 text-[clamp(38px,4.2vw,60px)]">Your agent can run all of it.</h2>
          <p className="m-0 max-w-[34em] text-[17px] leading-relaxed text-[#c9ccd2]">
            MakeReady is an MCP server. Add it to ChatGPT and ask for an object in plain words. Your assistant calls the tools, the MakeReady card appears in the chat, and the same run updates on this site. For now it asks you before every paid tool.
          </p>
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {[
              ["Turn on developer mode", "In ChatGPT, open Settings, then Apps & Connectors, and switch on developer mode."],
              ["Create the connector", "Name it MakeReady and paste the MCP server address you got from the team."],
              ["Pick it in a chat", "Start a new chat and choose MakeReady from the tools menu."],
              ["Say what you want", "“Use MakeReady to make a 12 cm hand-painted figurine of my cat.”"],
            ].map(([t, d], i) => (
              <li key={t} className="flex gap-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-tape font-black text-black">{i + 1}</span>
                <span className="flex flex-col"><b className="text-[16px]">{t}</b><span className="text-[15px] text-[#c9ccd2]">{d}</span></span>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <Link href="/agents" className="inline-flex min-h-12 items-center rounded-full border-[1.5px] border-black bg-tape px-5 font-extrabold text-black">Read the agent guide</Link>
            <a href="/llms.txt" className="inline-flex min-h-12 items-center rounded-full border-[1.5px] border-[#f2f2ee] px-5 font-bold">llms.txt</a>
          </div>
        </div>
        <div className="flex min-w-0 flex-col">
          <ChatPreview />
        </div>
        <div className="flex min-w-0 flex-col gap-3 lg:col-span-2">
          <h3 className="m-0 flex items-center gap-2 text-[16px] font-bold"><Hat kind="foreman" className="size-5 text-[#f2f2ee]" />Tools any agent can call</h3>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2 p-0">
            {DESIGN_TOOLS.map((t) => (
              <li key={t.name} className="flex min-w-0 flex-col gap-1 rounded-xl bg-[#23262b] px-3.5 py-2.5">
                <code className="font-mono text-[13.5px] font-medium">{t.name}</code>
                <span className="text-[14px] text-[#c9ccd2]">{t.does}</span>
                <span className={`mt-0.5 self-start rounded-full px-2 text-[12px] font-bold ${t.cost.startsWith("Paid") ? "bg-tape text-black" : "border-[1.2px] border-[#5a5f68]"}`}>{t.cost}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="mr-1 text-[14px] font-bold">Maker agents speak a job contract:</span>
            {MAKER_TOOLS.map((t) => <code key={t} className="rounded-full border-[1.5px] border-dashed border-[#8a8f98] px-3 py-1 font-mono text-[12.5px]">{t}</code>)}
            <span className="text-[13px] text-[#a9aeb6]">Sandbox makers in this demo.</span>
          </div>
        </div>
      </section>

      {/* 5. Built today with Codex */}
      <section aria-labelledby="built-title" className="mt-24 grid gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <div className="flex flex-col gap-4">
          <h2 id="built-title" className="mr-heading m-0 text-[clamp(30px,3vw,42px)]">Built today, by agents working in parallel</h2>
          <p className="m-0 max-w-[34em] text-[17px] leading-relaxed text-ink-2">
            Codex agents split the backend: contracts first, then providers, geometry, durable jobs and the MCP server, each in its own files. Claude built the interface against the frozen contracts. Everything here was written during the hackathon.
          </p>
          <dl className="m-0 grid grid-cols-2 gap-3">
            <Fact k="Real today" v="Concept, change orders, 3D, measuring, package" />
            <Fact k="Sandbox today" v="Print shop, painter, QA, courier" />
          </dl>
        </div>
        <ol className="m-0 flex list-none flex-col p-0" aria-label="Some of today's commits">
          {TIMELINE.map((c) => (
            <li key={c.at + c.what} className="grid grid-cols-[56px_76px_1fr] items-baseline gap-3 border-b border-line py-2.5 last:border-0">
              <time className="font-mono text-[14px] tabular-nums">{c.at}</time>
              <span className={`justify-self-start rounded-full px-2.5 text-[12.5px] font-bold ${c.who === "Codex" ? "bg-ink text-panel" : "bg-tape text-black"}`}>{c.who}</span>
              <span className="text-[15.5px]">{c.what}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* 6. Where it goes: potential */}
      <section aria-labelledby="next-title" className="mt-24 flex flex-col gap-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h2 id="next-title" className="mr-heading m-0 text-[clamp(30px,3vw,42px)]">Figurines first. Any made thing next.</h2>
          <p className="m-0 max-w-[40em] text-[16px] text-ink-2">The same six lanes carry a cat figurine, a replacement bracket or a stage prop. New makers join as agents, not as one-off integrations.</p>
        </div>
        <div className="overflow-x-auto rounded-[22px] border-[1.5px] border-line bg-panel">
          <table className="w-full min-w-[720px] border-collapse text-left text-[15px]">
            <thead>
              <tr className="border-b-[1.5px] border-ink">
                <th scope="col" className="px-5 py-3 font-extrabold">Lane</th>
                <th scope="col" className="px-5 py-3 font-extrabold">Today</th>
                <th scope="col" className="px-5 py-3 font-extrabold">Next</th>
              </tr>
            </thead>
            <tbody>
              {LANES.map((l) => (
                <tr key={l.lane} className="border-b border-line last:border-0">
                  <th scope="row" className="px-5 py-3 font-bold">{l.lane}</th>
                  <td className="px-5 py-3">{l.today}</td>
                  <td className="px-5 py-3 text-ink-2">{l.next}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 7. Closing */}
      <section aria-labelledby="end-title" className="mt-24 grid items-center gap-8 rounded-[28px] border-[1.5px] border-ink bg-panel p-6 sm:p-10 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex flex-col gap-5">
          <h2 id="end-title" className="mr-display m-0 text-[clamp(40px,4.6vw,68px)]">Say it once.</h2>
          <p className="m-0 max-w-[34em] text-[18px] text-ink-2">Start a live run here, or let your assistant drive it from ChatGPT. Hamur carries your idea from station to station either way. Poke the dough.</p>
          <div className="flex flex-wrap gap-2">
            <a href="#top" className="inline-flex min-h-12 items-center rounded-full border-[1.5px] border-black bg-tape px-5 font-extrabold text-black">Start a run</a>
            <Link href="/demo" className="inline-flex min-h-12 items-center rounded-full border-[1.5px] border-ink px-5 font-bold">Watch a full run</Link>
            <Link href="/agents" className="inline-flex min-h-12 items-center rounded-full border-[1.5px] border-ink px-5 font-bold">For agents</Link>
          </div>
        </div>
        <div className="justify-self-center">
          <Hamur size={360} playful wander label="Hamur" />
        </div>
      </section>

      <footer className="mt-12 flex flex-wrap justify-between gap-3 border-t-[1.5px] border-line pt-5 text-[13.5px] text-ink-2">
        <span>Built at the OpenAI × Slush’D Codex hackathon, Istanbul, 12 October 2026.</span>
        <span>Makers shown are sandbox agents. Nothing is printed or shipped yet.</span>
      </footer>
    </div>
  );
}

function Step({ n, title, body, children }: { n: string; title: string; body: string; children: ReactNode }) {
  return (
    <article className="flex flex-col overflow-hidden rounded-[22px] border-[1.5px] border-line bg-panel">
      <div className="flex gap-4 border-b-[1.5px] border-line p-5">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-tape text-[18px] font-black text-black">{n}</span>
        <div className="flex flex-col gap-1"><h3 className="m-0 text-[20px] font-extrabold">{title}</h3><p className="m-0 text-[15px] text-ink-2">{body}</p></div>
      </div>
      <div className="flex-1">{children}</div>
    </article>
  );
}
function Fact({ k, v }: { k: string; v: string }) {
  return <div className="min-w-0 rounded-xl bg-panel-2 px-3 py-2"><dt className="text-[12.5px] text-ink-2">{k}</dt><dd className="m-0 font-bold">{v}</dd></div>;
}
function Row({ k, children }: { k: string; children: ReactNode }) {
  return <div className="grid grid-cols-[72px_1fr] items-center gap-3"><b>{k}</b><span>{children}</span></div>;
}
function Dot() {
  return <span aria-hidden="true" className="inline-block size-3.5 shrink-0 rounded-full bg-go" />;
}
