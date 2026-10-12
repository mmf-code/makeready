import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { McpView, type ViewTheme } from "./cards";
import { errorHint, readNotChecked, toViewModel, type ActionHandler, type ViewModel } from "./format";
import type { ApiError } from "@/lib/contracts";

type ToolResult = Awaited<ReturnType<App["callServerTool"]>>;

interface ViewState {
  model: ViewModel | null;
  notChecked: string[];
  appUrl: string | null;
  theme: ViewTheme;
}

const APP_URL_META = "makeready/appUrl";

const state: ViewState = {
  model: null,
  notChecked: [],
  appUrl: null,
  theme: systemTheme(),
};

const app = new App({ name: "MakeReady View", version: "1.0.0" }, {}, { autoResize: true });

const container = document.getElementById("root");
if (!container) throw new Error("MakeReady View needs a #root element.");
const root = createRoot(container);

function render(): void {
  root.render(
    <StrictMode>
      <McpView model={state.model} notChecked={state.notChecked} appUrl={state.appUrl} theme={state.theme} onAction={onAction} />
    </StrictMode>,
  );
}

function systemTheme(): ViewTheme {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** structuredContent, or the JSON copy the server also puts in the text content. */
function structuredOf(result: ToolResult): unknown {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  for (const block of result.content ?? []) {
    if (block.type !== "text") continue;
    try {
      const parsed: unknown = JSON.parse(block.text);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Plain text, not JSON.
    }
  }
  return undefined;
}

function textOf(result: ToolResult): string | undefined {
  for (const block of result.content ?? []) if (block.type === "text" && block.text.trim()) return block.text.trim();
  return undefined;
}

function applyAppUrl(meta: unknown): void {
  if (!isRecord(meta) || !(APP_URL_META in meta)) return;
  const value = meta[APP_URL_META];
  state.appUrl = typeof value === "string" && value ? value : null;
}

function showResult(result: ToolResult, toolName: string | undefined): void {
  const structured = structuredOf(result);
  applyAppUrl(result._meta);
  state.notChecked = readNotChecked(structured);
  const model = toViewModel(structured, toolName);
  if (model.kind === "unknown" && result.isError) {
    state.model = { kind: "error", error: { code: "INTERNAL_ERROR", message: textOf(result) ?? "MakeReady could not complete this request.", retryable: false } };
  } else {
    state.model = model;
  }
  render();
}

/** The message shown under the button when a tool call returns isError. */
function failureMessage(result: ToolResult): string {
  const structured = structuredOf(result);
  if (isRecord(structured) && isRecord(structured.error) && typeof structured.error.message === "string") {
    const error = structured.error as ApiError;
    return `${error.message} ${errorHint(error.code)}`;
  }
  return textOf(result) ?? "MakeReady could not complete this request.";
}

const onAction: ActionHandler = async (action) => {
  if (action.type === "open") {
    const response = await app.openLink({ url: action.url });
    if (response.isError) throw new Error("The host did not open the link.");
    return;
  }
  const result = await app.callServerTool({ name: action.name, arguments: action.arguments });
  if (result.isError) throw new Error(failureMessage(result));
  showResult(result, action.name);
};

function syncHostContext(): void {
  const context = app.getHostContext();
  if (!context) return;
  if (context.theme === "light" || context.theme === "dark") {
    state.theme = context.theme;
    applyDocumentTheme(context.theme);
  }
  // Host colors and the host font stack. Host font files are not loaded: system fonts only.
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  render();
}

// ChatGPT compatibility: an initial tool output may already be on window.openai.
function readOpenAiGlobals(): void {
  const openai = (window as unknown as { openai?: Record<string, unknown> }).openai;
  if (!isRecord(openai)) return;
  if (openai.theme === "light" || openai.theme === "dark") state.theme = openai.theme;
  applyAppUrl(openai.toolResponseMetadata);
  if (isRecord(openai.toolOutput) && !state.model) {
    state.notChecked = readNotChecked(openai.toolOutput);
    state.model = toViewModel(openai.toolOutput);
  }
}

// Register handlers before connect so the first tool result is never missed.
app.addEventListener("toolresult", (result) => {
  showResult(result, app.getHostContext()?.toolInfo?.tool.name);
});
app.addEventListener("hostcontextchanged", () => {
  syncHostContext();
});

readOpenAiGlobals();
applyDocumentTheme(state.theme);
render();

app.connect().then(syncHostContext).catch((cause: unknown) => {
  console.error("MakeReady View could not connect to the host.", cause);
});
