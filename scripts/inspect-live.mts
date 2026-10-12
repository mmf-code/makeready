/**
 * Independent local measurement of real downloaded MakeReady outputs.
 * pnpm exec tsx scripts/inspect-live.mts --dir artifacts/live/<run> \
 *   --width-mm 80 --depth-mm 60 --height-mm 12
 *
 * Reads source.glb, normalized.glb, model.stl and audit.json; writes only
 * measurement.json beside them. No network, environment, repair or rescaling.
 * --height-mm is required; --width-mm and --depth-mm are optional.
 * Output dimensions are checked against every explicitly requested dimension
 * with a fixed 0.1 mm tolerance. A failed measurement exits with status 1.
 * GLB is interpreted as meters/Y-up; STL as millimeters/Z-up, because STL
 * itself contains no authoritative unit or axis metadata.
 */
import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger, NodeIO, type Document } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { Box3, Matrix4, Vector3 } from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { PhysicalAuditSchema } from "../src/lib/contracts";

export const TOLERANCE_MM = 0.1;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TRIANGLES = 250_000;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
type Dimensions = { width: number; depth: number; height: number };
type ExpectedDimensions = { height: number; width?: number; depth?: number };
type Bounds = Dimensions & { min: [number, number, number]; max: [number, number, number] };
class InspectionError extends Error {}
function reject(code: string): never { throw new InspectionError(code); }
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function parseOptions(args: string[]) {
  const accepted = new Set(["--dir", "--width-mm", "--depth-mm", "--height-mm"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!accepted.has(flag) || !value || value.startsWith("--") || values.has(flag)) reject("INVALID_ARGUMENT");
    values.set(flag, value);
  }
  if (!values.has("--dir") || !values.has("--height-mm")) reject("REQUIRED_DIMENSIONS_MISSING");
  const expected: ExpectedDimensions = {
    height: Number(values.get("--height-mm")),
    ...(values.has("--width-mm") ? { width: Number(values.get("--width-mm")) } : {}),
    ...(values.has("--depth-mm") ? { depth: Number(values.get("--depth-mm")) } : {}),
  };
  if (Object.values(expected).some((value) => !Number.isFinite(value) || value <= 0 || value > 10_000)) reject("INVALID_EXPECTED_DIMENSIONS");
  return { directory: resolve(values.get("--dir")!), expected };
}

async function readBounded(path: string): Promise<Uint8Array> {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) reject("INVALID_FILE_SIZE");
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_FILE_BYTES) reject("INVALID_FILE_SIZE");
  return bytes;
}

async function loadGlb(glb: Uint8Array): Promise<Document> {
  if (glb.byteLength < 20 || glb.byteLength > MAX_FILE_BYTES) reject("INVALID_GLB");
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const length = view.getUint32(12, true);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== glb.byteLength || view.getUint32(16, true) !== 0x4e4f534a || length > 8 * 1024 * 1024 || length + 20 > glb.byteLength) reject("INVALID_GLB");
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length))) as {
    buffers?: { uri?: string }[]; images?: { uri?: string }[];
    accessors?: { count: number }[]; nodes?: unknown[];
  };
  if ([...(json.buffers ?? []), ...(json.images ?? [])].some((resource) => resource.uri && !resource.uri.startsWith("data:"))) reject("EXTERNAL_GLB_RESOURCE");
  if ((json.nodes?.length ?? 0) > 10_000 || (json.accessors ?? []).some((accessor) => !Number.isSafeInteger(accessor.count) || accessor.count < 0 || accessor.count > 2_000_000)) reject("GLB_RESOURCE_LIMIT");
  const [{ default: draco }, { MeshoptDecoder }] = await Promise.all([import("draco3dgltf"), import("meshoptimizer")]);
  await MeshoptDecoder.ready;
  const io = new NodeIO().setAllowNetwork(false).setLogger(new Logger(Logger.Verbosity.SILENT))
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "draco3d.decoder": await draco.createDecoderModule(), "meshopt.decoder": MeshoptDecoder });
  return io.readBinary(glb);
}

