import { test, expect, chromium, firefox } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { makePDF } from "../pdf-fixture.mjs";

const origin = "https://learn.inside.dtu.dk";
const topicURL = `${origin}/d2l/le/lessons/326354/topics/1260091`;
const lessonPath = "/d2l/ui/apps/smart-curriculum/3.32.20/index.html";
const pdf = makePDF();
let context;
let profile;
let remote;

test.beforeAll(async ({}, info) => {
  profile = await mkdtemp(path.join(tmpdir(), "dtu-pdf-test-"));
  const extensionPath = path.resolve(`dist/${info.project.name}`);
  if (info.project.name === "chrome") {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium", headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
  } else {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    context = await firefox.launchPersistentContext(profile, {
      headless: true, args: ["-start-debugger-server", String(port)],
      firefoxUserPrefs: {
        "devtools.debugger.remote-enabled": true,
        "devtools.debugger.prompt-connection": false,
        "devtools.chrome.enabled": true,
        "extensions.autoDisableScopes": 0
      }
    });
    // Use Mozilla's installer against the actual Firefox extension runtime.
    const { connectWithMaxRetries } = await import(new URL("../../node_modules/web-ext/lib/firefox/remote.js", import.meta.url));
    remote = await connectWithMaxRetries({ port, maxRetries: 20, retryInterval: 100 });
    await remote.installTemporaryAddon(extensionPath);
  }
  await context.addCookies([{ name: "test-session", value: "signed-in", domain: "learn.inside.dtu.dk", path: "/", secure: true, sameSite: "Lax" }]);
});

