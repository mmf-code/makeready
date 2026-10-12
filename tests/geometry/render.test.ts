import { describe, expect, it } from "vitest";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRMaterialsUnlit } from "@gltf-transform/extensions";
import { BoxGeometry } from "three";
import sharp from "sharp";
import { renderModelViews } from "@/lib/geometry/render";
import { sha256 } from "@/lib/geometry/prepare";

async function fixture(options: { color?: [number, number, number, number]; textured?: boolean; transparent?: boolean } = {}) {
  const document = new Document(), buffer = document.createBuffer();
  const box = new BoxGeometry(.08, .12, .04);
  const primitive = document.createPrimitive();
  for (const [name, semantic, type] of [["position", "POSITION", "VEC3"], ["uv", "TEXCOORD_0", "VEC2"]] as const) {
    primitive.setAttribute(semantic, document.createAccessor().setBuffer(buffer).setType(type).setArray(new Float32Array(box.getAttribute(name).array)));
  }
  primitive.setIndices(document.createAccessor().setBuffer(buffer).setType("SCALAR").setArray(new Uint16Array(box.index!.array)));
  const material = document.createMaterial().setBaseColorFactor(options.color ?? [1, 0, 0, 1]);
  material.setExtension("KHR_materials_unlit", document.createExtension(KHRMaterialsUnlit).createUnlit());
  if (options.textured) {
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#00ff00" } }).png().toBuffer();
    material.setBaseColorFactor([1, 1, 1, 1]).setBaseColorTexture(document.createTexture().setImage(image).setMimeType("image/png"));
  }
  if (options.transparent) material.setAlphaMode("BLEND");
  primitive.setMaterial(material);
  const node = document.createNode().setMesh(document.createMesh().addPrimitive(primitive)).setTranslation([.1, .3, -.2]);
  document.createScene().addChild(node);
  const glb = await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document);
  box.dispose();
  return glb;
}

describe("actual GLB camera evidence", () => {
  it("renders three nonempty distinct views with common framing, actual world transforms and immutable hashes", async () => {
    const glb = await fixture(), hash = sha256(glb);
    const result = await renderModelViews(glb);
    expect(sha256(glb)).toBe(hash);
    expect(result.manifest.modelSha256).toBe(hash);
    expect(result.manifest.sheetSha256).toBe(sha256(result.sheet));
    expect(result.manifest.camera.commonFraming).toBe(true);
    expect(result.manifest.camera.center[0]).toBeCloseTo(.1);
    expect(result.views.map(v => v.name)).toEqual(["front", "side", "three_quarter"]);
    expect(new Set(result.views.map(v => v.sha256)).size).toBe(3);
    expect(result.views.every(v => v.visiblePixels > 500)).toBe(true);
    const { data, info } = await sharp(result.views[0].bytes).raw().toBuffer({ resolveWithObject: true });
    const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 3;
    expect([...data.subarray(center, center + 3)]).toEqual([255, 0, 0]);
  });

  it("uses the embedded texture's pixels and records its hash instead of inventing a material", async () => {
    const result = await renderModelViews(await fixture({ textured: true }));
    expect(result.manifest.textureSha256).toHaveLength(1);
    const { data, info } = await sharp(result.views[0].bytes).raw().toBuffer({ resolveWithObject: true });
    const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 3;
    expect([...data.subarray(center, center + 3)]).toEqual([0, 255, 0]);
  });

  it("produces deterministic evidence for the same exact stored model", async () => {
    const glb = await fixture();
    expect((await renderModelViews(glb)).manifest).toEqual((await renderModelViews(glb)).manifest);
  });

  it("refuses unsupported transparency rather than producing misleading evidence", async () => {
    await expect(renderModelViews(await fixture({ transparent: true }))).rejects.toThrow("Translucent");
  });
});
