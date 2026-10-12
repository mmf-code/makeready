import Link from "next/link";
import { Hat, Wordmark } from "@/components/makeready/brand";
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

export default function Home() {
  return (
    <div className="mx-auto flex max-w-[1480px] flex-col gap-6 px-4 pb-12 sm:px-8">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b-[1.5px] border-line py-3.5">
        <Wordmark />
        <nav className="ml-auto flex flex-wrap gap-2" aria-label="Main">
          <a href="#agents" className="inline-flex min-h-11 items-center rounded-full px-4 font-semibold">Connect an agent</a>
          <Link href="/demo" className="inline-flex min-h-11 items-center rounded-full border-[1.5px] border-clay bg-panel px-4 font-bold text-clay">Watch a full run</Link>
        </nav>
      </header>

      <section className="grid items-stretch gap-6 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-4">
            <h1 className="mr-display m-0 text-[clamp(52px,6.6vw,96px)] text-clay">Give your idea a shape.</h1>
            <p className="m-0 max-w-[34em] text-[19px] leading-relaxed text-ink">
              Describe an object once. Agents design it, critique it, keep what matters and reshape the rest, then hand print-ready files to makers. Every step is a tool call you can follow, and anything that costs money waits for your approval.
            </p>
          </div>
          <StartForm />
          <RecentRuns />
        </div>
        <HeroCell />
      </section>

      <section id="agents" aria-labelledby="agents-title" className="grid gap-6 rounded-[28px] border-[1.5px] border-line bg-panel p-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="flex flex-col gap-3">
          <h2 id="agents-title" className="mr-heading m-0 text-[clamp(28px,2.8vw,38px)] text-ink">Your agent can run all of it</h2>
          <p className="m-0 max-w-[34em] text-[16px] text-ink-2">
            MakeReady is an MCP server. Add it to ChatGPT or Claude and say what you want in plain words. Your assistant calls these tools, the MakeReady card appears in the chat, and the same run updates here live. For now your assistant asks you before every paid tool.
          </p>
          <p className="m-0 rounded-xl bg-panel-2 px-4 py-3 text-[16px] font-semibold">
            “Use MakeReady to make a 12 cm hand-painted figurine of my cat.”
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-[15px] font-bold"><Hat kind="foreman" className="size-5 text-ink" />Design tools any agent can call</h3>
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(250px,1fr))] gap-2 p-0">
              {DESIGN_TOOLS.map((t) => (
                <li key={t.name} className="flex min-w-0 flex-col gap-1 rounded-xl bg-panel-2 px-3.5 py-2.5">
                  <code className="font-mono text-[13px] font-medium">{t.name}</code>
                  <span className="text-[14px] text-ink-2">{t.does}</span>
                  <span className={`mt-0.5 self-start rounded-full px-2 text-[12px] font-bold ${t.cost.startsWith("Paid") ? "bg-clay text-clay-ink" : "border-[1.2px] border-line"}`}>{t.cost}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 flex items-center gap-2 text-[15px] font-bold"><Hat kind="maker" className="size-5 text-ink" />The job contract maker agents speak</h3>
            <div className="flex flex-wrap gap-1.5">
              {MAKER_TOOLS.map((t) => <code key={t} className="rounded-full border-[1.5px] border-dashed border-clay px-3 py-1 font-mono text-[12.5px] text-clay-deep">{t}</code>)}
              <span className="self-center text-[13px] text-ink-2">Makers are sandbox agents in this demo.</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
