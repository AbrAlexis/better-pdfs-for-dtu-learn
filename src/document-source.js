export const PORTAL_ORIGIN = "https://learn.inside.dtu.dk";

// Never turn page attributes or messages into an unrestricted authenticated fetch.
export function allowedDocumentURL(value) {
  try {
    const url = new URL(value, PORTAL_ORIGIN);
    if (url.origin !== PORTAL_ORIGIN || url.username || url.password) return null;
    if (!url.pathname.startsWith("/content/enforced/") &&
        !/^\/d2l\/api\/le\/\d+\.\d+\/\d+\/content\/topics\/\d+\/file$/.test(url.pathname)) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function documentSources(src, panelID, pageURL) {
  const candidates = [];
  if (src) {
    const direct = allowedDocumentURL(src);
    if (direct) candidates.push(direct);
  }
  const panelMatch = /_(\d+)_(\d+)$/.exec(panelID || "");
  const pageMatch = /\/d2l\/le\/lessons\/(\d+)\/topics\/(\d+)(?:\/|$)/.exec(new URL(pageURL).pathname);
  const ids = panelMatch || pageMatch;
  if (ids) candidates.push(`${PORTAL_ORIGIN}/d2l/api/le/1.38/${ids[1]}/content/topics/${ids[2]}/file?stream=true`);
  return [...new Set(candidates)];
}

export function isPDF(buffer) {
  // A login page can be returned with HTTP 200. Don't pass it to the renderer.
  return new TextDecoder("latin1").decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 1024))).includes("%PDF-");
}

export async function fetchPDF(candidates, signal, fetcher = fetch) {
  let lastError;
  for (const candidate of candidates) {
    const url = allowedDocumentURL(candidate);
    if (!url) continue;
    try {
      const response = await fetcher(url, { credentials: "include", signal, redirect: "error" });
      if (!response.ok) throw new Error(`The document request returned HTTP ${response.status}.`);
      const data = await response.arrayBuffer();
      if (!isPDF(data)) throw new Error("DTU returned a page instead of a PDF. Try refreshing your login.");
      return { data, url };
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error("Could not locate the original PDF.");
}
