import * as THREE from "three";

/**
 * Procedural designer-toy cat used for the sample hero and the scripted run.
 * It is a stand-in, never presented as a generated model.
 * Units: about 3 tall, base on y = 0.
 */
export type CatMode = "sketch" | "clay" | "measured" | "printing" | "primer" | "painted";

const PAINT = { orange: 0xf29a3a, cream: 0xfbe7c9, pink: 0xf08ca8, eye: 0x15171a, blue: 0x2f6bff, base: 0x1c1e22, stripe: 0xc5601b, white: 0xffffff };
const COL = {
  clay: new THREE.Color(0xbdb5a9), clayDark: new THREE.Color(0x8c857a), measured: new THREE.Color(0xb3b7bd),
  resin: new THREE.Color(0x8f969f), primer: new THREE.Color(0xa9acb1),
};
type Role = "body" | "eye" | "glint" | "stripe";
interface Part { mesh: THREE.Mesh; mat: THREE.MeshPhysicalMaterial; outline: THREE.Mesh | null; paint: THREE.Color; role: Role }

export function createToyCat(clip: THREE.Plane) {
  const group = new THREE.Group();
  const outlineMat = new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.BackSide, clippingPlanes: [clip] });
  const parts: Part[] = [];
  const v2 = (a: number[][]) => a.map(([x, y]) => new THREE.Vector2(x, y));

  function part(geo: THREE.BufferGeometry, paint: number, o: { pos?: number[]; scale?: number[]; rot?: number[]; parent?: THREE.Object3D; outline?: number; noOutline?: boolean; role?: Role; transparent?: boolean } = {}) {
    const mat = new THREE.MeshPhysicalMaterial({ color: paint, roughness: 0.5, clippingPlanes: [clip], clipShadows: true, transparent: !!o.transparent });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true;
    if (o.pos) mesh.position.set(o.pos[0], o.pos[1], o.pos[2]);
    if (o.scale) mesh.scale.set(o.scale[0], o.scale[1], o.scale[2]);
    if (o.rot) mesh.rotation.set(o.rot[0], o.rot[1], o.rot[2]);
    let outline: THREE.Mesh | null = null;
    if (!o.noOutline) { outline = new THREE.Mesh(geo, outlineMat); outline.scale.setScalar(o.outline ?? 1.045); mesh.add(outline); }
    (o.parent ?? group).add(mesh);
    const p: Part = { mesh, mat, outline, paint: new THREE.Color(paint), role: o.role ?? "body" };
    parts.push(p);
    return p;
  }

  part(new THREE.LatheGeometry(v2([[0, 0], [1.02, 0], [1.1, 0.03], [1.14, 0.1], [1.12, 0.18], [1.05, 0.22], [0, 0.22]]), 96), PAINT.base, { outline: 1.02 });
  const bodyCurve = new THREE.SplineCurve(v2([[0, 0.2], [0.66, 0.24], [0.86, 0.5], [0.85, 0.85], [0.72, 1.15], [0.54, 1.4], [0.28, 1.6], [0, 1.66]]));
  part(new THREE.LatheGeometry(bodyCurve.getPoints(60), 96), PAINT.orange, { outline: 1.03 });
  part(new THREE.SphereGeometry(0.42, 48, 32), PAINT.cream, { pos: [0, 0.95, 0.58], scale: [1, 1.3, 0.55] });
  part(new THREE.SphereGeometry(0.2, 32, 24), PAINT.cream, { pos: [-0.3, 0.33, 0.66], scale: [1, 0.7, 1.35] });
  part(new THREE.SphereGeometry(0.2, 32, 24), PAINT.cream, { pos: [0.3, 0.33, 0.66], scale: [1, 0.7, 1.35] });
  part(new THREE.SphereGeometry(0.74, 64, 48), PAINT.orange, { pos: [0, 2.0, 0.06], scale: [1.1, 0.95, 1.0], outline: 1.035 });
  part(new THREE.SphereGeometry(0.3, 48, 32), PAINT.cream, { pos: [0, 1.86, 0.66], scale: [1.35, 0.78, 0.85] });
  part(new THREE.SphereGeometry(0.105, 32, 24), PAINT.eye, { pos: [-0.27, 2.06, 0.7], role: "eye", noOutline: true });
  part(new THREE.SphereGeometry(0.105, 32, 24), PAINT.eye, { pos: [0.27, 2.06, 0.7], role: "eye", noOutline: true });
  part(new THREE.SphereGeometry(0.03, 16, 12), PAINT.white, { pos: [-0.235, 2.1, 0.795], role: "glint", noOutline: true });
  part(new THREE.SphereGeometry(0.03, 16, 12), PAINT.white, { pos: [0.305, 2.1, 0.795], role: "glint", noOutline: true });
  part(new THREE.SphereGeometry(0.06, 24, 16), PAINT.pink, { pos: [0, 1.95, 0.9], scale: [1.3, 0.8, 0.8], noOutline: true });
  part(new THREE.TorusGeometry(0.56, 0.13, 28, 96), PAINT.blue, { pos: [0, 1.43, 0.02], rot: [Math.PI / 2 - 0.08, 0, 0.06], outline: 1.03 });
  part(new THREE.CapsuleGeometry(0.1, 0.38, 8, 20), PAINT.blue, { pos: [0.27, 1.16, 0.55], rot: [0.25, 0, 0.38] });

  const ears: THREE.Group[] = [];
  for (const s of [-1, 1]) {
    const g = new THREE.Group();
    g.position.set(0.43 * s, 2.47, 0.02); g.rotation.set(-0.08, 0, -0.32 * s);
    group.add(g); ears.push(g);
    const outer = new THREE.ConeGeometry(0.27, 0.56, 48); outer.translate(0, 0.28, 0);
    part(outer, PAINT.orange, { parent: g, outline: 1.06 });
    const inner = new THREE.ConeGeometry(0.15, 0.36, 32); inner.translate(0, 0.18, 0);
    part(inner, PAINT.pink, { parent: g, pos: [0, 0.03, 0.12], rot: [-0.12, 0, 0], noOutline: true });
  }
  for (const [y, r] of [[0.72, 0.86], [0.97, 0.81], [1.2, 0.7]]) {
    const arc = Math.PI * 0.8;
    const geo = new THREE.TorusGeometry(r + 0.012, 0.042, 10, 64, arc);
    geo.rotateX(-Math.PI / 2);
    part(geo, PAINT.stripe, { pos: [0, y, 0], rot: [0, Math.PI / 2 - arc / 2, 0], role: "stripe", noOutline: true, transparent: true });
  }
  const tailCurve = new THREE.CatmullRomCurve3([[0.5, 0.35, -0.45], [0.98, 0.42, -0.06], [1.0, 0.5, 0.4], [0.72, 0.6, 0.78], [0.38, 0.74, 0.88]].map((a) => new THREE.Vector3(a[0], a[1], a[2])));
  const tail = part(new THREE.TubeGeometry(tailCurve, 80, 0.075, 18, false), PAINT.orange, { noOutline: true });
  const tailTip = part(new THREE.SphereGeometry(0.075, 24, 16), PAINT.orange, { pos: [0.38, 0.74, 0.88], noOutline: true });

  let earScale = 1;
  let tailR = 0.075;
  const tmp = new THREE.Color();
  const BARE: CatMode[] = ["clay", "measured", "printing", "primer"];

  return {
    group,
    get earScale() { return earScale; },
    get tailRadius() { return tailR; },
    /** Height of the ear tips above the base, for dimension lines. */
    top() { return 2.47 + 0.53 * earScale * Math.cos(0.32); },
    setEars(scale: number) { earScale = scale; ears.forEach((g) => g.scale.setScalar(scale)); },
    setTail(r: number) {
      if (Math.abs(r - tailR) < 0.0005) return;
      tail.mesh.geometry.dispose();
      tail.mesh.geometry = new THREE.TubeGeometry(tailCurve, 80, r, 18, false);
      tailTip.mesh.scale.setScalar(r / 0.075);
      tailR = r;
    },
    setLook(mode: CatMode, mix = 1) {
      const sketch = mode === "sketch";
      for (const p of parts) {
        const m = p.mat;
        let rough = 0.5, coat = 0, env = 1, opacity = 1, visible = true;
        let col: THREE.Color;
        if (sketch) { col = p.paint; rough = 1; env = 0.25; }
        else if (mode === "clay") { col = p.role === "eye" ? COL.clayDark : COL.clay; rough = 0.92; env = 0.5; }
        else if (mode === "measured") { col = p.role === "eye" ? COL.clayDark : COL.measured; rough = 0.8; env = 0.5; }
        else if (mode === "printing") { col = COL.resin; rough = 0.38; coat = 0.3; env = 0.45; }
        else if (mode === "primer") { col = COL.primer; rough = 0.78; env = 0.45; }
        else { col = tmp.copy(COL.primer).lerp(p.paint, mix); rough = 0.42; coat = 0.55 * mix; env = 0.75; if (p.role === "eye") { rough = 0.12; coat = mix; } }
        if (p.role === "glint") visible = sketch || (mix > 0.9 && !BARE.includes(mode));
        if (p.role === "stripe") {
          const on = sketch ? 1 : BARE.includes(mode) ? 0 : Math.max(0, (mix - 0.4) / 0.6);
          opacity = on; visible = on > 0.01; m.color.copy(p.paint);
        } else m.color.copy(col);
        m.roughness = rough; m.clearcoat = coat; m.envMapIntensity = env; m.opacity = opacity; p.mesh.visible = visible;
        if (p.role === "glint") { m.emissive.set(sketch || mix > 0.9 ? 0xffffff : 0x000000); m.emissiveIntensity = 0.6; }
        if (p.outline) p.outline.visible = sketch;
      }
    },
    dispose() {
      group.traverse((o) => { const mesh = o as THREE.Mesh; if (mesh.isMesh) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); } });
      outlineMat.dispose();
    },
  };
}
export type ToyCat = ReturnType<typeof createToyCat>;
