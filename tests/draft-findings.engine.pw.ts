import { readFile } from "node:fs/promises";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { transformer } from "@openfga/syntax-transformer";

import {
  baseDsl, boundDraft, companionGrant, engineAllows, fetchInstances, holdAction, openTarget, policyFixture,
  routeGrant, setDraft, toYaml, workspace, writeEngine,
} from "./finding-helpers";
import { capturedRequests, clearTraffic, postToEngine } from "./workbench-fixtures";

/** Await the editor's operation feedback after a save or publication reaches a terminal state. */
function editorFeedback(page: Page) {
  return page.getByRole("status").filter({ hasText: /saved|tuple changes published|publish tuples/i });
}

/** Check the real auto-save/auto-publish boundary with a populated engine record. */
async function invalidAutoPublication(page: Page, request: APIRequestContext, name: string, authored: string) {
  const target = await policyFixture(request, name, baseDsl, [routeGrant]);
  await setDraft(request, target, { yaml: toYaml([routeGrant]), baseline: [routeGrant] }, { autoSave: true, autoPublish: true });
  await openTarget(page, target, "instances");
  const editor = page.getByRole("textbox", { name: "Tuple YAML" });
  await expect(editor).toHaveValue(toYaml([routeGrant]));
  await clearTraffic(request);
  await editor.fill(authored);
  await expect(editorFeedback(page).first()).toBeVisible();
  expect.soft(boundDraft(await workspace(request), target).yaml).toBe(authored);
  expect.soft(await capturedRequests(request, target.path + "/write")).toEqual([]);
  expect.soft(await engineAllows(request, target, routeGrant)).toBe(true);
  expect(await engineAllows(request, target, companionGrant)).toBe(false);
}

test("F03 blank auto-saved tuple YAML preserves the actual stored grant", async ({ page, request }) => {
  await invalidAutoPublication(page, request, "Blank tuple draft", "");
});

test("F03 YAML null does not turn a saved draft into bulk removal", async ({ page, request }) => {
  await invalidAutoPublication(page, request, "Null tuple draft", "null\n");
});

test("F03 misspelled tuple condition does not become an unconditional stored grant", async ({ page, request }) => {
  const typo = toYaml([routeGrant, companionGrant]).trimEnd() + "\n  conditon:\n    name: region_guard\n";
  await invalidAutoPublication(page, request, "Misspelled tuple condition", typo);
});

test("F03 explicit YAML empty sequence removes the fetched grant", async ({ page, request }) => {
  const target = await policyFixture(request, "Authored tuple deletion", baseDsl, [routeGrant]);
  await setDraft(request, target, { yaml: toYaml([routeGrant]), baseline: [routeGrant] }, { autoSave: true, autoPublish: true });
  await openTarget(page, target, "instances");
  const editor = page.getByRole("textbox", { name: "Tuple YAML" });
  await expect(editor).toHaveValue(toYaml([routeGrant]));
  await clearTraffic(request);
  await editor.fill("[]\n");
  await expect(page.getByText("Tuple changes published", { exact: true })).toBeVisible();
  expect(await capturedRequests(request, target.path + "/write")).toEqual([{
    authorization_model_id: target.revision, deletes: { tuple_keys: [routeGrant] },
  }]);
  expect(await engineAllows(request, target, routeGrant)).toBe(false);
});

test("F04 manual-save workspace fetch keeps an unsaved addition in the editor only", async ({ page, request }) => {
  const target = await policyFixture(request, "Manual fetch boundary", baseDsl, [routeGrant]);
  const saved = toYaml([routeGrant]);
  await setDraft(request, target, { yaml: saved, baseline: [routeGrant] }, { autoSave: false, autoPublish: false });
  await openTarget(page, target, "instances");
  const editor = page.getByRole("textbox", { name: "Tuple YAML" });
  await expect(editor).toHaveValue(saved);
  await editor.fill(toYaml([routeGrant, companionGrant]));
  await fetchInstances(page);
  await expect(editor).toHaveValue(/user:casey/);
  expect(boundDraft(await workspace(request), target).yaml).toBe(saved);
  expect(await engineAllows(request, target, companionGrant)).toBe(false);
});

