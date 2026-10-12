-- Additive fix: preserve 0001's applied checksum and every artifact/job guard.
-- Indirect comparisons may join manufacturing revisions through at most 30
-- same-session ancestor links. Direct comparisons retain their existing kinds.
create or replace function public.mr_validate_record() returns trigger language plpgsql set search_path = '' as $$
declare
  r public.design_records; j public.generation_jobs; a jsonb; e jsonb;
  expected_hashes jsonb; actual_hashes jsonb; kinds text[];
  comparison_parent public.design_records; comparison_child public.design_records;
  ancestor public.design_records; cursor_id uuid; visited uuid[];
  direct_comparison boolean; lineage_found boolean; depth integer;
begin
  if new.source_job_id is not null then
    select * into j from public.generation_jobs where id = new.source_job_id and session_id = new.session_id;
    if not found then raise exception 'SESSION_MISMATCH'; end if;
  end if;
  if new.kind in ('revision','plan') then
    if new.data->>'parentRevisionId' is not null then
      select * into r from public.design_records where id = (new.data->>'parentRevisionId')::uuid and session_id = new.session_id and kind = 'revision';
      if not found then raise exception 'PARENT_NOT_FOUND'; end if;
    elsif new.kind = 'plan' then raise exception 'PARENT_NOT_FOUND'; end if;
    if new.source_job_id is not null and (new.data->>'parentRevisionId') is distinct from (j.data->>'parentRevisionId') then raise exception 'LINEAGE_MISMATCH'; end if;
  end if;
  if new.kind = 'revision' then
    if (new.data->>'sourceJobId') is distinct from new.source_job_id::text then raise exception 'SOURCE_JOB_MISMATCH'; end if;
    if jsonb_typeof(new.data->'artifacts') is distinct from 'array' then raise exception 'ARTIFACTS_REQUIRED'; end if;
    if jsonb_array_length(new.data->'artifacts') = 0 then raise exception 'ARTIFACTS_REQUIRED'; end if;
    for a in select value from jsonb_array_elements(new.data->'artifacts') loop
      -- Whole canonical receipt must match, including path, kind, units and axis.
      if not exists(select 1 from public.make_artifacts where id = (a->>'id')::uuid and session_id = new.session_id and verified and data = a) then raise exception 'ARTIFACT_NOT_VERIFIED'; end if;
    end loop;
    if (select count(*) from jsonb_array_elements(new.data->'artifacts')) <> (select count(distinct value->>'id') from jsonb_array_elements(new.data->'artifacts')) then raise exception 'DUPLICATE_ARTIFACT'; end if;
    select array_agg(value->>'kind') into kinds from jsonb_array_elements(new.data->'artifacts');
    if new.data->>'kind' = 'manufacturing' then
      if not (kinds @> array['source_glb','model_glb','model_stl','audit']) then raise exception 'ARTIFACTS_REQUIRED'; end if;
    elsif new.data->>'kind' = 'concept' then
      if not (kinds && array['source_image','concept_image']) then raise exception 'ARTIFACTS_REQUIRED'; end if;
    else raise exception 'INVALID_RECORD_KIND'; end if;
  elsif new.kind = 'plan' then
    if new.data->>'maxAttempts' is distinct from '2' then raise exception 'INVALID_ATTEMPT_LIMIT'; end if;
  elsif new.kind in ('evaluation','decision') then
    select * into r from public.design_records where id = (new.data->>'revisionId')::uuid and session_id = new.session_id and kind = 'revision';
    if not found then raise exception 'REVISION_NOT_FOUND'; end if;
    if jsonb_typeof(new.data->'artifactHashes') is distinct from 'array' then raise exception 'ARTIFACT_HASH_MISMATCH'; end if;
    select coalesce(jsonb_agg(value->'sha256' order by value->>'sha256'),'[]'::jsonb) into expected_hashes from jsonb_array_elements(r.data->'artifacts');
    select coalesce(jsonb_agg(value order by value),'[]'::jsonb) into actual_hashes from jsonb_array_elements(new.data->'artifactHashes');
    if expected_hashes is distinct from actual_hashes then raise exception 'ARTIFACT_HASH_MISMATCH'; end if;
  elsif new.kind = 'comparison' then
    select * into comparison_parent from public.design_records where id = (new.data->>'parentRevisionId')::uuid and session_id = new.session_id and kind = 'revision';
    if not found then raise exception 'PARENT_NOT_FOUND'; end if;
    select * into comparison_child from public.design_records where id = (new.data->>'childRevisionId')::uuid and session_id = new.session_id and kind = 'revision';
    if not found or comparison_child.id = comparison_parent.id then raise exception 'LINEAGE_MISMATCH'; end if;
    direct_comparison := coalesce(comparison_child.data->>'parentRevisionId' = comparison_parent.id::text,false);
    if not direct_comparison and (comparison_parent.data->>'kind' is distinct from 'manufacturing' or comparison_child.data->>'kind' is distinct from 'manufacturing') then raise exception 'LINEAGE_MISMATCH'; end if;
    visited := array[comparison_child.id];
    cursor_id := (comparison_child.data->>'parentRevisionId')::uuid;
    lineage_found := false;
    for depth in 1..30 loop
      if cursor_id is null or cursor_id = any(visited) then raise exception 'LINEAGE_MISMATCH'; end if;
      select * into ancestor from public.design_records where id = cursor_id and session_id = new.session_id and kind = 'revision';
      if not found then raise exception 'LINEAGE_MISMATCH'; end if;
      visited := array_append(visited,ancestor.id);
      -- Also reject a closing edge from the selected ancestor into this path.
      if (ancestor.data->>'parentRevisionId')::uuid = any(visited) then raise exception 'LINEAGE_MISMATCH'; end if;
      if ancestor.id = comparison_parent.id then lineage_found := true; exit; end if;
      cursor_id := (ancestor.data->>'parentRevisionId')::uuid;
    end loop;
    if not lineage_found then raise exception 'LINEAGE_MISMATCH'; end if;
    -- The originating plan must bind to an ancestor on this exact path. For a
    -- direct comparison the path has only the original direct parent.
    if new.data->>'planId' is not null and not exists(
      select 1 from public.design_records where id = (new.data->>'planId')::uuid and session_id = new.session_id and kind = 'plan'
      and (data->>'parentRevisionId')::uuid = any(visited[2:array_length(visited,1)])
    ) then raise exception 'PLAN_NOT_FOUND'; end if;
    if jsonb_typeof(new.data->'visualEvaluationIds') is distinct from 'array' or jsonb_typeof(new.data->'physicalEvaluationIds') is distinct from 'array' then raise exception 'EVALUATION_NOT_FOUND'; end if;
    for e in select jsonb_build_object('id',value,'kind','visual') from jsonb_array_elements(new.data->'visualEvaluationIds') union all select jsonb_build_object('id',value,'kind','physical') from jsonb_array_elements(new.data->'physicalEvaluationIds') loop
      if not exists(select 1 from public.design_records where id = (e->>'id')::uuid and session_id = new.session_id and kind = 'evaluation' and data->>'kind' = e->>'kind' and data->>'revisionId' in (new.data->>'parentRevisionId',new.data->>'childRevisionId')) then raise exception 'EVALUATION_NOT_FOUND'; end if;
    end loop;
  end if;
  return new;
end $$;

-- CREATE OR REPLACE retains existing ACLs; make the original boundary explicit.
revoke execute on function public.mr_validate_record() from public,anon,authenticated;
