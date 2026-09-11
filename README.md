# Better PDFs for DTU Learn

An unofficial browser extension that gives PDFs on [DTU Learn](https://learn.inside.dtu.dk) a more capable viewer. It uses Mozilla's standard PDF.js interface and works in Chrome and Firefox.

Better PDFs for DTU Learn is an independent project and is not affiliated with or endorsed by DTU.

## Features

- Search the entire PDF with **Ctrl+F** or **Cmd+F**, including pages you have not viewed yet.
- Navigate pages and search matches from the keyboard.
- Zoom, rotate, print, and download PDFs.
- Browse thumbnails, outlines, attachments, and document properties.
- Choose vertical, horizontal, wrapped, single-page, or spread layouts.
- Open the original PDF in a new tab.
- Switch back to Brightspace's original viewer at any time.

## Install the beta

This project does not have a signed store release yet. Build output is available in `dist`, with shareable ZIP packages in `artifacts`.

### Chrome

1. Extract `artifacts/dtu-pdf-search-chrome-0.2.0.zip`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the extracted folder.
5. Refresh DTU Learn and open a PDF.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `artifacts/dtu-pdf-search-firefox-0.2.0.zip`.
4. Refresh DTU Learn and open a PDF.

Firefox removes temporary add-ons when it restarts. A permanent installation requires a package signed by Mozilla.

The current desktop targets are Chrome 132+ and Firefox 140+. The extension has been manually tested on Windows and Linux. Automated integration tests cover Chrome and Firefox. macOS and mobile browsers have not been tested.

## Using the viewer

Press **Ctrl+F** or **Cmd+F**, or click the search icon, to open PDF.js's find bar. Press the shortcut again or press **Escape** to close it. Search text is preserved when the bar is reopened. **Enter** and **Shift+Enter** move between matches, and the find bar offers highlight-all, case-sensitive, whole-word, and diacritic-sensitive matching.

The toolbar provides page navigation, zoom, printing, downloading, and access to the pages sidebar. The **Tools (») menu** contains rotation and layout controls along with **Open PDF in new tab** and **Use original viewer**. In the original viewer, the extension's menu offers **Use searchable viewer** to switch back.

Switching to the original viewer reloads the lesson so Brightspace can initialize its renderer at the correct size. This resets the document's scroll position.

## Privacy

PDFs are fetched using the existing DTU Learn session and processed locally in browser memory. The extension has no backend, telemetry, advertising, external PDF service, or saved search history. It does not request access to other websites, read cookies through a browser API, or run a background process.

The extension sends the PDF bytes to its own local viewer frame. It does not send session cookies or PDF contents to another server. A session-storage entry only remembers when the current document should use Brightspace's original viewer.

## Current limitations

- This extension supports DTU Learn specifically, not every Brightspace installation.
- Image-only scans have no searchable text and require OCR, which is not included.
- Password-protected and unsupported PDFs fall back to the original viewer.
- The complete PDF is loaded into memory before viewing, so very large files may take longer and use more memory.
- Redirect-only or externally hosted files fall back to the original viewer.
- Brightspace-specific annotation controls remain available through the original viewer.
- Future changes to DTU Learn's page structure may require an extension update.

## Development

Node.js 22.13 or newer and npm are required. Node.js 24 is recommended.

```sh
npm ci
npm run build
npm test
npx playwright install chromium firefox
npm run test:browser
npm run lint:firefox
```

`npm run check` builds both browser packages, runs the unit and browser integration tests, and validates the Firefox package. Playwright may require additional browser system libraries on some operating systems.

After rebuilding, reload the extension from the browser's extension manager and refresh DTU Learn. The build assigns content-based names to the generated viewer resources to prevent stale files from being combined after an extension reload.

The browser tests install the actual extension in isolated Chrome and Firefox profiles. They intercept the DTU hostname and serve simulated Brightspace pages and generated PDFs, so they do not contact DTU or use a real account. Coverage includes full-document search, authenticated loading, API fallback, source changes, failed requests, nested frames, shadow roots, sidebar startup behavior, downloads, viewer switching, and viewport sizing.

Firefox's linter currently reports warnings in Mozilla's bundled PDF.js compatibility code. It reports no validation errors. PDF scripting is disabled, and the extension's content security policy does not allow JavaScript `eval` or the `Function` constructor.

## Architecture

1. A content script runs on `https://learn.inside.dtu.dk/*`, including matching frames.
2. It finds Brightspace's `d2l-pdf-viewer`, including instances inside open shadow roots.
3. It fetches the PDF through the signed-in DTU Learn page. If necessary, it tries Brightspace's topic file API using the lesson identifiers.
4. It transfers the bytes to an extension frame after checking the URL, message origin, source window, and per-viewer token.
5. The bundled standard PDF.js viewer renders the document and provides its interface.
6. DOM observers handle lesson changes, abort requests for removed viewers, and restore Brightspace's viewer after failures.

[`src/content.js`](src/content.js) integrates with Brightspace, [`src/document-source.js`](src/document-source.js) validates and loads PDF sources, and [`src/viewer.js`](src/viewer.js) connects the standard PDF.js viewer to the extension. [`scripts/build.mjs`](scripts/build.mjs) creates the Chrome and Firefox packages.

## PDF.js

`vendor/pdfjs/web` contains the unmodified standard viewer, icons, and translations from the official PDF.js 6.3.289 legacy distribution. [`vendor/pdfjs/UPSTREAM.json`](vendor/pdfjs/UPSTREAM.json) records its download URL and SHA-256 checksum. PDF.js core, its worker, fonts, CMaps, and decoding assets come from the matching pinned `pdfjs-dist` package.

When updating PDF.js, update both sources to the same version. The build rejects version mismatches and checks the locations where DTU-specific menu items and startup integration are added. Review the application options, find-bar integration, password fallback, and auto-print behavior after every update.

PDF.js is licensed under the Apache License 2.0. Its license and notices are included in each generated package.