test.afterAll(async () => {
  remote?.disconnect();
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

async function openFixture({ failed = false, fallback = false, nested = false, trustedTypes = false, nativeLifecycle = false, padded = false } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  // No requests reach DTU: both the portal and its session-protected PDFs are fixtures.
  await page.route(`${origin}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith("/content/enforced/") || url.pathname.includes("/file")) {
      expect(route.request().headers().cookie).toContain("test-session=signed-in");
      if (failed || (fallback && url.pathname.startsWith("/content/enforced/"))) {
        return route.fulfill({ status: failed ? 403 : 200, contentType: "text/html", body: "Sign in" });
      }
      return route.fulfill({ contentType: "application/pdf", body: url.pathname.includes("second") ? makePDF(5, "Replacement document") : pdf });
    }
    const content = `<div class="content-panel" id="d2l_content_326354_1260091" data-attr-activity-type="file">
      <h1>Lecture 1</h1><d2l-pdf-viewer src="/content/enforced/326354-course/lecture.pdf" style="display:block;height:600px">Original Brightspace viewer</d2l-pdf-viewer></div>`;
    // Model a renderer that measures its host once after asynchronously loading
    // its document. Unhiding it later cannot repair a zero-sized initial canvas.
    const nativeScript = nativeLifecycle ? `<script>
      customElements.define('d2l-pdf-viewer', class extends HTMLElement {
        connectedCallback() {
          setTimeout(() => {
            const canvas = document.createElement('canvas');
            canvas.width = this.getBoundingClientRect().width;
            canvas.height = this.getBoundingClientRect().height;
            this.attachShadow({mode:'open'}).append(canvas);
            if (canvas.width && canvas.height) {
              canvas.getContext('2d').fillText('Original PDF rendered', 20, 30);
            }
            this.dataset.painted = String(canvas.width > 0 && canvas.height > 0);
          }, 300);
        }
      });
    </script>` : '';
    return route.fulfill({ contentType: "text/html",
      headers: trustedTypes ? { "Content-Security-Policy": "require-trusted-types-for 'script'" } : {},
      body: `<!doctype html><html><body${padded ? ' style="padding-bottom:24px"' : ''}>${nested && url.pathname !== lessonPath ? `<h1>Course page</h1><iframe title="Lesson" src="${lessonPath}" style="width:100%;height:900px"></iframe>` : content + nativeScript}</body></html>` });
  });
  await page.goto(topicURL);
  return { page, errors };
}

function viewer(page) {
  return page.frameLocator(".dtu-pdf-search iframe");
}

test("page padding creates no outer overflow and outer scrolling cannot grow the viewer", async () => {
  const { page, errors } = await openFixture({ padded: true });
  await expect(viewer(page).locator('#pageCount')).toHaveText('/ 40');
  await expect.poll(() => page.evaluate(() => document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight)).toBeLessThanOrEqual(1);
  const frame = page.locator('.dtu-pdf-search iframe');
  const initial = await frame.boundingBox();
  // Actual content below the PDF must stay reachable; don't solve overflow by
  // disabling the portal's scrolling or by stretching the PDF during scrolling.
  await page.evaluate(() => {
    const footer = document.createElement('div');
    footer.style.height = '80px';
    footer.textContent = 'Other lesson content';
    document.body.append(footer);
    window.scrollTo(0, 30);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect((await frame.boundingBox()).height).toBeCloseTo(initial.height, 2);
  expect(errors).toEqual([]);
  await page.close();
});

test("Ctrl+F finds and highlights page 40 without visiting it; supports navigation and zoom", async ({}, info) => {
  const { page, errors } = await openFixture();
  const pdfFrame = viewer(page);
  await expect(pdfFrame.locator("#pageCount")).toHaveText("/ 40");
  await expect(pdfFrame.locator("#toolbar")).toHaveCSS("display", "flex");
  await expect(pdfFrame.locator("#toolbar")).toHaveCSS("height", "36px");
  await expect(pdfFrame.locator('#findToggle svg')).toHaveCSS('width', '16px');
  await expect(pdfFrame.locator("#pageNumber")).toHaveValue("1");
  await expect(pdfFrame.locator('.page[data-page-number="40"] canvas')).toHaveCount(0);
  await page.locator("h1").click();
  await page.keyboard.press("Control+f");
  await expect(pdfFrame.getByRole("searchbox")).toBeFocused();
  await pdfFrame.getByRole("searchbox").fill("Distant quasar needle");
  await expect(pdfFrame.locator("#findStatus")).toHaveText("1 / 1");
  await expect(pdfFrame.locator("#pageNumber")).toHaveValue("40");
  await expect(pdfFrame.locator('.page[data-page-number="40"] .highlight.selected')).toContainText("Distant quasar needle");
  await pdfFrame.getByRole("searchbox").press("Control+f");
  await expect(pdfFrame.locator("#findbar")).toBeHidden();
  await expect(pdfFrame.locator("#viewerContainer")).toBeFocused();
  await page.keyboard.press("Control+f");
  await expect(pdfFrame.getByRole("searchbox")).toBeFocused();
  await expect(pdfFrame.getByRole("searchbox")).toHaveValue("Distant quasar needle");
  await expect(pdfFrame.locator("#toolbar")).toHaveCSS("height", "36px");
  await page.screenshot({ path: info.outputPath("compact-toolbar.png") });
  await pdfFrame.getByRole("searchbox").fill("Lecture notes");
  await expect(pdfFrame.locator("#findStatus")).toHaveText("1 / 39");
  await pdfFrame.getByRole("button", { name: "Next match", exact: true }).click();
  await expect(pdfFrame.locator("#findStatus")).toHaveText("2 / 39");
  await pdfFrame.getByRole("searchbox").press("Shift+Enter");
  await expect(pdfFrame.locator("#findStatus")).toHaveText("1 / 39");
  await pdfFrame.getByRole("searchbox").fill("nonexistent phrase");
  await expect(pdfFrame.locator("#findStatus")).toContainText("No matches");
  await pdfFrame.getByRole("searchbox").press("Escape");
  await expect(pdfFrame.locator("#findbar")).toBeHidden();
  await pdfFrame.getByRole("combobox", { name: "Zoom", exact: true }).selectOption("1.5");
  await expect(pdfFrame.locator("#scale")).toHaveValue("1.5");
  await pdfFrame.getByLabel("PDF options", { exact: true }).click();
  await pdfFrame.getByRole("button", { name: "Use original viewer", exact: true }).click();
  await expect(page.locator("d2l-pdf-viewer")).toBeVisible();
  await page.getByLabel("PDF options", { exact: true }).click();
  await page.getByRole("button", { name: "Use searchable viewer", exact: true }).click();
  await expect(pdfFrame.locator("#viewerContainer")).toBeVisible();
  expect(errors).toEqual([]);
  await page.close();
});

test("falls back to the verified API when the direct URL returns HTML", async () => {
  const { page, errors } = await openFixture({ fallback: true });
  await expect(viewer(page).locator("#pageCount")).toHaveText("/ 40");
  await viewer(page).getByLabel("PDF options", { exact: true }).click();
  await expect(viewer(page).getByRole("link", { name: "Open PDF in new tab" })).toHaveAttribute("href", `${origin}/d2l/api/le/1.38/326354/content/topics/1260091/file?stream=true`);
  expect(errors).toEqual([]);
  await page.close();
});

test("loads a new document after a source change", async () => {
  const { page, errors } = await openFixture();
  await expect(viewer(page).locator("#pageCount")).toHaveText("/ 40");
  await page.locator("d2l-pdf-viewer").evaluate(el => el.setAttribute("src", "/content/enforced/326354-course/second.pdf"));
  await expect(viewer(page).locator("#pageCount")).toHaveText("/ 5");
  await expect(page.locator(".dtu-pdf-search")).toHaveCount(1);
  expect(errors).toEqual([]);
  await page.close();
});

test("restores the original viewer after a failed authenticated request", async () => {
  const { page } = await openFixture({ failed: true });
  await expect(page.getByRole("status")).toContainText("HTTP 403");
  await expect(page.locator("d2l-pdf-viewer")).toBeVisible();
  await page.getByLabel("PDF options", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry searchable viewer" })).toBeVisible();
  await page.close();
});

test("routes Ctrl+F from the outer course page into a nested lesson frame", async () => {
  const { page, errors } = await openFixture({ nested: true });
  const lesson = page.frameLocator('iframe[title="Lesson"]');
  const pdfFrame = lesson.frameLocator(".dtu-pdf-search iframe");
  await expect(pdfFrame.locator("#pageCount")).toHaveText("/ 40");
  // The lesson frame is 900px tall: sizing must use the outer browser's visible
  // bottom, not the nested frame's full height or a fixed viewport percentage.
  for (const height of [720, 900, 600]) {
    await page.setViewportSize({ width: 1280, height });
    await expect.poll(async () => {
      const box = await lesson.locator('.dtu-pdf-search iframe').boundingBox();
      const bottom = await page.evaluate(() => visualViewport.offsetTop + visualViewport.height);
      // Leave room for the lesson document's default 8px body bottom margin.
      return Math.abs(box.y + box.height + 8 - bottom);
    }).toBeLessThanOrEqual(1);
  }
  await page.getByRole("heading", { name: "Course page" }).click();
  await page.keyboard.press("Control+f");
  await expect(pdfFrame.getByRole("searchbox")).toBeFocused();
  await page.getByRole("heading", { name: "Course page" }).click();
  await page.keyboard.press("Control+f");
  await expect(pdfFrame.locator("#findbar")).toBeHidden();
  await page.getByRole("heading", { name: "Course page" }).click();
  await page.keyboard.press("Control+f");
  await expect(pdfFrame.getByRole("searchbox")).toBeFocused();
  await pdfFrame.getByRole("searchbox").fill("Distant quasar needle");
  await expect(pdfFrame.locator("#pageNumber")).toHaveValue("40");
  expect(errors).toEqual([]);
  await page.close();
});

test("finds a viewer inside a late-attached shadow root and cleans up removed topics", async () => {
  const { page, errors } = await openFixture();
  await expect(viewer(page).locator("#pageCount")).toHaveText("/ 40");
  await page.evaluate(() => {
    document.querySelector(".content-panel").remove();
    document.body.append(document.createElement("lesson-shell"));
  });
  await expect(page.locator(".dtu-pdf-search")).toHaveCount(0);
  await page.evaluate(() => {
    const shadow = document.querySelector("lesson-shell").attachShadow({ mode: "open" });
    shadow.innerHTML = '<d2l-pdf-viewer src="/content/enforced/326354-course/second.pdf">Original</d2l-pdf-viewer>';
  });
  await expect(viewer(page).locator("#pageCount")).toHaveText("/ 5");
  await page.locator("lesson-shell").evaluate(el => el.remove());
  // With no PDF present, the extension must leave browser Find alone.
  await expect.poll(() => page.evaluate(() => !window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true })))).toBe(false);
  expect(errors).toEqual([]);
  await page.close();
});

test("loads inside the smart-curriculum frame when the portal enforces Trusted Types", async () => {
  const { page, errors } = await openFixture({ nested: true, trustedTypes: true });
  const pdfFrame = page.frameLocator('iframe[title="Lesson"]').frameLocator(".dtu-pdf-search iframe");
  await expect(pdfFrame.locator("#pageCount")).toHaveText("/ 40");
  expect(errors).toEqual([]);
  await page.close();
});

test("original viewer initializes at its real size after switching back, including repeated switches", async () => {
  const { page, errors } = await openFixture({ nested: true, nativeLifecycle: true });
  const lesson = page.frameLocator('iframe[title="Lesson"]');
  const native = lesson.locator('d2l-pdf-viewer');
  const pdfFrame = lesson.frameLocator('.dtu-pdf-search iframe');
  await expect(pdfFrame.locator('#pageCount')).toHaveText('/ 40');
  await expect(native).toHaveAttribute('data-painted', 'false');
  for (let i = 0; i < 2; i++) {
    await pdfFrame.getByLabel('PDF options', { exact: true }).click();
    await pdfFrame.getByRole('button', { name: 'Use original viewer', exact: true }).click();
    await expect(native).toHaveAttribute('data-painted', 'true');
    await expect(native.locator('canvas')).toBeVisible();
    await expect(lesson.getByRole('status')).toHaveText('Brightspace original viewer');
    await lesson.getByLabel('PDF options', { exact: true }).click();
    await lesson.getByRole('button', { name: 'Use searchable viewer', exact: true }).click();
    await expect(pdfFrame.locator('#pageCount')).toHaveText('/ 40');
    await pdfFrame.getByRole('button', { name: 'Find in PDF', exact: true }).click();
    await pdfFrame.getByRole('searchbox').fill('Distant quasar needle');
    await expect(pdfFrame.locator('#findStatus')).toHaveText('1 / 1');
  }
  expect(errors).toEqual([]);
  await page.close();
});
