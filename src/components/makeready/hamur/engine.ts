/**
 * Hamur, the MakeReady clay M. Every frame is a pure function of time:
 * a key pose from the current act, plus organic layers (breath, blinks,
 * gaze). No React here, so the logo, the hero and the production line all
 * draw the same character.
 *
 * Frame: 600 × 400 units, ground at y = 390, centre at x = 300.
 */

export interface Pose {
  sx: number; sy: number;      // squash and stretch around the feet
  lift: number;                // height above the ground
  skew: number;                // lean, as a skew of the top over the feet
  tilt: number;                // rotation in degrees around the feet
  dip: number;                 // extra depth of the valley between the humps
  humpL: number; humpR: number; // extra hump height, 0 = rest
  spread: number;              // feet apart (+) or together (−)
  reach: number;               // right hump stretches out to grab, 0..1
  eye: number;                 // eye openness, 1 = rest
  eyeScale: number;            // eye size, 1 = rest
  lookX: number; lookY: number; // gaze, −1..1
  pebble: number;              // the yellow idea held in the arch, 0..1
  grab: number;                // the pebble sits at the tip of the reach, 0..1
}

export const REST: Pose = {
  sx: 1, sy: 1, lift: 0, skew: 0, tilt: 0, dip: 0, humpL: 0, humpR: 0, spread: 0,
  reach: 0, eye: 1, eyeScale: 1, lookX: 0, lookY: 0, pebble: 0, grab: 0,
};

export type Mood = "idle" | "working" | "holding" | "worried" | "happy";
export type Act = "cheer" | "nod" | "think" | "surprised" | "wiggle" | "kavrar" | "sekil" | "hop" | "shake";

/* ---------- easing ---------- */
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
export const ease = {
  inOut: (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  out: (u: number) => 1 - Math.pow(1 - u, 3),
  /** Passes the key and comes back: a snap with life in it. */
  overshoot: (u: number) => { const c = 1.9; return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2); },
  /** A damped spring: arrives fast, swings past, settles. */
  spring: (u: number) => (u >= 1 ? 1 : 1 - Math.exp(-6 * u) * Math.cos(10.5 * u)),
};

/* ---------- the M ---------- */
const f = (n: number) => n.toFixed(1);

/** The clay M outline for a pose. Same topology as the logo, so it never tears. */
export function mPath(p: Pose = REST): string {
  const s = p.spread * 34;
  const L = -s, R = s;                       // foot offsets
  const d = p.dip * 46;                      // valley depth
  const hl = p.humpL * 44, hr = p.humpR * 44; // hump heights
  const rx = p.reach * 150, ry = p.reach * 70; // reach out and down
  return [
    `M${f(62 + L)} 390`,
    `C${f(32 + L)} 390 ${f(26 + L)} 362 ${f(30 + L)} 330`,
    `C${f(38 + L)} 236 ${f(52 + L * 0.6)} ${f(140 - hl * 0.5)} ${f(86 + L * 0.4)} ${f(84 - hl * 0.8)}`,
    `C116 ${f(34 - hl)} 160 ${f(14 - hl)} 204 ${f(18 - hl)}`,
    `C252 ${f(22 - hl * 0.6)} 280 ${f(58 + d * 0.6)} 300 ${f(82 + d)}`,
    `C312 ${f(96 + d)} 330 ${f(96 + d)} 342 ${f(82 + d)}`,
    `C${f(366 + rx * 0.2)} ${f(54 - hr + ry * 0.3)} ${f(398 + rx * 0.5)} ${f(32 - hr + ry * 0.6)} ${f(440 + rx)} ${f(36 - hr + ry)}`,
    `C${f(500 + rx * 1.1)} ${f(42 - hr * 0.6 + ry)} ${f(548 + R * 0.4 + rx * 0.9)} ${f(92 + ry * 1.4)} ${f(562 + R * 0.6 + rx * 0.5)} ${f(172 + ry * 0.9)}`,
    `C${f(576 + R)} 250 ${f(576 + R)} 322 ${f(572 + R)} 352`,
    `C${f(569 + R)} 380 ${f(553 + R)} 390 ${f(528 + R)} 390`,
    `L${f(470 + R)} 390`,
    `C${f(444 + R)} 390 ${f(434 + R)} 376 ${f(431 + R * 0.9)} 350`,
    `C${f(425 + R * 0.7)} 302 ${f(406 + R * 0.4)} 258 380 248`,
    `C356 240 344 266 334 292`,
    `C324 314 300 320 285 302`,
    `C272 286 264 256 244 248`,
    `C${f(220 + L * 0.4)} 238 ${f(200 + L * 0.7)} 268 ${f(192 + L * 0.9)} 302`,
    `C${f(185 + L)} 336 ${f(184 + L)} 362 ${f(179 + L)} 377`,
    `C${f(174 + L)} 388 ${f(164 + L)} 390 ${f(150 + L)} 390Z`,
  ].join("");
}

