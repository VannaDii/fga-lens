import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Launch the test Next server on loopback with one explicitly assigned or private workspace.
 * Keep the directory until Next has stopped, including on Playwright teardown and startup failure.
 */
async function run() {
  const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const assigned = process.env.FGA_TEST_WORKSPACE_DIR;
  const owned = assigned ? null : await mkdtemp(join(tmpdir(), "fga-playwright-workspace-"));
  try {
    const child = spawn(process.execPath,
      [next, "dev", "--hostname", "127.0.0.1", "--port", process.env.FGA_TEST_APP_PORT ?? "35490"], {
        env: { ...process.env, FGA_WORKSPACE_DIR: assigned || owned },
        stdio: "inherit",
      });
    /**
     * Forward an interrupt when only the launcher receives it. Next handles its own workers.
     * @param {NodeJS.Signals} signal Stop signal received by the launcher.
     */
    const stop = (signal) => child.kill(signal);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      process.exitCode = await new Promise((resolve) => {
        child.once("error", () => console.error("Could not launch the Playwright Next.js server."));
        child.once("close", (code, signal) => resolve(code ?? (signal ? 128 + constants.signals[signal] : 1)));
      });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } finally {
    if (owned) await rm(owned, { recursive: true, force: true });
  }
}

await run();
