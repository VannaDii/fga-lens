import { readFile } from "node:fs/promises";

import { errors, expect, test, type APIRequestContext, type Page, type Response } from "@playwright/test";
import { transformer } from "@openfga/syntax-transformer";

import {
  appCommand, baseDsl, boundDraft, companionGrant, engineAllows, fetchInstances, gateState, holdAction, openTarget, policyFixture,
  routeGrant, setDraft, toYaml, workspace, writeEngine,
} from "./finding-helpers";
import { armTransport, capturedRequests, clearTraffic, postToEngine } from "./workbench-fixtures";

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

/** Identify the Save receipt for the pending interaction, including failures from the real handler. */
function saveReceipt(response: Response, matches: (state: { model: string }) => boolean = () => true) {
  const sent = response.request();
  if (sent.method() !== "POST" || new URL(response.url()).pathname !== "/api/workbench") return false;
  const body = sent.postDataJSON();
  return body?.action === "save" && matches(body.state);
}

test("C1 delayed same-tab Save acknowledges the newer tuple checkpoint without losing draft or selection", async ({ page, request }) => {
  const target = await policyFixture(request, "Delayed same-tab acknowledgement", baseDsl, [routeGrant]);
  const { authorization_model_id: alternate } = await postToEngine(request, target.path + "/authorization-models",
    transformer.transformDSLToJSONObject(baseDsl + "\n\ntype alternate_document\n"));
  await setDraft(request, target, { yaml: toYaml([routeGrant]), baseline: [routeGrant] }, { autoSave: false, autoPublish: false });
  await openTarget(page, target, "instances");
  const editor = page.getByRole("textbox", { name: "Tuple YAML" });
  const revision = page.getByRole("combobox", { name: "Model revision", exact: true });
  const authored = toYaml([routeGrant, companionGrant]);
  const later = "# retained while both replies were pending\n" + authored;
  await editor.fill(authored);
  const gate = "publish-before-save-acknowledgement";
  await clearTraffic(request);
  await armTransport(request, [{ path: target.path + "/authorization-models/" + target.revision, kind: "gate-response", gate }]);
  const delayed = holdAction(page, "save", "after checkpoint", (body) =>
    (body.state as { model?: string }).model === alternate);
  await delayed.ready;
  try {
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await expect.poll(() => gateState(request)).toContain(gate);
    const publicationStart = await workspace(request);
    const selectionReply = page.waitForResponse((response) => saveReceipt(response, (state) => state.model === alternate));
    await revision.selectOption(alternate);
    await delayed.arrived;
    const laterSave = await workspace(request);
    expect(laterSave.state).toMatchObject({ model: alternate, revision: publicationStart.state.revision + 1 });
    await editor.fill(later);

    await gateState(request, gate);
    await expect(page.getByText("Tuple changes published", { exact: true })).toBeVisible();
    const completed = await workspace(request);
    expect(completed.state.revision).toBeGreaterThan(laterSave.state.revision);
    expect(completed.state.authoredRevision).toBe(laterSave.state.authoredRevision);
    expect(boundDraft(completed, target).baseline).toEqual([routeGrant, companionGrant]);
    expect(await capturedRequests(request, target.path + "/write")).toEqual([{
      authorization_model_id: target.revision, writes: { tuple_keys: [companionGrant] },
    }]);

    delayed.release();
    expect((await selectionReply).ok()).toBe(true);
    await expect(editor).toHaveValue(later);
    await expect(revision).toHaveValue(alternate);
    await expect.soft(page.getByRole("banner").getByText(/^Tuples · In sync · \S/), "the publication checkpoint updates the editor baseline").toBeVisible({ timeout: 2500 });

    const nextSave = page.waitForResponse((response) => saveReceipt(response));
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await nextSave;
    await expect.soft(page.getByText("Saved to workspace", { exact: true }), "the next ordinary Save succeeds").toBeVisible({ timeout: 2500 });
    const persisted = await workspace(request);
    expect.soft(persisted.state.model).toBe(alternate);
    expect(boundDraft(persisted, target).yaml).toBe(later);
  } finally {
    delayed.release();
    if ((await gateState(request)).includes(gate)) await gateState(request, gate);
  }
});

test("C1 Save retries after an already-committed publication reply without waiting in a cycle", async ({ page, request }) => {
  const target = await policyFixture(request, "Save retry with a held checkpoint", baseDsl, [routeGrant]);
  await setDraft(request, target, { yaml: toYaml([routeGrant]), baseline: [routeGrant] }, { autoSave: false, autoPublish: false });
  await openTarget(page, target, "instances");
  const editor = page.getByRole("textbox", { name: "Tuple YAML" });
  const saved = toYaml([routeGrant, companionGrant]);
  const later = "# saved after the in-flight publication\n" + saved;
  await editor.fill(saved);
  const publication = holdAction(page, "publish-tuples", "after checkpoint");
  await publication.ready;
  try {
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await publication.arrived;
    const committed = await workspace(request);
    expect(boundDraft(committed, target).baseline).toEqual([routeGrant, companionGrant]);
    await editor.fill(later);
    const conflict = page.waitForResponse((response) => saveReceipt(response) && response.status() === 409);
    const retry = page.waitForResponse((response) => saveReceipt(response) && response.status() === 200, { timeout: 4500 });
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await conflict;
    publication.release();
    const confirmed = (await (await retry).json()).state;
    expect(confirmed.revision).toBe(committed.state.revision + 1);
    await expect(page.getByText("Saved to workspace", { exact: true })).toBeVisible();
    await expect(editor).toHaveValue(later);
    expect(boundDraft(await workspace(request), target).yaml).toBe(later);
  } finally {
    publication.release();
  }
});