export const REST_PATH = mPath(REST);

/** Group transform: rotate, skew and squash around the feet, then lift. */
export function bodyTransform(p: Pose): string {
  return `translate(300 ${f(390 - p.lift)}) rotate(${f(p.tilt)}) skewX(${f(p.skew * 57.3)}) scale(${p.sx.toFixed(3)} ${p.sy.toFixed(3)}) translate(-300 -390)`;
}

/* ---------- acts: key poses over normalised time ---------- */
type Partial = { [K in keyof Pose]?: number };
const DUR: Record<Act, number> = { cheer: 1.25, nod: 0.9, think: 1.6, surprised: 1.1, wiggle: 1.0, kavrar: 1.9, sekil: 1.8, hop: 0.62, shake: 0.7 };
export const actDuration = (a: Act) => DUR[a];

function act(a: Act, u: number): Partial {
  const bump = (from: number, to: number) => Math.sin(Math.PI * clamp((u - from) / (to - from)));
  switch (a) {
    case "cheer": {
      // anticipate (squash), launch (stretch), land (squash), settle with a spring
      const squash = u < 0.18 ? ease.out(u / 0.18) : u < 0.3 ? 1 - (u - 0.18) / 0.12 : 0;
      const air = bump(0.22, 0.72);
      const land = bump(0.7, 0.86);
      const settle = u > 0.86 ? 1 - ease.spring((u - 0.86) / 0.14) : 0;
      return {
        sy: 1 - 0.16 * squash + 0.12 * air - 0.14 * land + 0.04 * settle,
        sx: 1 + 0.14 * squash - 0.08 * air + 0.12 * land,
        lift: 110 * air, humpL: 0.35 * air, humpR: 0.35 * air, eye: 1 - 0.75 * air, eyeScale: 1 + 0.1 * air,
      };
    }
    case "hop": {
      const air = bump(0.15, 0.8);
      const squash = bump(0, 0.18) + bump(0.78, 1);
      return { lift: 46 * air, sy: 1 - 0.12 * squash + 0.08 * air, sx: 1 + 0.1 * squash - 0.05 * air, skew: -0.08 * air };
    }
    case "nod": {
      const n = Math.sin(u * Math.PI * 4) * (1 - u);
      return { skew: 0.07 * n, lookY: 0.6 * Math.max(0, n), sy: 1 - 0.03 * Math.abs(n) };
    }
    case "think": {
      const k = bump(0, 1);
      return { tilt: 7 * k, dip: 0.35 * k, lookX: -0.6 * k, lookY: -0.7 * k, eye: 1 - 0.25 * k };
    }
    case "surprised": {
      const k = ease.overshoot(clamp(u / 0.25)) * (1 - ease.inOut(clamp((u - 0.6) / 0.4)));
      return { sy: 1 + 0.14 * k, sx: 1 - 0.07 * k, humpL: 0.45 * k, humpR: 0.45 * k, eyeScale: 1 + 0.45 * k, lift: 14 * k };
    }
    case "wiggle": {
      const w = Math.sin(u * Math.PI * 6) * (1 - u);
      return { humpR: 0.35 * Math.max(0, w), humpL: 0.35 * Math.max(0, -w), tilt: 3 * w };
    }
    case "shake": {
      const w = Math.sin(u * Math.PI * 8) * (1 - u);
      return { skew: 0.06 * w, eye: 0.55, eyeScale: 0.9 };
    }
    case "kavrar": {
      // lean forward, stretch the right hump out like a trunk, close on the idea, bring it home
      const out = ease.overshoot(clamp(u / 0.35));
      const back = ease.inOut(clamp((u - 0.62) / 0.38));
      const k = out * (1 - back);
      return { reach: k, skew: -0.16 * k, lookX: 0.9 * k, lookY: 0.2 * k, grab: clamp(u / 0.3) * (1 - back), pebble: back, sx: 1 + 0.05 * k };
    }
    case "sekil": {
      // feet together, humps fold over the idea, two firm squeezes
      const k = ease.overshoot(clamp(u / 0.3)) * (1 - ease.inOut(clamp((u - 0.75) / 0.25)));
      const squeeze = (bump(0.32, 0.48) + bump(0.52, 0.68)) * k;
      return { spread: -0.7 * k, humpL: -0.25 * k, humpR: -0.25 * k, dip: 0.3 * k, pebble: 1, sy: 1 - 0.08 * squeeze, sx: 1 + 0.07 * squeeze, eye: 1 - 0.6 * squeeze };
    }
  }
}

