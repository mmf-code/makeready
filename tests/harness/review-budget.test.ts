import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimReview, settleReview } from "../../scripts/review-live-model.mjs";

describe("one existing-model review against actual immutable PostgreSQL events and budget", () => {
  let db:PGlite;
  let identity:{scope:string;jobId:string;sessionId:string;reviewId:string;revisionId:string};
  beforeAll(async()=>{
    db=new PGlite();
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls; create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint);");
    await db.exec(await readFile(new URL("../../supabase/migrations/202610120001_makeready.sql",import.meta.url),"utf8"));
  },30_000);
  beforeEach(async()=>{
    await db.exec("truncate public.generation_job_events,public.design_records,public.make_artifacts,public.generation_jobs,public.make_budgets,public.design_sessions restart identity cascade;");
    identity={scope:"isolated-review",jobId:randomUUID(),sessionId:randomUUID(),revisionId:randomUUID(),reviewId:randomUUID()};
    await db.query("INSERT INTO design_sessions(id,scope,data) VALUES($1,$2,$3)",[identity.sessionId,identity.scope,{id:identity.sessionId}]);
    await db.query("INSERT INTO make_budgets(scope,cap_micros) VALUES($1,1000000)",[identity.scope]);
    await db.query("INSERT INTO generation_jobs(id,session_id,scope,idempotency_key,input_hash,data,payload) VALUES($1,$2,$3,'isolated-model-key',$4,$5,'{}')",[identity.jobId,identity.sessionId,identity.scope,"a".repeat(64),{id:identity.jobId,sessionId:identity.sessionId,status:"completed",operation:"model"}]);
  });
  afterAll(async()=>{await db?.close();});
  it("reserves once, records an append-only dispatch, and settles once without allowing another paid review",async()=>{
    expect(await claimReview(db,identity)).toBe(true);
    expect(await claimReview(db,identity)).toBe(false);
    expect((await db.query<{reserved_micros:number}>("SELECT reserved_micros FROM make_budgets")).rows[0].reserved_micros).toBe(100000);
    await settleReview(db,{...identity,state:"completed"});
    await settleReview(db,{...identity,state:"completed"});
    expect((await db.query("SELECT reserved_micros,spent_micros FROM make_budgets")).rows[0]).toEqual({reserved_micros:0,spent_micros:100000});
    expect(await claimReview(db,identity)).toBe(false);
    expect((await db.query<{kind:string}>("SELECT kind FROM generation_job_events ORDER BY id")).rows.map(r=>r.kind)).toEqual(["model_review_requested","model_review_settled"]);
    await expect(db.query("UPDATE generation_job_events SET data='{}'")).rejects.toThrow("IMMUTABLE_RECORD");
  });
  it("refuses another request after a crash/unknown outcome and keeps its budget reservation",async()=>{
    expect(await claimReview(db,identity)).toBe(true);
    expect(await claimReview(db,identity)).toBe(false);
    expect((await db.query<{reserved_micros:number}>("SELECT reserved_micros FROM make_budgets")).rows[0].reserved_micros).toBe(100000);
  });
  it("rejects an exhausted budget without recording a dispatch",async()=>{
    await db.query("UPDATE make_budgets SET spent_micros=1000000");
    await expect(claimReview(db,identity)).rejects.toThrow("BUDGET_EXCEEDED");
    expect((await db.query("SELECT id FROM generation_job_events")).rows).toHaveLength(0);
  });
  it("rejects a failed job or the wrong scope before reserving or dispatching",async()=>{
    await db.query("UPDATE generation_jobs SET data=data||'{\"status\":\"failed\"}'::jsonb");
    await expect(claimReview(db,identity)).rejects.toThrow("COMPLETED_MODEL_JOB_REQUIRED");
    expect((await db.query<{reserved_micros:number}>("SELECT reserved_micros FROM make_budgets")).rows[0].reserved_micros).toBe(0);
    expect((await db.query("SELECT id FROM generation_job_events")).rows).toHaveLength(0);
  });
});
