import * as pdfjsLib from "./vendor/build/pdf.mjs";
import { EventBus, FindState, PDFFindController, PDFLinkService, PDFViewer } from "./vendor/web/pdf_viewer.mjs";

const PORTAL_ORIGIN = "https://learn.inside.dtu.dk";
const token = location.hash.slice(1);
const $ = id => document.getElementById(id);
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2, externalLinkRel: "noopener noreferrer" });
// PDF.js extracts text from every page, independently of the rendered page window.
const findController = new PDFFindController({ linkService, eventBus, updateMatchesCountOnProgress: false });
const pdfViewer = new PDFViewer({
  container: $("viewerContainer"), viewer: $("viewer"), eventBus, linkService, findController,
  imageResourcesPath: new URL("./vendor/web/images/", import.meta.url).href,
  annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
  annotationMode: pdfjsLib.AnnotationMode.ENABLE,
  maxCanvasPixels: 16_777_216
});
linkService.setViewer(pdfViewer);
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/build/pdf.worker.mjs", import.meta.url).href;
let documentLoaded = false;
let received = false;
let loadingTask;

function notify(type) {
  parent.postMessage({ type, token }, PORTAL_ORIGIN);
}

function search(type = "", findPrevious = false) {
  if (!documentLoaded) {
    $("findStatus").textContent = "Loading…";
    return;
  }
  if (!$("query").value) $("findStatus").textContent = "";
  eventBus.dispatch("find", {
    source: window, type, query: $("query").value,
    caseSensitive: $("matchCase").checked, entireWord: $("wholeWord").checked,
    highlightAll: true, findPrevious, matchDiacritics: false
  });
}

function openSearch() {
  $("findbar").hidden = false;
  $("findToggle").setAttribute("aria-expanded", "true");
  resize();
  $("query").focus();
  $("query").select();
  if ($("query").value) search("again");
}

function closeSearch() {
  $("findbar").hidden = true;
  $("findToggle").setAttribute("aria-expanded", "false");
  eventBus.dispatch("findbarclose", { source: window });
  resize();
  $("viewerContainer").focus();
}

function toggleSearch() {
  if ($("findbar").hidden) openSearch();
  else closeSearch();
}

function resize() {
  if (!documentLoaded) return;
  if (["page-width", "page-fit"].includes(pdfViewer.currentScaleValue)) pdfViewer.currentScaleValue = pdfViewer.currentScaleValue;
  pdfViewer.update();
}

function updateCount({ current = 0, total = 0 } = {}) {
  if (!$("query").value) return;
  $("findStatus").textContent = total ? `${current} / ${total}` : "No matches";
  $("findStatus").setAttribute("aria-label", total ? `${current} of ${total} matches` : "No matches in this PDF");
}

eventBus.on("updatefindmatchescount", ({ matchesCount }) => updateCount(matchesCount));
eventBus.on("updatefindcontrolstate", ({ state, matchesCount }) => {
  if (!$("query").value) return;
  if (state === FindState.PENDING) $("findStatus").textContent = "Searching…";
  else updateCount(matchesCount);
});
eventBus.on("pagesinit", () => {
  documentLoaded = true;
  pdfViewer.currentScaleValue = "page-width";
  $("loading").hidden = true;
  $("viewerContainer").setAttribute("aria-busy", "false");
  for (const id of ["pageNumber", "scale", "zoomIn", "zoomOut"]) $(id).disabled = false;
  updatePageControls();
  notify("dtu-pdf-loaded");
  if ($("query").value) search();
});

function updatePageControls() {
  $("pageNumber").value = pdfViewer.currentPageNumber;
  $("pageNumber").max = pdfViewer.pagesCount;
  $("pageCount").textContent = `/ ${pdfViewer.pagesCount}`;
  $("previousPage").disabled = pdfViewer.currentPageNumber <= 1;
  $("nextPage").disabled = pdfViewer.currentPageNumber >= pdfViewer.pagesCount;
}
eventBus.on("pagechanging", updatePageControls);
eventBus.on("scalechanging", ({ scale, presetValue }) => {
  const value = presetValue || String(scale);
  const exists = [...$("scale").options].some(option => option.value === value);
  $("scale").value = exists ? value : "custom";
  $("scale").querySelector('[value="custom"]').textContent = `${Math.round(scale * 100)}%`;
});

