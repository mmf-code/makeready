import { describe, expect, it } from "vitest";
import { DesignSessionSchema, GenerationJobStatusSchema, RevisionSchema } from "@/lib/contracts";
import { contractFixtures, exampleAudit, exampleJobs, exampleV1 } from "@/lib/contracts/fixtures";

describe("frozen frontend contracts", () => {
  it("validates the full development tree and every job status", () => {
    expect(DesignSessionSchema.safeParse(contractFixtures.session).success).toBe(true);
    expect(exampleJobs.map(j => j.status)).toEqual(GenerationJobStatusSchema.options);
    expect(new Set(contractFixtures.evaluations.map(e => e.kind)).size).toBe(3);
    expect(new Set(exampleAudit.checks.map(c => c.status))).toEqual(new Set(["pass", "fail", "not_checked"]));
  });
  it("cannot materialize an artifactless revision", () => {
    expect(RevisionSchema.safeParse({ ...exampleV1, artifacts: [] }).success).toBe(false);
    expect(RevisionSchema.safeParse({ ...exampleV1, kind: "manufacturing" }).success).toBe(false);
  });
});
