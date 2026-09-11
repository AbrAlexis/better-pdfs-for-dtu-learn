import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
import { zipSync } from "fflate";

const manifest = JSON.parse(await readFile("src/manifest.json", "utf8"));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const pdfPackage = JSON.parse(await readFile("node_modules/pdfjs-dist/package.json", "utf8"));
const viewerSources = Object.fromEntries(await Promise.all(
  ["viewer.js", "viewer.css"].map(async file => [file, await readFile(`src/${file}`, "utf8")])
));
const upstream = JSON.parse(await readFile("vendor/pdfjs/UPSTREAM.json", "utf8"));
if (upstream.version !== pdfPackage.version) throw new Error("The standard viewer and pdfjs-dist must have the same version");
const upstreamHTML = await readFile("vendor/pdfjs/web/viewer.html", "utf8");
const upstreamJS = await readFile("vendor/pdfjs/web/viewer.mjs", "utf8");
const upstreamCSS = await readFile("vendor/pdfjs/web/viewer.css", "utf8");
function replaceOnce(text, before, after) {
  if (text.split(before).length !== 2) throw new Error(`Upstream viewer changed: ${before}`);
  return text.replace(before, after);
}
// The bridge listens in the extension frame. Accessing Brightspace's parent
// document is cross-origin and makes upstream log a caught SecurityError.
const viewerJS = replaceOnce(upstreamJS, `  try {
    parent.document.dispatchEvent(event);
  } catch (ex) {
    console.error("webviewerloaded:", ex);
    document.dispatchEvent(event);
  }`, `  // Modified by DTU PDF Search: dispatch startup inside the extension frame.
  document.dispatchEvent(event);`);
// New HTML, JS and CSS always travel together, even when a browser keeps extension
// resources cached across a temporary add-on reload.
const revision = createHash("sha256").update(JSON.stringify({ viewerSources, upstreamHTML, viewerJS, upstreamCSS, pdfVersion: pdfPackage.version })).digest("hex").slice(0, 12);
const viewerPage = `vendor/web/viewer.${revision}.html`;

for (const browser of ["chrome", "firefox"]) {
  const dest = `dist/${browser}`;
  // Only generated output is removed; source and dependency directories are untouched.
  await rm(dest, { recursive: true, force: true });
  await mkdir(`${dest}/vendor`, { recursive: true });
  const browserManifest = {
    ...manifest, version: pkg.version,
    web_accessible_resources: [{ ...manifest.web_accessible_resources[0], resources: [viewerPage] }]
  };
  if (browser === "firefox") {
    browserManifest.browser_specific_settings = {
      gecko: {
        id: "dtu-pdf-search@dtu-pdf-search.local",
        strict_min_version: "140.0",
        data_collection_permissions: { required: ["none"] }
      },
      gecko_android: { strict_min_version: "142.0" }
    };
  } else {
    browserManifest.minimum_chrome_version = "132";
  }
  await writeFile(`${dest}/manifest.json`, JSON.stringify(browserManifest, null, 2) + "\n");
  await mkdir(`${dest}/icons`, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    await cp(`logo/icon-${size}.png`, `${dest}/icons/icon-${size}.png`);
  }
  await build({
    entryPoints: ["src/content.js"], outfile: `${dest}/content.js`, bundle: true,
    target: ["chrome132", "firefox140"], define: { __VIEWER_PAGE__: JSON.stringify(viewerPage) }
  });
  await cp("vendor/pdfjs/web", `${dest}/vendor/web`, { recursive: true });
  await rm(`${dest}/vendor/web/viewer.html`);
  let html = replaceOnce(upstreamHTML, '<title>PDF.js viewer</title>', '<title>DTU PDF Search</title>');
  html = replaceOnce(html, 'src="viewer.mjs"', `src="bridge.${revision}.js"`);
  html = replaceOnce(html, 'href="viewer.css"', `href="viewer.${revision}.css"`);
  html = replaceOnce(html, '</head>', `<link rel="stylesheet" href="bridge.${revision}.css" /></head>`);
  html = replaceOnce(html, '<div id="secondaryToolbarButtonContainer" class="menuContainer">',
    `<div id="secondaryToolbarButtonContainer" class="menuContainer">
      <a id="openOriginal" class="toolbarButton labeled" target="_blank" rel="noopener noreferrer" aria-disabled="true"><span>Open PDF in new tab</span></a>
      <button id="useOriginal" class="toolbarButton labeled" type="button"><span>Use original viewer</span></button>`);
  await writeFile(`${dest}/${viewerPage}`, html);
  await writeFile(`${dest}/vendor/web/bridge.${revision}.js`, replaceOnce(viewerSources["viewer.js"], './viewer.mjs', `./viewer.${revision}.mjs`));
  await writeFile(`${dest}/vendor/web/viewer.${revision}.mjs`, viewerJS);
  await rm(`${dest}/vendor/web/viewer.mjs`);
  await writeFile(`${dest}/vendor/web/bridge.${revision}.css`, viewerSources["viewer.css"]);
  await writeFile(`${dest}/vendor/web/viewer.${revision}.css`, upstreamCSS);
  await rm(`${dest}/vendor/web/viewer.css`);
  for (const file of ["build/pdf.mjs", "build/pdf.worker.mjs", "LICENSE"]) {
    const source = file.endsWith(".mjs") ? `legacy/${file}` : file;
    await cp(`node_modules/pdfjs-dist/${source}`, `${dest}/vendor/${file}`, { recursive: true });
  }
  for (const asset of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
    await cp(`node_modules/pdfjs-dist/${asset}`, `${dest}/vendor/web/${asset}`, { recursive: true });
  }
  await writeFile(`${dest}/THIRD_PARTY_NOTICES.txt`, `Includes Mozilla PDF.js ${pdfPackage.version}, licensed under Apache-2.0. See vendor/LICENSE and license files within vendor asset directories.\n`);
  const files = {};
  async function collect(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) await collect(filename);
      else files[path.relative(dest, filename).split(path.sep).join("/")] = new Uint8Array(await readFile(filename));
    }
  }
  await collect(dest);
  await mkdir("artifacts", { recursive: true });
  await writeFile(`artifacts/dtu-pdf-search-${browser}-${pkg.version}.zip`, zipSync(files));
  console.log(`Built ${dest} and artifacts/dtu-pdf-search-${browser}-${pkg.version}.zip`);
}
