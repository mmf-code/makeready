"use client";

import { useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Logo } from "../brand";
import { actDuration, frame, REST, type Act, type Mood, type Pose } from "./engine";
import { HamurArt, PAINT, PAINT_ON_DARK, useHamur, type HamurPalette } from "./hamur";

const MOODS: { id: Mood; label: string; use: string }[] = [
  { id: "idle", label: "Idle", use: "Waiting, gaze follows you" },
  { id: "working", label: "Working", use: "An agent job is running" },
  { id: "holding", label: "Holding", use: "Carries the idea between stations" },
  { id: "worried", label: "Worried", use: "A station reported a problem" },
  { id: "happy", label: "Happy", use: "Delivered" },
];
const ACTS: { id: Act; label: string; use: string }[] = [
  { id: "kavrar", label: "Grab the idea", use: "You approve the start. Reaches, presses the dough, brings it in, hugs." },
  { id: "sekil", label: "Squeeze", use: "A version is saved. Hugs the dough tight, twice." },
  { id: "drop", label: "Put it down", use: "The idea goes to a maker." },
  { id: "poke", label: "Poke the dough", use: "Same as clicking the dough." },
  { id: "hop", label: "Hop", use: "Moves to the next station." },
  { id: "cheer", label: "Cheer", use: "Checks passed." },
  { id: "surprised", label: "Surprised", use: "A problem arrives." },
  { id: "shake", label: "Shake", use: "A request failed." },
  { id: "think", label: "Think", use: "The foreman is planning." },
  { id: "nod", label: "Nod", use: "A change order is approved." },
  { id: "wiggle", label: "Wiggle", use: "Pressed for fun." },
];
const RANGES: Record<keyof Pose, [number, number, number]> = {
  sx: [0.7, 1.3, 0.01], sy: [0.7, 1.3, 0.01], lift: [0, 140, 1], skew: [-0.3, 0.3, 0.01], tilt: [-15, 15, 0.5],
  dip: [-0.5, 1, 0.01], humpL: [-0.6, 0.8, 0.01], humpR: [-0.6, 0.8, 0.01], spread: [-1, 1, 0.01], reach: [0, 1.2, 0.01], curl: [0, 1, 0.01], hug: [0, 1, 0.01],
  eye: [0, 1.2, 0.01], eyeScale: [0.6, 1.6, 0.01], lookX: [-1, 1, 0.01], lookY: [-1, 1, 0.01],
  ballX: [150, 700, 1], ballY: [150, 360, 1], ballSX: [0.6, 1.5, 0.01], ballSY: [0.6, 1.5, 0.01], dentA: [-3.14, 3.14, 0.01], dentD: [0, 0.4, 0.01], dentSides: [0, 0.4, 0.01], ballShow: [0, 1, 1],
};
const SURFACES: { id: string; label: string; bg: string; paint: HamurPalette; ink: string }[] = [
  { id: "floor", label: "Concrete", bg: "#e7e8e3", paint: PAINT, ink: "#000" },
  { id: "dark", label: "Work cell", bg: "#17191c", paint: PAINT_ON_DARK, ink: "#f2f2ee" },
  { id: "paper", label: "Paper", bg: "#ffffff", paint: PAINT, ink: "#000" },
];

const at = (act: Act | null, u: number, mood: Mood = "idle", holding = false): Pose =>
  frame({ t: 10 + u * (act ? actDuration(act) : 1), mood, act: act ? { name: act, start: 10 } : null, look: { x: 0.25, y: 0 }, blinkAt: -9, holding, ball: true });

const KEYS: { title: string; pose: Pose }[] = [
  { title: "Rest, idea beside", pose: at(null, 0) },
  { title: "Notices", pose: at("kavrar", 0.1) },
  { title: "Reaches", pose: at("kavrar", 0.34) },
  { title: "Presses the dough", pose: at("kavrar", 0.44) },
  { title: "Lifts it", pose: at("kavrar", 0.62) },
  { title: "Hugs it", pose: at("kavrar", 0.92) },
  { title: "Holding", pose: at(null, 0, "holding") },
  { title: "Squeeze", pose: at("sekil", 0.27, "holding") },
  { title: "Kneading", pose: at(null, 0.24, "working") },
  { title: "Cheer, air", pose: at("cheer", 0.45, "holding") },
  { title: "Surprised", pose: at("surprised", 0.3, "holding") },
  { title: "Worried", pose: at(null, 0, "worried", true) },
];

