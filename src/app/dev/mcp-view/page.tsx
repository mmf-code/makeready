import { notFound } from "next/navigation";
import { McpViewPreview } from "@/components/mcp-view/preview";

export const metadata = { title: "MCP View preview" };

/** Development-only preview of the MCP View cards with fixture data. */
export default function McpViewPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <McpViewPreview />;
}