/** Uses Three's matrix math, not the preparation pipeline's coordinate code. */
function glbWorldCorners(document: Document): Float64Array {
  const scenes = document.getRoot().listScenes();
  if (scenes.length !== 1 || document.getRoot().listAnimations().length) reject("UNSUPPORTED_DYNAMIC_OR_MULTISCENE_GLB");
  const corners: number[] = [];
  const point = new Vector3(), matrix = new Matrix4(), local: number[] = [];
  let count = 0;
  scenes[0].traverse((node) => {
    if (node.getSkin() || node.getExtension("EXT_mesh_gpu_instancing")) reject("UNSUPPORTED_DYNAMIC_OR_INSTANCED_GLB");
    matrix.fromArray(node.getWorldMatrix());
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      if (primitive.getMode() !== 4 || primitive.listTargets().length) reject("UNSUPPORTED_GLB_PRIMITIVE");
      const positions = primitive.getAttribute("POSITION"), indices = primitive.getIndices();
      if (!positions || positions.getType() !== "VEC3") reject("MISSING_GLB_POSITIONS");
      const vertices = indices?.getCount() ?? positions.getCount();
      if (vertices % 3 !== 0 || (count += vertices / 3) > MAX_TRIANGLES) reject("INVALID_TRIANGLE_COUNT");
      for (let index = 0; index < vertices; index++) {
        const vertex = indices ? indices.getScalar(index) : index;
        if (!Number.isInteger(vertex) || vertex < 0 || vertex >= positions.getCount()) reject("INVALID_GLB_INDEX");
        positions.getElement(vertex, local); // API decodes normalized integer accessors.
        point.fromArray(local).applyMatrix4(matrix).multiplyScalar(1000);
        if (![point.x, point.y, point.z].every(Number.isFinite)) reject("NONFINITE_GLB_COORDINATE");
        corners.push(point.x, point.y, point.z);
      }
    }
  });
  if (!corners.length) reject("EMPTY_GLB");
  return Float64Array.from(corners);
}

function boundsOf(corners: Float64Array): Bounds {
  const box = new Box3(), point = new Vector3();
  for (let index = 0; index < corners.length; index += 3) box.expandByPoint(point.fromArray(corners, index));
  const size = box.getSize(new Vector3());
  return { width: size.x, height: size.y, depth: size.z, min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
}

function loadStl(stl: Uint8Array) {
  if (stl.byteLength < 84 || stl.byteLength > MAX_FILE_BYTES) reject("INVALID_STL");
  const count = new DataView(stl.buffer, stl.byteOffset, stl.byteLength).getUint32(80, true);
  if (count === 0 || count > MAX_TRIANGLES || 84 + count * 50 !== stl.byteLength) reject("INVALID_BINARY_STL");
  const geometry = new STLLoader().parse(Uint8Array.from(stl).buffer);
  try {
    const position = geometry.getAttribute("position");
    if (!position || position.count !== count * 3) reject("INVALID_STL_POSITIONS");
    const canonical = new Float64Array(position.count * 3);
    for (let index = 0; index < position.count; index++) {
      // Inverse of the proper Y-up -> Z-up rotation: (x,y,z) -> (x,z,-y).
      const x = position.getX(index), y = position.getY(index), z = position.getZ(index);
      if (![x, y, z].every(Number.isFinite)) reject("NONFINITE_STL_COORDINATE");
      canonical[index * 3] = x; canonical[index * 3 + 1] = z; canonical[index * 3 + 2] = -y;
    }
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    return {
      corners: canonical,
      canonicalBounds: boundsOf(canonical),
      nativeBounds: { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z], width: box.max.x - box.min.x, depth: box.max.y - box.min.y, height: box.max.z - box.min.z },
    };
  } finally { geometry.dispose(); }
}

function maxBoundsDelta(a: Bounds, b: Bounds): number {
  return Math.max(...(["width", "height", "depth"] as const).map((key) => Math.abs(a[key] - b[key])), ...a.min.map((value, index) => Math.abs(value - b.min[index])), ...a.max.map((value, index) => Math.abs(value - b.max[index])));
}

/** Matching face ordinal, allowing either winding and every corner ordering. */
function cornerDelta(a: Float64Array, b: Float64Array): number | null {
  if (a.length !== b.length) return null;
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  let maximum = 0;
  for (let offset = 0; offset < a.length; offset += 9) {
    let best = Infinity;
    for (const order of permutations) {
      let distance = 0;
      for (let vertex = 0; vertex < 3; vertex++) for (let axis = 0; axis < 3; axis++) distance = Math.max(distance, Math.abs(a[offset + vertex * 3 + axis] - b[offset + order[vertex] * 3 + axis]));
      best = Math.min(best, distance);
    }
    maximum = Math.max(maximum, best);
  }
  return maximum;
}