/** Keep the normal authoring path enabled while completed publication responses are deliberately reordered. */
async function openAutoPublishingModel(page: Page, request: APIRequestContext, name: string) {
  const target = await policyFixture(request, name);
  await setDraft(request, target, { dsl: baseDsl, validDsl: baseDsl, modelManual: false },
    { autoSave: true, autoPublish: true, resetSelections: true });
  await openTarget(page, target, "model");
  const editor = page.getByRole("textbox", { name: "OpenFGA authorization model" });
  const revision = page.getByRole("combobox", { name: "Model revision", exact: true });
  await expect(editor).toHaveValue(baseDsl);
  await expect.poll(async () => (await workspace(request)).state.route).toBe("model");
  return { target, editor, revision };
}

/** Wait briefly for a concurrent B receipt. An implementation can instead serialize it behind A. */
async function newerReplyWhileHeld(page: Page, revision: number) {
  try {
    return await page.waitForResponse((reply) => {
      const sent = reply.request();
      if (sent.method() !== "POST" || new URL(sent.url()).pathname !== "/api/workbench") return false;
      const body = sent.postDataJSON();
      return body?.action === "publish-model" && body.revision === revision;
    }, { timeout: 1400 });
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
    return null;
  }
}

/** Compare actual installed revision contents with the final workspace, live selection, and reload. */
async function expectLatestModel(page: Page, request: APIRequestContext,
  authoring: Awaited<ReturnType<typeof openAutoPublishingModel>>, newest: string, expectedType: string, manual?: string) {
  const { target, editor, revision } = authoring;
  await expect(page.getByRole("button", { name: /^Publish(?: again| new draft)?$/ })).toBeEnabled();
  await expect(page.getByText("Model published", { exact: true })).toBeVisible();
  const { authorization_models: installed } = await appCommand<{
    authorization_models: { id: string; type_definitions: { type: string }[] }[];
  }>(request, { action: "models", store: target.store });
  const newestInstalled = installed.find(({ type_definitions }) => type_definitions.some(({ type }) => type === expectedType));
  expect(newestInstalled, "the valid newest edit is installed in the real store").toBeDefined();
  expect.soft(installed[0].id, "an older attempt never creates a later upstream revision").toBe(newestInstalled?.id);
  const saved = await workspace(request);
  expect.soft(boundDraft(saved, target)).toMatchObject({ dsl: newest, publishedDsl: newest, published: newestInstalled!.id });
  const selected = manual ?? newestInstalled!.id;
  await expect.soft(revision).toHaveValue(selected, { timeout: 1800 });
  await expect(editor).toHaveValue(newest);
  expect.soft(saved.state.model).toBe(selected);
  await page.reload();
  await expect.soft(revision).toHaveValue(selected, { timeout: 1800 });
  await expect(editor).toHaveValue(newest);
}

test("C6 a retry for the older auto-publication cannot install behind the newer valid edit", async ({ page, request }) => {
  const authoring = await openAutoPublishingModel(page, request, "Older provider retry");
  const { target, editor } = authoring;
  const older = baseDsl + "\n\ntype older_retry_document\n";
  const newer = baseDsl + "\n\ntype newer_retry_document\n";
  const write = target.path + "/authorization-models";
  const lookup = write + "?continuation_token=";
  const gate = "older-retry-lookup";
  await clearTraffic(request);
  await armTransport(request, [
    { path: lookup, kind: "forward" }, { path: write, kind: "drop-request" },
    { path: lookup, kind: "gate-response", gate },
  ]);
  try {
    await editor.fill(older);
    await expect.poll(() => gateState(request)).toContain(gate);
    await editor.fill(newer);
    await expect.poll(async () => boundDraft(await workspace(request), target).dsl).toBe(newer);
    const saved = await workspace(request);
    await newerReplyWhileHeld(page, saved.state.revision);
    await gateState(request, gate);
    await expectLatestModel(page, request, authoring, newer, "newer_retry_document");
  } finally {
    if ((await gateState(request)).includes(gate)) await gateState(request, gate);
  }
});

test("C6 delayed older provider and browser receipts keep the newest publication and an explicit historical choice", async ({ page, request }) => {
  const authoring = await openAutoPublishingModel(page, request, "Older model acknowledgement");
  const { target, editor, revision } = authoring;
  const anchor = baseDsl + "\n\ntype historical_choice\n";
  const { authorization_model_id: historical } = await postToEngine(request, target.path + "/authorization-models",
    transformer.transformDSLToJSONObject(anchor));
  await page.reload();
  await expect(revision.getByRole("option", { name: historical, exact: true })).toHaveCount(1);
  await revision.selectOption(historical);
  await expect.poll(async () => (await workspace(request)).state.model).toBe(historical);

  const older = baseDsl + "\n\ntype older_receipt_document\n";
  const newer = baseDsl + "\n\ntype newer_receipt_document\n";
  const gate = "older-model-write-response";
  const receipt = holdAction(page, "publish-model", "after checkpoint");
  await receipt.ready;
  await clearTraffic(request);
  await armTransport(request, [{ path: target.path + "/authorization-models", kind: "gate-response", gate }]);
  try {
    await editor.fill(older);
    await expect.poll(() => gateState(request)).toContain(gate);
    await editor.fill(newer);
    await expect.poll(async () => boundDraft(await workspace(request), target).dsl).toBe(newer);
    const saved = await workspace(request);
    await newerReplyWhileHeld(page, saved.state.revision);
    await gateState(request, gate);
    await receipt.arrived;
    await expect(revision).toHaveValue(historical);
    receipt.release();
    await expectLatestModel(page, request, authoring, newer, "newer_receipt_document", historical);
  } finally {
    receipt.release();
    if ((await gateState(request)).includes(gate)) await gateState(request, gate);
  }
});
