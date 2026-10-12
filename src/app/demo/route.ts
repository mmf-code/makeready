import { SCRIPTED_RUN_HTML } from "@/components/makeready/scripted-run-html";

// The scripted run: one message, every builder, no live provider calls.
export function GET(): Response {
  return new Response(SCRIPTED_RUN_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
