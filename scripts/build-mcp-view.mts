import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build, type Metafile } from "esbuild";

const execFileAsync = promisify(execFile);
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetLoaders = { ".png": "dataurl", ".jpg": "dataurl", ".webp": "dataurl", ".svg": "dataurl", ".woff2": "dataurl" } as const;

async function collectInputs(root: string) {
  const entry = join(root, "src/components/mcp-view/entry.tsx");
  const globals = join(root, "src/app/globals.css");
  const javascript = await build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, metafile: true,
    format: "iife", platform: "browser", target: "es2022", jsx: "automatic", minify: true,
    sourcemap: false, outfile: join(root, ".next/mcp-view.js"),
    define: { "process.env.NODE_ENV": '"production"' }, loader: assetLoaders,
    // Server environment values and MCP secrets are never injected into this bundle.
  });
  const stylesheet = await build({
    absWorkingDir: root,
    ...(existsSync(globals) ? { entryPoints: [globals] } : { stdin: { contents: '@import "tailwindcss" source(none);', loader: "css" as const, resolveDir: root } }),
    bundle: true, write: false, metafile: true, logLevel: "silent",
    conditions: ["style"], mainFields: ["style", "main"], loader: assetLoaders,
    outfile: join(root, ".next/mcp-style.css"),
  });
  for (const result of [javascript, stylesheet]) {
    const external = Object.values(result.metafile.outputs).flatMap((output) => output.imports).filter((item) => item.external);
    if (external.length) throw new Error(`MCP View must be self-contained; external imports: ${external.map((item) => item.path).join(", ")}`);
  }
  const jsPaths = Object.keys(javascript.metafile.inputs).map((path) => absoluteInput(root, path));
  const cssPaths = Object.keys(stylesheet.metafile.inputs).filter((path) => path !== "<stdin>").map((path) => absoluteInput(root, path));
  const classSources = jsPaths.filter((path) => !dependencyPath(path) && /\.(?:[cm]?[jt]sx?|html|json)$/.test(path)).sort();
  // Include every scanned file and every imported stylesheet, including package CSS.
  // Remaining JS dependency content is covered by the lockfile.
  const paths = new Set([...jsPaths.filter((path) => !dependencyPath(path)), ...cssPaths]);
  for (const path of [join(root, "package.json"), join(root, "pnpm-lock.yaml"), join(root, "scripts/build-mcp-view.mts")]) {
    if (existsSync(path)) paths.add(path);
  }
  const sourceHashes: Record<string, string> = {};
  for (const path of [...paths].sort((a, b) => inputKey(root, a).localeCompare(inputKey(root, b)))) {
    sourceHashes[inputKey(root, path)] = digest(await readFile(path));
  }
  return { javascript, stylesheet, classSources, sourceHashes, globals };
}

/** Recompute the graph as well as hashes: an added file can change import resolution. */
export async function collectMcpViewSourceHashes(rootDirectory = defaultRoot): Promise<Record<string, string>> {
  return (await collectInputs(resolve(rootDirectory))).sourceHashes;
}

