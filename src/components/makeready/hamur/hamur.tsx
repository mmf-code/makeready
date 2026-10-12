"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { actDuration, bodyTransform, frame, mPath, REST, type Act, type Mood, type Pose } from "./engine";

/** Flat paint: one yellow body, one ink line, ink eyes, a grey stone. No texture. */
export interface HamurPalette { body: string; ink: string; stone: string; shadow: string }
export const PAINT: HamurPalette = { body: "#ffd400", ink: "#000000", stone: "#d6d2ca", shadow: "rgba(0,0,0,0.16)" };
export const PAINT_ON_DARK: HamurPalette = { ...PAINT, shadow: "rgba(0,0,0,0.45)" };

export const VIEW = { x: -20, y: -150, w: 740, h: 570 };
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** One still of Hamur. The live character and every sheet pose draw through this. */
export function HamurArt({ pose, size, paint = PAINT, line = 2.4, ground = false, label }: {
  pose: Pose; size: number; paint?: HamurPalette; line?: number; ground?: boolean; label?: string;
}) {
  const shift = pose.reach * 22;
  const eye = (x: number) => {
    const ry = 15 * pose.eyeScale * pose.eye;
    const cx = x + shift + pose.lookX * 11, cy = 212 + pose.lookY * 8;
    // a closed eye is a short ink line, an open one a solid oval
    return ry < 3
      ? <path key={x} d={`M${cx - 10 * pose.eyeScale} ${cy}q${10 * pose.eyeScale} 5 ${20 * pose.eyeScale} 0`} fill="none" stroke={paint.ink} strokeWidth={line} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      : <ellipse key={x} cx={cx} cy={cy} rx={9 * pose.eyeScale} ry={ry} fill={paint.ink} />;
  };
  const amount = Math.max(pose.pebble, pose.grab);
  const toTip = pose.grab / (pose.grab + pose.pebble + 1e-6);
  const px = 300 + 330 * toTip * pose.reach, py = 322 - 126 * toTip * pose.reach;
  const lift = Math.max(0, 1 - pose.lift / 220);
  return (
    <svg
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
      width={size}
      height={Math.round((size * VIEW.h) / VIEW.w)}
      className="block overflow-visible"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {ground && <line x1={VIEW.x} x2={VIEW.x + VIEW.w} y1={392} y2={392} stroke={paint.ink} strokeOpacity={0.18} strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      <ellipse cx={300} cy={394} rx={250 * (0.55 + 0.45 * lift) * pose.sx} ry={14} fill={paint.shadow} opacity={lift} />
      <g transform={bodyTransform(pose)}>
        <path d={mPath(pose)} fill={paint.body} stroke={paint.ink} strokeWidth={line} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {eye(252)}
        {eye(348)}
        {amount > 0.02 && (
          <ellipse cx={px} cy={py} rx={64 * amount} ry={46 * amount} fill={paint.stone} stroke={paint.ink} strokeWidth={line} vectorEffect="non-scaling-stroke" />
        )}
      </g>
    </svg>
  );
}

export interface HamurOptions {
  mood?: Mood;
  /** Plays `act` once each time `key` changes. */
  cue?: { act: Act; key: string | number } | null;
  /** Gaze follows the pointer. */
  gaze?: boolean;
  speed?: number;
  /** A fixed pose: no clock, no layers. */
  freeze?: Pose | null;
}

/** Hamur's pose over time: the clock, the gaze and the cues. */
export function useHamur({ mood = "idle", cue = null, gaze = false, speed = 1, freeze = null }: HamurOptions, anchor: RefObject<Element | null>) {
  const [pose, setPose] = useState<Pose>(REST);
  const s = useRef({ t: 0, last: -1, act: null as { name: Act; start: number } | null, look: { x: 0, y: 0 }, target: { x: 0, y: 0 }, blinkAt: 2, mood, speed });
  useEffect(() => { s.current.mood = mood; s.current.speed = speed; }, [mood, speed]);

  useEffect(() => {
    if (freeze) return;
    if (reduced()) { setPose(frame({ t: 0, mood: s.current.mood, look: { x: 0, y: 0 }, blinkAt: -9, still: true })); return; }
    let raf = 0;
    const st = s.current;
    const tick = (now: number) => {
      const dt = st.last < 0 ? 0 : Math.min(0.05, (now - st.last) / 1000);
      st.last = now;
      st.t += dt * st.speed;
      const k = 1 - Math.exp(-dt * 6);
      st.look.x += (st.target.x - st.look.x) * k;
      st.look.y += (st.target.y - st.look.y) * k;
      if (st.t > st.blinkAt + 0.12) st.blinkAt = st.t + 2.6 + Math.random() * 2.8;
      if (st.act && st.t - st.act.start > actDuration(st.act.name) + 0.2) st.act = null;
      setPose(frame({ t: st.t, mood: st.mood, act: st.act, look: st.look, blinkAt: st.blinkAt }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); st.last = -1; };
  }, [freeze]);

  useEffect(() => {
    if (!cue || reduced()) return;
    s.current.act = { name: cue.act, start: s.current.t };
  }, [cue?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!gaze || reduced()) { s.current.target = { x: 0, y: 0 }; return; }
    const onMove = (e: PointerEvent) => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height * 0.45);
      s.current.target = { x: Math.max(-1, Math.min(1, dx / 420)), y: Math.max(-1, Math.min(1, dy / 320)) };
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [gaze, anchor]);

  const play = (name: Act) => { if (!reduced()) s.current.act = { name, start: s.current.t }; };
  return { pose: freeze ?? pose, play, current: () => s.current.act?.name ?? null };
}

const PLAYS: Act[] = ["cheer", "wiggle", "nod", "think", "surprised"];

export interface HamurProps extends HamurOptions {
  size?: number;
  /** A click plays a move and the gaze follows the pointer. */
  playful?: boolean;
  label?: string;
  className?: string;
  paint?: HamurPalette;
}

export function Hamur({ size = 160, mood = "idle", cue = null, playful = false, speed = 1, freeze = null, label, className = "", paint = PAINT }: HamurProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const h = useHamur({ mood, cue, gaze: playful, speed, freeze }, anchor);
  const art = <HamurArt pose={h.pose} size={size} paint={paint} label={playful ? undefined : label} />;
  if (!playful) return <span ref={anchor} className={`inline-block ${className}`}>{art}</span>;
  const play = () => {
    const options = PLAYS.filter((a) => a !== h.current());
    h.play(options[Math.floor(Math.random() * options.length)]);
  };
  return (
    <span ref={anchor} className={`inline-block ${className}`}>
      <button
        type="button"
        onClick={play}
        onKeyDown={(e: KeyboardEvent) => { if (e.key === " ") e.preventDefault(); }}
        aria-label={label ? `${label}. Press to make it move.` : "Hamur, the MakeReady character. Press to make it move."}
        className="block cursor-pointer rounded-3xl bg-transparent p-0"
      >
        {art}
      </button>
    </span>
  );
}
