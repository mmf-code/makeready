import JSZip from "jszip";
import type { PreparedModel } from "./geometry/types";

/** Creates a self-contained package; a physical audit failure remains visible. */
export async function makePackage(model: PreparedModel, extraManifest: Record<string, unknown> = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("source.glb", model.source, { compression: "STORE" });
  zip.file("normalized.glb", model.glb, { compression: "STORE" });
  zip.file("model.stl", model.stl);
  zip.file("audit.json", JSON.stringify(model.audit, null, 2));
  zip.file("geometry-audit.json", JSON.stringify(model.geometryAudit, null, 2));
  zip.file("manifest.json", JSON.stringify({
    ...extraManifest,
    schemaVersion: "makeready.make-package.v1",
    files: {
      "source.glb": { sha256: model.hashes.source, bytes: model.source.byteLength, purpose: "Exact original provider artifact" },
      "normalized.glb": { sha256: model.hashes.glb, bytes: model.glb.byteLength, units: "m", upAxis: "Y" },
      "model.stl": { sha256: model.hashes.stl, bytes: model.stl.byteLength, units: "mm", upAxis: "Z" },
    },
    physicalAuditStatus: model.geometryAudit.status,
    dimensionsMm: { width: model.bounds.width, height: model.bounds.height, depth: model.bounds.depth },
    provenance: model.provenance,
  }, null, 2));
  const findings = model.geometryAudit.issues.length
    ? model.geometryAudit.issues.map((issue) => `- ${issue.severity.toUpperCase()}: ${issue.message} (${issue.count})`).join("\n")
    : "The implemented topology checks found no issues.";
  const cnc = model.audit.notChecked.includes("cnc_tool_access");
  const manufacturingReview = cnc
    ? "CNC candidate only. Review cutter access, undercuts, stock dimensions, fixturing and material before machining. Create and simulate CAM toolpaths with the intended cutter and machine; no toolpaths or machining verification are included."
    : "Review the model in a slicer, verify dimensions and wall thickness, and select material, orientation and supports before manufacturing.";
  zip.file("README.md", `# MakeReady production preparation\n\nPhysical audit: ${model.geometryAudit.status.toUpperCase()}. This is a bounded geometry inspection, not a manufacturing certification.\n\n- source.glb: the exact original provider file.\n- normalized.glb: scaled textured model in meters, Y-up.\n- model.stl: surface geometry in millimeters, Z-up. STL does not contain colors, textures or unit metadata. Import it into your slicer or CAM software using millimeters.\n- audit.json: measured dimensions, topology findings and checks not performed.\n- geometry-audit.json: detailed topology counts and findings.\n- manifest.json: units, hashes and provenance.\n\nTarget height: ${model.audit.targetHeightMm} mm. Dimensions: ${model.bounds.width.toFixed(3)} x ${model.bounds.depth.toFixed(3)} x ${model.bounds.height.toFixed(3)} mm (width x depth x height).\n\n## Findings\n\n${findings}\n\n## Checks not performed\n\n${model.geometryAudit.notChecked.map((check) => `- ${check}`).join("\n")}\n\n${manufacturingReview} Failed physical checks must be reviewed and repaired; downloading files does not change their audit result.\n\n${model.provenance.preservation}\n`);
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
