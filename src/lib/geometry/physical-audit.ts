import type { AuditCheck, PhysicalAudit } from "../contracts";
import type { GeometryAudit } from "./types";

export function toPhysicalAudit(
  geometry: GeometryAudit,
  hashes: { source: string; glb: string; stl: string },
): PhysicalAudit {
  const checks: AuditCheck[] = [];
  const count = (id: string, actual: number, threshold: number, method: string) => {
    checks.push({ id, actual, threshold, status: actual === threshold ? "pass" : "fail", method, limitation: null });
  };
  checks.push({
    id: "height", status: Math.abs(geometry.bounds.height - geometry.targetHeightMm) <= 0.01 ? "pass" : "fail",
    actual: geometry.bounds.height, threshold: { targetMm: geometry.targetHeightMm, toleranceMm: 0.01 },
    method: "Bounds of referenced vertices after every node world transform, measured in millimeters.", limitation: null,
  });
  checks.push({ id: "finite_coordinates", status: "pass", actual: true, threshold: true, method: "All exported world-space vertex coordinates are finite; invalid inputs stop preparation.", limitation: null });
  count("boundary_edges", geometry.boundaryEdgeCount, 0, "Undirected triangle edge incidence after position-only welding.");
  count("non_manifold_edges", geometry.nonManifoldEdgeCount, 0, "Edges incident to more than two triangles after position-only welding.");
  count("non_manifold_vertices", geometry.nonManifoldVertexCount, 0, "Each vertex link must be a single cycle or a single boundary path.");
  count("inconsistent_winding_edges", geometry.inconsistentWindingEdgeCount, 0, "Shared edges must have opposite directions in their two incident faces.");
  count("degenerate_triangles", geometry.degenerateTriangleCount, 0, "Repeated welded vertices or area at most weldToleranceMm squared.");
  count("duplicate_triangles", geometry.duplicateTriangleCount, 0, "Repeated unordered triples of welded vertex IDs.");
  count("connected_components", geometry.connectedComponentCount, 1, "Surface components connected by shared triangle edges; one connected figure expected.");
  count("unreferenced_vertices", geometry.unreferencedVertexCount, 0, "Declared primitive vertices not referenced by any triangle.");
  const notChecked = [...new Set(["wall_thickness", "self_intersections", "supports", "material_strength", ...geometry.notChecked])];
  for (const id of notChecked) checks.push({ id, status: "not_checked", actual: null, threshold: null, method: "Not implemented.", limitation: "This property needs additional manufacturing analysis and has not been measured." });
  return {
    engineVersion: geometry.version, measuredBy: "server", inputSha256: hashes.source,
    outputSha256: { glb: hashes.glb, stl: hashes.stl }, targetHeightMm: geometry.targetHeightMm,
    measuredBoundsMm: geometry.bounds, triangleCount: geometry.triangleCount,
    weldToleranceMm: geometry.toleranceMm, checks, notChecked,
    manufacturingStatus: "preparation_only", createdAt: new Date().toISOString(),
  };
}
