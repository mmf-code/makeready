import type { AcceptanceResult, DesignSession } from "@/lib/contracts";

const METRIC = { height_mm: "Height", width_mm: "Width", depth_mm: "Depth" } as const;
const OP = { "=": "≈", "<=": "≤", ">=": "≥" } as const;
const STATUS = {
  met: { mark: "✓", word: "met", tone: "text-go" },
  not_met: { mark: "✗", word: "not met", tone: "text-stop" },
  not_checked: { mark: "–", word: "not checked yet", tone: "text-stage-2" },
} as const;

/** Every comparison of one child carries the same per-requirement results. */
export function acceptanceFor(session: DesignSession, revisionId: string): AcceptanceResult[] {
  return session.comparisons.find((c) => c.childRevisionId === revisionId && c.acceptance?.length)?.acceptance ?? [];
}

/** Requested sizes against the server's measured bounds. Regional features are never implied. */
export function AcceptanceList({ results }: { results: AcceptanceResult[] }) {
  if (!results.length) return null;
  const feedback = results.some((r) => r.source === "feedback");
  return (
    <div className="mt-2 max-w-[34em] rounded-xl border border-stage-line bg-[rgba(23,25,28,0.82)] px-3 py-2 text-[13px] text-stage-ink">
      <b className="text-[12.5px]">Requested sizes, checked in code</b>
      <ul className="m-0 mt-1 flex list-none flex-col gap-0.5 p-0 tabular-nums">
        {results.map((r) => {
          const s = STATUS[r.status];
          return (
            <li key={r.id} title={r.source === "feedback" ? `From your feedback: “${r.quote}”` : "From the design specification"}>
              <span className={`inline-block w-4 font-bold ${s.tone}`} aria-hidden="true">{s.mark}</span>
              {METRIC[r.metric]} {OP[r.op]} {r.value} mm
              {r.actualMm !== null && <span className="text-stage-2"> · measured {r.actualMm.toFixed(1)} mm</span>}
              <span className={s.tone}> · {s.word}</span>
              <span className="text-stage-2"> ({r.source === "feedback" ? "your words" : "spec"})</span>
            </li>
          );
        })}
      </ul>
      <p className="m-0 mt-1 text-xs text-stage-2">
        Overall bounds only.{feedback ? " Changes without a number, such as smaller ears or a kept face, are not measured here." : ""}
      </p>
    </div>
  );
}
