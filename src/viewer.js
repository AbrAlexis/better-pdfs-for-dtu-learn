// Brightspace bridge around Mozilla's complete viewer; rendering and UI stay upstream.
const PORTAL_ORIGIN = "https://learn.inside.dtu.dk";
const token = location.hash.slice(1);
// The token authenticates our bridge; it isn't a PDF destination or zoom setting.
history.replaceState(null, "", location.pathname);
const $ = id => document.getElementById(id);
let app;
let received = false;
const notify = type => parent.postMessage({ type, token }, PORTAL_ORIGIN);

function toggleSearch() {
  if (!app?.initialized) return;
  app.findBar.toggle();
  if (!app.findBar.opened) app.pdfViewer.focus();
}

// Register before importing the generic viewer, whose startup dispatches this event.
document.addEventListener("webviewerloaded", () => {
  app = window.PDFViewerApplication;
  window.PDFViewerApplicationOptions.setAll({
    defaultUrl: "", disablePreferences: true, disableHistory: true,
    defaultZoomValue: "page-width", viewOnLoad: 1,
    // Start closed even when the PDF requests thumbnails or an outline on open.
    sidebarViewOnLoad: 0,
    enableScripting: false, enableXfa: false,
    annotationEditorMode: -1, annotationMode: 1,
    enableAltTextModelDownload: false, enableSignatureVerification: false,
    externalLinkTarget: 2, externalLinkRel: "noopener noreferrer",
    maxCanvasPixels: 16_777_216, pdfBugEnabled: false,
    workerSrc: "../build/pdf.worker.mjs"
  });
  // A PDF's print action should not open the browser's print dialog on load.
  app._initializeAutoPrint = async () => {};
}, { once: true });

window.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    event.stopImmediatePropagation();
    toggleSearch();
  }
}, true);

// Keep this viewer attached to the lesson PDF, including when files are dropped.
for (const type of ["dragover", "drop"]) {
  window.addEventListener(type, event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

window.addEventListener("message", async event => {
  if (event.source !== parent || event.origin !== PORTAL_ORIGIN || event.data?.token !== token) return;
  if (event.data.type === "dtu-pdf-find") toggleSearch();
  else if (event.data.type === "dtu-pdf-resize") app?.eventBus?.dispatch("resize", { source: window });
  else if (event.data.type === "dtu-pdf-data" && !received && event.data.data instanceof ArrayBuffer) {
    received = true;
    try {
      const url = new URL(event.data.url);
      if (url.origin !== PORTAL_ORIGIN || url.username || url.password) throw new Error("Invalid PDF origin");
      $("openOriginal").href = url.href;
      $("openOriginal").removeAttribute("aria-disabled");
      const name = decodeURIComponent(url.pathname.split("/").pop());
      await app.open({ data: new Uint8Array(event.data.data), filename: /\.pdf$/i.test(name) ? name : "document.pdf" });
    } catch {
      notify("dtu-pdf-error");
    }
  }
});

try {
  await import("./viewer.mjs");
  await app.initializedPromise;
  app.eventBus.on("pagesinit", () => notify("dtu-pdf-loaded"));
  app.eventBus.on("documenterror", () => notify("dtu-pdf-error"));
  // Keep the existing fallback for encrypted documents instead of leaving the
  // lesson waiting on a password dialog past the host's loading timeout.
  app.passwordPrompt.open = async () => { notify("dtu-pdf-error"); };
  $("findHighlightAll").checked = true;
  $("useOriginal").addEventListener("click", () => notify("dtu-pdf-original"));
  $("openOriginal").addEventListener("click", () => app.secondaryToolbar.close());
  window.addEventListener("pagehide", () => { void app.close(); });
  notify("dtu-pdf-ready");
} catch {
  notify("dtu-pdf-error");
}
