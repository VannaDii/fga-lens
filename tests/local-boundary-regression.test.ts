import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

const local = "http://127.0.0.1:35490";
const damaged = new Uint8Array([123, 34, 116, 102, 53, 45, 114, 101, 99, 111, 118, 101, 114, 121, 34, 58, 255]);

let directory: string;
let getWorkspace: (request: Request) => Promise<Response>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fga-read-policy-"));
  await writeFile(join(directory, "workspace.json"), damaged);
  vi.stubEnv("FGA_WORKSPACE_DIR", directory);
  vi.resetModules();
  ({ GET: getWorkspace } = await import("@/app/api/workbench/route"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

/** Drive the real request handler with a disposable file workspace. */
function workspaceRequest(suffix = "", host = "127.0.0.1:35490") {
  return getWorkspace(new Request(local + "/api/workbench" + suffix, { headers: { host } }));
}

test("F02 refuses workspace state for an unrecognized host", async () => {
  const response = await workspaceRequest("", "workspace.example.invalid");
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(await response.text()).not.toContain('"drafts"');
});

test("F02 refuses recovery bytes for an unrecognized host", async () => {
  const response = await workspaceRequest("?recovery", "workspace.example.invalid");
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.headers.get("content-disposition")).toBeNull();
  expect(new Uint8Array(await response.arrayBuffer())).not.toEqual(damaged);
});

test("F02 local control loads the workspace and detects the damaged original", async () => {
  const response = await workspaceRequest();
  expect(response.ok).toBe(true);
  expect(await response.json()).toMatchObject({ recovery: true, state: { drafts: {} } });
});

test("F02 local recovery returns exact bytes with a private no-store attachment", async () => {
  const response = await workspaceRequest("?recovery");
  expect(response.ok).toBe(true);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(damaged);
  expect(response.headers.get("content-disposition")).toMatch(/attachment/i);
  expect(response.headers.get("cache-control")?.split(",").map((part) => part.trim())).toEqual(
    expect.arrayContaining(["private", "no-store"]),
  );
});
