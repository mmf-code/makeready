"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { CatMode } from "./three/toy-cat";

const WorkCell = dynamic(() => import("./three/work-cell").then((m) => m.WorkCell), {
  ssr: false,
  loading: () => <div className="absolute inset-0 grid place-items-center text-sm text-stage-2">Setting up the work cell</div>,
});

const STEPS: { mode: CatMode; ears: number; tail: number; label: string; sub: string; print?: boolean; dims?: boolean; hold: number }[] = [
  { mode: "sketch", ears: 1.5, tail: 0.075, label: "Concept v1", sub: "The look inspector finds the ears 31% too large.", hold: 2600 },
  { mode: "sketch", ears: 1.0, tail: 0.075, label: "Concept v2", sub: "Change order CO-1: ears 25% smaller. Face and scarf kept.", hold: 2600 },
  { mode: "clay", ears: 1.0, tail: 0.075, label: "3D model", sub: "Sculpted from four views of v2.", hold: 2200 },
  { mode: "measured", ears: 1.0, tail: 0.12, label: "Print shape, 120.0 mm", sub: "The print shop asked for a thicker tail. CO-2 made it 1.4 mm. Nothing else changed.", dims: true, hold: 2800 },
  { mode: "printing", ears: 1.0, tail: 0.12, label: "Printing", sub: "Layer by layer, cured with 405 nm light.", print: true, hold: 3600 },
  { mode: "painted", ears: 1.0, tail: 0.12, label: "Painted and inspected", sub: "A painter and her agent finished it. Caliper: 120.2 mm.", hold: 3400 },
];

/** The sample figurine walking through the line. A stand-in, labeled as such. */
export function HeroCell() {
  const [i, setI] = useState(STEPS.length - 1);
  const [t0, setT0] = useState(0);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let k = 0;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => { setI(k); setT0(performance.now()); timer = setTimeout(() => { k = (k + 1) % STEPS.length; next(); }, STEPS[k].hold); };
    timer = setTimeout(next, 600);
    const tick = setInterval(() => setNow(performance.now()), 100);
    return () => { clearTimeout(timer); clearInterval(tick); };
  }, []);
  const s = STEPS[i];
  const print = s.print ? Math.min(1, Math.max(0, (now - t0) / (s.hold - 500))) : null;
  return (
    <div className="relative min-h-[520px] overflow-hidden rounded-[22px] mr-stage border-[1.5px] border-stage-line lg:min-h-[600px]">
      <div className="absolute inset-0">
        <WorkCell subject={{ kind: "cat", mode: s.mode, ears: s.ears, tail: s.tail }} print={print} dims={s.dims ? { height: "120.0 mm", width: "82.4 mm" } : null} label={`Sample figurine. ${s.label}. ${s.sub}`} />
      </div>
      <div className="pointer-events-none absolute inset-x-[18px] top-4 flex justify-between gap-3">
        <div>
          <h2 className="mr-heading text-[clamp(22px,2vw,28px)] text-ink">{s.label}</h2>
          <p className="mt-1 mb-0 max-w-[30em] text-sm text-stage-2">{s.sub}</p>
        </div>
        <span className="h-fit rounded-full border border-dashed border-stage-2 bg-panel/70 px-3 py-1 text-[12.5px] whitespace-nowrap text-stage-2">Sample, not generated</span>
      </div>
    </div>
  );
}
