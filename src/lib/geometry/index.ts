export { prepareModel, sha256, GEOMETRY_LIMITS } from "./prepare";
export { inspectGeometry, boundsOf, WELD_TOLERANCE_MM } from "./inspect";
export { binaryStl } from "./stl";
export { toPhysicalAudit } from "./physical-audit";
export { GeometryPreparationError } from "./types";
export type { PreparedModel, GeometryAudit, GeometryIssue, ModelBounds, ModelProvenance, TriangleSoup, Vec3 } from "./types";
