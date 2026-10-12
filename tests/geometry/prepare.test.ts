import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRDracoMeshCompression, EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { BoxGeometry } from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import JSZip from "jszip";
import { PhysicalAuditSchema } from "../../src/lib/contracts";
import { prepareModel, inspectGeometry, boundsOf } from "../../src/lib/geometry";
import { makePackage } from "../../src/lib/make-package";

const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZgAAAABJRU5ErkJggg==", "base64"));

function boxDocument(textured = false) {
  const document = new Document();
  const buffer = document.createBuffer();
  const box = new BoxGeometry(2, 4, 3);
  const primitive = document.createPrimitive();
  for (const [name, semantic, type] of [["position", "POSITION", "VEC3"], ["normal", "NORMAL", "VEC3"], ["uv", "TEXCOORD_0", "VEC2"]] as const) {
    primitive.setAttribute(semantic, document.createAccessor().setType(type).setArray(new Float32Array(box.getAttribute(name).array)).setBuffer(buffer));
  }
  primitive.setIndices(document.createAccessor().setType("SCALAR").setArray(new Uint16Array(box.index!.array)).setBuffer(buffer));
  if (textured) {
    const texture = document.createTexture("reference texture").setImage(png).setMimeType("image/png");
    primitive.setMaterial(document.createMaterial("source material").setBaseColorTexture(texture).setBaseColorFactor([0.3, 0.5, 0.9, 1]).setRoughnessFactor(0.7));
  }
  const mesh = document.createMesh().addPrimitive(primitive);
  const node = document.createNode("figure").setMesh(mesh);
  const scene = document.createScene().addChild(node);
  document.getRoot().setDefaultScene(scene);
  box.dispose();
  return { document, mesh, node, scene, primitive };
}

async function encoded(document: Document) { return new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(document); }

function reloadedBounds(document: Document) {
  const vertices: number[] = [];
  document.getRoot().getDefaultScene()!.traverse((node) => {
    const m = node.getWorldMatrix();
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      const positions = primitive.getAttribute("POSITION")!;
      for (let i = 0; i < positions.getCount(); i++) {
        const [x, y, z] = positions.getElement(i, [0, 0, 0]);
        vertices.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
      }
    }
  });
  return boundsOf(new Float64Array(vertices));
}

