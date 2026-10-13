import sharp from "sharp";
import type { Accessor, Primitive, Texture, Node } from "@gltf-transform/core";
import type { Transform } from "@gltf-transform/extensions";
import { boundsOf } from "./inspect";
import { readStaticGlb, sha256 } from "./prepare";
import { GeometryPreparationError } from "./types";

export const RENDERER_VERSION = "makeready.model-views.v1";
export const VIEW_NAMES = ["front", "side", "three_quarter"] as const;
const SIZE = 448, LABEL = 28;
const MAX_PIXEL_TESTS = 45_000_000;
type Vector = [number, number, number];
type Pixels = { data: Buffer; width: number; height: number };
type Part = {
  primitive: Primitive; positions: Float64Array; uv: Accessor | null; colors: Accessor | null;
  texture?: Pixels; factor: number[]; wrap: [number, number]; transform?: Transform;
  doubleSided: boolean; mirrored: boolean; mask: number | null; unlit: boolean;
};
const dot = (a: Vector, b: Vector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vector): Vector => { const n = Math.hypot(...a); return a.map(v => v / n) as Vector; };
const cross = (a: Vector, b: Vector): Vector => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const linear = Array.from({ length: 256 }, (_, i) => i / 255 <= .04045 ? i / 255 / 12.92 : ((i / 255 + .055) / 1.055) ** 2.4);
const srgb = Uint8Array.from({ length: 4097 }, (_, i) => Math.round(255 * (i / 4096 <= .0031308 ? i / 4096 * 12.92 : 1.055 * (i / 4096) ** (1 / 2.4) - .055)));
function fail(message: string): never { throw new GeometryPreparationError("VISUAL_RENDER_UNSUPPORTED", message); }
function wrapped(value: number, mode: number) {
  if (mode === 33071) return Math.max(0, Math.min(1, value));
  if (mode === 33648) { const x = ((value % 2) + 2) % 2; return x <= 1 ? x : 2 - x; }
  return value - Math.floor(value);
}

