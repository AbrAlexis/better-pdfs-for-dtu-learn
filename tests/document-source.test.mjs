import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedDocumentURL, documentSources, fetchPDF, isPDF } from "../src/document-source.js";
import { makePDF } from "./pdf-fixture.mjs";

const origin = "https://learn.inside.dtu.dk";
const api = `${origin}/d2l/api/le/1.38/326354/content/topics/1260091/file?stream=true`;
const location = `${origin}/d2l/le/lessons/326354/topics/1260091`;

test("uses the screenshot's original file and verified API as fallback", () => {
  assert.deepEqual(documentSources("/content/enforced/326354-course/Lecture%201.pdf", "d2l_content_326354_1260091", location), [
    `${origin}/content/enforced/326354-course/Lecture%201.pdf`, api
  ]);
  assert.deepEqual(documentSources(null, null, location), [api]);
});

test("rejects other hosts, non-document endpoints, credentials and traversal", () => {
  for (const url of ["https://evil.example/content/enforced/a.pdf", "//evil.example/a.pdf", "javascript:alert(1)", `${origin}/d2l/api/users`, `${origin}/content/enforced/../../account`, "https://user:pass@learn.inside.dtu.dk/content/enforced/a.pdf"]) {
    assert.equal(allowedDocumentURL(url), null);
  }
});

test("falls back after a login HTML response, keeping session credentials", async () => {
  const requests = [];
  const result = await fetchPDF([`${origin}/content/enforced/a.pdf`, api], new AbortController().signal, async (url, options) => {
    requests.push(url);
    assert.equal(options.credentials, "include");
    assert.equal(options.redirect, "error");
    return new Response(requests.length === 1 ? "<html>Sign in</html>" : makePDF());
  });
  assert.equal(result.url, api);
  assert.equal(requests.length, 2);
  assert.ok(isPDF(result.data));
});

test("a removed topic cancels loading without fetching the next candidate", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(fetchPDF([`${origin}/content/enforced/a.pdf`, api], controller.signal, async () => {
    calls++;
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("does not accept an HTTP error body as a successful PDF", async () => {
  await assert.rejects(fetchPDF([api], new AbortController().signal, async () => new Response("Denied", { status: 403 })), /403/);
});
