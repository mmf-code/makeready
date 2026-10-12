/**
 * Hamur, the MakeReady clay M, and the idea it shapes: a soft dough ball.
 * Every frame is a pure function of time: a key pose from the current act,
 * plus organic layers (breath, blinks, gaze, the ball's wobble). No React here,
 * so the logo, the sheet and the app all draw the same character.
 *
 * Frame: ground at y = 390, Hamur centred on x = 300. The ball lives in world
 * space so it can sit on the ground beside Hamur or ride in its arms.
 */

export interface Pose {
  sx: number; sy: number;      // squash and stretch around the feet
  lift: number;                // height above the ground
  skew: number;                // lean, as a skew of the top over the feet
  tilt: number;                // rotation in degrees around the feet
  dip: number;                 // extra depth of the valley between the humps
  humpL: number; humpR: number; // extra hump height, 0 = rest
  spread: number;              // feet apart (+) or together (−)
  reach: number;               // right hump stretches out like a trunk, 0..1
  curl: number;                // the trunk bends down toward the ground, 0..1
  hug: number;                 // little paws close around the ball, 0..1
  eye: number;                 // eye openness, 1 = rest
  eyeScale: number;            // eye size, 1 = rest
  lookX: number; lookY: number; // gaze, −1..1
  // the ball, in world space
  ballX: number; ballY: number; // centre
  ballSX: number; ballSY: number; // squash and stretch
  dentA: number; dentD: number; // a press: angle (radians) and depth 0..0.4
  dentSides: number;           // both sides pressed in, as in a hug, 0..0.4
  ballShow: number;            // 0 = no ball, 1 = ball
}

/** Where the ball rests on the ground and where it rides in Hamur's arms (local). */
export const BALL = { rx: 86, ry: 66, groundX: 668, heldLocalX: 300, heldLocalY: 322 };
const GROUND_Y = 390 - BALL.ry;

export const REST: Pose = {
  sx: 1, sy: 1, lift: 0, skew: 0, tilt: 0, dip: 0, humpL: 0, humpR: 0, spread: 0, reach: 0, curl: 0, hug: 0,
  eye: 1, eyeScale: 1, lookX: 0, lookY: 0,
  ballX: BALL.groundX, ballY: GROUND_Y, ballSX: 1, ballSY: 1, dentA: -Math.PI / 2, dentD: 0, dentSides: 0, ballShow: 0,
};

export type Mood = "idle" | "working" | "holding" | "worried" | "happy";
export type Act = "kavrar" | "sekil" | "drop" | "poke" | "cheer" | "nod" | "think" | "surprised" | "wiggle" | "hop" | "shake";

/* ---------- easing ---------- */
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const seg = (u: number, a: number, b: number) => clamp((u - a) / (b - a));
const bump = (u: number, a: number, b: number) => Math.sin(Math.PI * seg(u, a, b));
export const ease = {
  inOut: (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  out: (u: number) => 1 - Math.pow(1 - u, 3),
  /** Passes the key and comes back: a snap with life in it. */
  overshoot: (u: number) => { const c = 1.9; return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2); },
  /** A damped spring: arrives fast, swings past, settles. */
  spring: (u: number) => (u >= 1 ? 1 : 1 - Math.exp(-6 * u) * Math.cos(10.5 * u)),
};
/** Dough wobble after a squeeze: decaying oscillation, starts at full squash. */
const jelly = (since: number, amount: number) => (since < 0 ? 0 : amount * Math.exp(-5 * since) * Math.cos(16 * since));

/* ---------- the M ---------- */
const f = (n: number) => n.toFixed(1);

