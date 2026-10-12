import { GeometryPreparationError } from "./types";

/** STL has no unit metadata: coordinates here are explicitly millimeters. */
export function binaryStl(positions: Float64Array): Uint8Array {
  if (positions.length === 0 || positions.length % 9 !== 0) {
    throw new GeometryPreparationError("INVALID_TRIANGLES", "No complete triangles to export.");
  }
  const triangleCount = positions.length / 9;
  const result = new Uint8Array(84 + triangleCount * 50);
  result.set(new TextEncoder().encode("MakeReady | millimeters | Z-up | see audit.json"));
  const view = new DataView(result.buffer);
  view.setUint32(80, triangleCount, true);
  let offset = 84;
  for (let i = 0; i < positions.length; i += 9) {
    // A proper rotation: Y-up -> Z-up, preserving handedness.
    const a = [positions[i], -positions[i + 2], positions[i + 1]];
    const b = [positions[i + 3], -positions[i + 5], positions[i + 4]];
    const c = [positions[i + 6], -positions[i + 8], positions[i + 7]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length > 0) { nx /= length; ny /= length; nz /= length; }
    for (const value of [nx, ny, nz, ...a, ...b, ...c]) {
      if (!Number.isFinite(value) || Math.abs(value) > 3.402823466e38) {
        throw new GeometryPreparationError("INVALID_COORDINATE", "STL contains an invalid coordinate.");
      }
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  return result;
}
