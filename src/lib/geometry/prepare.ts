import { createHash } from "node:crypto";
import { NodeIO, type Document, type Node } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { boundsOf, inspectGeometry } from "./inspect";
import { binaryStl } from "./stl";
import { toPhysicalAudit } from "./physical-audit";
import { GeometryPreparationError, type PreparedModel, type TriangleSoup, type Vec3 } from "./types";

export const GEOMETRY_LIMITS = {
  sourceBytes: 64 * 1024 * 1024,
  jsonBytes: 8 * 1024 * 1024,
  decodedAccessorBytes: 128 * 1024 * 1024,
  triangles: 250_000,
  nodes: 10_000,
} as const;

interface GlbJson {
  asset?: { version?: string };
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  accessors?: { count: number; componentType: number; type: string }[];
  nodes?: { children?: number[] }[];
}

export const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
function fail(code: string, message: string): never { throw new GeometryPreparationError(code, message); }

function preflight(source: Uint8Array): string[] {
  if (source.byteLength > GEOMETRY_LIMITS.sourceBytes) fail("MODEL_TOO_LARGE", "The GLB exceeds the 64 MiB processing limit.");
  if (source.byteLength < 20) fail("INVALID_GLB", "The file is not a complete GLB.");
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== source.byteLength) {
    fail("INVALID_GLB", "The file must be a valid glTF 2.0 binary.");
  }
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || jsonLength > GEOMETRY_LIMITS.jsonBytes || jsonLength + 20 > source.byteLength) {
    fail("INVALID_GLB", "The GLB JSON chunk is invalid or too large.");
  }
  let json: GlbJson;
  try { json = JSON.parse(new TextDecoder().decode(source.subarray(20, 20 + jsonLength))) as GlbJson; }
  catch { return fail("INVALID_GLB", "The GLB JSON could not be read."); }
  if (!json || typeof json !== "object" || json.asset?.version !== "2.0") fail("INVALID_GLB", "Only glTF 2.0 is supported.");
  for (const list of [json.extensionsUsed, json.extensionsRequired]) {
    if (list !== undefined && (!Array.isArray(list) || !list.every((name) => typeof name === "string"))) fail("INVALID_GLB", "The GLB extension list is malformed.");
  }
  if ((json.accessors !== undefined && !Array.isArray(json.accessors)) || (json.nodes !== undefined && !Array.isArray(json.nodes))) fail("INVALID_GLB", "The GLB resource lists are malformed.");
  const extensions = [...new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])])];
  const supported = new Set<string>(ALL_EXTENSIONS.map((extension) => extension.EXTENSION_NAME));
  const unsupported = extensions.filter((name) => !supported.has(name));
  if (unsupported.length) fail("UNSUPPORTED_EXTENSION", `Unsupported GLB extension: ${unsupported.join(", ")}. The original file can be retained, but preservation during export cannot be guaranteed.`);
  const unsupportedGeometry = extensions.filter((name) => ["EXT_mesh_gpu_instancing", "KHR_node_visibility", "KHR_accessor_float16", "KHR_accessor_float64"].includes(name));
  if (unsupportedGeometry.length) fail("UNSUPPORTED_GEOMETRY", `This geometry feature needs baking before export: ${unsupportedGeometry.join(", ")}.`);

  const componentBytes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  const elementComponents: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  let decodedBytes = 0;
  for (const accessor of json.accessors ?? []) {
    if (!accessor || !Number.isSafeInteger(accessor.count) || accessor.count < 0 || !componentBytes[accessor.componentType] || !elementComponents[accessor.type]) {
      fail("INVALID_ACCESSOR", "The GLB has an invalid accessor declaration.");
    }
    decodedBytes += accessor.count * componentBytes[accessor.componentType] * elementComponents[accessor.type];
    if (decodedBytes > GEOMETRY_LIMITS.decodedAccessorBytes) fail("MODEL_TOO_LARGE", "Decoded geometry exceeds the 128 MiB processing limit.");
  }
  const nodes = json.nodes ?? [];
  if (nodes.length > GEOMETRY_LIMITS.nodes) fail("MODEL_TOO_LARGE", "The GLB has too many scene nodes.");
  const state = new Uint8Array(nodes.length);
  const parentCount = new Uint8Array(nodes.length);
  for (const node of nodes) {
    if (!node || typeof node !== "object" || (node.children !== undefined && !Array.isArray(node.children))) fail("INVALID_SCENE", "The GLB contains an invalid node declaration.");
    for (const child of node.children ?? []) {
      if (!Number.isInteger(child) || child < 0 || child >= nodes.length || ++parentCount[child] > 1) {
        fail("INVALID_SCENE", "The GLB contains an invalid scene hierarchy.");
      }
    }
  }
  const visit = (id: number, depth: number) => {
    if (depth > 256 || state[id] === 1) fail("INVALID_SCENE", "The scene hierarchy is cyclic or too deep.");
    if (state[id] === 2) return;
    state[id] = 1;
    for (const child of nodes[id].children ?? []) visit(child, depth + 1);
    state[id] = 2;
  };
  for (let i = 0; i < nodes.length; i++) visit(i, 0);
  return extensions;
}

