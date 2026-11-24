import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, test, vi } from "vitest";

let launcher: ChildProcess | undefined;
let workspace: string;
let app: string;
let engine: string;
let exited: Promise<void> | undefined;

/** Allocate fresh test-only loopback addresses for the actual managed supervisor. */
async function port() {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  if (!address || typeof address === "string") throw new Error("A numeric loopback port is required");
  await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return String(address.port);
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "fga-managed-policy-"));
  const appPort = await port();
  const httpPort = await port();
  const grpcPort = await port();
  app = "http://127.0.0.1:" + appPort;
  engine = "http://127.0.0.1:" + httpPort;
  launcher = spawn(process.execPath, ["scripts/managed.mjs"], {
    detached: true,
    stdio: "inherit",
    env: { ...process.env, PORT: appPort, FGA_WORKSPACE_DIR: workspace, OPENFGA_PRESHARED_KEY: "",
      OPENFGA_MANAGED_HTTP_PORT: httpPort, OPENFGA_MANAGED_GRPC_PORT: grpcPort, NEXT_TELEMETRY_DISABLED: "1" },
  });
  exited = new Promise((resolve) => {
    launcher!.once("error", () => resolve());
    launcher!.once("exit", () => resolve());
  });
  await vi.waitFor(async () => {
    const response = await fetch(app + "/api/workbench", { signal: AbortSignal.timeout(2000) });
    expect(response.ok).toBe(true);
  }, { timeout: 25_000, interval: 200 });
}, 29_000);

afterAll(async () => {
  if (launcher?.pid && launcher.exitCode === null) process.kill(-launcher.pid, "SIGTERM");
  await exited;
  if (workspace) await rm(workspace, { recursive: true, force: true });
}, 10_000);

/** Use the normal local, same-origin workbench command path. */
async function command(input: object) {
  const response = await fetch(app + "/api/workbench", {
    method: "POST", headers: { origin: app, "content-type": "application/json" },
    body: JSON.stringify(input), signal: AbortSignal.timeout(8000),
  });
  expect(response.ok, "workbench command returned " + response.status).toBe(true);
  return response.json();
}

test("F01 managed store access requires a server-only credential", async () => {
  const response = await fetch(engine + "/stores");
  expect([401, 403]).toContain(response.status);
});

test("F01 managed HTTP does not authorize unrelated browser origins", async () => {
  const origin = "https://unrelated.example.invalid";
  const response = await fetch(engine + "/stores", { method: "OPTIONS", headers: {
    origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization",
  } });
  const allowed = response.headers.get("access-control-allow-origin");
  expect(allowed).not.toBe("*");
  expect(allowed).not.toBe(origin);
});

test("F01 same-origin workbench creates and publishes to the actual managed engine", async () => {
  const dsl = "model\n  schema 1.1\n\ntype user\n\ntype document\n  relations\n    define viewer: [user]\n";
  const created = await command({ action: "create", name: "Managed synthetic fixture" });
  const before = await (await fetch(app + "/api/workbench")).json();
  const saved = await command({ action: "save", state: {
    ...before.state, store: created.id, drafts: { ...before.state.drafts,
      [before.endpoint + "/" + created.id]: { dsl, validDsl: dsl, yaml: "[]\n", inventory: [], baseline: [], conflicts: [] },
    },
  } });
  const receipt = await command({ action: "publish-model", store: created.id, revision: saved.state.revision });
  const published = receipt.state.drafts[before.endpoint + "/" + created.id].published;
  expect(published).toMatch(/^[A-Z0-9]{26}$/);
  const installed = await command({ action: "models", store: created.id });
  expect(installed.authorization_models).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: published, type_definitions: expect.arrayContaining([expect.objectContaining({ type: "document" })]) }),
  ]));
});
