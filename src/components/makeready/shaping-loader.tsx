"use client";

import { useEffect, useState } from "react";
import type { GenerationJob } from "@/lib/contracts";
import { JOB_STEPS, jobStepIndex } from "../mcp-view/format";
import { Hamur, PAINT_ON_DARK } from "./hamur/hamur";

const WORK: Record<GenerationJob["operation"], { actor: string; first: string; again: string }> = {
  concept: { actor: "Concept artist", first: "Shaping the first concept", again: "Drawing a new concept" },
  planning: { actor: "Foreman", first: "Writing the change order", again: "Writing the change order" },
  refinement: { actor: "Technician", first: "Applying the change order", again: "Applying the change order" },
  model: { actor: "Geometry agent", first: "Building the 3D model", again: "Building the 3D model" },
  scale: { actor: "Technician", first: "Rescaling the model", again: "Rescaling the model" },
  import: { actor: "Technician", first: "Importing the file", again: "Importing the file" },
};

/** Hamur kneads the idea on a loop: one squeeze, a short rest, again. */
function useKnead(on: boolean): number {
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setBeat((b) => b + 1), 2400);
    return () => window.clearInterval(id);
  }, [on]);
  return beat;
}

function Steps({ job }: { job: GenerationJob }) {
  const current = jobStepIndex(job.status);
  if (current < 0) return null;
  const stuck = job.status === "submission_unknown";
  return (
    <ol className="m-0 flex list-none flex-wrap justify-center gap-x-4 gap-y-2 p-0" aria-label="Job progress">
      {JOB_STEPS.map((step, i) => {
        const state = i < current ? "done" : i === current ? "now" : "next";
        return (
          <li key={step} aria-current={state === "now" ? "step" : undefined}
            className={`flex items-center gap-1.5 text-[13px] ${state === "next" ? "text-stage-2" : "text-stage-ink"} ${state === "now" ? "font-bold" : ""}`}>
            <span aria-hidden="true" className={`size-2.5 rounded-full ${
              state === "done" ? "bg-stage-ink" : state === "now" ? (stuck ? "bg-wait" : "animate-pulse bg-tape shadow-[0_0_0_4px_rgba(255,212,0,0.22)] motion-reduce:animate-none") : "border-[1.5px] border-stage-2"
            }`} />
            {step}
          </li>
        );
      })}
    </ol>
  );
}

/** The empty stage while the first version is being made. No 3D cell: there is nothing to put in it yet. */
export function ShapingLoader({ job }: { job: GenerationJob | undefined }) {
  const beat = useKnead(!!job);
  const work = job ? WORK[job.operation] : null;
  const percent = job?.progress !== null && job?.progress !== undefined && job.status === "running" ? `, ${Math.round(job.progress)}%` : "";
  return (
    <div className="flex flex-col items-center gap-4 px-6 text-center">
      {/* Hamur's body sits at 40% of its drawing (the right side is room for a ball set down), so shift it to the center. */}
      <div className="relative translate-x-[10%]">
        {/* A pool of light on the floor: the stage before there is a model to stand in it. */}
        <span aria-hidden="true" className="absolute bottom-0 left-[40%] h-[24%] w-[76%] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(closest-side,rgba(255,212,0,0.26),rgba(255,212,0,0.08)_62%,transparent)]" />
        <Hamur size={300} mood={job ? "working" : "idle"} cue={job ? { act: "sekil", key: beat } : null} playful paint={PAINT_ON_DARK}
          label={work ? `Hamur kneading the idea: ${work.first}` : "Hamur"} className="relative" />
      </div>
      <div className="flex flex-col items-center gap-1" role="status">
        <p className="m-0 text-[19px] font-extrabold text-stage-ink">{work ? work.first : "Nothing to show yet"}</p>
        <p className="m-0 text-[14px] text-stage-2">{work ? `${work.actor}${percent}` : "Start a run and the first concept appears here."}</p>
      </div>
      {job ? <Steps job={job} /> : null}
    </div>
  );
}

/** A small kneading Hamur with the job's state, for when a version is already on the stage. */
export function WorkingBadge({ job, status }: { job: GenerationJob; status: string }) {
  const beat = useKnead(true);
  const work = WORK[job.operation];
  return (
    <span className="flex h-fit items-center gap-1 rounded-full border border-stage-line bg-black/40 py-1 pr-3.5 pl-2.5 text-[12.5px] whitespace-nowrap text-stage-ink" role="status">
      {/* The drawing keeps room on its right for a ball set down; pull the text into it. */}
      <span className="-mr-4 block"><Hamur size={56} mood="working" cue={{ act: "sekil", key: beat }} paint={PAINT_ON_DARK} label="Hamur kneading" /></span>
      <span className="flex flex-col leading-tight"><b>{work.again}</b><span className="text-stage-2">{status}</span></span>
    </span>
  );
}