let dracoDecoder: Promise<unknown> | undefined;
async function configuredIo(extensions: string[]): Promise<NodeIO> {
  const dependencies: Record<string, unknown> = {};
  if (extensions.includes("KHR_draco_mesh_compression")) {
    dracoDecoder ??= import("draco3dgltf").then(({ default: draco }) => draco.createDecoderModule());
    dependencies["draco3d.decoder"] = await dracoDecoder;
  }
  if (extensions.includes("EXT_meshopt_compression")) {
    const { MeshoptDecoder } = await import("meshoptimizer");
    await MeshoptDecoder.ready;
    dependencies["meshopt.decoder"] = MeshoptDecoder;
  }
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies(dependencies);
}

function trianglesOf(document: Document, multiplier: number): TriangleSoup {
  const scenes = document.getRoot().listScenes();
  if (scenes.length !== 1) fail("UNSUPPORTED_SCENE", "The first version supports one static scene per GLB.");
  if (document.getRoot().listAnimations().length) fail("ANIMATED_MODEL", "Animated models must be baked to a static model first.");
  const meshNodes: Node[] = [];
  scenes[0].traverse((node) => {
    if (node.getSkin()) fail("SKINNED_MODEL", "Skinned models must be baked to a static model first.");
    if (node.getMesh()) meshNodes.push(node);
  });
  let triangleCount = 0;
  for (const node of meshNodes) {
    for (const primitive of node.getMesh()!.listPrimitives()) {
      if (primitive.getMode() !== 4) fail("UNSUPPORTED_PRIMITIVES", "Only triangle primitives are supported for manufacturing export.");
      if (primitive.listTargets().length) fail("MORPH_MODEL", "Morph-target models must be baked before export.");
      const position = primitive.getAttribute("POSITION");
      if (!position || position.getType() !== "VEC3") fail("MISSING_POSITIONS", "A mesh primitive has no valid vertex positions.");
      const indices = primitive.getIndices();
      if (indices && (indices.getNormalized() || indices.getType() !== "SCALAR")) fail("INVALID_INDICES", "Triangle indices must be scalar integers.");
      const count = indices ? indices.getCount() : position.getCount();
      if (count % 3 !== 0) fail("INVALID_TRIANGLES", "A triangle primitive contains an incomplete face.");
      triangleCount += count / 3;
      if (triangleCount > GEOMETRY_LIMITS.triangles) fail("MODEL_TOO_LARGE", "The model exceeds the 250,000 triangle processing limit.");
    }
  }
  if (triangleCount === 0) fail("EMPTY_MODEL", "The GLB contains no triangles.");
  const positions = new Float64Array(triangleCount * 9);
  let offset = 0, sourceVertexCount = 0, unreferencedVertexCount = 0;
  const local: number[] = [0, 0, 0];
  for (const node of meshNodes) {
    const m = node.getWorldMatrix();
    if (!Array.from(m).every(Number.isFinite)) fail("INVALID_TRANSFORM", "The scene contains an invalid world transform.");
    const determinant = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    if (!Number.isFinite(determinant) || determinant === 0) fail("INVALID_TRANSFORM", "The scene contains a singular world transform.");
    for (const primitive of node.getMesh()!.listPrimitives()) {
      const position = primitive.getAttribute("POSITION")!;
      const indices = primitive.getIndices();
      const count = indices ? indices.getCount() : position.getCount();
      const referenced = new Set<number>();
      sourceVertexCount += position.getCount();
      for (let i = 0; i < count; i += 3) {
        const order = determinant < 0 ? [0, 2, 1] : [0, 1, 2];
        for (const corner of order) {
          const index = indices ? indices.getScalar(i + corner) : i + corner;
          if (!Number.isInteger(index) || index < 0 || index >= position.getCount()) fail("INVALID_INDICES", "A triangle references a missing vertex.");
          referenced.add(index);
          position.getElement(index, local);
          const x = (m[0] * local[0] + m[4] * local[1] + m[8] * local[2] + m[12]) * multiplier;
          const y = (m[1] * local[0] + m[5] * local[1] + m[9] * local[2] + m[13]) * multiplier;
          const z = (m[2] * local[0] + m[6] * local[1] + m[10] * local[2] + m[14]) * multiplier;
          if (![x, y, z].every(Number.isFinite)) fail("INVALID_COORDINATE", "The model contains nonfinite coordinates.");
          positions[offset++] = x; positions[offset++] = y; positions[offset++] = z;
        }
      }
      unreferencedVertexCount += position.getCount() - referenced.size;
    }
  }
  return { positions, sourceVertexCount, unreferencedVertexCount };
}

