import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactRef, GenerationJob, Revision, RevisionPlan } from "../../src/lib/contracts";

type Row = Record<string, unknown>;
interface Database {
  exec(sql: string): Promise<unknown>;
  query<T extends Row = Row>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}
const timestamp = "2026-10-12T08:00:00.000Z";
const hash = "a".repeat(64);
const spec = { description: "A small fox", objectType: "fox", use: "Figurine", targetHeightMm: 120, preserve: [], changeable: [], process: "resin_candidate" as const };

describe("actual PostgreSQL migration and RPC invariants (isolated PGlite)", () => {
  let db: Database;
  let session: string;
  let otherSession: string;
  const scope = "isolated-test";

  beforeAll(async () => {
    db = new PGlite();
    // Supabase-only infrastructure is represented by its roles and bucket table.
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);");
    await db.exec(await readFile(new URL("../../supabase/migrations/202610120001_makeready.sql", import.meta.url), "utf8"));
    await db.exec(await readFile(new URL("../../supabase/migrations/202610120002_comparison_ancestry.sql", import.meta.url), "utf8"));
  }, 30_000);
  beforeEach(async () => {
    await db.exec("truncate public.generation_job_events,public.design_records,public.make_artifacts,public.generation_jobs,public.make_budgets,public.design_sessions restart identity cascade;");
    session = randomUUID(); otherSession = randomUUID();
    for (const id of [session, otherSession]) await db.query("insert into public.design_sessions(id,scope,data) values($1,$2,$3)", [id, scope, { id }]);
  });
  afterAll(async () => { await db?.close(); });

  async function scalar<T>(sql: string, values: unknown[] = []): Promise<T> {
    return (await db.query<{ result: T }>(sql, values)).rows[0].result;
  }
  function job(overrides: Partial<GenerationJob> = {}): GenerationJob {
    return { id: randomUUID(), sessionId: session, parentRevisionId: null, planId: null, operation: "concept", status: "created", progress: 0, provider: "fal", providerRequestId: null, attempts: 0, estimatedCostUsd: .1, result: null, error: null, createdAt: timestamp, updatedAt: timestamp, ...overrides };
  }
  async function create(data = job(), key = randomUUID(), reserve = 100, cap = 1_000, inputHash = hash) {
    return scalar<GenerationJob>("select public.mr_create_job($1,$2,$3,$4,$5,$6,$7) as result", [scope, data, { input: { prompt: "fox" } }, key, inputHash, reserve, cap]);
  }
  async function claim(id: string) {
    return scalar<{ fence: number; data: GenerationJob } | null>("select public.mr_claim_job($1,$2) as result", [id, randomUUID()]);
  }
  async function patch(id: string, fence: number, data: Row = {}, payload: Row = {}) {
    return scalar<GenerationJob>("select public.mr_patch_job($1,$2,$3,$4) as result", [id, fence, data, payload]);
  }
  async function budget() {
    return (await db.query("select cap_micros::int,reserved_micros::int,spent_micros::int from public.make_budgets where scope=$1", [scope])).rows[0];
  }
  async function artifact(kind: ArtifactRef["kind"] = "concept_image", sessionId = session, verified = true): Promise<ArtifactRef> {
    const id = randomUUID();
    const geometry = kind === "source_glb" || kind === "model_glb" || kind === "model_stl";
    const ext = kind === "model_stl" ? "stl" : geometry ? "glb" : kind === "audit" || kind === "manifest" ? "json" : kind === "make_package" ? "zip" : "png";
    const ref: ArtifactRef = { id, sessionId, kind, storagePath: `${sessionId}/${id}/${hash}.${ext}`, sha256: hash, sizeBytes: 128, mimeType: ext === "glb" ? "model/gltf-binary" : ext === "stl" ? "model/stl" : ext === "json" ? "application/json" : ext === "zip" ? "application/zip" : "image/png", units: kind === "model_stl" ? "mm" : geometry ? "m" : "none", axis: kind === "model_stl" ? "z_up" : geometry ? "y_up" : "none", createdAt: timestamp };
    await db.query("insert into public.make_artifacts(id,session_id,data,verified) values($1,$2,$3,$4)", [id, sessionId, ref, verified]);
    return ref;
  }
  function revision(source: GenerationJob, artifacts: ArtifactRef[], overrides: Partial<Revision> = {}): Revision {
    return { id: randomUUID(), sessionId: source.sessionId, parentRevisionId: source.parentRevisionId, kind: "concept", spec, artifacts, sourceJobId: source.id, createdAt: timestamp, ...overrides };
  }
  async function finish(source: GenerationJob, fence: number, record: Revision | RevisionPlan, kind = "revision") {
    return scalar<Revision | RevisionPlan>("select public.mr_finish_job($1,$2,$3,$4) as result", [source.id, fence, record, kind]);
  }
  async function concept(sessionId = session) {
    const source = await create(job({ sessionId })); const lease = (await claim(source.id))!;
    const result = revision(source, [await artifact("concept_image", sessionId)]);
    await finish(source, lease.fence, result);
    return result;
  }
  async function insertRecord(kind: string, data: Row & { id: string; sessionId: string }, sourceJobId: string | null = null) {
    await db.query("insert into public.design_records(id,session_id,kind,data,source_job_id) values($1,$2,$3,$4,$5)", [data.id, data.sessionId, kind, data, sourceJobId]);
  }
  async function descendant(parentRevisionId: string | null, kind: Revision["kind"], sessionId = session) {
    const source = await create(job({ sessionId, operation: kind === "manufacturing" ? "model" : "refinement", parentRevisionId }), randomUUID(), 0);
    const lease = (await claim(source.id))!;
    const refs = kind === "manufacturing"
      ? await Promise.all([artifact("source_glb", sessionId), artifact("model_glb", sessionId), artifact("model_stl", sessionId), artifact("audit", sessionId)])
      : [await artifact("concept_image", sessionId)];
    const result = revision(source, refs, { kind });
    await finish(source, lease.fence, result);
    return result;
  }
  function comparison(parent: Revision, child: Revision, overrides: Row = {}) {
    return { id: randomUUID(), sessionId: session, parentRevisionId: parent.id, childRevisionId: child.id, planId: null, visualEvaluationIds: [], physicalEvaluationIds: [], ...overrides };
  }
  async function savedPlan(parent: Revision) {
    const plan = { id: randomUUID(), sessionId: parent.sessionId, parentRevisionId: parent.id, maxAttempts: 2 };
    await insertRecord("plan", plan);
    return plan;
  }

  it("applies the complete migration and grants only the server role access", async () => {
    expect(await scalar<string>("select version() as result")).toContain("PostgreSQL");
    expect(await scalar<boolean>("select has_table_privilege('anon','public.generation_jobs','SELECT') as result")).toBe(false);
    expect(await scalar<boolean>("select has_table_privilege('authenticated','public.make_artifacts','INSERT') as result")).toBe(false);
    expect(await scalar<boolean>("select has_function_privilege('anon','public.mr_claim_job(uuid,uuid)','EXECUTE') as result")).toBe(false);
    expect(await scalar<boolean>("select has_function_privilege('service_role','public.mr_claim_job(uuid,uuid)','EXECUTE') as result")).toBe(true);
    expect((await db.query("select relrowsecurity from pg_class where oid='public.generation_jobs'::regclass")).rows[0].relrowsecurity).toBe(true);
    expect((await db.query("select public,file_size_limit from storage.buckets where id='makeready'")).rows[0]).toEqual({ public: false, file_size_limit: 52_428_800 });
    await db.exec("set role anon");
    try {
      await expect(db.query("select * from public.generation_jobs")).rejects.toThrow("permission denied");
      await expect(claim(randomUUID())).rejects.toThrow("permission denied");
    } finally { await db.exec("reset role"); }
    await db.exec("set role service_role");
    try { expect((await concept()).sourceJobId).toBeTruthy(); }
    finally { await db.exec("reset role"); }
  });

  it("deduplicates accepted requests without reserving twice and rejects key reuse", async () => {
    const initial = job(), key = randomUUID();
    expect(await create(initial, key)).toEqual(initial);
    expect(await create({ ...initial, id: randomUUID() }, key)).toEqual(initial);
    expect(await budget()).toEqual({ cap_micros: 1_000, reserved_micros: 100, spent_micros: 0 });
    await expect(create(initial, key, 100, 1_000, "b".repeat(64))).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    await expect(create({ ...initial, sessionId: otherSession }, key)).rejects.toThrow("IDEMPOTENCY_CONFLICT");
    expect(await scalar<number>("select count(*)::int as result from public.generation_jobs")).toBe(1);
  });

  it("enforces the original cap and rolls back a failed reservation or invalid insert", async () => {
    await create(job(), randomUUID(), 900, 1_000);
    await expect(create(job(), randomUUID(), 101, 50_000)).rejects.toThrow("BUDGET_EXCEEDED");
    await expect(create(job({ id: "not-a-uuid" }), randomUUID(), 50)).rejects.toThrow();
    expect(await budget()).toEqual({ cap_micros: 1_000, reserved_micros: 900, spent_micros: 0 });
    expect(await scalar<number>("select count(*)::int as result from public.generation_job_events")).toBe(1);
  });

  it("allows one active claimant and fences a released, expired or superseded worker", async () => {
    const source = await create(); const first = (await claim(source.id))!;
    expect(await claim(source.id)).toBeNull();
    await patch(source.id, first.fence, { status: "queued" });
    await db.query("select public.mr_release_job($1,$2)", [source.id, first.fence]);
    await expect(patch(source.id, first.fence)).rejects.toThrow("STALE_LEASE");
    const second = (await claim(source.id))!; expect(second.fence).toBeGreaterThan(first.fence);
    await expect(patch(source.id, first.fence)).rejects.toThrow("STALE_LEASE");
    await db.query("update public.generation_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1", [source.id]);
    await expect(patch(source.id, second.fence)).rejects.toThrow("STALE_LEASE");
    await expect(db.query("select public.mr_fail_job($1,$2,$3)", [source.id, second.fence, { code: "INTERNAL_ERROR" }])).rejects.toThrow("STALE_LEASE");
    await expect(finish(source, second.fence, revision(source, [await artifact()]))).rejects.toThrow("STALE_LEASE");
  });

  it("protects immutable job identity and a durable provider request receipt", async () => {
    const source = await create(); const lease = (await claim(source.id))!;
    await expect(patch(source.id, lease.fence, { sessionId: otherSession })).rejects.toThrow("IMMUTABLE_JOB_FIELD");
    await expect(patch(source.id, lease.fence, { status: "completed" })).rejects.toThrow("IMMUTABLE_JOB_FIELD");
    const receipt = { provider: "fal", requestId: "original-paid-request" };
    await db.query("select public.mr_patch_job($1,$2,$3,$4,$5)", [source.id, lease.fence, { status: "queued" }, {}, receipt]);
    await expect(db.query("select public.mr_patch_job($1,$2,$3,$4,$5)", [source.id, lease.fence, {}, {}, { ...receipt, requestId: "duplicate" }])).rejects.toThrow("PROVIDER_REF_CONFLICT");
  });

  it("quarantines interrupted paid dispatch without retrying or releasing its budget", async () => {
    const source = await create(); const lease = (await claim(source.id))!;
    await patch(source.id, lease.fence, { status: "submitting" }, { dispatchInFlight: true });
    await db.query("select public.mr_release_job($1,$2)", [source.id, lease.fence]);
    expect(await claim(source.id)).toBeNull(); expect(await claim(source.id)).toBeNull();
    expect((await db.query("select data->>'status' as status,settled from public.generation_jobs where id=$1", [source.id])).rows[0]).toEqual({ status: "submission_unknown", settled: false });
    expect(await budget()).toEqual({ cap_micros: 1_000, reserved_micros: 100, spent_micros: 0 });
  });

  it("settles known failure once and cannot subsequently finalize the job", async () => {
    const source = await create(); const lease = (await claim(source.id))!;
    await db.query("select public.mr_fail_job($1,$2,$3,false)", [source.id, lease.fence, { code: "PROVIDER_FAILED", message: "failed", retryable: false }]);
    await db.query("select public.mr_fail_job($1,$2,$3,false)", [source.id, lease.fence, { code: "PROVIDER_FAILED" }]);
    expect(await budget()).toEqual({ cap_micros: 1_000, reserved_micros: 0, spent_micros: 100 });
    expect(await claim(source.id)).toBeNull();
    await expect(finish(source, lease.fence, revision(source, [await artifact()]))).rejects.toThrow("STALE_LEASE");
  });

  it("requires verified exact artifact receipts and leaves failed finalization atomic", async () => {
    const source = await create(); const lease = (await claim(source.id))!; const ref = await artifact();
    for (const changed of [{ ...ref, storagePath: "other/file.png" }, { ...ref, kind: "model_glb" as const }, { ...ref, units: "mm" as const }, { ...ref, url: "https://expired.example/a" }]) {
      await expect(finish(source, lease.fence, revision(source, [changed]))).rejects.toThrow("ARTIFACT_NOT_VERIFIED");
    }
    await expect(finish(source, lease.fence, revision(source, [await artifact("concept_image", session, false)]))).rejects.toThrow("ARTIFACT_NOT_VERIFIED");
    await expect(finish(source, lease.fence, revision(source, [await artifact("concept_image", otherSession)]))).rejects.toThrow("ARTIFACT_NOT_VERIFIED");
    await expect(finish(source, lease.fence, revision(source, []))).rejects.toThrow("ARTIFACTS_REQUIRED");
    await expect(finish(source, lease.fence, revision(source, [ref], { sourceJobId: null }))).rejects.toThrow("SOURCE_JOB_MISMATCH");
    await expect(finish(source, lease.fence, { ...revision(source, [ref]), sessionId: undefined } as unknown as Revision)).rejects.toThrow("SESSION_MISMATCH");
    expect(await scalar<number>("select count(*)::int as result from public.design_records")).toBe(0);
    expect(await budget()).toEqual({ cap_micros: 1_000, reserved_micros: 100, spent_micros: 0 });
    const result = revision(source, [ref]); await finish(source, lease.fence, result);
    expect(await finish(source, lease.fence, result)).toEqual(result);
    await expect(finish(source, lease.fence, { ...result, spec: { ...spec, targetHeightMm: 50 } })).rejects.toThrow("FINALIZATION_CONFLICT");
    expect(await budget()).toEqual({ cap_micros: 1_000, reserved_micros: 0, spent_micros: 100 });
    expect(await scalar<number>("select count(*)::int as result from public.generation_job_events where kind='completed'")).toBe(1);
  });

  it("requires all manufacturing files and preserves a parent's exact source on scale", async () => {
    const parent = await concept();
    const source = await create(job({ operation: "model", parentRevisionId: parent.id })); const lease = (await claim(source.id))!;
    const refs = await Promise.all([artifact("source_glb"), artifact("model_glb"), artifact("model_stl"), artifact("audit")]);
    await expect(finish(source, lease.fence, revision(source, refs.slice(1), { kind: "manufacturing" }))).rejects.toThrow("ARTIFACTS_REQUIRED");
    const manufacturing = revision(source, refs, { kind: "manufacturing" }); await finish(source, lease.fence, manufacturing);
    const childJob = await create(job({ operation: "scale", parentRevisionId: manufacturing.id })); const childLease = (await claim(childJob.id))!;
    const child = revision(childJob, [refs[0], await artifact("model_glb"), await artifact("model_stl"), await artifact("audit")], { kind: "manufacturing", spec: { ...spec, targetHeightMm: 60 } });
    await finish(childJob, childLease.fence, child);
    expect((await db.query("select data from public.design_records where id=$1", [manufacturing.id])).rows[0].data).toEqual(manufacturing);
    expect(child.artifacts[0]).toEqual(manufacturing.artifacts[0]);
  });

  it("rejects cross-session lineage and enforces two accepted execution jobs per plan", async () => {
    const parent = await concept(), foreign = await concept(otherSession);
    await expect(create(job({ parentRevisionId: foreign.id }))).rejects.toThrow("PARENT_NOT_FOUND");
    const planner = await create(job({ operation: "planning", provider: "openai", parentRevisionId: parent.id })); const lease = (await claim(planner.id))!;
    const plan: RevisionPlan = { id: randomUUID(), sessionId: session, parentRevisionId: parent.id, requestedChange: "Smaller ears", interpretedIntent: "Reduce ear proportions", preserve: ["face"], action: "edit_concept", reason: "User request", expectedDifferences: ["Smaller ears"], targetHeightMm: null, maxAttempts: 2, estimatedCostUsd: .5, createdAt: timestamp };
    await expect(finish(planner, lease.fence, { ...plan, parentRevisionId: foreign.id }, "plan")).rejects.toThrow("PARENT_NOT_FOUND");
    await finish(planner, lease.fence, plan, "plan");
    const execution = job({ operation: "refinement", parentRevisionId: parent.id, planId: plan.id }); const key = randomUUID();
    await create(execution, key); await create({ ...execution, id: randomUUID() }, key);
    await create(job({ operation: "refinement", parentRevisionId: parent.id, planId: plan.id }));
    await expect(create(job({ operation: "refinement", parentRevisionId: parent.id, planId: plan.id }))).rejects.toThrow("REVISION_LIMIT");
    await expect(create(job({ sessionId: otherSession, parentRevisionId: foreign.id, planId: plan.id }))).rejects.toThrow("PLAN_NOT_FOUND");
  });

  it("keeps receipts, revisions and events immutable while unverified uploads can be removed", async () => {
    const result = await concept(); const ref = result.artifacts[0];
    await expect(db.query("update public.make_artifacts set verified=false where id=$1", [ref.id])).rejects.toThrow("IMMUTABLE_ARTIFACT");
    await expect(db.query("delete from public.make_artifacts where id=$1", [ref.id])).rejects.toThrow("IMMUTABLE_ARTIFACT");
    await expect(db.query("update public.design_records set data=data where id=$1", [result.id])).rejects.toThrow("IMMUTABLE_RECORD");
    await expect(db.query("delete from public.generation_job_events")).rejects.toThrow("IMMUTABLE_RECORD");
    const upload = await artifact("source_image", session, false);
    await expect(db.query("update public.make_artifacts set data=jsonb_set(data,'{sha256}',$2) where id=$1", [upload.id, JSON.stringify("b".repeat(64))])).rejects.toThrow("IMMUTABLE_ARTIFACT_METADATA");
    await db.query("delete from public.make_artifacts where id=$1", [upload.id]);
    expect(await scalar<number>("select count(*)::int as result from public.make_artifacts where id=$1", [upload.id])).toBe(0);
  });

  it("binds decisions and independent evaluations to exact revision hashes", async () => {
    const parent = await concept(), foreign = await concept(otherSession);
    const base = { sessionId: session, revisionId: parent.id, artifactHashes: parent.artifacts.map(a => a.sha256), createdAt: timestamp };
    await expect(insertRecord("decision", { ...base, id: randomUUID(), revisionId: foreign.id, decision: "approve" })).rejects.toThrow("REVISION_NOT_FOUND");
    await expect(insertRecord("decision", { ...base, id: randomUUID(), artifactHashes: [], decision: "approve" })).rejects.toThrow("ARTIFACT_HASH_MISMATCH");
    await insertRecord("decision", { ...base, id: randomUUID(), decision: "reject" });
    await insertRecord("evaluation", { ...base, id: randomUUID(), kind: "visual" }, parent.sourceJobId);
    await insertRecord("evaluation", { ...base, id: randomUUID(), kind: "physical" }, parent.sourceJobId);
    await expect(insertRecord("evaluation", { ...base, id: randomUUID(), kind: "visual" }, parent.sourceJobId)).rejects.toThrow("duplicate key");
    expect(await scalar<number>("select count(*)::int as result from public.design_records where kind='evaluation'")).toBe(2);
  });

  it("validates comparison lineage and exact evaluation references", async () => {
    const parent = await concept(), foreign = await concept(otherSession);
    const source = await create(job({ operation: "refinement", parentRevisionId: parent.id })); const lease = (await claim(source.id))!;
    const child = revision(source, [await artifact()]); await finish(source, lease.fence, child);
    const evaluation = { id: randomUUID(), sessionId: session, revisionId: child.id, artifactHashes: child.artifacts.map(a => a.sha256), kind: "visual", createdAt: timestamp };
    await insertRecord("evaluation", evaluation);
    const comparison = { id: randomUUID(), sessionId: session, parentRevisionId: parent.id, childRevisionId: child.id, planId: null, visualEvaluationIds: [evaluation.id], physicalEvaluationIds: [] };
    await expect(insertRecord("comparison", { ...comparison, parentRevisionId: foreign.id })).rejects.toThrow("PARENT_NOT_FOUND");
    await expect(insertRecord("comparison", { ...comparison, childRevisionId: parent.id })).rejects.toThrow("LINEAGE_MISMATCH");
    await expect(insertRecord("comparison", { ...comparison, visualEvaluationIds: [], physicalEvaluationIds: [evaluation.id] })).rejects.toThrow("EVALUATION_NOT_FOUND");
    await insertRecord("comparison", comparison);
  });

  it("accepts old manufacturing -> revised concept -> new manufacturing without changing direct lineage", async () => {
    const parent = await descendant(null, "manufacturing");
    const conceptChild = await descendant(parent.id, "concept");
    const child = await descendant(conceptChild.id, "manufacturing");
    const physical = { id: randomUUID(), sessionId: session, revisionId: child.id, artifactHashes: child.artifacts.map(a => a.sha256), kind: "physical" };
    await insertRecord("evaluation", physical);
    const plan = await savedPlan(conceptChild);
    await insertRecord("comparison", comparison(conceptChild, child, { planId: plan.id }));
    await insertRecord("comparison", comparison(parent, child, { planId: plan.id, physicalEvaluationIds: [physical.id] }));
    expect(await scalar<number>("select count(*)::int as result from public.design_records where kind='comparison'")).toBe(2);
    expect(await scalar<string>("select data->>'parentRevisionId' as result from public.design_records where id=$1", [child.id])).toBe(conceptChild.id);
    expect(await scalar<boolean>("select has_function_privilege('anon','public.mr_validate_record()','EXECUTE') as result")).toBe(false);
  });

  it("rejects unrelated/foreign ancestry and permits indirect comparisons only between manufacturing revisions", async () => {
    const parent = await descendant(null, "manufacturing"), unrelated = await descendant(null, "manufacturing");
    const middle = await descendant(parent.id, "concept"), child = await descendant(middle.id, "manufacturing");
    const foreign = await descendant(null, "manufacturing", otherSession);
    await expect(insertRecord("comparison", comparison(unrelated, child))).rejects.toThrow("LINEAGE_MISMATCH");
    await expect(insertRecord("comparison", comparison(foreign, child))).rejects.toThrow("PARENT_NOT_FOUND");
    await expect(insertRecord("comparison", comparison(parent, foreign))).rejects.toThrow("LINEAGE_MISMATCH");
    const rootConcept = await concept(), nextConcept = await descendant(rootConcept.id, "concept"), farConcept = await descendant(nextConcept.id, "concept");
    await expect(insertRecord("comparison", comparison(rootConcept, farConcept))).rejects.toThrow("LINEAGE_MISMATCH");
    await expect(insertRecord("comparison", comparison(parent, await descendant(middle.id, "concept")))).rejects.toThrow("LINEAGE_MISMATCH");
    const unrelatedPlan = await savedPlan(unrelated), foreignPlan = await savedPlan(foreign);
    await expect(insertRecord("comparison", comparison(parent, child, { planId: unrelatedPlan.id }))).rejects.toThrow("PLAN_NOT_FOUND");
    await expect(insertRecord("comparison", comparison(parent, child, { planId: foreignPlan.id }))).rejects.toThrow("PLAN_NOT_FOUND");
    const oldPlan = await savedPlan(parent);
    await expect(insertRecord("comparison", comparison(middle, child, { planId: oldPlan.id }))).rejects.toThrow("PLAN_NOT_FOUND");
    await insertRecord("comparison", comparison(parent, child, { planId: oldPlan.id }));
  });

  it("rejects corrupt cyclic or cross-session intermediate chains within the bounded walk", async () => {
    const parent = await descendant(null, "manufacturing"), middle = await descendant(parent.id, "concept"), child = await descendant(middle.id, "manufacturing");
    // Existing append-only guards prevent corrupt chains in normal operation.
    // Disable only the immutable-update trigger to construct hostile fixtures.
    await db.exec("alter table public.design_records disable trigger immutable_design_records");
    try {
      await db.query("update public.design_records set data=jsonb_set(data,'{parentRevisionId}',$2) where id=$1", [middle.id, JSON.stringify(child.id)]);
    } finally { await db.exec("alter table public.design_records enable trigger immutable_design_records"); }
    await expect(insertRecord("comparison", comparison(parent, child))).rejects.toThrow("LINEAGE_MISMATCH");
    const foreign = await descendant(null, "concept", otherSession);
    await db.exec("alter table public.design_records disable trigger immutable_design_records");
    try {
      await db.query("update public.design_records set data=jsonb_set(data,'{parentRevisionId}',$2) where id=$1", [middle.id, JSON.stringify(foreign.id)]);
    } finally { await db.exec("alter table public.design_records enable trigger immutable_design_records"); }
    await expect(insertRecord("comparison", comparison(parent, child))).rejects.toThrow("LINEAGE_MISMATCH");
  });

  it("accepts 30 ancestor links and rejects a 31-link comparison", async () => {
    const parent = await descendant(null, "manufacturing");
    let cursor = parent;
    for (let index = 0; index < 29; index++) cursor = await descendant(cursor.id, "concept");
    const within = await descendant(cursor.id, "manufacturing");
    await insertRecord("comparison", comparison(parent, within));
    const beyond = await descendant(within.id, "manufacturing");
    await expect(insertRecord("comparison", comparison(parent, beyond))).rejects.toThrow("LINEAGE_MISMATCH");
    // Direct manufacturing comparisons remain valid at any overall history depth.
    await insertRecord("comparison", comparison(within, beyond));
  });
});
