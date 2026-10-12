import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/makeready/brand";
import { CONNECT, FLOW, INTRO, RULES, TOOLS } from "@/components/makeready/agent-guide";
import { Hamur } from "@/components/makeready/hamur/hamur";

export const metadata: Metadata = {
  title: "For agents",
  description: "How AI agents connect to MakeReady over MCP, which tools they can call and the rules they follow.",
};

export default function AgentsPage() {
  return (
    <div className="mx-auto flex max-w-[1180px] flex-col gap-12 px-4 pb-16 sm:px-8">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b-[1.5px] border-line py-3.5">
        <Link href="/" aria-label="MakeReady home"><Wordmark /></Link>
        <nav className="ml-auto flex flex-wrap gap-1" aria-label="Agent guide">
          <a href="/llms.txt" className="inline-flex min-h-11 items-center rounded-full px-3.5 font-semibold">llms.txt</a>
          <Link href="/" className="inline-flex min-h-11 items-center rounded-full border-[1.5px] border-black bg-tape px-4 font-bold text-black">Start a run</Link>
        </nav>
      </header>

      <section className="grid items-center gap-8 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex flex-col gap-4">
          <h1 className="mr-display m-0 text-[clamp(44px,5.4vw,80px)]">For agents.</h1>
          <p className="m-0 max-w-[40em] text-[18px] leading-relaxed">{INTRO}</p>
          <p className="m-0 text-[15px] text-ink-2">This page is written for AI agents and the people who build them. The same text is at <a className="font-bold underline" href="/llms.txt">/llms.txt</a>.</p>
        </div>
        <Hamur size={240} mood="holding" holding playful label="Hamur" />
      </section>

      <section aria-labelledby="connect-title" className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <h2 id="connect-title" className="mr-heading m-0 text-[28px]">Connect</h2>
          <ul className="m-0 flex list-disc flex-col gap-2 pl-5 text-[16px]">{CONNECT.map((c) => <li key={c}>{c}</li>)}</ul>
        </div>
        <div className="flex flex-col gap-3">
          <h2 className="mr-heading m-0 text-[28px]">A good run</h2>
          <ol className="m-0 flex list-none flex-col gap-2 p-0 text-[16px]">
            {FLOW.map((f, i) => (
              <li key={f} className="flex gap-3"><span className="grid size-7 shrink-0 place-items-center rounded-full bg-tape text-[14px] font-black text-black">{i + 1}</span><span>{f}</span></li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="rules-title" className="flex flex-col gap-3 rounded-[22px] border-[1.5px] border-ink bg-panel p-6">
        <h2 id="rules-title" className="mr-heading m-0 text-[28px]">Rules agents follow</h2>
        <ul className="m-0 grid list-none gap-x-8 gap-y-2 p-0 text-[16px] md:grid-cols-2">
          {RULES.map((r) => <li key={r} className="flex gap-2.5"><span aria-hidden="true" className="mt-2 size-2.5 shrink-0 rounded-full bg-tape ring-[1.5px] ring-black" />{r}</li>)}
        </ul>
      </section>

      <section aria-labelledby="tools-title" className="flex flex-col gap-4">
        <h2 id="tools-title" className="mr-heading m-0 text-[28px]">Tools</h2>
        <div className="flex flex-col gap-3">
          {TOOLS.map((t) => (
            <article key={t.name} className="grid gap-3 rounded-[18px] border-[1.5px] border-line bg-panel p-5 md:grid-cols-[220px_minmax(0,1fr)]">
              <div className="flex flex-col items-start gap-2">
                <code className="font-mono text-[16px] font-medium">{t.name}</code>
                <span className={`rounded-full px-2.5 text-[12.5px] font-bold ${t.paid ? "bg-tape text-black" : "border-[1.2px] border-line"}`}>{t.paid ? "Paid, ask first" : t.readOnly ? "Read only" : "Free"}</span>
              </div>
              <div className="flex min-w-0 flex-col gap-2 text-[15px]">
                <p className="m-0 font-semibold">{t.does}</p>
                <p className="m-0 text-ink-2">When: {t.when}</p>
                <pre className="m-0 overflow-x-auto rounded-xl bg-panel-2 px-3 py-2 font-mono text-[13px] whitespace-pre-wrap">{`input   ${t.input}\nreturns ${t.returns}`}</pre>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