export async function prepareModel(input: { source: Uint8Array; targetHeightMm: number }): Promise<PreparedModel> {
  if (!Number.isFinite(input.targetHeightMm) || input.targetHeightMm <= 0 || input.targetHeightMm > 10_000) {
    fail("INVALID_TARGET_HEIGHT", "Target height must be greater than zero and at most 10,000 millimeters.");
  }
  // Keep an exact independent copy; NodeIO output is not byte-identical to the source.
  const source = Uint8Array.from(input.source);
  const sourceExtensions = preflight(source);
  const io = await configuredIo(sourceExtensions);
  let document: Document;
  try { document = await io.readBinary(source); }
  catch (error) { return fail("GLB_DECODE_FAILED", `The GLB could not be decoded: ${error instanceof Error ? error.message : "unknown error"}`); }
  const originalTriangles = trianglesOf(document, 1);
  const originalBounds = boundsOf(originalTriangles.positions);
  if (!Number.isFinite(originalBounds.height) || originalBounds.height <= 1e-12) fail("ZERO_HEIGHT", "The model has no measurable height.");
  const scaleFactor = input.targetHeightMm / 1000 / originalBounds.height;
  const centerX = (originalBounds.min[0] + originalBounds.max[0]) / 2;
  const centerZ = (originalBounds.min[2] + originalBounds.max[2]) / 2;
  const translationMeters: Vec3 = [-scaleFactor * centerX, -scaleFactor * originalBounds.min[1], -scaleFactor * centerZ];
  const scene = document.getRoot().listScenes()[0];
  const originalRoots = scene.listChildren();
  const wrapper = document.createNode("MakeReady physical normalization")
    .setScale([scaleFactor, scaleFactor, scaleFactor]).setTranslation(translationMeters);
  for (const node of originalRoots) { scene.removeChild(node); wrapper.addChild(node); }
  scene.addChild(wrapper);
  document.getRoot().setDefaultScene(scene);

  const physicalTriangles = trianglesOf(document, 1000);
  const geometryAudit = inspectGeometry(physicalTriangles, input.targetHeightMm);
  const stl = binaryStl(physicalTriangles.positions);
  const sourceTextureHashes = document.getRoot().listTextures().map((texture) => {
    const image = texture.getImage();
    if (!image) return fail("MISSING_TEXTURE", "A source texture image is unavailable.");
    return sha256(image);
  });
  // Read-time decompression has already populated accessors. Avoid another lossy
  // encoding pass; retain all material, texture and quantization extensions.
  for (const extension of document.getRoot().listExtensionsUsed()) {
    if (["KHR_draco_mesh_compression", "EXT_meshopt_compression"].includes(extension.extensionName)) extension.dispose();
  }
  let glb: Uint8Array;
  try { glb = await io.writeBinary(document); }
  catch (error) { return fail("GLB_EXPORT_FAILED", `The normalized GLB could not be written: ${error instanceof Error ? error.message : "unknown error"}`); }
  const hashes = { source: sha256(source), glb: sha256(glb), stl: sha256(stl) };
  return {
    source, glb, stl, audit: toPhysicalAudit(geometryAudit, hashes), geometryAudit, bounds: geometryAudit.bounds,
    hashes,
    provenance: {
      pipelineVersion: "makeready.geometry.v1", sourceUnits: "m", glbUnits: "m", stlUnits: "mm",
      glbUpAxis: "Y", stlUpAxis: "Z", scaleFactor, sourceHeightMeters: originalBounds.height,
      translationMeters, sourceExtensions, sourceTextureHashes,
      preservation: "source.glb retains exact downloaded bytes. normalized.glb is reserialized; source material properties and encoded texture images are retained without texture reencoding. Geometry compression is decoded, not recompressed.",
    },
  };
}
