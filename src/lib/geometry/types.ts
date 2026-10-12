import type { PhysicalAudit } from "../contracts";

export type Vec3 = [number, number, number];

export interface ModelBounds {
  /** Millimeters, in the GLB's Y-up coordinate system. */
  min: Vec3;
  max: Vec3;
  width: number;
  height: number;
  depth: number;
}

export interface GeometryIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  count: number;
}

export interface GeometryAudit {
  version: "makeready.geometry.v1";
  /** Passing these checks is not a claim of manufacturing suitability. */
  status: "pass" | "fail";
  units: "mm";
  toleranceMm: number;
  targetHeightMm: number;
  bounds: ModelBounds;
  triangleCount: number;
  sourceVertexCount: number;
  weldedVertexCount: number;
  unreferencedVertexCount: number;
  boundaryEdgeCount: number;
  nonManifoldEdgeCount: number;
  nonManifoldVertexCount: number;
  inconsistentWindingEdgeCount: number;
  degenerateTriangleCount: number;
  duplicateTriangleCount: number;
  connectedComponentCount: number;
  issues: GeometryIssue[];
  notChecked: string[];
}

export interface ModelProvenance {
  pipelineVersion: "makeready.geometry.v1";
  sourceUnits: "m";
  glbUnits: "m";
  stlUnits: "mm";
  glbUpAxis: "Y";
  stlUpAxis: "Z";
  scaleFactor: number;
  sourceHeightMeters: number;
  translationMeters: Vec3;
  sourceExtensions: string[];
  sourceTextureHashes: string[];
  preservation: string;
}

export interface PreparedModel {
  source: Uint8Array;
  glb: Uint8Array;
  stl: Uint8Array;
  audit: PhysicalAudit;
  geometryAudit: GeometryAudit;
  bounds: ModelBounds;
  hashes: { source: string; glb: string; stl: string };
  provenance: ModelProvenance;
}

export interface TriangleSoup {
  /** Nine numbers per triangle, in millimeters, Y-up. */
  positions: Float64Array;
  sourceVertexCount: number;
  unreferencedVertexCount: number;
}

export class GeometryPreparationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "GeometryPreparationError";
  }
}
