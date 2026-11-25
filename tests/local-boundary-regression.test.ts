import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Workspace, WorkspaceView } from "@/lib/workbench-contract";

const local = "http://127.0.0.1:35490";
const damaged = new Uint8Array([123, 34, 116, 102, 53, 45, 114, 101, 99, 111, 118, 101, 114, 121, 34, 58, 255]);

let directory: string;
let getWorkspace: (request: Request) => Promise<Response>;
let postWorkspace: (request: Request) => Promise<Response>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fga-read-policy-"));
  await writeFile(join(directory, "workspace.json"), damaged);
  vi.stubEnv("FGA_WORKSPACE_DIR", directory);
  vi.resetModules();
  ({ GET: getWorkspace, POST: postWorkspace } = await import("@/app/api/workbench/route"));
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

const unicodeDraft = "# café and a literal replacement character �\n[]\n";

/** Build a valid persisted shape with a distinguishable multibyte sequence. */
async function unicodeWorkspace() {
  const { state, endpoint }: WorkspaceView = await (await workspaceRequest()).json();
  return { ...state, revision: 1, drafts: { [endpoint + "/"]: {
    dsl: "", validDsl: "", yaml: unicodeDraft, inventory: [], baseline: [], conflicts: [],
  } } } satisfies Workspace;
}

test("restores Explore from a workspace saved on the previous route", async () => {
  const state = await unicodeWorkspace();
  await writeFile(join(directory, "workspace.json"), JSON.stringify({ ...state, route: "access-review" }));

  const view: WorkspaceView = await (await workspaceRequest()).json();
  expect(view).toMatchObject({ recovery: false, state: { ...state, route: "explore" } });
});

/** Use an ordinary same-origin Save after the workspace is loaded. */
function saveWorkspace(state: Workspace) {
  return postWorkspace(new Request(local + "/api/workbench", {
    method: "POST", headers: { origin: local, "content-type": "application/json" },
    body: JSON.stringify({ action: "save", state: { ...state, route: "instances" } }),
  }));
}

test("C3 malformed UTF-8 in otherwise valid workspace JSON downloads exactly and survives a recovery Save", async () => {
  const state = await unicodeWorkspace();
  const valid = Buffer.from(JSON.stringify(state));
  const literal = Buffer.from("�");
  const damagedAt = valid.indexOf(literal);
  expect(damagedAt).toBeGreaterThan(0);
  const bytes = Buffer.concat([valid.subarray(0, damagedAt), Buffer.from([0xff]), valid.subarray(damagedAt + literal.length)]);
  expect(JSON.parse(bytes.toString("utf8"))).toEqual(state);
  const path = join(directory, "workspace.json");
  await writeFile(path, bytes);

  const view: WorkspaceView = await (await workspaceRequest()).json();
  expect.soft(view.recovery).toBe(true);
  expect.soft(view.state.drafts).toEqual({});
  const download = await workspaceRequest("?recovery");
  expect.soft(download.status).toBe(200);
  expect.soft(Buffer.from(await download.arrayBuffer())).toEqual(bytes);

  const saved = await saveWorkspace(view.state);
  expect(saved.status).toBe(200);
  const reopened: WorkspaceView = await (await workspaceRequest()).json();
  expect.soft(reopened).toMatchObject({ recovery: true, state: { route: "instances", revision: view.state.revision + 1 } });
  expect.soft(await readFile(path)).toEqual(bytes);
  await expect(readFile(join(directory, "workspace.recovery.json"), "utf8")).resolves.toContain('"route":"instances"');
});

test("C3 valid multibyte text and a literal replacement character load and save without recovery", async () => {
  const state = await unicodeWorkspace();
  const path = join(directory, "workspace.json");
  await writeFile(path, JSON.stringify(state));
  const view: WorkspaceView = await (await workspaceRequest()).json();
  expect(view).toMatchObject({ recovery: false, state });
  expect((await saveWorkspace(view.state)).status).toBe(200);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  expect(persisted).toMatchObject({ revision: 2, route: "instances", drafts: state.drafts });
  const reopened: WorkspaceView = await (await workspaceRequest()).json();
  expect(reopened.recovery).toBe(false);
});
