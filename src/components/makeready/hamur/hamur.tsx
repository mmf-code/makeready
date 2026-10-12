"use client";

import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { bodyTransform, frame, mPath, REST, type Act, type Mood, type Pose } from "./engine";

export interface HamurProps {
  /** Width in px. Height follows the frame. */
  size?: number;
  mood?: Mood;
  /** Plays `act` once each time `key` changes. */
  cue?: { act: Act; key: string | number } | null;
  /** Gaze follows the pointer and a click plays a move. */
  playful?: boolean;
  /** Accessible name. Without it the character is decorative. */
  label?: string;
  className?: string;
}

const VIEW = { x: -10, y: -140, w: 720, h: 560 };
const PLAYS: Act[] = ["cheer", "wiggle", "nod", "think", "surprised"];
const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Hamur({ size = 160, mood = "idle", cue = null, playful = false, label, className = "" }: HamurProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const svg = useRef<SVGSVGElement>(null);
  const body = useRef<SVGGElement>(null);
  const path = useRef<SVGPathElement>(null);
  const eyes = useRef<[SVGEllipseElement | null, SVGEllipseElement | null]>([null, null]);
  const pebble = useRef<SVGGElement>(null);
  const shadow = useRef<SVGEllipseElement>(null);
  const state = useRef({ t0: 0, act: null as { name: Act; start: number } | null, look: { x: 0, y: 0 }, target: { x: 0, y: 0 }, blinkAt: 2, last: -1 as number, mood });
  useEffect(() => { state.current.mood = mood; }, [mood]);

  // draw one pose into the SVG without re-rendering React
  const draw = (p: Pose) => {
    path.current?.setAttribute("d", mPath(p));
    body.current?.setAttribute("transform", bodyTransform(p));
    const shift = p.reach * 22;
    [[252, 212], [348, 212]].forEach(([x, y], i) => {
      const e = eyes.current[i];
      if (!e) return;
      e.setAttribute("cx", (x + shift + p.lookX * 11).toFixed(1));
      e.setAttribute("cy", (y + p.lookY * 8).toFixed(1));
      e.setAttribute("rx", (9 * p.eyeScale).toFixed(2));
      e.setAttribute("ry", Math.max(0.8, 15 * p.eyeScale * p.eye).toFixed(2));
    });
    const amount = Math.max(p.pebble, p.grab);
    if (pebble.current) {
      const toTip = p.grab / (p.grab + p.pebble + 1e-6);
      const cx = 300 + (630 - 300) * toTip * p.reach;
      const cy = 322 + (196 - 322) * toTip * p.reach;
      pebble.current.setAttribute("transform", `translate(${cx.toFixed(1)} ${cy.toFixed(1)}) scale(${amount.toFixed(3)})`);
      pebble.current.style.opacity = amount > 0.02 ? "1" : "0";
    }
    if (shadow.current) {
      const k = Math.max(0, 1 - p.lift / 220);
      shadow.current.setAttribute("rx", (250 * (0.55 + 0.45 * k) * p.sx).toFixed(1));
      shadow.current.style.opacity = (0.22 * k).toFixed(3);
    }
  };

  // the clock
  useEffect(() => {
    const s = state.current;
    if (reduced()) { draw(frame({ t: 0, mood: s.mood, look: { x: 0, y: 0 }, blinkAt: -9, still: true })); return; }
    let raf = 0;
    s.t0 = performance.now();
    const tick = (now: number) => {
      const t = (now - s.t0) / 1000;
      const dt = s.last < 0 ? 0 : t - s.last;
      s.last = t;
      const k = 1 - Math.exp(-dt * 6);
      s.look.x += (s.target.x - s.look.x) * k;
      s.look.y += (s.target.y - s.look.y) * k;
      if (t > s.blinkAt + 0.12) s.blinkAt = t + 2.6 + Math.random() * 2.8;
      if (s.act && t - s.act.start > 3) s.act = null;
      draw(frame({ t, mood: s.mood, act: s.act, look: s.look, blinkAt: s.blinkAt }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // cues from the page
  useEffect(() => {
    if (!cue || reduced()) return;
    const s = state.current;
    s.act = { name: cue.act, start: (performance.now() - s.t0) / 1000 };
  }, [cue?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // gaze follows the pointer
  useEffect(() => {
    if (!playful || reduced()) return;
    const onMove = (e: PointerEvent) => {
      const r = svg.current?.getBoundingClientRect();
      if (!r) return;
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height * 0.45);
      state.current.target = { x: Math.max(-1, Math.min(1, dx / 420)), y: Math.max(-1, Math.min(1, dy / 320)) };
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [playful]);

  const play = () => {
    if (reduced()) return;
    const s = state.current;
    const options = PLAYS.filter((a) => a !== s.act?.name);
    s.act = { name: options[Math.floor(Math.random() * options.length)], start: (performance.now() - s.t0) / 1000 };
  };

  const art = (
    <svg
      ref={svg}
      viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
      width={size}
      height={Math.round((size * VIEW.h) / VIEW.w)}
      className="block overflow-visible"
      {...(label && !playful ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <defs>
        <radialGradient id={`body${uid}`} cx="36%" cy="24%" r="90%">
          <stop offset="0" stopColor="#ffe86a" />
          <stop offset="0.5" stopColor="#ffd400" />
          <stop offset="1" stopColor="#e3a900" />
        </radialGradient>
        <radialGradient id={`peb${uid}`} cx="38%" cy="32%" r="85%">
          <stop offset="0" stopColor="#f6f4ee" />
          <stop offset="0.6" stopColor="#d9d5cc" />
          <stop offset="1" stopColor="#b3ada2" />
        </radialGradient>
        <PlushFilter id={`plush${uid}`} shade="#7a5600" light="#fff7c2" fur="#ffd400" unitsPerPx={VIEW.w / size} />
        <PlushFilter id={`plushPeb${uid}`} shade="#5e594f" light="#ffffff" fur="#d9d5cc" unitsPerPx={VIEW.w / size} />
      </defs>
      <ellipse ref={shadow} cx="300" cy="396" rx="250" ry="18" fill="#1c1c21" opacity="0.22" style={{ filter: "blur(6px)" }} />
      <g ref={body}>
        <path ref={path} d={mPath(REST)} fill={`url(#body${uid})`} filter={`url(#plush${uid})`} />
        <ellipse ref={(e) => { eyes.current[0] = e; }} cx="252" cy="212" rx="9" ry="15" fill="#000000" />
        <ellipse ref={(e) => { eyes.current[1] = e; }} cx="348" cy="212" rx="9" ry="15" fill="#000000" />
        <g ref={pebble} style={{ opacity: 0 }}>
          <ellipse cx="0" cy="0" rx="64" ry="46" fill={`url(#peb${uid})`} filter={`url(#plushPeb${uid})`} />
        </g>
      </g>
    </svg>
  );

  if (!playful) return <span className={`inline-block ${className}`}>{art}</span>;
  return (
    <button
      type="button"
      onClick={play}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === " ") e.preventDefault(); }}
      aria-label={label ?? "Hamur, the MakeReady character. Press to make it move."}
      className={`inline-block cursor-pointer rounded-3xl bg-transparent p-0 ${className}`}
    >
      {art}
    </button>
  );
}

/**
 * Plush: light from the top left. A soft inner shadow along the lower right
 * edge and a pale lift along the upper left give the volume. Fibres and a fringe
 * of short hairs outside the silhouette give the pile. Noise frequencies are set
 * per screen pixel, so the fur reads the same at 58 px and at 300 px.
 */
function PlushFilter({ id, shade, light, fur, unitsPerPx }: { id: string; shade: string; light: string; fur: string; unitsPerPx: number }) {
  const u = Math.max(1, unitsPerPx);
  const fibre = (0.55 / u).toFixed(4);
  const hairs = (0.9 / u).toFixed(4);
  const fuzz = (0.18 / u).toFixed(4);
  return (
    <filter id={id} x="-15%" y="-15%" width="130%" height="130%" colorInterpolationFilters="sRGB">
      <feGaussianBlur in="SourceAlpha" stdDeviation="16" result="blur" />
      <feOffset in="blur" dx="-14" dy="-20" result="towardLight" />
      <feComposite in="SourceAlpha" in2="towardLight" operator="out" result="lowEdge" />
      <feGaussianBlur in="lowEdge" stdDeviation="10" result="lowEdgeSoft" />
      <feFlood floodColor={shade} floodOpacity="0.55" />
      <feComposite in2="lowEdgeSoft" operator="in" result="shade" />
      <feOffset in="blur" dx="12" dy="18" result="awayLight" />
      <feComposite in="SourceAlpha" in2="awayLight" operator="out" result="highEdge" />
      <feGaussianBlur in="highEdge" stdDeviation="9" result="highEdgeSoft" />
      <feFlood floodColor={light} floodOpacity="0.6" />
      <feComposite in2="highEdgeSoft" operator="in" result="lift" />
      <feMerge result="volume">
        <feMergeNode in="SourceGraphic" />
        <feMergeNode in="shade" />
        <feMergeNode in="lift" />
      </feMerge>
      {/* pile: fibres at about two per pixel, strong enough to read */}
      <feTurbulence type="fractalNoise" baseFrequency={fibre} numOctaves="3" seed="11" result="fibre" />
      <feColorMatrix in="fibre" type="saturate" values="0" result="fibreGrey" />
      <feComponentTransfer in="fibreGrey" result="fibreSoft">
        <feFuncA type="linear" slope="0" intercept="0.42" />
      </feComponentTransfer>
      <feBlend in="fibreSoft" in2="volume" mode="soft-light" result="velvet" />
      <feComposite in="velvet" in2="SourceAlpha" operator="in" result="inside" />
      {/* fringe: short hairs just outside the edge */}
      <feMorphology in="SourceAlpha" operator="dilate" radius={(2.2 * u).toFixed(1)} result="grow" />
      <feComposite in="grow" in2="SourceAlpha" operator="out" result="rim" />
      <feTurbulence type="fractalNoise" baseFrequency={hairs} numOctaves="2" seed="21" result="hairNoise" />
      <feColorMatrix in="hairNoise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 7 -3.2" result="hairMask" />
      <feComposite in="hairMask" in2="rim" operator="in" result="hairs" />
      <feFlood floodColor={fur} />
      <feComposite in2="hairs" operator="in" result="fringe" />
      <feMerge result="plush">
        <feMergeNode in="fringe" />
        <feMergeNode in="inside" />
      </feMerge>
      <feTurbulence type="fractalNoise" baseFrequency={fuzz} numOctaves="1" seed="4" result="fuzz" />
      <feDisplacementMap in="plush" in2="fuzz" scale={(2.2 * u).toFixed(1)} xChannelSelector="R" yChannelSelector="G" />
    </filter>
  );
}