export async function measureOutputs(input: { source: Uint8Array; glb: Uint8Array; stl: Uint8Array; audit: unknown; expected: ExpectedDimensions }) {
  if (!Number.isFinite(input.expected.height) || input.expected.height <= 0 || Object.values(input.expected).some((value) => !Number.isFinite(value) || value <= 0)) reject("INVALID_EXPECTED_DIMENSIONS");
  const audit = PhysicalAuditSchema.parse(input.audit);
  const glbCorners = glbWorldCorners(await loadGlb(input.glb));
  const glb = boundsOf(glbCorners), stl = loadStl(input.stl);
  const hashes = { source: hash(input.source), glb: hash(input.glb), stl: hash(input.stl) };
  const checks: { id: string; pass: boolean; actual: number | boolean | null; expected: number | boolean; toleranceMm?: number }[] = [];
  const numeric = (id: string, actual: number, expected: number) => checks.push({ id, pass: Math.abs(actual - expected) <= TOLERANCE_MM, actual, expected, toleranceMm: TOLERANCE_MM });
  const boolean = (id: string, actual: boolean) => checks.push({ id, pass: actual, actual, expected: true });
  boolean("source_hash_matches_audit", hashes.source === audit.inputSha256);
  boolean("glb_hash_matches_audit", hashes.glb === audit.outputSha256.glb);
  boolean("stl_hash_matches_audit", hashes.stl === audit.outputSha256.stl);
  for (const key of ["width", "depth", "height"] as const) {
    const target = input.expected[key];
    if (target !== undefined) {
      numeric(`glb_expected_${key}_mm`, glb[key], target);
      numeric(`stl_expected_${key}_mm`, stl.canonicalBounds[key], target);
    }
  }
  numeric("audit_target_height_mm", audit.targetHeightMm, input.expected.height);
  numeric("glb_audit_bounds_max_delta_mm", maxBoundsDelta(glb, audit.measuredBoundsMm), 0);
  numeric("stl_audit_bounds_max_delta_mm", maxBoundsDelta(stl.canonicalBounds, audit.measuredBoundsMm), 0);
  numeric("glb_stl_bounds_max_delta_mm", maxBoundsDelta(glb, stl.canonicalBounds), 0);
  numeric("glb_ground_y_mm", glb.min[1], 0);
  numeric("stl_ground_z_mm", stl.nativeBounds.min[2], 0);
  boolean("glb_triangle_count_matches_audit", glbCorners.length / 9 === audit.triangleCount);
  boolean("stl_triangle_count_matches_audit", stl.corners.length / 9 === audit.triangleCount);
  const axisDelta = cornerDelta(glbCorners, stl.corners);
  checks.push({ id: "y_up_glb_matches_z_up_stl_corners", pass: axisDelta !== null && axisDelta <= TOLERANCE_MM, actual: axisDelta, expected: 0, toleranceMm: TOLERANCE_MM });
  return {
    schemaVersion: "makeready.independent-measurement.v1",
    measurementStatus: checks.every((check) => check.pass) ? "pass" : "fail",
    toleranceMm: TOLERANCE_MM,
    expectedDimensionsMm: input.expected,
    glb: { assumedUnits: "m", upAxis: "Y", measuredBoundsMm: glb, triangleCount: glbCorners.length / 9 },
    stl: { assumedUnits: "mm", upAxis: "Z", nativeBoundsMm: stl.nativeBounds, yUpBoundsMm: stl.canonicalBounds, triangleCount: stl.corners.length / 9 },
    hashes,
    checks,
    physicalAudit: {
      status: audit.checks.some((check) => check.status === "fail") ? "fail" : audit.checks.some((check) => check.status === "pass") ? "pass" : "not_checked",
      passed: audit.checks.filter((check) => check.status === "pass").length,
      failed: audit.checks.filter((check) => check.status === "fail").length,
      notChecked: [...audit.notChecked],
      manufacturingStatus: "preparation_only",
    },
    limitations: ["This independently checks file identity, referenced vertex measurements and coordinate conversion; it does not repeat the topology audit.", "Triangle comparison preserves face ordinal and allows all corner orderings; arbitrary face reordering is not supported.", "No wall thickness, tool access, toolpath or machining suitability analysis is performed."],
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const directory = await realpath(options.directory);
  const inside = relative(root, directory);
  if (!isAbsolute(inside) && inside !== ".." && !inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && inside !== "artifacts/live" && !inside.startsWith(`artifacts/live${process.platform === "win32" ? "\\" : "/"}`)) reject("RESULT_FOLDER_MUST_BE_IGNORED");
  const [source, glb, stl, audit] = await Promise.all(["source.glb", "normalized.glb", "model.stl", "audit.json"].map((name) => readBounded(join(directory, name))));
  const result = await measureOutputs({ source, glb, stl, audit: JSON.parse(new TextDecoder().decode(audit)), expected: options.expected });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  await writeFile(join(directory, "measurement.json"), serialized, { mode: 0o600 });
  console.info(serialized.trim());
  if (result.measurementStatus !== "pass") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error: unknown) => {
  console.error(JSON.stringify({ measurementStatus: "fail", error: error instanceof InspectionError ? error.message : "UNREADABLE_OR_UNSUPPORTED_OUTPUT", detailsSuppressed: true }));
  process.exitCode = 1;
});
