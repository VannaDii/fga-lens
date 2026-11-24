import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

const integration = process.env.FGA_TEST_ENGINE === "1";
const appPort = process.env.FGA_TEST_APP_PORT ?? "35490";
const enginePort = process.env.FGA_TEST_ENGINE_PORT ?? "35491";
const proxyPort = process.env.FGA_TEST_PROXY_PORT ?? "35492";
const grpcPort = process.env.FGA_TEST_GRPC_PORT ?? "35493";
const appUrl = "http://127.0.0.1:" + appPort;
const upstreamUrl = "http://127.0.0.1:" + proxyPort;

/** Browser coverage uses installed Chrome and disposable loopback services and workspaces. */
export default defineConfig({
  testDir: "tests",
  testMatch: integration ? "**/*.engine.pw.ts" : "**/*.chrome.pw.ts",
  forbidOnly: true,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: process.env.FGA_TEST_ARTIFACTS ?? join(tmpdir(), "fga-lens-playwright-" + process.pid),
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    baseURL: appUrl,
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    ...(integration
      ? [
          {
            command: "node tests/openfga-harness.mjs",
            env: {
              FGA_TEST_ENGINE_PORT: enginePort,
              FGA_TEST_PROXY_PORT: proxyPort,
              FGA_TEST_GRPC_PORT: grpcPort,
            },
            url: upstreamUrl + "/healthz",
            timeout: 15_000,
            gracefulShutdown: { signal: "SIGTERM" as const, timeout: 4000 },
            stdout: "pipe" as const,
          },
        ]
      : []),
    {
      command: "node scripts/playwright-next.mjs",
      env: {
        FGA_TEST_APP_PORT: appPort,
        NEXT_TELEMETRY_DISABLED: "1",
        OPENFGA_API_URL: upstreamUrl,
        OPENFGA_PRESHARED_KEY: "",
      },
      url: appUrl,
      timeout: 45_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 4000 },
      stdout: "pipe",
    },
  ],
});
