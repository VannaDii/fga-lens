import { expect, type APIRequestContext, type Page, type Route } from "@playwright/test";
import { transformer } from "@openfga/syntax-transformer";
import { stringify } from "yaml";

import type { Draft, Tuple, WorkspaceView } from "@/lib/workbench-contract";
import { postToEngine } from "./workbench-fixtures";

const appOrigin = "http://127.0.0.1:" + (process.env.FGA_TEST_APP_PORT ?? "35490");
const engineProxy = "http://127.0.0.1:" + (process.env.FGA_TEST_PROXY_PORT ?? "35492");

export type FixtureTarget = { store: string; path: string; revision: string };
export const routeGrant = { user: "user:maya", relation: "viewer", object: "document:example" };
export const companionGrant = { user: "user:casey", relation: "editor", object: "document:example" };
export const baseDsl = [
  "model", "  schema 1.1", "", "type user", "", "type document", "  relations",
  "    define viewer: [user]", "    define editor: [user]", "    define access: viewer or editor",
].join("\n");

/** Resolve an app API action at the same origin used by the browser. */
export function appRequest(request: APIRequestContext, data: object) {
  return request.post("/api/workbench", { data, headers: { origin: appOrigin } });
}

/** Parse a successful app response and expose safe failure text in the test log. */
export async function appCommand<T = WorkspaceView>(request: APIRequestContext, data: object): Promise<T> {
  const response = await appRequest(request, data);
  expect(response.ok(), "workbench response " + response.status() + " " + await response.text()).toBe(true);
  return response.json();
}

/** Read the durable state over the supported local workspace API. */
export async function workspace(request: APIRequestContext): Promise<WorkspaceView> {
  const response = await request.get("/api/workbench");
  expect(response.ok()).toBe(true);
  return response.json();
}

/** Install fixture preconditions through the same save boundary used by a browser. */
export async function setDraft(request: APIRequestContext, target: FixtureTarget, input: Partial<Draft>,
  { resetSelections = false, ...preference }: { resetSelections?: boolean; autoSave?: boolean; autoPublish?: boolean } = {}) {
  const { state, endpoint } = await workspace(request);
  const key = endpoint + "/" + target.store;
  const prior = state.drafts[key] ?? {
    dsl: baseDsl, validDsl: baseDsl, yaml: "[]\n", baseline: [], inventory: [], conflicts: [],
  };
  const draft: Draft = { ...prior, ...input };
  return appCommand(request, { action: "save", state: {
    ...state, ...preference, store: target.store, model: target.revision,
    selections: { ...(resetSelections ? {} : state.selections), ["primary-store/" + endpoint]: target.store },
    drafts: { ...state.drafts, [key]: { ...draft, modelSelection: target.revision } },
  } });
}

/** Construct a stock store and use the provider's DSL transformer before installing. */
export async function policyFixture(request: APIRequestContext, name: string, dsl = baseDsl, tuples: Tuple[] = []) {
  const store: { id: string } = await postToEngine(request, "/stores", { name });
  const path = "/stores/" + store.id;
  const content = transformer.transformDSLToJSONObject(dsl);
  const installed: { authorization_model_id: string } = await postToEngine(request, path + "/authorization-models", content);
  const target = { store: store.id, path, revision: installed.authorization_model_id };
  if (tuples.length) await writeEngine(request, target, { writes: { tuple_keys: tuples } });
  return target;
}

/** Write the independent fixture and avoid reusing app-side publication logic. */
export function writeEngine(request: APIRequestContext, target: FixtureTarget, change: object) {
  return postToEngine(request, target.path + "/write", { authorization_model_id: target.revision, ...change });
}

/** Check the actual authorization state using the pinned REST wire shape. */
export async function engineAllows(request: APIRequestContext, target: FixtureTarget, tuple: Tuple) {
  const reply = await postToEngine(request, target.path + "/check", {
    authorization_model_id: target.revision, tuple_key: tuple, consistency: "HIGHER_CONSISTENCY",
  });
  return reply.allowed;
}

/** Select the explicit target in the actual browser, including the installed model. */
export async function openTarget(page: Page, target: FixtureTarget, screen: "instances" | "model" | "queries") {
  await page.goto("/" + screen);
  const store = page.getByRole("combobox", { name: "Store", exact: true });
  await expect(store.locator("option[value='" + target.store + "']")).toHaveCount(1);
  if (await store.inputValue() !== target.store) await store.selectOption(target.store);
  const revision = page.getByRole("combobox", { name: "Model revision", exact: true });
  await expect(revision.locator('option[value="' + target.revision + '"]')).toHaveCount(1);
  if (await revision.inputValue() !== target.revision) await revision.selectOption(target.revision);
}

/** Set comparison mode through the Query disclosure. */
export async function setCompare(page: Page, open: boolean) {
  const toggle = page.locator("summary").filter({ hasText: /^Compare$/ });
  await expect(toggle).toBeVisible();
  if ((await toggle.locator("..").getAttribute("open") !== null) !== open) await toggle.click();
  const alternate = page.getByRole("combobox", { name: "Alternate store", exact: true });
  if (open) await expect(alternate).toBeVisible();
  else await expect(alternate).toBeHidden();
}

/** Wait for the fetch's own completed status so subsequent edits see its baseline. */
export async function fetchInstances(page: Page) {
  const finished = page.getByRole("button", { name: "Fetch store tuples", exact: true });
  await finished.click();
  await expect(finished).toBeEnabled();
}

/** Read the draft bound to the actual configured target. */
export function boundDraft(view: WorkspaceView, target: FixtureTarget) {
  return view.state.drafts[view.endpoint + "/" + target.store];
}

/** Generate an authored native sequence, preserving full condition data. */
export function toYaml(tuples: Tuple[]) {
  return stringify(tuples);
}

/** Pause a single app request or its real response to reproduce races without sleeps. */
export function holdAction(page: Page, action: string, delivery: "before dispatch" | "after checkpoint",
  matches: (payload: Record<string, unknown>) => boolean = () => true) {
  let observed!: () => void;
  let permit!: () => void;
  let armed = true;
  const arrived = new Promise<void>((resolve) => { observed = resolve; });
  const released = new Promise<void>((resolve) => { permit = resolve; });
  const url = "**/api/workbench";
  const handler = async (route: Route) => {
    const request = route.request();
    const payload = request.method() === "POST" ? request.postDataJSON() : {};
    if (!armed || payload.action !== action || !matches(payload)) return route.fallback();
    armed = false;
    if (delivery === "after checkpoint") {
      const response = await route.fetch();
      observed();
      await released;
      return route.fulfill({ response });
    }
    observed();
    await released;
    return route.fallback();
  };
  const ready = page.route(url, handler);
  return { ready, arrived, release: permit };
}

/** Observe and release named reply barriers in the test-only proxy. */
export async function gateState(request: APIRequestContext, release?: string): Promise<string[]> {
  const url = engineProxy + "/__fga_test__/gates";
  const result = release ? await request.post(url, { data: { id: release } }) : await request.get(url);
  expect(result.ok()).toBe(true);
  return result.json();
}

/** Isolate result evidence from form options that contain the same identifier. */
export function evidencePanel(page: Page) {
  return page.locator("details[open]").filter({ has: page.getByText("Evidence", { exact: true }) });
}