describe("server GLB preparation", () => {
  it("keeps CNC suitability unverified even when a real mesh passes the implemented topology checks", async () => {
    const { document } = boxDocument(true);
    const result = await prepareModel({ source: await encoded(document), targetHeightMm: 12, process: "cnc_candidate" });
    expect(result.bounds.height).toBeCloseTo(12, 3);
    expect(result.geometryAudit.status).toBe("pass");
    expect(result.audit.manufacturingStatus).toBe("preparation_only");
    for (const id of ["cnc_tool_access", "cnc_undercuts", "cnc_stock_fixturing", "cnc_toolpaths"]) {
      expect(result.audit.checks.find((check) => check.id === id)).toMatchObject({ status: "not_checked", actual: null });
      expect(result.audit.notChecked).toContain(id);
    }
    const zip = await JSZip.loadAsync(await makePackage(result));
    const readme = await zip.file("README.md")!.async("string");
    expect(readme).toContain("CNC candidate only");
    expect(readme).toContain("no toolpaths or machining verification are included");
    expect(readme).toContain("cnc_tool_access");
    expect(await zip.file("source.glb")!.async("uint8array")).toEqual(result.source);
  });

  it("honors nested world transforms and preserves millimeter dimensions in an actual STL round trip", async () => {
    const { document, node, scene } = boxDocument();
    scene.removeChild(node);
    node.setScale([1, 2, 1]).setTranslation([1, 2, 3]);
    const parent = document.createNode().setScale([2, 1, 3]).setRotation([0, 0, Math.SQRT1_2, Math.SQRT1_2]).setTranslation([3, 7, -5]).addChild(node);
    scene.addChild(parent);
    const source = await encoded(document);
    const result = await prepareModel({ source, targetHeightMm: 80 });
    expect(result.bounds.height).toBeCloseTo(80, 3);
    expect(result.bounds.width).toBeCloseTo(160, 3);
    expect(result.bounds.depth).toBeCloseTo(180, 3);
    expect(result.bounds.min[1]).toBeCloseTo(0, 3);
    expect(result.geometryAudit.status).toBe("pass");
    expect(PhysicalAuditSchema.safeParse(result.audit).success).toBe(true);
    const reloaded = await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(result.glb);
    expect(reloadedBounds(reloaded).height).toBeCloseTo(0.08, 6);
    const stl = new STLLoader().parse(result.stl.slice().buffer as ArrayBuffer);
    stl.computeBoundingBox();
    const box = stl.boundingBox!;
    expect(box.max.z - box.min.z).toBeCloseTo(80, 2);
    expect(box.max.x - box.min.x).toBeCloseTo(160, 2);
    expect(box.max.y - box.min.y).toBeCloseTo(180, 2);
    expect(box.min.z).toBeCloseTo(0, 2);
    stl.dispose();
  });

  it("audits UV/normal seam duplicates using positions without changing textured source data", async () => {
    const { document, primitive } = boxDocument(true);
    const rawEdges = new Map<string, number>();
    const rawIndices = primitive.getIndices()!.getArray()!;
    for (let i = 0; i < rawIndices.length; i += 3) {
      const [a, b, c] = [rawIndices[i], rawIndices[i + 1], rawIndices[i + 2]];
      for (const [start, end] of [[a, b], [b, c], [c, a]]) {
        const key = [start, end].sort((left, right) => left - right).join(",");
        rawEdges.set(key, (rawEdges.get(key) ?? 0) + 1);
      }
    }
    expect(Array.from(rawEdges.values()).filter((count) => count === 1)).toHaveLength(24);
    const source = await encoded(document);
    const exactCopy = source.slice();
    const result = await prepareModel({ source, targetHeightMm: 120 });
    expect(result.source).toEqual(exactCopy);
    expect(result.hashes.source).toBe(createHash("sha256").update(exactCopy).digest("hex"));
    expect(result.glb).not.toEqual(exactCopy);
    expect(result.geometryAudit.sourceVertexCount).toBe(24);
    expect(result.geometryAudit.weldedVertexCount).toBe(8);
    expect(result.geometryAudit.boundaryEdgeCount).toBe(0);
    const normalized = await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(result.glb);
    expect(normalized.getRoot().listTextures()[0].getImage()).toEqual(png);
    expect(normalized.getRoot().listMaterials()[0].getBaseColorFactor()).toEqual([0.3, 0.5, 0.9, 1]);
    expect(normalized.getRoot().listMaterials()[0].getRoughnessFactor()).toBe(0.7);
    expect(normalized.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute("POSITION")!.getCount()).toBe(24);
  });

  it("includes all instances of a shared mesh and corrects mirrored STL winding", async () => {
    const { document, mesh, node, scene } = boxDocument();
    node.setTranslation([-3, 0, 0]);
    scene.addChild(document.createNode().setMesh(mesh).setScale([-1, 1, 1]).setTranslation([3, 0, 0]));
    const result = await prepareModel({ source: await encoded(document), targetHeightMm: 100 });
    expect(result.audit.triangleCount).toBe(24);
    expect(result.geometryAudit.connectedComponentCount).toBe(2);
    expect(result.geometryAudit.inconsistentWindingEdgeCount).toBe(0);
    const geometry = new STLLoader().parse(result.stl.slice().buffer as ArrayBuffer);
    const position = geometry.getAttribute("position");
    // Each instance is a closed outward-oriented box. A mirrored export without
    // winding correction would give their signed volumes opposite signs.
    const volumes = [0, 0];
    for (let i = 0; i < position.count; i += 3) {
      const a = [position.getX(i), position.getY(i), position.getZ(i)];
      const b = [position.getX(i + 1), position.getY(i + 1), position.getZ(i + 1)];
      const c = [position.getX(i + 2), position.getY(i + 2), position.getZ(i + 2)];
      volumes[i < 36 ? 0 : 1] += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }
    expect(volumes[0]).toBeGreaterThan(0);
    expect(volumes[1]).toBeGreaterThan(0);
    expect(volumes[0]).toBeCloseTo(volumes[1], 2);
    geometry.dispose();
  });

  it("decodes normalized integer positions, including their node quantization scale", async () => {
    const { document, primitive, node } = boxDocument();
    document.createExtension(KHRMeshQuantization).setRequired(true);
    const position = primitive.getAttribute("POSITION")!;
    const values = position.getArray()!;
    position.setArray(Int16Array.from(values, (value, i) => Math.round(value / [1, 2, 1.5][i % 3] * 32767))).setNormalized(true);
    node.setScale([1, 2, 1.5]);
    const result = await prepareModel({ source: await encoded(document), targetHeightMm: 100 });
    expect(result.bounds.width).toBeCloseTo(50, 5);
    expect(result.bounds.height).toBeCloseTo(100, 5);
    expect(result.bounds.depth).toBeCloseTo(75, 5);
    expect(result.geometryAudit.status).toBe("pass");
  });

  it("keeps failed physical findings visible while producing valid downloadable artifacts", async () => {
    const { document, primitive } = boxDocument();
    primitive.getIndices()!.setArray(primitive.getIndices()!.getArray()!.slice(0, 30));
    const result = await prepareModel({ source: await encoded(document), targetHeightMm: 100 });
    expect(result.geometryAudit.status).toBe("fail");
    expect(result.audit.checks.find((check) => check.id === "boundary_edges")?.status).toBe("fail");
    expect(result.audit.manufacturingStatus).toBe("preparation_only");
    expect(result.audit.checks.find((check) => check.id === "wall_thickness")?.status).toBe("not_checked");
    const zip = await JSZip.loadAsync(await makePackage(result, { revisionId: "a-real-revision" }));
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(["source.glb", "normalized.glb", "model.stl", "audit.json", "manifest.json", "README.md"]));
    expect(await zip.file("source.glb")!.async("uint8array")).toEqual(result.source);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(manifest.physicalAuditStatus).toBe("fail");
    expect(manifest.files["model.stl"].sha256).toBe(result.hashes.stl);
    expect(await zip.file("README.md")!.async("string")).toContain("Physical audit: FAIL");
  });

  it("rejects invalid coordinates and unsupported animated manufacturing inputs", async () => {
    const { document, primitive } = boxDocument();
    primitive.getAttribute("POSITION")!.getArray()![0] = NaN;
    await expect(prepareModel({ source: await encoded(document), targetHeightMm: 100 })).rejects.toMatchObject({ code: "INVALID_COORDINATE" });
    const animated = boxDocument();
    animated.document.createAnimation();
    await expect(prepareModel({ source: await encoded(animated.document), targetHeightMm: 100 })).rejects.toMatchObject({ code: "ANIMATED_MODEL" });
    await expect(prepareModel({ source: new Uint8Array([0]), targetHeightMm: 100 })).rejects.toMatchObject({ code: "INVALID_GLB" });
  });

  it("decodes Draco input and exports without recompressing source geometry", async () => {
    const { document } = boxDocument(true);
    const { default: draco } = await import("draco3dgltf");
    document.createExtension(KHRDracoMeshCompression).setRequired(true);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.encoder": await draco.createEncoderModule() });
    const result = await prepareModel({ source: await io.writeBinary(document), targetHeightMm: 100 });
    expect(result.geometryAudit.status).toBe("pass");
    const output = await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(result.glb);
    expect(output.getRoot().listExtensionsUsed().map((extension) => extension.extensionName)).not.toContain("KHR_draco_mesh_compression");
    expect(output.getRoot().listTextures()[0].getImage()).toEqual(png);
  });

  it("decodes Meshopt input and writes a decoder-free normalized GLB", async () => {
    const { document } = boxDocument();
    const { MeshoptEncoder } = await import("meshoptimizer");
    await MeshoptEncoder.ready;
    document.createExtension(EXTMeshoptCompression).setRequired(true);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder });
    const result = await prepareModel({ source: await io.writeBinary(document), targetHeightMm: 100 });
    expect(result.geometryAudit.status).toBe("pass");
    const output = await new NodeIO().registerExtensions(ALL_EXTENSIONS).readBinary(result.glb);
    expect(output.getRoot().listExtensionsUsed().map((extension) => extension.extensionName)).not.toContain("EXT_meshopt_compression");
  });
});

