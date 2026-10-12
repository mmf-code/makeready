import type { GeometryAudit, GeometryIssue, ModelBounds, TriangleSoup, Vec3 } from "./types";

export const WELD_TOLERANCE_MM = 0.001;

export function boundsOf(positions: Float64Array): ModelBounds {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], positions[i + axis]);
      max[axis] = Math.max(max[axis], positions[i + axis]);
    }
  }
  return { min, max, width: max[0] - min[0], height: max[1] - min[1], depth: max[2] - min[2] };
}

/** Position welding is for inspection only; UVs, normals and source geometry are never changed. */
export function inspectGeometry(soup: TriangleSoup, targetHeightMm: number): GeometryAudit {
  const { positions } = soup;
  const tolerance = WELD_TOLERANCE_MM;
  const buckets = new Map<string, number[]>();
  const vertices: Vec3[] = [];
  const welded = new Uint32Array(positions.length / 3);
  const toleranceSquared = tolerance * tolerance;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    const bx = Math.floor(x / tolerance), by = Math.floor(y / tolerance), bz = Math.floor(z / tolerance);
    let found = -1;
    search: for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const candidates = buckets.get(`${bx + dx},${by + dy},${bz + dz}`);
          if (!candidates) continue;
          for (const id of candidates) {
            const v = vertices[id];
            if ((v[0] - x) ** 2 + (v[1] - y) ** 2 + (v[2] - z) ** 2 <= toleranceSquared) {
              found = id;
              break search;
            }
          }
        }
      }
    }
    if (found < 0) {
      found = vertices.length;
      vertices.push([x, y, z]);
      const key = `${bx},${by},${bz}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(found); else buckets.set(key, [found]);
    }
    welded[i / 3] = found;
  }

  const triangleCount = positions.length / 9;
  const parents = Int32Array.from({ length: triangleCount }, (_, i) => i);
  const activeFaces = new Set<number>();
  const incidentFaces: number[][] = Array.from({ length: vertices.length }, () => []);
  const edges = new Map<string, { faces: number[]; balance: number }>();
  const faceKeys = new Set<string>();
  let degenerateTriangleCount = 0;
  let duplicateTriangleCount = 0;
  const find = (id: number): number => {
    let root = id;
    while (parents[root] !== root) root = parents[root];
    while (parents[id] !== id) { const next = parents[id]; parents[id] = root; id = next; }
    return root;
  };
  const union = (a: number, b: number) => { parents[find(a)] = find(b); };
  for (let face = 0; face < triangleCount; face++) {
    const [a, b, c] = [welded[face * 3], welded[face * 3 + 1], welded[face * 3 + 2]];
    const p = face * 9;
    const ux = positions[p + 3] - positions[p], uy = positions[p + 4] - positions[p + 1], uz = positions[p + 5] - positions[p + 2];
    const vx = positions[p + 6] - positions[p], vy = positions[p + 7] - positions[p + 1], vz = positions[p + 8] - positions[p + 2];
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    if (a === b || b === c || c === a || area <= toleranceSquared) {
      degenerateTriangleCount++;
      continue;
    }
    const faceKey = [a, b, c].sort((left, right) => left - right).join(",");
    if (faceKeys.has(faceKey)) duplicateTriangleCount++; else faceKeys.add(faceKey);
    activeFaces.add(face);
    for (const vertex of [a, b, c]) incidentFaces[vertex].push(face);
    for (const [start, end] of [[a, b], [b, c], [c, a]]) {
      const key = start < end ? `${start},${end}` : `${end},${start}`;
      const direction = start < end ? 1 : -1;
      const edge = edges.get(key);
      if (edge) { edge.faces.push(face); edge.balance += direction; union(face, edge.faces[0]); }
      else edges.set(key, { faces: [face], balance: direction });
    }
  }
  let boundaryEdgeCount = 0, nonManifoldEdgeCount = 0, inconsistentWindingEdgeCount = 0;
  for (const edge of edges.values()) {
    if (edge.faces.length === 1) boundaryEdgeCount++;
    if (edge.faces.length > 2) nonManifoldEdgeCount++;
    if (edge.faces.length === 2 && edge.balance !== 0) inconsistentWindingEdgeCount++;
  }

  // Each vertex's link must be one cycle (interior) or one path (boundary).
  // Edge incidence alone would miss two closed shells touching at one vertex.
  let nonManifoldVertexCount = 0;
  for (let vertex = 0; vertex < incidentFaces.length; vertex++) {
    const faces = incidentFaces[vertex];
    if (faces.length === 0) continue;
    const link = new Map<number, number[]>();
    for (const face of faces) {
      const others = [welded[face * 3], welded[face * 3 + 1], welded[face * 3 + 2]].filter((id) => id !== vertex);
      for (const [a, b] of [[others[0], others[1]], [others[1], others[0]]]) {
        const neighbors = link.get(a);
        if (neighbors) neighbors.push(b); else link.set(a, [b]);
      }
    }
    const first = link.keys().next().value as number;
    const seen = new Set<number>();
    const stack = [first];
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const neighbor of link.get(next) ?? []) if (!seen.has(neighbor)) stack.push(neighbor);
    }
    let endpoints = 0, invalidDegree = false;
    for (const neighbors of link.values()) {
      if (neighbors.length === 1) endpoints++;
      else if (neighbors.length !== 2) invalidDegree = true;
    }
    if (seen.size !== link.size || invalidDegree || (endpoints !== 0 && endpoints !== 2)) nonManifoldVertexCount++;
  }
  const connectedComponentCount = new Set(Array.from(activeFaces, find)).size;
  const bounds = boundsOf(positions);
  const issues: GeometryIssue[] = [];
  const issue = (code: string, count: number, message: string, severity: "error" | "warning" = "error") => {
    if (count > 0) issues.push({ code, count, severity, message });
  };
  issue("BOUNDARY_EDGES", boundaryEdgeCount, "The surface has open boundary edges.");
  issue("NON_MANIFOLD_EDGES", nonManifoldEdgeCount, "Some edges belong to more than two triangles.");
  issue("NON_MANIFOLD_VERTICES", nonManifoldVertexCount, "Some vertices do not have a connected surface fan.");
  issue("INCONSISTENT_WINDING", inconsistentWindingEdgeCount, "Adjacent faces have inconsistent orientation.");
  issue("DEGENERATE_TRIANGLES", degenerateTriangleCount, "Some triangles have negligible area or repeated vertices.");
  issue("DUPLICATE_TRIANGLES", duplicateTriangleCount, "Some triangles duplicate an existing surface.");
  issue("DISCONNECTED_COMPONENTS", Math.max(0, connectedComponentCount - 1), "The model contains separate surface components.");
  issue("UNREFERENCED_VERTICES", soup.unreferencedVertexCount, "Some source vertices are not referenced by a face.");
  if (Math.abs(bounds.height - targetHeightMm) > 0.01) issue("HEIGHT_MISMATCH", 1, "Measured height differs from the requested height by more than 0.01 mm.");
  if (activeFaces.size === 0) issue("NO_VALID_SURFACE", 1, "No nondegenerate surface triangles were found.");
  return {
    version: "makeready.geometry.v1", status: issues.some((entry) => entry.severity === "error") ? "fail" : "pass",
    units: "mm", toleranceMm: tolerance, targetHeightMm, bounds, triangleCount,
    sourceVertexCount: soup.sourceVertexCount, weldedVertexCount: vertices.length,
    unreferencedVertexCount: soup.unreferencedVertexCount,
    boundaryEdgeCount, nonManifoldEdgeCount, nonManifoldVertexCount, inconsistentWindingEdgeCount,
    degenerateTriangleCount, duplicateTriangleCount, connectedComponentCount, issues,
    notChecked: ["Wall thickness", "Self-intersections", "Overhangs and supports", "Structural strength", "Material suitability", "Printer-specific tolerances"],
  };
}
