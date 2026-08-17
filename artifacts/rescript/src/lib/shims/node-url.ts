/**
 * Browser shim for `node:url`, aliased in vite.config.ts.
 *
 * @chatoctopus/timeline's file-url helper calls `pathToFileURL` only when a
 * media path is not already a file:// URL. In the browser the editor always
 * passes URLs (blob:/https:) or plain names, so a minimal implementation that
 * produces a syntactically valid file URL is all that is needed.
 */

export function pathToFileURL(path: string): URL {
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return new URL(`file://${encodeURI(withSlash).replace(/[?#]/g, encodeURIComponent)}`);
}

export function fileURLToPath(url: string | URL): string {
  const u = typeof url === "string" ? new URL(url) : url;
  return decodeURIComponent(u.pathname);
}

export default { pathToFileURL, fileURLToPath };
