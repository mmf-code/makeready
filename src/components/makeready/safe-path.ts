/** Only same-origin relative paths: "/runs/x" passes; "//evil.com", "/\evil.com" and "/.//evil.com" do not. */
export function safePath(value: unknown): string {
  if (typeof value !== "string" || !isRelative(value)) return "/";
  try {
    const url = new URL(value, "http://same.origin");
    if (url.origin !== "http://same.origin") return "/";
    // Normalisation can turn "/.//evil.com" into "//evil.com", so check the result as well.
    const path = `${url.pathname}${url.search}${url.hash}`;
    return isRelative(path) ? path : "/";
  } catch {
    return "/";
  }
}

function isRelative(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.startsWith("/\\");
}