describe("topology audit", () => {
  const tetraVertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const tetraFaces = [[1, 2, 3], [0, 2, 1], [0, 1, 3], [0, 3, 2]];
  const tetra = tetraFaces.flatMap((face) => face.flatMap((index) => tetraVertices[index]));
  const inspect = (numbers: number[]) => inspectGeometry({ positions: new Float64Array(numbers), sourceVertexCount: numbers.length / 3, unreferencedVertexCount: 0 }, 1);

  it("detects duplicate, degenerate and nonmanifold surfaces", () => {
    expect(inspect(tetra).status).toBe("pass");
    const duplicate = inspect([...tetra, ...tetra.slice(0, 9)]);
    expect(duplicate.duplicateTriangleCount).toBe(1);
    expect(duplicate.nonManifoldEdgeCount).toBe(3);
    const degenerate = inspect([...tetra, 0, 0, 0, 0, 0, 0, 1, 1, 1]);
    expect(degenerate.degenerateTriangleCount).toBe(1);
    expect(degenerate.status).toBe("fail");
  });

  it("detects a bow-tie vertex even when every edge belongs to exactly two faces", () => {
    const touching = inspect([...tetra, ...tetra.map((coordinate) => -coordinate)]);
    expect(touching.boundaryEdgeCount).toBe(0);
    expect(touching.nonManifoldEdgeCount).toBe(0);
    expect(touching.nonManifoldVertexCount).toBe(1);
    expect(touching.connectedComponentCount).toBe(2);
    expect(touching.status).toBe("fail");
  });
});
