"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { actDuration, BALL, ballPath, bodyTransform, frame, HOLDS_AFTER, mPath, REST, type Act, type Mood, type Pose } from "./engine";

/** Flat paint with cel shading: a base, a shade crescent, a light crescent, one ink line. */
export interface HamurPalette {
  body: string; bodyShade: string; bodyLight: string;
  dough: string; doughShade: string; doughLight: string;
  ink: string; cheek: string; shadow: string;
}
export const PAINT: HamurPalette = {
  body: "#ffd400", bodyShade: "#e8a800", bodyLight: "#ffec7a",
  dough: "#f4ecdc", doughShade: "#d8c9ae", doughLight: "#fffaf0",
  ink: "#000000", cheek: "#ff8d5c", shadow: "rgba(0,0,0,0.16)",
};
export const PAINT_ON_DARK: HamurPalette = { ...PAINT, shadow: "rgba(0,0,0,0.45)" };

export const VIEW = { x: -20, y: -150, w: 800, h: 570 };
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Base, shade along the lower right, light along the upper left, then the ink line. */
function Shaded({ d, id, base, shade, light, ink, line }: { d: string; id: string; base: string; shade: string; light: string; ink: string; line: number }) {
  return (
    <>
      <clipPath id={`${id}c`}><path d={d} /></clipPath>
      <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="-400" y="-400" width="1600" height="1400">
        <path d={d} fill="#fff" />
        <path d={d} fill="#000" transform="translate(9 12)" />
      </mask>
      <path d={d} fill={shade} />
      <g clipPath={`url(#${id}c)`}>
        <path d={d} fill={base} transform="translate(-11 -15)" />
        <path d={d} fill={light} mask={`url(#${id}m)`} />
      </g>
      <path d={d} fill="none" stroke={ink} strokeWidth={line} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </>
  );
}

