# DTU PDF Search

A browser extension for **Chrome and Firefox** that replaces the PDF viewer inside [DTU Learn](https://learn.inside.dtu.dk) with a locally bundled PDF.js viewer. **Ctrl+F / Cmd+F searches the entire PDF**, including pages you have never scrolled to, and highlights and navigates between matches.

## Try the built extension

The build creates `dist/chrome`, `dist/firefox`, and ZIP packages in `artifacts`. You can load the generated folders directly; no development server is needed.

### Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this project's `dist/chrome` folder.
4. Refresh the DTU Learn tab and open a PDF.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `dist/firefox/manifest.json` in this project.
4. Refresh the DTU Learn tab and open a PDF.

Firefox removes temporary add-ons when it restarts. Permanent installation in standard Firefox requires Mozilla signing; the generated ZIP is an unsigned development package, not a signed release.

Desktop targets: Chrome 132+ and Firefox 140+. The PDF.js compatibility build is bundled to support older JavaScript implementations. Automated integration tests run against the downloaded test-browser versions, not every supported version. Mobile browsers have not been tested.

## Use

- Press **Ctrl+F** (or **Cmd+F** on macOS), or click the **search icon**. Search opens within the compact, single-row toolbar. Press the shortcut again to close it; your search text is preserved when reopening.
- Type a phrase. Search processes text from all pages independently of rendering; the first search can take longer for a large PDF.
- Press **Enter** / **Shift+Enter** to move between matches. Case-sensitive and whole-word searches are available.
- Press **Escape** to close search. Page navigation and zoom controls remain available.
- The **⋯ menu** contains **Use original viewer**, which reloads the lesson with Brightspace's viewer visible from startup so its renderer can initialize at the correct size. In original mode, the menu offers **Use searchable viewer** to switch back without reloading. Reloading resets the document's scroll position.
- **Open PDF in new tab**, also in the ⋯ menu, opens the original file using your existing DTU session.

On narrow viewers, opening search temporarily hides zoom controls and, at smaller widths, page controls to keep the toolbar on one row. Close search to bring those controls back. The **Aa** and **W** toggles enable case-sensitive and whole-word matching.

The viewer fills the remaining browser height below its toolbar, reserving room for surrounding page padding so it does not create a small outer scrollbar. It adjusts when the window resizes, including when Brightspace embeds the lesson in another frame. Scrolling the surrounding page does not grow the viewer.

On a lesson with the searchable viewer active, Ctrl+F is routed to PDF search, including from its enclosing DTU frame. Switch to the original viewer to use normal browser page search. Pages without an active PDF keep normal browser Find behavior.

## Build and check

Requires Node.js 22.13+ (Node.js 24 recommended) and npm.

```sh
npm ci
npm run build
npm test
npx playwright install chromium firefox
npm run test:browser
npm run lint:firefox
```

`npm run check` runs the build, unit tests, browser tests, and Firefox package validation. Playwright needs the browser system libraries for your OS. To store test browsers outside its default cache, set the same `PLAYWRIGHT_BROWSERS_PATH` when installing and running them.

After rebuilding, reload the add-on in the browser's extension manager and refresh the DTU tab. Viewer HTML, CSS, and JavaScript receive content-based filenames so browser caches cannot pair a new toolbar with an old stylesheet. Each build recreates the generated `dist/chrome` and `dist/firefox` folders.

The browser tests install the **actual extension** in isolated Chrome and Firefox profiles. They intercept the DTU hostname and serve a simulated portal and generated PDFs; they do not use your DTU account or contact DTU for fixture content. Tests cover a match on page 40 before that page renders, match navigation, zoom, authenticated fetching, API fallback, source changes, failure recovery, nested frames, and shadow roots.

Firefox's linter reports warnings in the unmodified PDF.js compatibility libraries (dynamic imports and legacy polyfills using `Function`/DOM writes). These are third-party warnings, not validation errors. The extension disables PDF.js evaluation, does not enable PDF scripting, and its content security policy blocks JavaScript `eval`. Revisit the warnings when updating PDF.js or preparing a store submission.

## How it works

1. A content script runs only on `https://learn.inside.dtu.dk/*`, including matching frames.
2. It detects `d2l-pdf-viewer`, including in open shadow roots, and reads its `src`.
3. It fetches the original PDF from the DTU page's context with the existing login session. If needed, it tries `/d2l/api/le/1.38/{org}/content/topics/{topic}/file?stream=true`, using IDs from the content panel or lesson URL.
4. It transfers PDF bytes to an extension iframe. A per-viewer token, origin check, and source-window check constrain the message bridge.
5. PDF.js's `PDFFindController` extracts and searches all pages. Its `PDFViewer` renders pages as needed and handles match highlighting and scrolling.
6. A DOM observer handles topic changes; a periodic check catches late shadow-root attachment. Removed viewers have their requests aborted. Failed loads restore the original viewer.

`src/content.js` handles Brightspace integration, `src/document-source.js` locates and loads PDFs, and `src/viewer.*` implements the viewer. `scripts/build.mjs` bundles the content script, copies pinned PDF.js assets and licenses, and generates browser-specific packages.

## Privacy and current limits

PDFs are fetched into browser memory and processed locally. There is no backend, telemetry, external PDF service, saved search history, or request for access to other websites. A session-storage entry remembers which document should use the original viewer in this tab; switching back to search clears it. No broad host permissions, cookie-reading API, or background process is required. The viewer only receives PDF bytes, not session cookies.

- This first version targets the DTU structure shown in the supplied screenshot. It still needs a manual check in a real signed-in DTU lesson.
- Search needs PDF text. Image-only scans require OCR, which is outside this version.
- Password-protected or unsupported PDFs fall back to the original viewer.
- The complete PDF is loaded before viewing. Very large files use additional memory and may take longer to open.
- File requests reject redirects; documents hosted outside DTU or behind redirect-only endpoints fall back to the original viewer. No access restrictions are bypassed.
- Brightspace's annotation and other custom controls are available through the original viewer. This version focuses on reading and search.
- The extension uses the observed `src` and panel-ID conventions, with API version `1.38` as a fallback. Future portal changes may require updating detection.

PDF.js is licensed under Apache-2.0. Its license and asset notices are included in each build.