/** Actual mesh pixels, not a provider thumbnail. Bounded CPU rendering works in Node/Vercel. */
export async function renderModelViews(glb: Uint8Array) {
  const started = performance.now();
  const { document, triangles } = await readStaticGlb(glb);
  const bounds = boundsOf(triangles.positions);
  const center = bounds.min.map((v, i) => (v + bounds.max[i]) / 2) as Vector;
  // One common framing and scale for all three cameras, never fit each view separately.
  const span = Math.hypot(bounds.width, bounds.height, bounds.depth) / .84;
  if (!Number.isFinite(span) || span <= 0) fail("The model has no renderable extent.");
  const textures = new Map<Texture, Pixels>();
  const parts: Part[] = [];
  const meshNodes: Node[] = [];
  document.getRoot().listScenes()[0].traverse(node => { if (node.getMesh()) meshNodes.push(node); });
  const textureHashes: string[] = [];
  for (const node of meshNodes) {
    const m = node.getWorldMatrix();
    const mirrored = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]) < 0;
    for (const primitive of node.getMesh()!.listPrimitives()) {
      const material = primitive.getMaterial();
      if (material?.getAlphaMode() === "BLEND") fail("Translucent materials need a different renderer; no visual verdict was requested.");
      if (material?.getExtension("KHR_materials_pbrSpecularGlossiness")) fail("Specular-glossiness materials are not supported by this evidence renderer.");
      const position = primitive.getAttribute("POSITION")!;
      const positions = new Float64Array(position.getCount() * 3), p: number[] = [];
      for (let i = 0; i < position.getCount(); i++) {
        position.getElement(i, p);
        positions.set([m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]], i * 3);
      }
      const texture = material?.getBaseColorTexture();
      const info = material?.getBaseColorTextureInfo();
      const transform = info?.getExtension<Transform>("KHR_texture_transform") ?? undefined;
      const uv = primitive.getAttribute(`TEXCOORD_${transform?.getTexCoord() ?? info?.getTexCoord() ?? 0}`);
      if (texture && !uv) fail("A base-color texture has no matching UV coordinates.");
      if (texture && !textures.has(texture)) {
        if (textures.size >= 16) fail("Too many textures for the bounded renderer.");
        const bytes = texture.getImage();
        if (!bytes) fail("An embedded base-color texture is unavailable.");
        const decoded = await sharp(bytes, { limitInputPixels: 16_777_216, failOn: "warning", pages: 1 })
          .resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        textures.set(texture, { data: decoded.data, width: decoded.info.width, height: decoded.info.height });
        textureHashes.push(sha256(bytes));
      }
      parts.push({ primitive, positions, uv, colors: primitive.getAttribute("COLOR_0"), texture: texture ? textures.get(texture) : undefined,
        factor: material?.getBaseColorFactor() ?? [.7, .7, .7, 1], wrap: [info?.getWrapS() ?? 10497, info?.getWrapT() ?? 10497], transform,
        doubleSided: material?.getDoubleSided() ?? false, mirrored, mask: material?.getAlphaMode() === "MASK" ? material.getAlphaCutoff() : null,
        unlit: Boolean(material?.getExtension("KHR_materials_unlit")) });
    }
  }
  let pixelTests = 0;
  const directions: Vector[] = [[0, 0, 1], [1, 0, 0], unit([1, .42, 1])];
  const views: { name: typeof VIEW_NAMES[number]; bytes: Buffer; sha256: string; visiblePixels: number; direction: Vector }[] = [];
  for (let view = 0; view < directions.length; view++) {
    const axis = directions[view], right = unit([axis[2], 0, -axis[0]]), up = cross(axis, right);
    const rgb = Buffer.alloc(SIZE * SIZE * 3, 246), depth = new Float64Array(SIZE * SIZE).fill(-Infinity);
    let visiblePixels = 0;
    for (const part of parts) {
      const indices = part.primitive.getIndices(), count = indices?.getCount() ?? part.positions.length / 3;
      const points: Vector[] = [], screen: Vector[] = [], uv: number[][] = [], colors: number[][] = [];
      for (let face = 0; face < count; face += 3) {
        if (face % 1500 === 0 && performance.now() - started > 15_000) fail("Rendering exceeded the bounded time limit.");
        for (let c = 0; c < 3; c++) {
          const corner = part.mirrored ? [0, 2, 1][c] : c;
          const index = indices ? indices.getScalar(face + corner) : face + corner;
          points[c] = Array.from(part.positions.subarray(index * 3, index * 3 + 3)) as Vector;
          const relative = points[c].map((v, i) => v - center[i]) as Vector;
          screen[c] = [SIZE / 2 + dot(relative, right) * SIZE / span, SIZE / 2 - dot(relative, up) * SIZE / span, dot(relative, axis)];
          uv[c] = part.uv ? part.uv.getElement(index, []) : [0, 0];
          colors[c] = part.colors ? part.colors.getElement(index, []) : [1, 1, 1, 1];
        }
        const normal = cross(points[1].map((v, i) => v - points[0][i]) as Vector, points[2].map((v, i) => v - points[0][i]) as Vector);
        if (!part.doubleSided && dot(normal, axis) <= 0) continue;
        const [a, b, c] = screen;
        const area = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if (Math.abs(area) < 1e-9) continue;
        const minX = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), maxX = Math.min(SIZE - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
        const minY = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), maxY = Math.min(SIZE - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
        pixelTests += (maxX - minX + 1) * (maxY - minY + 1);
        if (pixelTests > MAX_PIXEL_TESTS) fail("Rendering exceeded the bounded pixel-work limit.");
        const shade = part.unlit ? 1 : .65 + .35 * Math.max(0, dot(unit(normal), unit([.3, .8, .5])));
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
          const w0 = ((b[1] - c[1]) * (x + .5 - c[0]) + (c[0] - b[0]) * (y + .5 - c[1])) / area;
          const w1 = ((c[1] - a[1]) * (x + .5 - c[0]) + (a[0] - c[0]) * (y + .5 - c[1])) / area, w2 = 1 - w0 - w1;
          if (w0 < -1e-8 || w1 < -1e-8 || w2 < -1e-8) continue;
          const at = y * SIZE + x, z = w0 * a[2] + w1 * b[2] + w2 * c[2];
          if (z <= depth[at]) continue;
          let texel = -1;
          if (part.texture) {
            let u = w0 * uv[0][0] + w1 * uv[1][0] + w2 * uv[2][0], v = w0 * uv[0][1] + w1 * uv[1][1] + w2 * uv[2][1];
            if (part.transform) {
              const scale = part.transform.getScale(), offset = part.transform.getOffset(), rotation = part.transform.getRotation();
              const s = u * scale[0], t = v * scale[1];
              u = offset[0] + Math.cos(rotation) * s - Math.sin(rotation) * t; v = offset[1] + Math.sin(rotation) * s + Math.cos(rotation) * t;
            }
            texel = (Math.min(part.texture.height - 1, Math.floor(wrapped(v, part.wrap[1]) * part.texture.height)) * part.texture.width + Math.min(part.texture.width - 1, Math.floor(wrapped(u, part.wrap[0]) * part.texture.width))) * 4;
          }
          const alpha = part.factor[3] * (part.texture ? part.texture.data[texel + 3] / 255 : 1) * (w0 * (colors[0][3] ?? 1) + w1 * (colors[1][3] ?? 1) + w2 * (colors[2][3] ?? 1));
          if (part.mask !== null && alpha < part.mask) continue;
          if (depth[at] === -Infinity) visiblePixels++;
          depth[at] = z;
          for (let channel = 0; channel < 3; channel++) {
            const value = part.factor[channel] * (part.texture ? linear[part.texture.data[texel + channel]] : 1) * shade * (w0 * colors[0][channel] + w1 * colors[1][channel] + w2 * colors[2][channel]);
            rgb[at * 3 + channel] = srgb[Math.max(0, Math.min(4096, Math.round(value * 4096)))];
          }
        }
      }
    }
    if (visiblePixels < 32) fail(`The ${VIEW_NAMES[view]} camera has insufficient visible geometry for a reliable review.`);
    const bytes = await sharp(rgb, { raw: { width: SIZE, height: SIZE, channels: 3 } }).png().toBuffer();
    views.push({ name: VIEW_NAMES[view], bytes, sha256: sha256(bytes), visiblePixels, direction: axis });
  }
  const sheet = await sharp({ create: { width: SIZE * 3, height: SIZE + LABEL, channels: 3, background: "#f6f6f6" } })
    .composite(views.flatMap((v, i) => [{ input: v.bytes, left: i * SIZE, top: LABEL }, {
      input: Buffer.from(`<svg width="${SIZE}" height="${LABEL}"><text x="12" y="20" font-family="sans-serif" font-size="16" fill="#222">${v.name.replaceAll("_", " ")}</text></svg>`), left: i * SIZE, top: 0,
    }])).png().toBuffer();
  return { sheet, views, manifest: {
    renderer: RENDERER_VERSION, modelSha256: sha256(glb), sheetSha256: sha256(sheet), textureSha256: textureHashes,
    camera: { projection: "orthographic", center, spanMeters: span, viewSize: SIZE, modelUp: "Y", commonFraming: true },
    views: views.map(({ name, sha256: hash, visiblePixels, direction }) => ({ name, sha256: hash, visiblePixels, direction })),
    limitations: ["Fixed mesh-local front (+Z), side (+X), and three-quarter views; source orientation may differ from the concept.", "Base color, embedded textures and vertex colors with simple lighting; no PBR reflections, normal maps or shadows.", "Textures sampled at at most 1024 pixels; small details and exact text may remain uncertain.", "Image comparison cannot establish dimensions, topology, wall thickness, material strength or printability."],
  } };
}