test("F04 manual conflict resolution does not silently save unrelated editor input", async ({ page, request }) => {
  const target = await policyFixture(request, "Manual resolution boundary", baseDsl, [routeGrant]);
  const saved = toYaml([routeGrant]);
  const identity = JSON.stringify([routeGrant.user, routeGrant.relation, routeGrant.object]);
  await setDraft(request, target, {
    yaml: saved, baseline: [routeGrant], conflicts: [{ key: identity, local: null, server: routeGrant }],
  }, { autoSave: false, autoPublish: false });
  await openTarget(page, target, "instances");
  const editor = page.getByRole("textbox", { name: "Tuple YAML" });
  await expect(editor).toHaveValue(saved);
  await editor.fill(toYaml([companionGrant]));
  await page.getByText("Tuple conflict " + identity, { exact: true }).click();
  await page.getByRole("button", { name: "Use server", exact: true }).click();
  await expect(page.getByText("Tuple conflict " + identity, { exact: true })).toBeHidden();
  await expect(editor).toHaveValue(/user:casey/);
  expect.soft(await editor.inputValue()).toContain("user:maya");
  expect.soft(boundDraft(await workspace(request), target).yaml).toBe(saved);
  expect(await engineAllows(request, target, companionGrant)).toBe(false);
});

test("F04 an equivalent fetch preserves authored tuple comments byte for byte", async ({ page, request }) => {
  const target = await policyFixture(request, "Source fidelity", baseDsl, [routeGrant]);
  const authored = "# review label stays with this rule\n" + toYaml([routeGrant]);
  await setDraft(request, target, { yaml: authored, baseline: [routeGrant] }, { autoSave: true, autoPublish: false });
  await openTarget(page, target, "instances");
  const editor = page.getByRole("textbox", { name: "Tuple YAML" });
  await expect(editor).toHaveValue(authored);
  await fetchInstances(page);
  await expect(editor).toHaveValue(authored);
  expect(boundDraft(await workspace(request), target).yaml).toBe(authored);
});

test("F04 a rejected stale-tab edit remains recoverable after the rejection", async ({ page, context, request }) => {
  const target = await policyFixture(request, "Stale tab recovery", baseDsl, [routeGrant]);
  const saved = toYaml([routeGrant]);
  await setDraft(request, target, { yaml: saved, baseline: [routeGrant] }, { autoSave: false, autoPublish: false });
  await openTarget(page, target, "instances");
  const stale = await context.newPage();
  await openTarget(stale, target, "instances");
  const freshEditor = page.getByRole("textbox", { name: "Tuple YAML" });
  const staleEditor = stale.getByRole("textbox", { name: "Tuple YAML" });
  await expect(freshEditor).toHaveValue(saved);
  await expect(staleEditor).toHaveValue(saved);
  await freshEditor.fill("# first tab saved this\n" + saved);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved to workspace", { exact: true })).toBeVisible();

  const rejected = "# second tab input needs a safe recovery path\n" + toYaml([routeGrant, companionGrant]);
  await staleEditor.fill(rejected);
  await stale.getByRole("button", { name: "Save", exact: true }).click();
  await expect(stale.getByRole("status").filter({ hasText: /conflict|stale/i }).first()).toBeVisible();
  expect(boundDraft(await workspace(request), target).yaml).toContain("first tab saved");
  const download = stale.getByRole("link", { name: /download.*(?:rejected|local|draft)/i })
    .or(stale.getByRole("button", { name: /download.*(?:rejected|local|draft)/i }));
  if (await download.count()) {
    const event = stale.waitForEvent("download");
    await download.first().click();
    const saved = await (await event).path();
    const bytes = await readFile(saved, "utf8");
    expect(bytes.includes(rejected) || bytes.includes(JSON.stringify(rejected).slice(1, -1))).toBe(true);
    return;
  }
  const reconcile = stale.getByRole("button", { name: /recover.*draft|reconcile|retry save/i });
  if (await reconcile.count()) {
    await reconcile.first().click();
    await expect(staleEditor).toHaveValue(rejected);
  } else {
    await stale.reload();
    await expect(staleEditor).toHaveValue(rejected);
  }
});

