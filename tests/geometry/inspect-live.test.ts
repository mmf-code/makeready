import { createHash } from "node:crypto";
import { Document, NodeIO } from "@gltf-transform/core";
import { BoxGeometry, Mesh } from "three";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { describe, expect, it } from "vitest";
import { measureOutputs, parseOptions } from "../../scripts/inspect-live.mjs";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Deliberately does not call prepareModel, binaryStl or the geometry audit. */
async function independentlyEncodedFiles(wrongStlAxis = false) {
  const document = new Document(), buffer = document.createBuffer();
  const shape = new BoxGeometry(0.08, 0.012, 0.06);
  const raw = shape.getAttribute("position").array;
  const vertices = new Float32Array(raw.length + 3);
  vertices.set(raw); vertices.set([9999, 9999, 9999], raw.length); // Not referenced by a face.
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(vertices).setBuffer(buffer))
    .setIndices(document.createAccessor().setType("SCALAR").setArray(new Uint16Array(shape.index!.array)).setBuffer(buffer));
  const node = document.createNode().setMesh(document.createMesh().addPrimitive(primitive)).setTranslation([0.01, 0.006, -0.02]);
  const wrapper = document.createNode().setTranslation([-0.01, 0, 0.02]).addChild(node);
  const scene = document.createScene().addChild(wrapper);
  document.getRoot().setDefaultScene(scene);
  const glb = await new NodeIO().writeBinary(document);
  const stlShape = new BoxGeometry(80, 12, 60), mesh = new Mesh(stlShape);
  if (wrongStlAxis) mesh.position.y = 6;
  else { mesh.rotation.x = Math.PI / 2; mesh.position.z = 6; }
  mesh.updateMatrixWorld(true);
  const encoded = new STLExporter().parse(mesh, { binary: true });
  const stl = new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  shape.dispose(); stlShape.dispose();
  return {
    source: glb, glb, stl,
    expected: { width: 80, depth: 60, height: 12 },
    audit: {
      engineVersion: "test-independent-files", measuredBy: "server", inputSha256: sha(glb), outputSha256: { glb: sha(glb), stl: sha(stl) },
      targetHeightMm: 12, measuredBoundsMm: { width: 80, height: 12, depth: 60, min: [-40, 0, -30], max: [40, 12, 30] },
      triangleCount: 12, weldToleranceMm: 0.001,
      checks: [{ id: "boundary_edges", status: "fail", actual: 2, threshold: 0, method: "Synthetic failed audit to test separation", limitation: null }],
      notChecked: ["cnc_tool_access", "cnc_toolpaths"], manufacturingStatus: "preparation_only", createdAt: "2026-10-12T10:00:00.000Z",
    },
  };
}

describe("independent local output measurements", () => {
  it("reloads nested transforms and referenced vertices, matches Y-up to Z-up, and preserves a failed physical audit", async () => {
    const result = await measureOutputs(await independentlyEncodedFiles());
    expect(result.measurementStatus).toBe("pass");
    expect(result.glb.measuredBoundsMm.height).toBeCloseTo(12, 4);
    expect(result.stl.nativeBoundsMm.height).toBeCloseTo(12, 4);
    expect(result.glb.measuredBoundsMm.width).toBeCloseTo(80, 4);
    expect(result.checks.find((check) => check.id === "y_up_glb_matches_z_up_stl_corners")).toMatchObject({ pass: true });
    expect(result.physicalAudit).toMatchObject({ status: "fail", failed: 1, manufacturingStatus: "preparation_only", notChecked: ["cnc_tool_access", "cnc_toolpaths"] });
  });

  it("fails an expected width mismatch without silently rescaling actual measurements", async () => {
    const files = await independentlyEncodedFiles();
    const result = await measureOutputs({ ...files, expected: { ...files.expected, width: 81 } });
    expect(result.measurementStatus).toBe("fail");
    expect(result.glb.measuredBoundsMm.width).toBeCloseTo(80, 4);
    expect(result.checks.find((check) => check.id === "glb_expected_width_mm")).toMatchObject({ pass: false, expected: 81, toleranceMm: 0.1 });
    expect(result.checks.find((check) => check.id === "stl_expected_width_mm")).toMatchObject({ pass: false });
  });

  it("fails a wrong STL up axis even when that file matches the audit's declared hash", async () => {
    const result = await measureOutputs(await independentlyEncodedFiles(true));
    expect(result.measurementStatus).toBe("fail");
    expect(result.checks.find((check) => check.id === "stl_hash_matches_audit")).toMatchObject({ pass: true });
    expect(result.checks.find((check) => check.id === "y_up_glb_matches_z_up_stl_corners")).toMatchObject({ pass: false });
    expect(result.checks.find((check) => check.id === "stl_ground_z_mm")).toMatchObject({ pass: false });
  });

  it("fails a changed artifact's hash and requires a positive height", async () => {
    const files = await independentlyEncodedFiles();
    const result = await measureOutputs({ ...files, source: Uint8Array.from([1, 2, 3]) });
    expect(result.checks.find((check) => check.id === "source_hash_matches_audit")).toMatchObject({ pass: false });
    expect(result.measurementStatus).toBe("fail");
    expect(() => parseOptions(["--dir", "artifacts/live/run"])).toThrow("REQUIRED_DIMENSIONS_MISSING");
    expect(() => parseOptions(["--dir", "artifacts/live/run", "--height-mm", "12", "--width-mm", "0", "--depth-mm", "60"])).toThrow("INVALID_EXPECTED_DIMENSIONS");
  });

  it("checks a height-only request without inventing expected width or depth", async () => {
    expect(parseOptions(["--dir", "artifacts/live/run", "--height-mm", "12"]).expected).toEqual({ height: 12 });
    const files = await independentlyEncodedFiles();
    const result = await measureOutputs({ ...files, expected: { height: 12 } });
    expect(result.measurementStatus).toBe("pass");
    expect(result.expectedDimensionsMm).toEqual({ height: 12 });
    expect(result.glb.measuredBoundsMm.width).toBeCloseTo(80, 4);
    expect(result.glb.measuredBoundsMm.depth).toBeCloseTo(60, 4);
    expect(result.checks.some((check) => check.id.includes("expected_width") || check.id.includes("expected_depth"))).toBe(false);
    expect(result.checks.find((check) => check.id === "glb_expected_height_mm")).toMatchObject({ pass: true, expected: 12 });
  });

  it("preserves every unchecked label and does not infer a physical pass from unchecked-only results", async () => {
    const files = await independentlyEncodedFiles();
    const notChecked = ["CNC tool access", "İnce duvar kalınlığı", "Self-intersection / toolpath clearance", "cnc_toolpaths"];
    const result = await measureOutputs({ ...files, audit: {
      ...files.audit,
      checks: notChecked.map((id) => ({ id, status: "not_checked", actual: null, threshold: null, method: "Not implemented", limitation: "Not measured" })),
      notChecked,
    } });
    expect(result.measurementStatus).toBe("pass");
    expect(result.physicalAudit).toMatchObject({ status: "not_checked", passed: 0, failed: 0, notChecked });
    const empty = await measureOutputs({ ...files, audit: { ...files.audit, checks: [], notChecked } });
    expect(empty.physicalAudit.status).toBe("not_checked");
    expect(empty.physicalAudit.notChecked).toEqual(notChecked);
  });
});