/** The clay M outline for a pose. Same topology as the logo, so it never tears. */
export function mPath(p: Pose = REST): string {
  const s = p.spread * 34;
  const L = -s, R = s;
  const d = p.dip * 46;
  const hl = p.humpL * 44, hr = p.humpR * 44;
  const rx = p.reach * 150, ry = p.reach * 62 + p.curl * 52; // reach out, curl down
  const cu = p.curl * 46;
  return [
    `M${f(62 + L)} 390`,
    `C${f(32 + L)} 390 ${f(26 + L)} 362 ${f(30 + L)} 330`,
    `C${f(38 + L)} 236 ${f(52 + L * 0.6)} ${f(140 - hl * 0.5)} ${f(86 + L * 0.4)} ${f(84 - hl * 0.8)}`,
    `C116 ${f(34 - hl)} 160 ${f(14 - hl)} 204 ${f(18 - hl)}`,
    `C252 ${f(22 - hl * 0.6)} 280 ${f(58 + d * 0.6)} 300 ${f(82 + d)}`,
    `C312 ${f(96 + d)} 330 ${f(96 + d)} 342 ${f(82 + d)}`,
    `C${f(366 + rx * 0.2)} ${f(54 - hr + ry * 0.3)} ${f(398 + rx * 0.5)} ${f(32 - hr + ry * 0.55)} ${f(440 + rx)} ${f(36 - hr + ry * 0.8)}`,
    `C${f(500 + rx * 1.1 - cu * 0.3)} ${f(42 - hr * 0.6 + ry)} ${f(548 + R * 0.4 + rx * 0.9 - cu * 0.5)} ${f(92 + ry * 1.35 + cu)} ${f(562 + R * 0.6 + rx * 0.45 - cu * 0.6)} ${f(172 + ry * 0.95 + cu * 0.6)}`,
    `C${f(576 + R - cu * 0.4)} 250 ${f(576 + R)} 322 ${f(572 + R)} 352`,
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

/** The same transform for a single local point, so the ball can ride along. */
export function toWorld(p: Pose, x: number, y: number): [number, number] {
  const x1 = (x - 300) * p.sx, y1 = (y - 390) * p.sy;
  const x2 = x1 + Math.tan(p.skew) * y1;
  const a = (p.tilt * Math.PI) / 180;
  return [300 + x2 * Math.cos(a) - y1 * Math.sin(a), 390 - p.lift + x2 * Math.sin(a) + y1 * Math.cos(a)];
}

/** The tip of the trunk, local, for a given reach and curl. */
const trunkTip = (p: Pose): [number, number] => [600 + p.reach * 108 - p.curl * 18, 150 + p.reach * 64 + p.curl * 70];

/** The dough ball outline: an ellipse with soft dents, as a smooth closed path. */
export function ballPath(p: Pose): string {
  const n = 40, pts: [number, number][] = [];
  const g = (d: number) => Math.exp(-(d * d) / (2 * 0.42 * 0.42));
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    let r = 1 - p.dentD * g(wrap(a - p.dentA)) - p.dentSides * (g(wrap(a)) + g(wrap(a - Math.PI)));
    r = Math.max(0.55, r);
    pts.push([BALL.rx * p.ballSX * r * Math.cos(a), BALL.ry * p.ballSY * r * Math.sin(a)]);
  }
  // Catmull-Rom through the points, as cubic Béziers
  const P = (i: number) => pts[(i + n) % n];
  let d = `M${f(P(0)[0])} ${f(P(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const [p0, p1, p2, p3] = [P(i - 1), P(i), P(i + 1), P(i + 2)];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d}Z`;
}

/* ---------- acts: key poses over normalised time ---------- */
type Partial = { [K in keyof Pose]?: number };
const DUR: Record<Act, number> = {
  kavrar: 2.4, sekil: 1.8, drop: 1.3, poke: 1.1, cheer: 1.25, nod: 0.9, think: 1.6, surprised: 1.1, wiggle: 1.0, hop: 0.62, shake: 0.7,
};
export const actDuration = (a: Act) => DUR[a];
/** Acts that change whether Hamur holds the ball once they finish. */
export const HOLDS_AFTER: { [K in Act]?: boolean } = { kavrar: true, drop: false };

interface Ctx { holding: boolean; u: number; t: number }

function act(a: Act, c: Ctx, base: Pose): Partial {
  const u = c.u;
  switch (a) {
    case "kavrar": {
      // 1 notice, 2 reach out and down like a trunk, 3 press the dough, 4 lift and bring it in, 5 hug
      const reachK = ease.overshoot(seg(u, 0.12, 0.38)) * (1 - ease.inOut(seg(u, 0.55, 0.8)));
      const curlK = ease.inOut(seg(u, 0.22, 0.42)) * (1 - ease.inOut(seg(u, 0.5, 0.7)));
      const press = bump(u, 0.36, 0.52);
      const carry = ease.inOut(seg(u, 0.5, 0.8));
      const hugK = ease.overshoot(seg(u, 0.74, 0.92));
      const pose: Partial = {
        reach: reachK, curl: curlK, skew: 0.04 * bump(u, 0, 0.14) - 0.17 * reachK, lookX: 0.9 * (1 - hugK) + 0.1, lookY: 0.4 * (1 - hugK) + 0.3 * hugK,
        sy: 1 - 0.07 * bump(u, 0, 0.14) - 0.05 * press, sx: 1 + 0.06 * bump(u, 0, 0.14) + 0.04 * reachK,
        hug: hugK, spread: -0.45 * hugK, humpL: -0.12 * hugK, humpR: -0.12 * hugK, ballShow: 1,
        dentA: -Math.PI / 2, dentD: 0.32 * press, ballSY: 1 - 0.16 * press + 0.08 * bump(u, 0.52, 0.72), ballSX: 1 + 0.12 * press - 0.05 * bump(u, 0.52, 0.72),
        eye: 1 - 0.65 * bump(u, 0.84, 0.97),
      };
      // ball travels: on the ground, then under the trunk tip, then into the arms
      const pr = { ...base, ...pose } as Pose;
      const [tx, ty] = toWorld(pr, ...trunkTip(pr));
      const [hx, hy] = toWorld(pr, BALL.heldLocalX, BALL.heldLocalY);
      const underTip: [number, number] = [tx - 10, ty + BALL.ry * 0.9];
      const lift = ease.inOut(seg(u, 0.48, 0.6));
      const gx = lerp(BALL.groundX, underTip[0], lift), gy = lerp(GROUND_Y, Math.min(GROUND_Y, underTip[1]), lift);
      pose.ballX = lerp(gx, hx, carry);
      pose.ballY = lerp(gy, hy, carry) - 26 * bump(u, 0.55, 0.8);
      pose.dentSides = 0.18 * bump(u, 0.82, 1);
      return pose;
    }
    case "drop": {
      const out = ease.inOut(seg(u, 0.1, 0.7));
      const pr = { ...base } as Pose;
      const [hx, hy] = toWorld(pr, BALL.heldLocalX, BALL.heldLocalY);
      const land = bump(u, 0.68, 0.86);
      return {
        hug: 1 - ease.inOut(seg(u, 0, 0.3)), spread: -0.45 * (1 - seg(u, 0, 0.3)), skew: -0.08 * bump(u, 0.1, 0.6), ballShow: 1,
        ballX: lerp(hx, BALL.groundX, out), ballY: lerp(hy, GROUND_Y, out) - 70 * bump(u, 0.1, 0.7),
        ballSY: 1 - 0.18 * land + jelly(u - 0.86, 0.06), ballSX: 1 + 0.14 * land - jelly(u - 0.86, 0.05),
        lookX: 0.8 * out, lookY: 0.4 * out,
      };
    }
    case "sekil": {
      // a firm hug, twice; the dough bulges up and down as the sides go in
      const sq = bump(u, 0.15, 0.4) + bump(u, 0.5, 0.75);
      return {
        hug: 1, spread: -0.6, humpL: -0.25 * sq - 0.1, humpR: -0.25 * sq - 0.1, dip: 0.25 * sq, eye: 1 - 0.7 * sq, sy: 1 - 0.06 * sq,
        dentSides: 0.22 * sq, ballSY: 1 + 0.1 * sq + jelly(u - 0.75, 0.05), ballSX: 1 - 0.1 * sq - jelly(u - 0.75, 0.04), ballShow: 1,
      };
    }
    case "poke": {
      // the ball is poked: it wobbles, Hamur looks, holds tighter or flinches
      const w = jelly(u - 0.02, 0.14);
      return c.holding
        ? { ballSY: 1 - w, ballSX: 1 + w * 0.8, dentD: 0.2 * bump(u, 0, 0.25), dentA: -Math.PI / 2, eyeScale: 1 + 0.25 * bump(u, 0, 0.5), lookY: 0.7, hug: 1, dentSides: 0.12 * bump(u, 0.3, 0.7), ballShow: 1 }
        : { ballSY: 1 - w, ballSX: 1 + w * 0.8, dentD: 0.2 * bump(u, 0, 0.25), dentA: -Math.PI / 2, lookX: 1, lookY: 0.5, eyeScale: 1 + 0.3 * bump(u, 0, 0.6), lift: 10 * bump(u, 0, 0.3), ballShow: 1 };
    }
    case "cheer": {
      const squash = u < 0.18 ? ease.out(u / 0.18) : u < 0.3 ? 1 - (u - 0.18) / 0.12 : 0;
      const air = bump(u, 0.22, 0.72), land = bump(u, 0.7, 0.86);
      const settle = u > 0.86 ? 1 - ease.spring((u - 0.86) / 0.14) : 0;
      return {
        sy: 1 - 0.16 * squash + 0.12 * air - 0.14 * land + 0.04 * settle, sx: 1 + 0.14 * squash - 0.08 * air + 0.12 * land,
        lift: 110 * air, humpL: 0.35 * air, humpR: 0.35 * air, eye: 1 - 0.9 * air, eyeScale: 1 + 0.1 * air,
      };
    }
    case "hop": {
      const air = bump(u, 0.15, 0.8), squash = bump(u, 0, 0.18) + bump(u, 0.78, 1);
      return { lift: 46 * air, sy: 1 - 0.12 * squash + 0.08 * air, sx: 1 + 0.1 * squash - 0.05 * air, skew: -0.08 * air };
    }
    case "nod": {
      const n = Math.sin(u * Math.PI * 4) * (1 - u);
      return { skew: 0.07 * n, lookY: 0.6 * Math.max(0, n), sy: 1 - 0.03 * Math.abs(n) };
    }
    case "think": {
      const k = bump(u, 0, 1);
      return { tilt: 7 * k, dip: 0.35 * k, lookX: -0.6 * k, lookY: -0.7 * k, eye: 1 - 0.25 * k };
    }
    case "surprised": {
      const k = ease.overshoot(seg(u, 0, 0.25)) * (1 - ease.inOut(seg(u, 0.6, 1)));
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
  }
}

/* ---------- moods: what Hamur does between acts ---------- */
function mood(m: Mood, t: number, holding: boolean): Partial {
  const hold: Partial = holding ? { hug: 0.85, spread: -0.45, humpL: -0.08, humpR: -0.08 } : {};
  switch (m) {
    case "working": {
      // kneading: press down, the dough spreads, let go, it springs back; alternate hands
      const k = Math.max(0, Math.sin(t * Math.PI * 2 * 1.05));
      const side = Math.sin(t * Math.PI * 1.05);
      return {
        hug: 0.95, spread: -0.5, humpL: -0.15 - 0.15 * k, humpR: -0.15 - 0.15 * k, sy: 1 - 0.07 * k, sx: 1 + 0.05 * k, skew: 0.035 * side,
        lookY: 0.6, eye: 1 - 0.3 * k, ballShow: 1, ballSY: 1 - 0.18 * k, ballSX: 1 + 0.14 * k, dentA: -Math.PI / 2 + side * 0.5, dentD: 0.22 * k,
      };
    }
    case "holding":
      return { hug: 0.85, spread: -0.45, humpL: -0.08, humpR: -0.08, ballShow: 1 };
    case "worried":
      return { ...hold, eyeScale: 0.82, sy: 0.97, dip: 0.25, lookY: 0.3, ballShow: holding ? 1 : 0 };
    case "happy": {
      const b = Math.max(0, Math.sin(t * Math.PI * 2 * 0.9));
      return { ...hold, lift: 10 * b, sy: 1 + 0.03 * b, humpL: 0.1, humpR: 0.1, ballShow: holding ? 1 : 0, ballSY: 1 - 0.06 * b };
    }
    default:
      return { ...hold };
  }
}

export interface FrameInput {
  t: number;
  mood: Mood;
  act?: { name: Act; start: number } | null;
  look: { x: number; y: number };
  blinkAt: number;
  /** Whether the ball is in Hamur's arms (between acts). */
  holding?: boolean;
  /** Show the ball beside Hamur when it is not held. */
  ball?: boolean;
  still?: boolean;
}

const MUL = new Set<keyof Pose>(["sx", "sy", "eye", "eyeScale", "ballSX", "ballSY"]);
const ABS = new Set<keyof Pose>(["ballX", "ballY", "dentA"]);

/** The whole scene at time t. */
export function frame(input: FrameInput): Pose {
  const holding = !!input.holding || input.mood === "holding" || input.mood === "working";
  const p: Pose = { ...REST, ballShow: input.ball || holding ? 1 : 0 };
  const apply = (part: Partial) => {
    for (const [k, v] of Object.entries(part) as [keyof Pose, number][]) {
      if (MUL.has(k)) p[k] *= v;
      else if (ABS.has(k)) p[k] = v;
      else if (k === "ballShow" || k === "hug") p[k] = Math.max(0, v);
      else p[k] += v - REST[k];
    }
  };
  const breath = input.still ? 0 : Math.sin((input.t * Math.PI * 2) / 3.4);
  p.sy *= 1 + 0.014 * breath;
  p.sx *= 1 - 0.009 * breath;
  apply(mood(input.mood, input.still ? 0 : input.t, holding));
  if (!input.still && input.act) {
    const u = (input.t - input.act.start) / DUR[input.act.name];
    if (u >= 0 && u <= 1) apply(act(input.act.name, { holding, u, t: input.t }, p));
  }
  // a held ball rides in the arms unless an act moved it
  const moved = input.act && ["kavrar", "drop"].includes(input.act.name) && (input.t - input.act.start) / DUR[input.act.name] <= 1;
  if (!moved) {
    if (holding) { [p.ballX, p.ballY] = toWorld(p, BALL.heldLocalX, BALL.heldLocalY); }
    else { p.ballX = BALL.groundX; p.ballY = GROUND_Y + (1 - p.ballSY) * BALL.ry; }
  }
  p.lookX += input.look.x * 0.9;
  p.lookY += input.look.y * 0.6;
  if (!input.still) {
    const since = input.t - input.blinkAt;
    if (since >= 0 && since < 0.11) p.eye *= 0.08 + Math.abs(since / 0.055 - 1) * 0.92;
  }
  return p;
}
