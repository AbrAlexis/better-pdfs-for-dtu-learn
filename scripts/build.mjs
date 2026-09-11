import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
import { zipSync } from "fflate";

const manifest = JSON.parse(await readFile("src/manifest.json", "utf8"));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const pdfPackage = JSON.parse(await readFile("node_modules/pdfjs-dist/package.json", "utf8"));
const viewerSources = Object.fromEntries(await Promise.all(
  ["viewer.html", "viewer.js", "viewer.css"].map(async file => [file, await readFile(`src/${file}`, "utf8")])
));
// New HTML, JS and CSS always travel together, even when a browser keeps extension
// resources cached across a temporary add-on reload.
const revision = createHash("sha256").update(JSON.stringify({ viewerSources, pdfVersion: pdfPackage.version })).digest("hex").slice(0, 12);
const viewerPage = `viewer.${revision}.html`;

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
  await build({
    entryPoints: ["src/content.js"], outfile: `${dest}/content.js`, bundle: true,
    target: ["chrome132", "firefox140"], define: { __VIEWER_PAGE__: JSON.stringify(viewerPage) }
  });
  await writeFile(`${dest}/${viewerPage}`, viewerSources["viewer.html"]
    .replace('href="viewer.css"', `href="viewer.${revision}.css"`)
    .replace('src="viewer.js"', `src="viewer.${revision}.js"`));
  await writeFile(`${dest}/viewer.${revision}.js`, viewerSources["viewer.js"]);
  await writeFile(`${dest}/viewer.${revision}.css`, viewerSources["viewer.css"]);
  for (const file of ["build/pdf.mjs", "build/pdf.worker.mjs", "web/pdf_viewer.mjs", "web/pdf_viewer.css", "web/images", "cmaps", "standard_fonts", "wasm", "iccs", "LICENSE"]) {
    const source = file.endsWith(".mjs") ? `legacy/${file}` : file;
    await cp(`node_modules/pdfjs-dist/${source}`, `${dest}/vendor/${file}`, { recursive: true });
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
