# ChatGPT connector acceptance

12 October 2026, Istanbul. This records deployment/API evidence separately from an installed ChatGPT session.

## Current deployment

- Source commit: `1644b7544fc69843050e2ae9947455696f0282ac`.
- Preview: <https://makeready-preview-mmf-code.vercel.app>.
- Deployment: `dpl_4t3FdETHZkSPNRBsmxaQRiKdUecJ`, `READY`.
- UI resource: `ui://makeready/view-b78728e56b44.html`.
- UI SHA-256: `b78728e56b444442f8959dd0559c89f48c957a8b5e616bf653ccc8e05d6b33fb`.
- MCP URL includes the private `MCP_SECRET` path segment. Do not put that complete URL in Git, screenshots, chat messages, or public guides.

## Verified

- Five widget/resource build tests pass; deployment compilation and TypeScript pass.
- Public HTTPS MCP initialization negotiates `2025-06-18`.
- Seven tools have input/output schemas, annotations, and `model`/`app` visibility, including `decide_revision`.
- The deployed HTML bytes match the resource URI hash.
- Resource CSP allows the dedicated Supabase storage origin and the preview application origin.
- Web access remains gated. A real session can be created, reloaded, and read through MCP from the same store.
- Read-only `get_design` retrieved the existing logo session: five revisions, one saved plan, five comparisons. No planning, image editing or model generation was submitted by this acceptance run.

Local, ignored evidence: `artifacts/live/mcp-chatgpt-20261012/preflight.json`.

## ChatGPT acceptance still required

API success does **not** establish that ChatGPT has installed the connector or rendered the widget. Both remain unverified until exercised in the signed-in browser.

Following the [official connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt), connect the existing HTTPS MCP endpoint as a private custom MCP server, choose the current no-OAuth authentication mode, install it, and start a new conversation. After a UI resource change, refresh connection metadata before starting the test conversation.

Use this first prompt with MakeReady selected; it does not authorize paid work:

> Use only MakeReady. Call get_design with sessionId d4feaec1-6e9b-4e7a-9665-46d40f2c3df6 and display its interactive card. Read the existing saved results; do not start, plan, edit, approve, or generate anything. Report the measured dimensions and failed/not-checked physical checks separately.

Then verify the actual card, the latest UI resource, and its “Open in MakeReady” link to the same `/runs/:sessionId`. Record the ChatGPT conversation URL and rendering result without retaining the private connector URL or credentials.

This test does not exercise photo attachment transfer, in-chat approval, paid generation, or a rotating 3D viewer inside ChatGPT.
