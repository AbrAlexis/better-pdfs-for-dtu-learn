import { PORTAL_ORIGIN, documentSources, fetchPDF } from "./document-source.js";

(() => {
  const extension = globalThis.browser || globalThis.chrome;
  const viewerURL = extension.runtime.getURL(__VIEWER_PAGE__);
  const parsedViewerURL = new URL(viewerURL);
  const viewerOrigin = `${parsedViewerURL.protocol}//${parsedViewerURL.host}`;
  const records = new Map();
  const roots = new Map();
  const childFrames = new Set();
  const queriedFrames = new WeakSet();
  const originalPreferenceKey = "dtu-pdf-search-original-viewer";
  let scheduled;
  let sizingScheduled = false;
  const watchedWindows = new Set();

  function scheduleSizing() {
    if (sizingScheduled) return;
    sizingScheduled = true;
    requestAnimationFrame(() => {
      sizingScheduled = false;
      for (const record of records.values()) {
        if (record.originalVisible || !record.frame.isConnected) continue;
        // The lesson iframe can be taller than the browser viewport. Translate
        // ancestor viewport edges into this document's coordinates before sizing.
        let owner = window;
        let offset = 0;
        let bottom = Infinity;
        let scrollOffset = 0;
        while (owner) {
          try {
            if (!watchedWindows.has(owner)) {
              owner.addEventListener("resize", scheduleSizing, { passive: true });
              owner.addEventListener("scroll", scheduleSizing, { passive: true, capture: true });
              owner.visualViewport?.addEventListener("resize", scheduleSizing, { passive: true });
              owner.visualViewport?.addEventListener("scroll", scheduleSizing, { passive: true });
              watchedWindows.add(owner);
            }
            const viewport = owner.visualViewport;
            scrollOffset += owner.scrollY;
            bottom = Math.min(bottom, (viewport ? viewport.offsetTop + viewport.height : owner.innerHeight) - offset);
            if (owner === owner.parent || !owner.frameElement) break;
            const frame = owner.frameElement;
            for (let ancestor = frame.parentElement; ancestor && ancestor !== owner.parent.document.documentElement; ancestor = ancestor.parentElement || ancestor.getRootNode().host) {
              if (ancestor !== owner.parent.document.body && ancestor !== owner.parent.document.scrollingElement) scrollOffset += ancestor.scrollTop;
            }
            offset += frame.getBoundingClientRect().top + frame.clientTop;
            owner = owner.parent;
          } catch { break; }
        }
        // Reserve the normal-flow spacing after the viewer. Filling right up to
        // the viewport without allowing for this creates a small outer scrollbar.
        let trailingSpace = 0;
        for (let ancestor = record.host; ancestor && ancestor !== document.documentElement; ancestor = ancestor.parentElement || ancestor.getRootNode().host) {
          const style = getComputedStyle(ancestor);
          trailingSpace += (parseFloat(style.marginBottom) || 0) + (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderBottomWidth) || 0);
          if (ancestor !== document.body && ancestor !== document.scrollingElement) scrollOffset += ancestor.scrollTop;
        }
        // Use its position in normal flow, not the scrolled position; otherwise
        // every outer scroll grows the PDF again and creates yet more overflow.
        const height = `${Math.max(120, Math.floor(bottom - record.frame.getBoundingClientRect().top - scrollOffset - trailingSpace))}px`;
        if (record.frame.style.height !== height) record.frame.style.height = height;
      }
    });
  }

  function prefersOriginal(key) {
    try { return sessionStorage.getItem(originalPreferenceKey) === key; }
    catch { return false; }
  }

  function restoreOriginal(record) {
    try {
      // A hidden Brightspace viewer may have initialized at zero size. Let the
      // portal initialize it normally instead of guessing its private refresh API.
      sessionStorage.setItem(originalPreferenceKey, record.key);
      if (window.top.location.origin === location.origin) window.top.location.reload();
      else location.reload();
    } catch {
      record.bar.hidden = false;
      record.status.textContent = "Could not reload the original viewer. Open the PDF in a new tab using the link here.";
    }
  }

  function activeRecord() {
    return [...records.values()].find(record => !record.originalVisible && !record.failed && record.host.getClientRects().length);
  }

  function activeChild() {
    for (const frame of childFrames) {
      if (!frame.isConnected) childFrames.delete(frame);
      else if (frame.getClientRects().length) return frame;
    }
  }

  function announce() {
    if (window !== parent) parent.postMessage({ type: "dtu-pdf-child-state", available: !!(activeRecord() || activeChild()) }, PORTAL_ORIGIN);
  }

  function focusSearch() {
    const active = activeRecord();
    if (active) {
      active.frame.focus();
      post(active, "dtu-pdf-find");
      return true;
    }
    const child = activeChild();
    if (child) {
      child.focus();
      child.contentWindow.postMessage({ type: "dtu-pdf-parent-find" }, PORTAL_ORIGIN);
      return true;
    }
    return false;
  }

  window.addEventListener("message", event => {
    if (event.origin !== PORTAL_ORIGIN) return;
    if (event.data?.type === "dtu-pdf-request-state" && window !== parent && event.source === parent) announce();
    else if (event.data?.type === "dtu-pdf-parent-find" && window !== parent && event.source === parent) focusSearch();
    else if (event.data?.type === "dtu-pdf-child-state") {
      for (const root of roots.keys()) {
        for (const frame of root.querySelectorAll("iframe")) {
          if (event.source !== frame.contentWindow) continue;
          if (event.data.available === true) childFrames.add(frame);
          else childFrames.delete(frame);
          announce();
          return;
        }
      }
    }
  });

  function post(record, type, extra = {}, transfer = []) {
    record.frame.contentWindow?.postMessage({ type, token: record.token, ...extra }, viewerOrigin, transfer);
  }

  function setOriginalVisible(record, visible) {
    if (visible) {
      if (record.display) record.element.style.setProperty("display", record.display, record.priority);
      else record.element.style.removeProperty("display");
    } else {
      record.element.style.setProperty("display", "none", "important");
    }
    record.frame.hidden = visible;
    record.bar.hidden = !visible;
    record.originalVisible = visible;
    record.toggle.textContent = visible ? "Use searchable viewer" : "Use original viewer";
    scheduleSizing();
    announce();
  }

  function remove(record) {
    record.controller.abort();
    clearTimeout(record.timeout);
    record.resizeObserver.disconnect();
    window.removeEventListener("message", record.onMessage);
    setOriginalVisible(record, true);
    record.host.remove();
    records.delete(record.element);
  }

  function fail(record, message) {
    clearTimeout(record.timeout);
    record.controller.abort();
    record.failed = true;
    record.status.textContent = `Searchable viewer unavailable. ${message}`;
    setOriginalVisible(record, true);
    record.toggle.textContent = "Retry searchable viewer";
  }

  function mount(element, sources, key) {
    const host = document.createElement("div");
    host.className = "dtu-pdf-search";
    // Keep the controls styled even when Brightspace places its viewer in a shadow root.
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { display: block; width: 100%; margin: 4px 0 0; color-scheme: light; }
        * { box-sizing: border-box; }
        .bar { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 3px 6px;
          background: #f8f9fb; border: 1px solid #d5d9df; border-radius: 5px; color: #253044; font: 12px/1.4 system-ui, sans-serif; }
        .status { flex: 1; min-width: 0; }
        button, a { font: inherit; }
        details { position: relative; flex: none; }
        summary { list-style: none; cursor: pointer; text-align: center; font: 20px/28px system-ui; width: 28px; height: 28px; border-radius: 4px; }
        summary::-webkit-details-marker { display: none; }
        summary:hover, details[open] summary { background: #e9edf4; }
        .menu-items { position: absolute; right: 0; top: 32px; z-index: 10; min-width: 200px; padding: 4px; border: 1px solid #d5d9df; border-radius: 6px; background: white; box-shadow: 0 4px 16px #25304420; }
        .menu-items button, .menu-items a { display: block; width: 100%; padding: 8px 10px; border: 0; border-radius: 3px; background: transparent; color: #253044; text-align: left; text-decoration: none; cursor: pointer; white-space: nowrap; }
        .menu-items button:hover, .menu-items a:hover { background: #e9edf4; }
        :focus-visible { outline: 2px solid #174f9b; outline-offset: 1px; }
        iframe { display: block; width: 100%; height: 100vh; border: 1px solid #d5d9df; border-radius: 5px; }
        [hidden] { display: none !important; }
      </style>
      <div class="bar">
        <span class="status" role="status">Loading searchable PDF…</span>
        <details>
          <summary aria-label="PDF options" title="PDF options">⋯</summary>
          <div class="menu-items">
            <a target="_blank" rel="noopener noreferrer">Open PDF in new tab</a>
            <button type="button">Use original viewer</button>
          </div>
        </details>
      </div>`;
    const frame = document.createElement("iframe");
    frame.title = "PDF — Better PDFs for DTU Learn";
    const token = crypto.randomUUID();
    shadow.append(frame);
    const original = prefersOriginal(key);
    const record = {
      element, host, frame, token, key, sources,
      bar: shadow.querySelector(".bar"),
      status: shadow.querySelector(".status"),
      toggle: shadow.querySelector("button"),
      display: element.style.getPropertyValue("display"),
      priority: element.style.getPropertyPriority("display"),
      controller: new AbortController(), originalVisible: false, started: false, failed: false
    };
    record.resizeObserver = new ResizeObserver(scheduleSizing);
    record.resizeObserver.observe(host);
    shadow.querySelector("a").href = sources[0];
    const menu = shadow.querySelector("details");
    shadow.addEventListener("click", event => {
      if (!event.composedPath().includes(menu) || event.target.closest(".menu-items")) menu.open = false;
    });
    shadow.addEventListener("keydown", event => {
      if (event.key === "Escape" && menu.open) {
        menu.open = false;
        menu.querySelector("summary").focus();
      }
    });
    menu.addEventListener("focusout", () => {
      setTimeout(() => { if (!menu.contains(shadow.activeElement)) menu.open = false; }, 0);
    });
    record.toggle.addEventListener("click", () => {
      if (record.failed) {
        remove(record);
        schedule();
        return;
      }
      if (!record.originalVisible) {
        restoreOriginal(record);
        return;
      }
      try { sessionStorage.removeItem(originalPreferenceKey); } catch { /* Still allow PDF search when storage is disabled. */ }
      setOriginalVisible(record, false);
      startViewer();
    });

    function startViewer() {
      record.status.textContent = "Loading searchable PDF…";
      frame.src = `${viewerURL}#${token}`;
      record.timeout = setTimeout(() => fail(record, "Loading timed out. Try again or open the PDF in a new tab."), 120_000);
    }

    record.onMessage = async event => {
      if (event.source !== frame.contentWindow || event.origin !== viewerOrigin || event.data?.token !== token) return;
      if (event.data.type === "dtu-pdf-ready" && !record.started) {
        record.started = true;
        try {
          const { data, url } = await fetchPDF(sources, record.controller.signal);
          if (record.controller.signal.aborted) return;
          shadow.querySelector("a").href = url;
          post(record, "dtu-pdf-data", { data, url }, [data]);
        } catch (error) {
          if (!record.controller.signal.aborted) fail(record, error.message);
        }
      } else if (event.data.type === "dtu-pdf-loaded") {
        clearTimeout(record.timeout);
        record.status.textContent = "Better PDFs for DTU Learn";
      } else if (event.data.type === "dtu-pdf-error") {
        fail(record, "The PDF could not be opened. You can use the original viewer or retry.");
      } else if (event.data.type === "dtu-pdf-original") {
        restoreOriginal(record);
      }
    };
    window.addEventListener("message", record.onMessage);
    records.set(element, record);
    element.before(host);
    setOriginalVisible(record, original);
    if (original) record.status.textContent = "Brightspace original viewer";
    else startViewer();
  }

  function scan() {
    scheduled = undefined;
    const viewers = new Set();
    function visit(root) {
      if (!roots.has(root)) {
        const observer = new MutationObserver(schedule);
        observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "id"] });
        roots.set(root, observer);
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.localName === "d2l-pdf-viewer") viewers.add(element);
        // A child can initialize before this document's content script. Ask for
        // its current state so an earlier announcement cannot be lost.
        if (element.localName === "iframe" && !queriedFrames.has(element)) {
          queriedFrames.add(element);
          element.contentWindow?.postMessage({ type: "dtu-pdf-request-state" }, PORTAL_ORIGIN);
        }
        if (element.shadowRoot && !element.classList.contains("dtu-pdf-search")) visit(element.shadowRoot);
      }
    }
    visit(document);
    for (const [root, observer] of roots) {
      if (root !== document && !root.host.isConnected) {
        observer.disconnect();
        roots.delete(root);
      }
    }
    for (const record of records.values()) {
      if (!viewers.has(record.element) || !record.host.isConnected) remove(record);
    }
    for (const element of viewers) {
      const panel = element.closest(".content-panel");
      const sources = documentSources(element.getAttribute("src"), panel?.id, location.href);
      const key = JSON.stringify(sources);
      const current = records.get(element);
      if (current?.key === key) continue;
      if (current) remove(current);
      if (sources.length) mount(element, sources, key);
    }
    scheduleSizing();
    announce();
  }

  function schedule() {
    if (scheduled === undefined) scheduled = setTimeout(scan, 80);
  }

  // Also catches a Ctrl+F originating outside the viewer, including in a parent frame.
  window.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
    if (focusSearch()) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);

  // Custom elements can attach a shadow root after insertion without a DOM mutation.
  // A light periodic rescan also covers those late upgrades and SPA history changes.
  setInterval(schedule, 2000);
  scan();
})();