/* ---------- moods: what the character does between acts ---------- */
function mood(m: Mood, t: number): Partial {
  switch (m) {
    case "working": {
      // kneading: a steady squash, alternating lean
      const k = Math.sin(t * Math.PI * 2 * 1.1);
      return { sy: 1 - 0.06 * Math.max(0, k), sx: 1 + 0.05 * Math.max(0, k), skew: 0.03 * Math.sin(t * Math.PI * 1.1), pebble: 1, spread: -0.4, humpL: -0.12, humpR: -0.12, lookY: 0.5 };
    }
    case "holding":
      return { pebble: 1, spread: -0.45, humpL: -0.1, humpR: -0.1, dip: 0.15 };
    case "worried":
      return { eyeScale: 0.8, sy: 0.97, dip: 0.25, lookY: 0.3 };
    case "happy": {
      const b = Math.max(0, Math.sin(t * Math.PI * 2 * 0.9));
      return { lift: 10 * b, sy: 1 + 0.03 * b, humpL: 0.1, humpR: 0.1, pebble: 1 };
    }
    default:
      return {};
  }
}

export interface FrameInput {
  t: number;            // seconds since mount
  mood: Mood;
  act?: { name: Act; start: number } | null;
  look: { x: number; y: number }; // smoothed gaze target, −1..1
  blinkAt: number;      // next blink time, seconds
  still?: boolean;      // reduced motion: rest pose, no layers
}

/** The whole character at time t. */
export function frame(input: FrameInput): Pose {
  const p: Pose = { ...REST };
  if (input.still) { Object.assign(p, mood(input.mood, 0)); p.sx = 1; p.sy = 1; p.lift = 0; p.skew = 0; return p; }
  const apply = (part: Partial, weight = 1) => {
    for (const [k, v] of Object.entries(part) as [keyof Pose, number][]) {
      const base = REST[k];
      p[k] = k === "sx" || k === "sy" || k === "eye" || k === "eyeScale" ? p[k] * lerp(1, v / (base || 1), weight) : p[k] + (v - base) * weight;
    }
  };
  // breath: soft parts rise and fall
  const breath = Math.sin(input.t * Math.PI * 2 / 3.4);
  p.sy *= 1 + 0.014 * breath;
  p.sx *= 1 - 0.009 * breath;
  apply(mood(input.mood, input.t));
  if (input.act) {
    const u = (input.t - input.act.start) / DUR[input.act.name];
    if (u >= 0 && u <= 1) apply(act(input.act.name, u));
  }
  p.lookX += input.look.x * 0.9;
  p.lookY += input.look.y * 0.6;
  // blink: 110 ms, eyes squeeze shut and reopen
  const since = input.t - input.blinkAt;
  if (since >= 0 && since < 0.11) p.eye *= 0.08 + Math.abs(since / 0.055 - 1) * 0.92;
  return p;
}