/** One still of Hamur and its dough. The live character and every sheet pose draw through this. */
export function HamurArt({ pose, size, paint = PAINT, line = 2.4, ground = false, label, onBall }: {
  pose: Pose; size: number; paint?: HamurPalette; line?: number; ground?: boolean; label?: string; onBall?: () => void;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const shift = pose.reach * 22;
  const eye = (x: number) => {
    const ry = 16 * pose.eyeScale * pose.eye;
    const cx = x + shift + pose.lookX * 11, cy = 210 + pose.lookY * 8;
    if (ry < 3.5) {
      // closed: a soft upturned line, like a smile with the eyes
      return <path key={x} d={`M${cx - 11 * pose.eyeScale} ${cy + 2}q${11 * pose.eyeScale} -9 ${22 * pose.eyeScale} 0`} fill="none" stroke={paint.ink} strokeWidth={line * 1.1} strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
    }
    return (
      <g key={x}>
        <ellipse cx={cx} cy={cy} rx={10 * pose.eyeScale} ry={ry} fill={paint.ink} />
        <circle cx={cx - 3 * pose.eyeScale} cy={cy - ry * 0.45} r={3.4 * pose.eyeScale} fill="#fff" />
      </g>
    );
  };
  const groundLift = Math.max(0, 1 - pose.lift / 220);
  const front = pose.hug > 0.3 || pose.ballX < 540;
  const showBall = pose.ballShow > 0.02;
  const ballOnGround = Math.max(0, 1 - Math.abs(pose.ballY - (390 - BALL.ry)) / 90);
  const bodyD = mPath(pose), doughD = ballPath(pose);
  const pawX = BALL.rx * pose.ballSX * (0.92 - pose.dentSides * 0.6);
  const paw = (side: -1 | 1) => {
    const from = { x: 300 + side * 104, y: 382 };
    const to = { x: BALL.heldLocalX + side * pawX, y: BALL.heldLocalY + 22 };
    const cx = from.x + (to.x - from.x) * pose.hug, cy = from.y + (to.y - from.y) * pose.hug;
    return (
      <g key={side} transform={`rotate(${side * -32} ${cx} ${cy})`}>
        <ellipse cx={cx} cy={cy} rx={36} ry={27} fill={paint.body} stroke={paint.ink} strokeWidth={line} vectorEffect="non-scaling-stroke" />
        <path d={`M${cx - 18} ${cy - 10}q14 -10 30 -4`} fill="none" stroke={paint.bodyLight} strokeWidth={line * 1.6} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </g>
    );
  };

  const body = (
    <g transform={bodyTransform(pose)}>
      <Shaded d={bodyD} id={`b${uid}`} base={paint.body} shade={paint.bodyShade} light={paint.bodyLight} ink={paint.ink} line={line} />
      <ellipse cx={218 + shift + pose.lookX * 6} cy={232} rx={15} ry={8} fill={paint.cheek} opacity={0.45} />
      <ellipse cx={382 + shift + pose.lookX * 6} cy={232} rx={15} ry={8} fill={paint.cheek} opacity={0.45} />
      {eye(252)}
      {eye(348)}
    </g>
  );
  const dough = showBall && (
    <g
      transform={`translate(${pose.ballX.toFixed(1)} ${pose.ballY.toFixed(1)})`}
      {...(onBall ? {
        role: "button", tabIndex: 0, "aria-label": "The idea. Press to squish it.", style: { cursor: "pointer", outline: "none", pointerEvents: "auto" as const },
        onClick: (e: MouseEvent) => { e.stopPropagation(); onBall(); },
        onKeyDown: (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onBall(); } },
      } : {})}
    >
      <Shaded d={doughD} id={`d${uid}`} base={paint.dough} shade={paint.doughShade} light={paint.doughLight} ink={paint.ink} line={line} />
      <path d="M-30 -24q14 -10 30 -6" fill="none" stroke={paint.doughLight} strokeWidth={line * 2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </g>
  );
  return (
    <svg
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
      width={size}
      height={Math.round((size * VIEW.h) / VIEW.w)}
      className="relative block overflow-visible"
      style={onBall ? { pointerEvents: "none" } : undefined}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": !onBall })}
    >
      {ground && <line x1={VIEW.x} x2={VIEW.x + VIEW.w} y1={392} y2={392} stroke={paint.ink} strokeOpacity={0.18} strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      <ellipse cx={300} cy={394} rx={250 * (0.55 + 0.45 * groundLift) * pose.sx} ry={14} fill={paint.shadow} opacity={groundLift} />
      {showBall && ballOnGround > 0 && !front && <ellipse cx={pose.ballX} cy={394} rx={BALL.rx * pose.ballSX} ry={9} fill={paint.shadow} opacity={ballOnGround} />}
      {front ? <>{body}{dough}</> : <>{dough}{body}</>}
      {showBall && pose.hug > 0.05 && <g transform={bodyTransform(pose)}>{paw(-1)}{paw(1)}</g>}
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
  /** Start with the dough in Hamur's arms. */
  holding?: boolean;
  /** Show the dough beside Hamur when it is not held. */
  ball?: boolean;
  /** Every few seconds, play with the dough or react on its own. */
  wander?: boolean;
}

/** Hamur's scene over time: the clock, the gaze, the cues and who holds the dough. */
export function useHamur({ mood = "idle", cue = null, gaze = false, speed = 1, freeze = null, holding = false, ball = true, wander = false }: HamurOptions, anchor: RefObject<Element | null>) {
  const [pose, setPose] = useState<Pose>(REST);
  const s = useRef({
    t: 0, last: -1, act: null as { name: Act; start: number } | null, queue: [] as Act[],
    look: { x: 0, y: 0 }, target: { x: 0, y: 0 }, blinkAt: 2, mood, speed, holding, ball, wander, nextWander: 3.5,
  });
  useEffect(() => { Object.assign(s.current, { mood, speed, ball, wander }); }, [mood, speed, ball, wander]);
  useEffect(() => { s.current.holding = holding; }, [holding]);

  useEffect(() => {
    if (freeze) return;
    const st = s.current;
    if (reduced()) { setPose(frame({ t: 0, mood: st.mood, look: { x: 0, y: 0 }, blinkAt: -9, holding: st.holding, ball: st.ball, still: true })); return; }
    let raf = 0;
    const tick = (now: number) => {
      const dt = st.last < 0 ? 0 : Math.min(0.05, (now - st.last) / 1000);
      st.last = now;
      st.t += dt * st.speed;
      const k = 1 - Math.exp(-dt * 6);
      st.look.x += (st.target.x - st.look.x) * k;
      st.look.y += (st.target.y - st.look.y) * k;
      if (st.t > st.blinkAt + 0.12) st.blinkAt = st.t + 2.6 + Math.random() * 2.8;
      if (st.act && st.t - st.act.start > actDuration(st.act.name)) {
        const after = HOLDS_AFTER[st.act.name];
        if (after !== undefined) st.holding = after;
        const next = st.queue.shift();
        st.act = next ? { name: next, start: st.t } : null;
      }
      if (st.wander && !st.act && st.t > st.nextWander && st.mood === "idle") {
        // play on its own: a surprise, a thought, or a game with the dough
        const held = st.holding;
        const bag: { name: Act; then?: Act[] }[] = held
          ? [{ name: "sekil" }, { name: "drop" }, { name: "cheer" }, { name: "nod" }, { name: "drop" }]
          : [{ name: "poke", then: ["kavrar"] }, { name: "surprised" }, { name: "think" }, { name: "wiggle" }, { name: "kavrar" }];
        const pick = bag[Math.floor(Math.random() * bag.length)];
        st.act = { name: pick.name, start: st.t };
        st.queue = pick.then ? [...pick.then] : [];
        st.nextWander = st.t + 5 + Math.random() * 5;
      }
      setPose(frame({ t: st.t, mood: st.mood, act: st.act, look: st.look, blinkAt: st.blinkAt, holding: st.holding, ball: st.ball }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); st.last = -1; };
  }, [freeze]);

  const play = (name: Act, then: Act[] = []) => {
    if (reduced()) return;
    const st = s.current;
    // grabbing what you already hold, or dropping what you do not, does nothing
    if (name === "kavrar" && (st.holding || st.mood === "holding" || st.mood === "working")) name = "sekil";
    if (name === "drop" && !st.holding) return;
    st.act = { name, start: st.t };
    st.queue = then;
  };

  useEffect(() => {
    if (cue) play(cue.act);
  }, [cue?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!gaze || reduced()) { s.current.target = { x: 0, y: 0 }; return; }
    const onMove = (e: PointerEvent) => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const dx = e.clientX - (r.left + r.width * 0.42), dy = e.clientY - (r.top + r.height * 0.5);
      s.current.target = { x: Math.max(-1, Math.min(1, dx / 420)), y: Math.max(-1, Math.min(1, dy / 320)) };
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [gaze, anchor]);

  /** The dough is poked: it wobbles, then Hamur grabs it or hugs it tighter. */
  const poke = () => {
    const st = s.current;
    const held = st.holding || st.mood === "holding" || st.mood === "working";
    play("poke", [held ? "sekil" : "kavrar"]);
  };

  return {
    pose: freeze ?? pose, play, poke,
    current: () => s.current.act?.name ?? null,
    holding: () => s.current.holding,
  };
}

const PLAYS: Act[] = ["cheer", "wiggle", "nod", "think", "surprised"];

export interface HamurProps extends HamurOptions {
  size?: number;
  /** A click plays a move, the dough can be poked and the gaze follows the pointer. */
  playful?: boolean;
  label?: string;
  className?: string;
  paint?: HamurPalette;
}

export function Hamur({ size = 160, mood = "idle", cue = null, playful = false, speed = 1, freeze = null, holding = false, ball = true, wander = false, label, className = "", paint = PAINT }: HamurProps) {
  const anchor = useRef<HTMLSpanElement>(null);
  const h = useHamur({ mood, cue, gaze: playful, speed, freeze, holding, ball, wander }, anchor);
  const art = <HamurArt pose={h.pose} size={size} paint={paint} label={playful ? undefined : label} onBall={playful ? h.poke : undefined} />;
  if (!playful) return <span ref={anchor} className={`inline-block ${className}`}>{art}</span>;
  const play = () => {
    const options = PLAYS.filter((a) => a !== h.current());
    h.play(options[Math.floor(Math.random() * options.length)]);
  };
  return (
    <span ref={anchor} className={`relative inline-block ${className}`}>
      <button
        type="button"
        onClick={play}
        onKeyDown={(e: KeyboardEvent) => { if (e.key === " ") e.preventDefault(); }}
        aria-label={label ? `${label}. Press to make it move.` : "Hamur, the MakeReady character. Press to make it move."}
        className="absolute top-[22%] left-[2%] h-[64%] w-[78%] cursor-pointer rounded-[40%] bg-transparent"
      />
      {art}
    </span>
  );
}