/** Copy CSS without changing frontend files, and disable every implicit class source. */
async function isolatedStylesheet(root: string, temporary: string, graph: Metafile, globals: string): Promise<string> {
  const copies = new Map<string, string>();
  for (const path of Object.keys(graph.inputs).filter((path) => path !== "<stdin>")) {
    if (!path.endsWith(".css")) throw new Error("MCP stylesheet assets must be embedded before bundling.");
    copies.set(path, join(temporary, `style-${digest(inputKey(root, absoluteInput(root, path))).slice(0, 16)}.css`));
  }
  for (const [path, copy] of copies) {
    const input = graph.inputs[path];
    let css = await readFile(absoluteInput(root, path), "utf8");
    // These directives introduce dependencies not described by esbuild's CSS graph.
    // Fail visibly instead of silently re-enabling broad filesystem scanning.
    if (/@(?:config|plugin|reference)\b/.test(css) || /@source\b(?!\s+inline\s*\()/m.test(css)) {
      throw new Error(`MCP stylesheet ${inputKey(root, absoluteInput(root, path))} has an undeclared Tailwind dependency or path source.`);
    }
    css = css.replace(/@import\s+(?:url\(\s*)?(["'])([^"']+)\1\s*\)?([^;]*);/g, (_rule, _quote: string, original: string, modifiers: string) => {
      const dependency = input.imports.find((item) => item.kind === "import-rule" && item.original === original);
      const destination = dependency && copies.get(dependency.path);
      if (!destination) throw new Error(`MCP stylesheet import was not resolved: ${original}`);
      // Tailwind may also be imported by a nested local stylesheet.
      const isTailwind = /(?:^|\/)tailwindcss\/(?:index|utilities)\.css$/.test(dependency.path.replaceAll("\\", "/"));
      const suffix = isTailwind ? `${modifiers.replace(/\bsource\([^)]*\)/g, "")} source(none)` : modifiers;
      return `@import ${JSON.stringify(destination)}${suffix};`;
    });
    await writeFile(copy, css);
  }
  const rootInput = Object.keys(graph.inputs).find((path) => absoluteInput(root, path) === globals);
  if (rootInput) return `@import ${JSON.stringify(copies.get(rootInput))};\n`;
  // No frontend global stylesheet exists yet.
  return '@import "tailwindcss" source(none);\n';
}

export async function buildMcpView(options: { rootDirectory?: string; quiet?: boolean } = {}): Promise<boolean> {
  const root = resolve(options.rootDirectory ?? defaultRoot);
  const entry = join(root, "src/components/mcp-view/entry.tsx");
  const target = join(root, "src/lib/mcp/view.generated.ts");
  if (!existsSync(entry)) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, '// Generated by scripts/build-mcp-view.mts. The frontend entry is unavailable.\nexport const mcpView = {\n  available: false,\n  html: "",\n  sha256: "",\n  resourceUri: "",\n  sourceHashes: {} as Record<string, string>,\n} as const;\n');
    if (!options.quiet) console.info("MCP View is unavailable: Claude's src/components/mcp-view/entry.tsx has not landed.");
    return false;
  }
  await mkdir(join(root, ".next"), { recursive: true });
  const temporary = await mkdtemp(join(root, ".next/mcp-view-"));
  try {
    const { javascript, stylesheet, classSources, sourceHashes, globals } = await collectInputs(root);
    const script = javascript.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
    if (!script) throw new Error("MCP View build produced no JavaScript.");
    const cssInput = join(temporary, "input.css");
    const cssOutput = join(temporary, "view.css");
    const cssImports = await isolatedStylesheet(root, temporary, stylesheet.metafile, globals);
    await writeFile(cssInput, `${cssImports}${classSources.map((path) => `@source ${JSON.stringify(path)};`).join("\n")}\n`);
    await execFileAsync("pnpm", ["exec", "tailwindcss", "-i", cssInput, "-o", cssOutput, "--minify"], { cwd: root });
    const bundledCss = javascript.outputFiles.filter((file) => file.path.endsWith(".css")).map((file) => file.text).join("\n");
    const css = `${await readFile(cssOutput, "utf8")}\n${bundledCss}`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MakeReady</title><style>${css.replace(/<\/style/gi, "<\\/style")}</style></head><body><div id="root"></div><script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
    const sha256 = digest(html);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `// Generated by scripts/build-mcp-view.mts. Do not edit.\nexport const mcpView = ${JSON.stringify({ available: true, html, sha256, resourceUri: `ui://makeready/view-${sha256.slice(0, 12)}.html`, sourceHashes }, null, 2)} as const;\n`);
    if (!options.quiet) console.info(`MCP View bundled: ui://makeready/view-${sha256.slice(0, 12)}.html`);
    return true;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function absoluteInput(root: string, path: string): string { return isAbsolute(path) ? path : resolve(root, path); }
function dependencyPath(path: string): boolean { return path.replaceAll("\\", "/").includes("/node_modules/"); }
function inputKey(root: string, path: string): string {
  const local = relative(root, path).replaceAll("\\", "/");
  // A source archive may share the installed node_modules through a symlink.
  return local.startsWith("../") && dependencyPath(path) ? path.replaceAll("\\", "/").slice(path.replaceAll("\\", "/").indexOf("/node_modules/") + 1) : local;
}
function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildMcpView();