$("findToggle").addEventListener("click", toggleSearch);
$("findClose").addEventListener("click", closeSearch);
$("query").addEventListener("input", () => search());
$("findPrevious").addEventListener("click", () => search("again", true));
$("findNext").addEventListener("click", () => search("again"));
for (const id of ["matchCase", "wholeWord"]) $(id).addEventListener("change", () => search());
$("query").addEventListener("keydown", event => {
  if (event.key === "Enter") {
    event.preventDefault();
    search("again", event.shiftKey);
  }
});
const optionsMenu = $("optionsMenu");
document.addEventListener("click", event => {
  if (!optionsMenu.contains(event.target) || event.target.closest(".menu-items")) optionsMenu.open = false;
});
optionsMenu.addEventListener("focusout", () => {
  setTimeout(() => { if (!optionsMenu.contains(document.activeElement)) optionsMenu.open = false; }, 0);
});
window.addEventListener("blur", () => { optionsMenu.open = false; });
$("useOriginal").addEventListener("click", () => notify("dtu-pdf-original"));
window.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    toggleSearch();
  } else if (event.key === "Escape" && optionsMenu.open) {
    event.preventDefault();
    optionsMenu.open = false;
    optionsMenu.querySelector("summary").focus();
  } else if (event.key === "Escape" && !$("findbar").hidden) {
    event.preventDefault();
    closeSearch();
  }
});
$("previousPage").addEventListener("click", () => pdfViewer.currentPageNumber--);
$("nextPage").addEventListener("click", () => pdfViewer.currentPageNumber++);
$("pageNumber").addEventListener("change", () => {
  const page = Number($("pageNumber").value);
  if (Number.isInteger(page) && page >= 1 && page <= pdfViewer.pagesCount) pdfViewer.currentPageNumber = page;
  updatePageControls();
});
$("scale").addEventListener("change", () => {
  if ($("scale").value !== "custom") pdfViewer.currentScaleValue = $("scale").value;
});
$("zoomIn").addEventListener("click", () => { pdfViewer.currentScale = Math.min(4, pdfViewer.currentScale * 1.1); });
$("zoomOut").addEventListener("click", () => { pdfViewer.currentScale = Math.max(.25, pdfViewer.currentScale / 1.1); });
new ResizeObserver(resize).observe($("documentArea"));

window.addEventListener("message", async event => {
  if (event.source !== parent || event.origin !== PORTAL_ORIGIN || event.data?.token !== token) return;
  if (event.data.type === "dtu-pdf-find") toggleSearch();
  else if (event.data.type === "dtu-pdf-resize") resize();
  else if (event.data.type === "dtu-pdf-data" && !received && event.data.data instanceof ArrayBuffer) {
    received = true;
    $("openOriginal").href = event.data.url;
    $("openOriginal").removeAttribute("aria-disabled");
    try {
      loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(event.data.data), isEvalSupported: false,
        cMapUrl: new URL("./vendor/cmaps/", import.meta.url).href, cMapPacked: true,
        standardFontDataUrl: new URL("./vendor/standard_fonts/", import.meta.url).href,
        wasmUrl: new URL("./vendor/wasm/", import.meta.url).href,
        iccUrl: new URL("./vendor/iccs/", import.meta.url).href,
        // Keep documents self-contained; don't run their JavaScript or XFA forms.
        enableXfa: false
      });
      const pdf = await loadingTask.promise;
      linkService.setDocument(pdf);
      pdfViewer.setDocument(pdf);
    } catch {
      $("loading").textContent = "This PDF could not be opened. Use the original viewer above.";
      notify("dtu-pdf-error");
    }
  }
});
window.addEventListener("pagehide", () => { void loadingTask?.destroy(); });
notify("dtu-pdf-ready");