test("F04 a model receipt arriving after a historical selection preserves the new selection", async ({ page, request }) => {
  const target = await policyFixture(request, "Concurrent model receipt");
  const older: { authorization_model_id: string } = await postToEngine(request, target.path + "/authorization-models",
    transformer.transformDSLToJSONObject(baseDsl + "\n\ntype historical_document\n"));
  await setDraft(request, target, { dsl: baseDsl, validDsl: baseDsl, modelManual: false }, { autoSave: false, autoPublish: false });
  await openTarget(page, target, "model");
  const editor = page.getByRole("textbox", { name: "OpenFGA authorization model" });
  await editor.fill(baseDsl + "\n\ntype refreshed_document\n");
  const publication = holdAction(page, "publish-model", "after checkpoint");
  await publication.ready;
  try {
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await publication.arrived;
    const revision = page.getByRole("combobox", { name: "Model revision", exact: true });
    const selection = page.waitForRequest((request) =>
      request.method() === "POST" && request.url().endsWith("/api/workbench")
      && request.postDataJSON()?.action === "save" && request.postDataJSON()?.state?.model === older.authorization_model_id);
    await revision.selectOption(older.authorization_model_id);
    await selection;
    publication.release();
    await expect(page.getByText("Model published", { exact: true })).toBeVisible();
    await expect(revision).toHaveValue(older.authorization_model_id);
    await expect.poll(async () => (await workspace(request)).state.model).toBe(older.authorization_model_id);
  } finally {
    publication.release();
  }
});

test("F04 an older fetch receipt cannot roll back a subsequently published tuple", async ({ page, request }) => {
  const target = await policyFixture(request, "Concurrent tuple receipt", baseDsl, [routeGrant]);
  const saved = toYaml([routeGrant]);
  await setDraft(request, target, { yaml: saved, baseline: [routeGrant] }, { autoSave: false, autoPublish: false });
  await openTarget(page, target, "instances");
  const editor = page.getByRole("textbox", { name: "Tuple YAML" });
  await expect(editor).toHaveValue(saved);
  const receipt = holdAction(page, "fetch-tuples", "after checkpoint");
  await receipt.ready;
  const fetch = page.getByRole("button", { name: "Fetch store tuples", exact: true });
  try {
    await fetch.click();
    await receipt.arrived;
    await editor.fill(toYaml([routeGrant, companionGrant]));
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page.getByText("Tuple changes published", { exact: true })).toBeVisible();
    expect(await engineAllows(request, target, companionGrant)).toBe(true);
    receipt.release();
    await expect(fetch).toBeEnabled();
    await expect(editor).toHaveValue(/user:casey/);
    const durable = boundDraft(await workspace(request), target);
    expect(durable.baseline).toContainEqual(companionGrant);
    expect(durable.yaml).toContain("user:casey");
  } finally {
    receipt.release();
  }
});

test("F04 fetch without local changes observes a real remote addition", async ({ page, request }) => {
  const target = await policyFixture(request, "Fetch application control", baseDsl, [routeGrant]);
  await setDraft(request, target, { yaml: toYaml([routeGrant]), baseline: [routeGrant] }, { autoSave: false, autoPublish: false });
  await openTarget(page, target, "instances");
  await writeEngine(request, target, { writes: { tuple_keys: [companionGrant] } });
  await fetchInstances(page);
  await expect(page.getByRole("textbox", { name: "Tuple YAML" })).toHaveValue(/user:casey/);
});
