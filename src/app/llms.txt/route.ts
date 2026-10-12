import { llmsText } from "@/components/makeready/agent-guide";

// The agent guide as plain text for LLMs and crawlers.
export function GET(): Response {
  return new Response(llmsText(), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
