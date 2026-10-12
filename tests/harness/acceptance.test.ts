import { describe, expect, it } from "vitest";
import type { DesignSpec, PhysicalAudit } from "@/lib/contracts";
import { evaluateChecks, quotedMillimetres, specChecks, toleranceFor, verifyFeedbackChecks } from "@/lib/harness/acceptance";

const hash = "a".repeat(64);
const spec: DesignSpec = { description: "Logo", objectType: "logo", use: "wall sign", targetHeightMm: 120, preserve: [], changeable: [], process: "fdm_candidate" };
// Measured bounds of the actual refined logo run (docs/AGENT_REFINEMENT_EVIDENCE.md).
const refinedLogo = {
  engineVersion: "test", measuredBy: "server", inputSha256: hash, outputSha256: { glb: hash, stl: hash }, targetHeightMm: 120,
  measuredBoundsMm: { width: 177.46775, height: 120, depth: 69.62725, min: [0, 0, 0], max: [0, 0, 0] },
  triangleCount: 80000, weldToleranceMm: 0.001, checks: [], notChecked: [], manufacturingStatus: "preparation_only", createdAt: "2026-10-12T10:16:00.000Z",
} as PhysicalAudit;
const planId = "33333333-3333-4333-8333-333333333333";

describe("feedback acceptance checks", () => {
  it("reads millimetre values written in mm, cm, with a comma or as a bare number", () => {
    expect(quotedMillimetres("derinlik 25 mm olsun")).toEqual([25]);
    expect(quotedMillimetres("2,5 cm kalınlık")).toEqual([25]);
    expect(quotedMillimetres("120mm boy")).toEqual([120]);
    expect(quotedMillimetres("depth 25")).toEqual([25]);
  });

  it("keeps a verbatim quote that states its value and sets the tolerance in code", () => {
    const feedback = "Logo çok ince. Derinliği 25 mm olsun, yüksekliği koru.";
    const { checks, rejected } = verifyFeedbackChecks(feedback, [{ metric: "depth_mm", op: "=", value: 25, quote: "Derinliği 25 mm olsun" }]);
    expect(rejected).toBe(0);
    expect(checks).toEqual([{ id: "feedback-1-depth_mm", metric: "depth_mm", op: "=", value: 25, toleranceMm: toleranceFor(25, "="), quote: "Derinliği 25 mm olsun", source: "feedback" }]);
    expect(toleranceFor(25, "=")).toBe(0.5);
    expect(toleranceFor(150, "=")).toBe(3);
    expect(toleranceFor(180, ">=")).toBe(0.1);
  });

  it("rejects a fabricated quote, a value the quote does not state, and duplicates", () => {
    const feedback = "Make it 2.5 cm deep.";
    const { checks, rejected } = verifyFeedbackChecks(feedback, [
      { metric: "depth_mm", op: "=", value: 25, quote: "2.5 cm deep" },
      { metric: "depth_mm", op: "=", value: 25, quote: "2.5 cm deep" },
      { metric: "width_mm", op: "<=", value: 80, quote: "at most 80 mm wide" },
      { metric: "depth_mm", op: "<=", value: 30, quote: "2.5 cm deep" },
    ]);
    expect(checks.map((c) => [c.metric, c.op, c.value])).toEqual([["depth_mm", "=", 25]]);
    expect(rejected).toBe(3);
  });
});

describe("evaluating checks against the server audit", () => {
  const depth = verifyFeedbackChecks("Derinliği 25 mm olsun", [{ metric: "depth_mm", op: "=", value: 25, quote: "Derinliği 25 mm olsun" }]).checks;

  it("marks the real refined logo depth as not met and keeps the measured value", () => {
    const [result] = evaluateChecks(depth, refinedLogo, hash, planId);
    expect(result).toMatchObject({ metric: "depth_mm", value: 25, status: "not_met", actualMm: 69.62725, auditSha256: hash, planId });
  });

  it("adds the specification height in code and checks it against the audit", () => {
    const [result] = evaluateChecks(specChecks(spec), refinedLogo, hash, planId);
    expect(result).toMatchObject({ id: "spec-height_mm", source: "spec", status: "met", actualMm: 120, planId: null });
  });

  it("never reports a check as met without a geometry audit", () => {
    const results = evaluateChecks([...specChecks(spec), ...depth], null, null, planId);
    expect(results.map((r) => r.status)).toEqual(["not_checked", "not_checked"]);
    expect(results.every((r) => r.actualMm === null)).toBe(true);
  });

  it("returns no result at all for zero checks rather than a pass", () => {
    expect(evaluateChecks([], refinedLogo, hash, planId)).toEqual([]);
  });

  it("applies upper and lower bounds with the code-owned tolerance", () => {
    const checks = verifyFeedbackChecks("at most 70 mm deep, at least 180 mm wide", [
      { metric: "depth_mm", op: "<=", value: 70, quote: "at most 70 mm deep" },
      { metric: "width_mm", op: ">=", value: 180, quote: "at least 180 mm wide" },
    ]).checks;
    expect(evaluateChecks(checks, refinedLogo, hash, planId).map((r) => r.status)).toEqual(["met", "not_met"]);
  });
});