export function HamurSheet() {
  const [mood, setMood] = useState<Mood>("idle");
  const [speed, setSpeed] = useState(1);
  const [gaze, setGaze] = useState(true);
  const [surface, setSurface] = useState(SURFACES[0]);
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<Pose>({ ...REST });
  const [copied, setCopied] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const live = useHamur({ mood, gaze, speed, freeze: editing ? edit : null }, anchor);

  useEffect(() => { if (!copied) return; const id = setTimeout(() => setCopied(false), 1600); return () => clearTimeout(id); }, [copied]);
  const json = useMemo(() => JSON.stringify(Object.fromEntries(Object.entries(edit).map(([k, v]) => [k, Math.round(v * 100) / 100]))), [edit]);
  const copy = async () => { try { await navigator.clipboard.writeText(json); setCopied(true); } catch { setCopied(false); } };

  return (
    <div className="mx-auto flex max-w-[1480px] flex-col gap-8 px-4 py-8 sm:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b-2 border-ink pb-5">
        <div className="flex flex-col gap-2">
          <h1 className="mr-heading m-0 text-[44px]">Hamur</h1>
          <p className="m-0 max-w-[46em] text-[17px] text-ink-2">The MakeReady character: one M shape, drawn in flat vector and moved in code. Every frame is a function of time, so this sheet, the app and a paused page all draw the same thing.</p>
        </div>
        <span className="rounded-full border-[1.5px] border-dashed border-ink-2 px-3 py-1 text-[13px] font-bold text-ink-2">Development only</span>
      </header>

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <div ref={anchor} className="grid min-h-[480px] place-items-center rounded-[22px] border-[1.5px] border-line" style={{ background: surface.bg }}>
            <HamurArt pose={live.pose} size={500} paint={surface.paint} ground onBall={editing ? undefined : () => live.poke()} />
          </div>

          <Group title="Mood" note="What Hamur does between moves.">
            {MOODS.map((m) => (
              <Chip key={m.id} on={mood === m.id && !editing} onClick={() => { setEditing(false); setMood(m.id); }} title={m.use}>{m.label}</Chip>
            ))}
          </Group>
          <p className="m-0 text-[14px] text-ink-2">Click the dough to squish it. Hamur grabs it from the ground, or hugs it tighter if it is already holding it.</p>
          <Group title="Moves" note="Each one plays once. Hover a move to see where the app uses it.">
            {ACTS.map((a) => (
              <Chip key={a.id} onClick={() => { setEditing(false); live.play(a.id); }} title={a.use}>{a.label}</Chip>
            ))}
          </Group>
          <div className="flex flex-wrap gap-6">
            <Group title="Speed">
              {[0.25, 0.5, 1].map((v) => <Chip key={v} on={speed === v} onClick={() => setSpeed(v)}>{`${v}×`}</Chip>)}
            </Group>
            <Group title="Surface">
              {SURFACES.map((s) => <Chip key={s.id} on={surface.id === s.id} onClick={() => setSurface(s)}>{s.label}</Chip>)}
            </Group>
            <Group title="Gaze">
              <Chip on={gaze} onClick={() => setGaze((g) => !g)}>{gaze ? "Follows the pointer" : "Looks ahead"}</Chip>
            </Group>
          </div>
        </div>

        <aside className="flex min-w-0 flex-col gap-4 rounded-[22px] border-[1.5px] border-line bg-panel p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="mr-heading m-0 text-[22px]">Pose editor</h2>
            <div className="flex flex-wrap gap-2">
              <Chip on={editing} onClick={() => { if (!editing) setEdit({ ...live.pose }); setEditing((e) => !e); }}>{editing ? "Editing, clock stopped" : "Freeze this frame"}</Chip>
              <Chip onClick={() => { setEdit({ ...REST }); setEditing(true); }}>Reset to rest</Chip>
            </div>
          </div>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-x-5 gap-y-3">
            {(Object.keys(RANGES) as (keyof Pose)[]).map((key) => {
              const [min, max, step] = RANGES[key];
              const value = editing ? edit[key] : live.pose[key];
              return (
                <label key={key} className="flex flex-col gap-1 text-[13px]">
                  <span className="flex justify-between font-bold"><span>{key}</span><span className="font-mono font-medium tabular-nums text-ink-2">{value.toFixed(2)}</span></span>
                  <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => { setEditing(true); setEdit((p) => ({ ...(editing ? p : live.pose), [key]: Number(e.target.value) })); }} className="accent-black" />
                </label>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t-[1.5px] border-dashed border-line pt-4">
            <button type="button" onClick={copy} className="inline-flex min-h-11 items-center rounded-full border-[1.5px] border-tape-ink bg-tape px-4 font-bold text-tape-ink">{copied ? "Copied" : "Copy pose JSON"}</button>
            <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2">{json}</code>
          </div>
        </aside>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="mr-heading m-0 text-[22px]">Key poses</h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
          {KEYS.map((k) => (
            <button key={k.title} type="button" onClick={() => { setEdit({ ...k.pose }); setEditing(true); }}
              className="flex flex-col items-center gap-2 rounded-2xl border-[1.5px] border-line bg-panel p-3 text-[13px] font-bold hover:border-ink">
              <HamurArt pose={k.pose} size={130} />
              {k.title}
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="mr-heading m-0 text-[22px]">Sizes in the app</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {SURFACES.map((s) => (
            <div key={s.id} className="flex items-end justify-around gap-4 rounded-2xl border-[1.5px] border-line p-5" style={{ background: s.bg, color: s.ink }}>
              <Sized label="Logo, 28 px"><Logo className="h-7 w-[44px]" /></Sized>
              <Sized label="Line token, 58 px"><HamurArt pose={live.pose} size={58} paint={s.paint} /></Sized>
              <Sized label="Form, 150 px"><HamurArt pose={live.pose} size={150} paint={s.paint} /></Sized>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Group({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3"><h3 className="m-0 text-[14px] font-extrabold">{title}</h3>{note && <span className="text-[13px] text-ink-2">{note}</span>}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}
function Chip({ on = false, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean }) {
  return (
    <button type="button" aria-pressed={on} {...props}
      className={`inline-flex min-h-11 items-center rounded-full border-[1.5px] px-4 text-[14px] font-bold ${on ? "border-ink bg-ink text-panel" : "border-line bg-panel text-ink hover:border-ink"}`}>
      {children}
    </button>
  );
}
function Sized({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-col items-center gap-2 text-[12px] font-semibold">{children}<span className="opacity-75">{label}</span></div>;
}
