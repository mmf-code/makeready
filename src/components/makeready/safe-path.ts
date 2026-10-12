/** Only same-origin relative paths: "/runs/x" passes, "//evil.com" and "/\evil.com" do not. */
export function safePath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
  try {
    const url = new URL(value, "http://same.origin");
    return url.origin === "http://same.origin" ? `${url.pathname}${url.search}${url.hash}` : "/";
  } catch {
    return "/";
  }
}
