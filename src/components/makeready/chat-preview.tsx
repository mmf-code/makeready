"use client";

import { NotChecked } from "@/lib/contracts";
import { examplePlan } from "@/lib/contracts/fixtures";
import { McpView } from "../mcp-view/cards";
import type { ActionHandler } from "../mcp-view/format";

const plan = {
  ...examplePlan,
  requestedChange: "Make the ears smaller, keep the face",
  interpretedIntent: "Smaller ears, everything else as it is",
  preserve: ["Face", "Scarf", "Colors", "Pose"],
  reason: "Ear size is a look change, so editing the concept image is cheaper than a new 3D model.",
  expectedDifferences: ["Shorter ears", "Same face and scarf"],
};
const noop: ActionHandler = async () => {};

/** What ChatGPT shows when an agent calls plan_refinement: the real in-chat card, with example data. */
export function ChatPreview() {
  return (
    <figure className="m-0 flex flex-col gap-3 rounded-[22px] bg-white p-4 text-[#1f1f1f] shadow-[0_24px_60px_rgba(0,0,0,0.35)] sm:p-5">
      <div className="ml-auto max-w-[80%] rounded-[20px] bg-[#f1f1f1] px-4 py-2.5 text-[15px]">The ears are too big. Make them smaller but keep the face.</div>
      <p className="m-0 text-[15px]">Here is the change order. Nothing has run yet.</p>
      <span className="text-[12.5px] text-[#6b6b6b]">MakeReady, shown by the host</span>
      <div className="rounded-[18px] border border-[#e3e3e3]">
        <McpView model={{ kind: "plan_refinement", result: plan }} notChecked={[...NotChecked]} appUrl={null} theme="light" onAction={noop} />
      </div>
      <figcaption className="text-[12.5px] text-[#6b6b6b]">The real in-chat card, filled with example data.</figcaption>
    </figure>
  );
}
