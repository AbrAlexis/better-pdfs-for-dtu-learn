import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 45_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: "list",
  projects: [{ name: "chrome" }, { name: "firefox" }],
  use: { screenshot: "only-on-failure" }
});
