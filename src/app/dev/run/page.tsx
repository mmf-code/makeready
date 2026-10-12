import { notFound } from "next/navigation";
import type { DesignSession, Evaluation, Revision } from "@/lib/contracts";
import { exampleAudit, exampleSession, FIXTURE_LABEL } from "@/lib/contracts/fixtures";
import { RunView } from "@/components/makeready/run-view";

export const metadata = { title: "Run view preview" };

// A public sample model stands in for a generated GLB. Development only, labeled on the page.
const SAMPLE_GLB = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Duck/glTF-Binary/Duck.glb";

export default async function RunPreview({ searchParams }: PageProps<"/dev/run">) {
  if (process.env.NODE_ENV === "production") notFound();
  const stage = (await searchParams).stage;
  const base = exampleSession;
  const v2 = base.revisions[1];
  const made: Revision = {
    ...v2, id: "00000000-0000-4000-8000-000000000090", parentRevisionId: v2.id, kind: "manufacturing", createdAt: "2026-10-12T08:20:00.000Z", sourceJobId: null,
    artifacts: [
      { ...v2.artifacts[0], id: "00000000-0000-4000-8000-000000000091", kind: "model_glb", storagePath: "fixtures/model.glb", mimeType: "model/gltf-binary", units: "m", axis: "y_up", url: SAMPLE_GLB },
      { ...v2.artifacts[0], id: "00000000-0000-4000-8000-000000000092", kind: "model_stl", storagePath: "fixtures/model.stl", mimeType: "model/stl", units: "mm", axis: "z_up" },
      { ...v2.artifacts[0], id: "00000000-0000-4000-8000-000000000093", kind: "audit", storagePath: "fixtures/audit.json", mimeType: "application/json", units: "none", axis: "none" },
    ],
  };
  const physical: Evaluation = {
    id: "00000000-0000-4000-8000-000000000094", sessionId: base.id, revisionId: made.id, kind: "physical", artifactHashes: [], engine: "fixture",
    method: "Development fixture only", limitations: [FIXTURE_LABEL], createdAt: "2026-10-12T08:21:00.000Z", audit: exampleAudit,
  };
  const session: DesignSession = stage === "concept"
    ? { ...base, decisions: [] }
    : { ...base, revisions: [...base.revisions, made], evaluations: [...base.evaluations, physical], updatedAt: made.createdAt,
        jobs: stage === "made" ? base.jobs.filter((j) => j.status === "completed") : base.jobs };
  return <RunView sessionId={base.id} fixture={session} fixtureLabel={`${FIXTURE_LABEL}. The 3D model is a public sample file.`} />;
}
