import type { AcceptanceCheck, AcceptanceResult, DesignSpec, PhysicalAudit } from "../contracts";

/** What the planner may propose. It never chooses ids, tolerances or the evidence source. */
export type AcceptanceCheckDraft = Pick<AcceptanceCheck, "metric" | "op" | "value" | "quote">;

const METRIC_AXIS = { height_mm: "height", width_mm: "width", depth_mm: "depth" } as const;
const UNIT_MM: Record<string, number> = { mm: 1, cm: 10 };

/**
 * Code-owned tolerance. A target ("=") allows 0.5 mm or 2 % of the value, whichever is larger.
 * A stated bound ("<=", ">=") is not loosened beyond the 0.1 mm measurement tolerance.
 */
export function toleranceFor(valueMm: number, op: AcceptanceCheck["op"]): number {
  return op === "=" ? Math.max(0.5, Math.round(valueMm * 0.02 * 1000) / 1000) : 0.1;
}

const normalize = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();

/** Millimetre values written in the quote, e.g. "25 mm", "2,5 cm", "120mm". A bare number counts as mm. */
export function quotedMillimetres(quote: string): number[] {
  const values: number[] = [];
  for (const match of quote.matchAll(/(\d+(?:[.,]\d+)?)\s*(mm|cm)?(?![a-z])/gi)) {
    const value = Number(match[1].replace(",", "."));
    if (Number.isFinite(value)) values.push(value * UNIT_MM[(match[2] ?? "mm").toLowerCase()]);
  }
  return values;
}

/**
 * Keep only checks whose quote is verbatim human feedback and whose value is written in that quote.
 * The planner cannot invent a number or a requirement the person did not state.
 */
export function verifyFeedbackChecks(feedback: string, drafts: AcceptanceCheckDraft[]): { checks: AcceptanceCheck[]; rejected: number } {
  const source = normalize(feedback);
  const checks: AcceptanceCheck[] = [];
  for (const draft of drafts) {
    const quote = normalize(draft.quote);
    const quoted = quote.length > 0 && source.includes(quote);
    const written = quotedMillimetres(quote).some((mm) => Math.abs(mm - draft.value) < 1e-6);
    const duplicate = checks.some((c) => c.metric === draft.metric && c.op === draft.op && c.value === draft.value);
    if (!quoted || !written || duplicate || !(draft.value > 0)) continue;
    checks.push({ id: `feedback-${checks.length + 1}-${draft.metric}`, metric: draft.metric, op: draft.op, value: draft.value, toleranceMm: toleranceFor(draft.value, draft.op), quote, source: "feedback" });
  }
  return { checks, rejected: drafts.length - checks.length };
}

/** The specification height is added by code, independently of any model output. */
export function specChecks(spec: DesignSpec): AcceptanceCheck[] {
  return [{ id: "spec-height_mm", metric: "height_mm", op: "=", value: spec.targetHeightMm, toleranceMm: 0.1, quote: `Design specification target height ${spec.targetHeightMm} mm`, source: "spec" }];
}

/** Evaluate against the server audit only. Without an audit every check stays not_checked. */
export function evaluateChecks(checks: AcceptanceCheck[], audit: PhysicalAudit | null, auditSha256: string | null, planId: string | null): AcceptanceResult[] {
  return checks.map((check) => {
    const planRef = check.source === "feedback" ? planId : null;
    if (!audit) return { ...check, planId: planRef, status: "not_checked", actualMm: null, auditSha256: null, method: "No 3D geometry audit exists for this revision yet." };
    const actual = audit.measuredBoundsMm[METRIC_AXIS[check.metric]];
    const met = check.op === "=" ? Math.abs(actual - check.value) <= check.toleranceMm
      : check.op === "<=" ? actual <= check.value + check.toleranceMm
        : actual >= check.value - check.toleranceMm;
    return { ...check, planId: planRef, status: met ? "met" : "not_met", actualMm: actual, auditSha256, method: "Overall world-space bounds from the server geometry audit. Regional features are not measured." };
  });
}
