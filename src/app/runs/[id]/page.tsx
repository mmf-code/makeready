import type { Metadata } from "next";
import { RunView } from "@/components/makeready/run-view";

export const metadata: Metadata = { title: "Live run" };

export default async function RunPage({ params }: PageProps<"/runs/[id]">) {
  const { id } = await params;
  return <RunView sessionId={id} />;
}
