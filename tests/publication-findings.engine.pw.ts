import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { transformer } from "@openfga/syntax-transformer";

import {
  appCommand, appRequest, baseDsl, boundDraft, companionGrant, engineAllows, openTarget, policyFixture,
  routeGrant, setDraft, toYaml, workspace, writeEngine, type FixtureTarget,
} from "./finding-helpers";
import { armTransport, capturedRequests, clearTraffic, postToEngine } from "./workbench-fixtures";
import type { Batch, Tuple, WorkspaceView } from "@/lib/workbench-contract";

const conditionalDsl = baseDsl.replace("define viewer: [user]", "define viewer: [user, user with region_guard]")
  + '\n\ncondition region_guard(region: string) {\n  region != ""\n}\n';

/** Attach independent condition data to the same stored identity. */
function inRegion(region: string): Tuple {
  return { ...routeGrant, condition: { name: "region_guard", context: { region } } };
}

/** Read the complete same-key tuple directly from the stock engine. */
async function observedTuple(request: APIRequestContext, target: FixtureTarget) {
  const result: { tuples: { key: Tuple }[] } = await postToEngine(request, target.path + "/read", {
    tuple_key: routeGrant, consistency: "HIGHER_CONSISTENCY",
  });
  return result.tuples.map(({ key }) => key);
}

type Receipt = WorkspaceView & { failure?: { error: string } };

/** Drive publication at the current saved workspace revision. */
async function publish(request: APIRequestContext, target: FixtureTarget) {
  return appCommand<Receipt>(request, {
    action: "publish-tuples", target: { store: target.store, revision: target.revision },
    revision: (await workspace(request)).state.revision,
  });
}

/** Let the original delete reach OpenFGA, then fail the add and leave its durable journal. */
async function interruptReplacement(request: APIRequestContext, name: string) {
  const before = inRegion("north");
  const desired = inRegion("south");
  const target = await policyFixture(request, name, conditionalDsl, [before]);
  await setDraft(request, target, { dsl: conditionalDsl, validDsl: conditionalDsl, yaml: toYaml([desired]), baseline: [before] });
  await armTransport(request, [
    { path: target.path + "/write", kind: "forward" },
    { path: target.path + "/write", kind: "service-error" },
  ]);
  const failed = await publish(request, target);
  expect(failed.failure?.error).toBe("partial publication");
  expect(boundDraft(failed, target).replacement).toMatchObject({
    target: { store: target.store, revision: target.revision }, original: before, desired,
  });
  expect(await observedTuple(request, target)).toEqual([]);
  await clearTraffic(request);
  return { target, desired };
}

test("F05 journal recovery honors the original target and replacement despite later invalid YAML", async ({ request }) => {
  const { target, desired } = await interruptReplacement(request, "Interrupted conditional replacement");
  const extra: { authorization_model_id: string } = await postToEngine(request, target.path + "/authorization-models",
    transformer.transformDSLToJSONObject(conditionalDsl.replace("\n\ncondition", "\n\ntype later_document\n\ncondition")));
  const selected = { ...target, revision: extra.authorization_model_id };
  const newer = "# independent unfinished edit\n[";
  await setDraft(request, selected, { yaml: newer });
  const response = await appRequest(request, {
    action: "publish-tuples", target: { store: selected.store, revision: selected.revision },
    revision: (await workspace(request)).state.revision,
  });

  expect.soft(response.ok(), "recovery can proceed with a later invalid editor buffer").toBe(true);
  expect.soft(await capturedRequests(request, target.path + "/write")).toEqual([{
    authorization_model_id: target.revision, writes: { tuple_keys: [desired] },
  }]);
  expect.soft(await observedTuple(request, target)).toEqual([desired]);
  const after = boundDraft(await workspace(request), target);
  expect.soft(after.yaml).toBe(newer);
  expect(after.replacement).toBeUndefined();
});

test("F05 resolving a journal conflict preserves a newer same-key local edit", async ({ request }) => {
  const { target, desired } = await interruptReplacement(request, "Unexpected replacement value");
  const later = inRegion("east");
  const unexpected = inRegion("west");
  const yaml = "# newer same-key request\n" + toYaml([later]);
  await setDraft(request, target, { yaml });
  await writeEngine(request, target, { writes: { tuple_keys: [unexpected] } });
  await clearTraffic(request);

  const conflicted = await publish(request, target);
  expect(conflicted.failure?.error).toBe("conflict");
  const [conflict] = boundDraft(conflicted, target).conflicts;
  expect(conflict).toMatchObject({ local: desired, server: unexpected });
  const resolved = await appCommand(request, { action: "resolve-tuple", store: target.store,
    identity: conflict.key, useServer: true, yaml, revision: conflicted.state.revision });

  expect.soft(boundDraft(resolved, target).yaml).toBe(yaml);
  expect.soft(boundDraft(resolved, target).baseline).toContainEqual(unexpected);
  expect.soft(await capturedRequests(request, target.path + "/write")).toEqual([]);
  expect(await observedTuple(request, target)).toEqual([unexpected]);
});

test("F05 a malformed later tuple rejects the entire ordinary publication before any write", async ({ request }) => {
  const target = await policyFixture(request, "Whole draft validation");
  const malformed = { user: "user:casey", relation: "viewer", object: "document:invalid id" };
  await setDraft(request, target, { yaml: toYaml([routeGrant, malformed]), baseline: [] });
  await clearTraffic(request);
  const response = await appRequest(request, {
    action: "publish-tuples", target: { store: target.store, revision: target.revision },
    revision: (await workspace(request)).state.revision,
  });
  const result = await response.json();
  expect.soft(result.error ?? result.failure?.error).toBe("invalid input");
  expect.soft(await capturedRequests(request, target.path + "/write")).toEqual([]);
  expect(await engineAllows(request, target, routeGrant)).toBe(false);
});

test("F06 a failed publication retry never silently publishes a later draft", async ({ page, request }) => {
  const target = await policyFixture(request, "Captured model retry");
  await setDraft(request, target, { dsl: baseDsl, validDsl: baseDsl }, { autoSave: false, autoPublish: false });
  await openTarget(page, target, "model");
  const editor = page.getByRole("textbox", { name: "OpenFGA authorization model" });
  const original = baseDsl + "\n\ntype publication_a\n";
  const later = baseDsl + "\n\ntype publication_b\n";
  const modelPath = target.path + "/authorization-models";
  await clearTraffic(request);
  await armTransport(request, [{ path: modelPath, kind: "service-error" }, { path: modelPath, kind: "service-error" }]);
  await editor.fill(original);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const error = page.getByRole("status").filter({ hasText: /publish model.*(server error|failed)/i });
  await expect(error.first()).toBeVisible();
  const originalWrites = await capturedRequests(request, modelPath);
  expect(originalWrites).toHaveLength(2);
  for (const write of originalWrites) {
    expect(write.type_definitions).toEqual(expect.arrayContaining([expect.objectContaining({ type: "publication_a" })]));
  }

  await editor.fill(later);
  await clearTraffic(request);
  const retry = page.getByRole("button", { name: /^(publish again|retry.*publish)/i });
  if (await retry.count() && await retry.first().isEnabled()) {
    await retry.first().click();
    await expect(page.getByText("Model published", { exact: true })).toBeVisible();
    const retried = await capturedRequests(request, modelPath);
    expect(retried).toHaveLength(1);
    expect(retried[0].type_definitions).toEqual(expect.arrayContaining([expect.objectContaining({ type: "publication_a" })]));
  } else {
    await expect(page.getByRole("button", { name: /publish.*(new|current|later).*draft/i })).toBeVisible();
    await expect(error.first()).toBeVisible();
    expect(await capturedRequests(request, modelPath)).toEqual([]);
  }
  await expect(editor).toHaveValue(later);
});

const decimalGuard = (expression: string) => baseDsl.replace("define viewer: [user]", "define viewer: [user with decimal_guard]")
  + "\n\ncondition decimal_guard(quota: double) {\n  " + expression + "\n}\n";

test("F06 valid whitespace-only condition edits reuse the actual installed revision", async ({ request }) => {
  const target = await policyFixture(request, "Equivalent condition formatting", decimalGuard("quota >= 1.5"));
  await clearTraffic(request);
  const dsl = decimalGuard("quota  >=  1.5");
  const saved = await setDraft(request, target, { dsl, validDsl: dsl });
  const receipt = await appCommand(request, { action: "publish-model", store: target.store, revision: saved.state.revision });
  expect(boundDraft(receipt, target).published).toBe(target.revision);
  expect(await capturedRequests(request, target.path + "/authorization-models")).toEqual([]);
});

test("F06 a split decimal rejected by stock CEL cannot reuse the valid installed model", async ({ request }) => {
  const expression = "quota >= 1 . 5";
  const valid = decimalGuard("quota >= 1.5");
  const target = await policyFixture(request, "Invalid split decimal", valid);
  const content = transformer.transformDSLToJSONObject(valid);
  content.conditions!.decimal_guard.expression = expression;
  const proxy = "http://127.0.0.1:" + (process.env.FGA_TEST_PROXY_PORT ?? "35492");
  const engine = await request.post(proxy + target.path + "/authorization-models", { data: content });
  expect(engine.status()).toBe(400);
  await clearTraffic(request);

  const invalid = decimalGuard(expression);
  const saved = await setDraft(request, target, { dsl: invalid, validDsl: valid });
  const app = await appRequest(request, { action: "publish-model", store: target.store, revision: saved.state.revision });
  const result = await app.json();
  expect.soft(app.ok() && !result.failure, "invalid CEL cannot yield a successful publish receipt").toBe(false);
  expect(boundDraft(await workspace(request), target).published).toBeUndefined();
});

/** Install both revisions in one stock store and capture its obsolete grant in the editor baseline. */
async function revisedGrant(page: Page, request: APIRequestContext, name: string,
  installedDsl: string, original: Tuple, nextDsl: string, authored: Tuple[]) {
  const previous = await policyFixture(request, name, installedDsl, [original, companionGrant]);
  const { authorization_model_id: revision } = await postToEngine(request, previous.path + "/authorization-models",
    transformer.transformDSLToJSONObject(nextDsl));
  const target = { ...previous, revision };
  await setDraft(request, target, { dsl: nextDsl, validDsl: nextDsl,
    yaml: toYaml(authored), baseline: [original, companionGrant] }, { autoSave: false, autoPublish: false });
  await openTarget(page, target, "instances");
  await expect(page.getByRole("combobox", { name: "Model revision", exact: true })).toHaveValue(revision);
  expect(await observedTuple(request, target)).toEqual([{ ...original, condition: original.condition ?? null }]);
  expect(await engineAllows(request, previous, routeGrant)).toBe(true);
  await clearTraffic(request);
  return { previous, target };
}

/** Submit a normal browser Publish and preserve the endpoint response for contract assertions. */
async function publishFromEditor(page: Page, target: FixtureTarget) {
  const delivered = page.waitForResponse((response) => {
    const sent = response.request();
    if (sent.method() !== "POST" || new URL(sent.url()).pathname !== "/api/workbench") return false;
    const body = sent.postDataJSON();
    return body.action === "publish-tuples" && body.target?.store === target.store && body.target.revision === target.revision;
  });
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const response = await delivered;
  return { status: response.status(), payload: await response.json() };
}

const revisedViewer = baseDsl.replace("define viewer: [user]", "define viewer: [group]") + "\n\ntype group\n";

test("C2 Publish removes a stored grant whose subject restriction changed in the selected revision", async ({ page, request }) => {
  const { previous, target } = await revisedGrant(page, request, "Obsolete stored subject", baseDsl, routeGrant, revisedViewer, [companionGrant]);
  const { status, payload } = await publishFromEditor(page, target);
  expect.soft(status, "a valid deletion is allowed by stock OpenFGA under the selected revision").toBe(200);
  expect.soft(payload.failure).toBeUndefined();
  expect.soft(await capturedRequests(request, target.path + "/read")).toContainEqual(expect.objectContaining({ tuple_key: routeGrant }));
  expect.soft(await capturedRequests(request, target.path + "/write")).toEqual([{
    authorization_model_id: target.revision, deletes: { tuple_keys: [routeGrant] },
  }]);
  expect.soft(await observedTuple(request, target)).toEqual([]);
  expect.soft(await engineAllows(request, previous, routeGrant)).toBe(false);
  expect(await engineAllows(request, target, companionGrant)).toBe(true);
});

test("C2 Publish replaces an obsolete condition on the same key under the selected revision", async ({ page, request }) => {
  const original = inRegion("north");
  const desired = { ...routeGrant, condition: { name: "district_guard", context: { region: "south" } } };
  const revisedDsl = conditionalDsl.replaceAll("region_guard", "district_guard");
  const { target } = await revisedGrant(page, request, "Obsolete stored condition", conditionalDsl, original, revisedDsl, [desired, companionGrant]);
  const { status, payload } = await publishFromEditor(page, target);
  expect.soft(status, "the new grant is valid and the obsolete condition does not invalidate its deletion").toBe(200);
  expect.soft(payload.failure).toBeUndefined();
  expect.soft(await capturedRequests(request, target.path + "/read")).toContainEqual(expect.objectContaining({ tuple_key: routeGrant }));
  expect.soft(await capturedRequests(request, target.path + "/write")).toEqual([
    { authorization_model_id: target.revision, deletes: { tuple_keys: [routeGrant] } },
    { authorization_model_id: target.revision, writes: { tuple_keys: [desired] } },
  ]);
  expect.soft(await observedTuple(request, target)).toEqual([desired]);
  const durable = boundDraft(await workspace(request), target);
  expect.soft(durable.baseline).toEqual(expect.arrayContaining([desired, companionGrant]));
  expect(durable.replacement).toBeUndefined();
});

test("C2 Publish reports an invalid addition and leaves the planned deletion and unrelated grant untouched", async ({ page, request }) => {
  const invalid = { ...routeGrant, user: "user:invalid-addition" };
  const { previous, target } = await revisedGrant(page, request, "Invalid addition before permitted removal", baseDsl, routeGrant,
    revisedViewer, [companionGrant, invalid]);
  const { status, payload } = await publishFromEditor(page, target);
  expect(status).toBe(400);
  expect.soft(payload.tupleIssues).toEqual([
    expect.objectContaining({ operation: "add", reason: "userRestriction", row: { source: "draft", index: 1 } }),
  ]);
  expect(await capturedRequests(request, target.path + "/write")).toEqual([]);
  expect(await observedTuple(request, target)).toEqual([{ ...routeGrant, condition: null }]);
  expect(await engineAllows(request, previous, routeGrant)).toBe(true);
  expect(await engineAllows(request, target, companionGrant)).toBe(true);
});

/** CEL keeps the three quoted characters after the escape and the spaces that follow them. */
function escapedLiteralModel(marker: string, spaces: string, operatorSpacing = " ") {
  return baseDsl.replace("define viewer: [user]", "define viewer: [user with exact_text]")
    + "\n\ncondition exact_text(label: string) {\n  label" + operatorSpacing + "==" + operatorSpacing
    + String.raw`"""before\"""` + spaces + marker + '"""\n}\n';
}

/** Ask the pinned engine to evaluate the given literal under one explicit revision. */
async function checkLiteral(request: APIRequestContext, target: FixtureTarget, label: string) {
  const result = await postToEngine(request, target.path + "/check", {
    authorization_model_id: target.revision, tuple_key: routeGrant, context: { label },
  });
  return result.allowed;
}

test("C5 ordinary Publish distinguishes escaped triple-literal spaces, recovers a lost reply and reuses formatting", async ({ page, request }) => {
  const marker = "publish_spelling";
  const original = escapedLiteralModel(marker, " ");
  const changed = escapedLiteralModel(marker, "  ");
  const target = await policyFixture(request, "Escaped CEL Publish", original,
    [{ ...routeGrant, condition: { name: "exact_text" } }]);
  const oldLabel = 'before""" ' + marker;
  const newLabel = 'before"""  ' + marker;
  expect(await checkLiteral(request, target, oldLabel)).toBe(true);
  expect(await checkLiteral(request, target, newLabel)).toBe(false);
  await setDraft(request, target, { dsl: original, validDsl: original }, { autoSave: false, autoPublish: false });
  await openTarget(page, target, "model");
  const editor = page.getByRole("textbox", { name: "OpenFGA authorization model" });
  const publish = page.getByRole("button", { name: "Publish", exact: true });
  const modelPath = target.path + "/authorization-models";
  await clearTraffic(request);
  await armTransport(request, [{ path: modelPath, kind: "drop-success" }]);
  await editor.fill(changed);
  await publish.click();
  await expect(page.getByText("Model published", { exact: true })).toBeVisible();
  const selected = boundDraft(await workspace(request), target).published!;
  expect.soft(selected, "one extra space inside the literal changes the installed model").not.toBe(target.revision);
  expect.soft(await capturedRequests(request, modelPath), "the dropped reply is recovered without a duplicate write").toHaveLength(1);
  expect.soft(await checkLiteral(request, { ...target, revision: selected }, newLabel)).toBe(true);
  expect.soft(await checkLiteral(request, { ...target, revision: selected }, oldLabel)).toBe(false);

  await clearTraffic(request);
  await editor.fill(escapedLiteralModel(marker, "  ", "   "));
  const formattingReceipt = page.waitForResponse((response) => {
    const sent = response.request();
    return sent.method() === "POST" && new URL(sent.url()).pathname === "/api/workbench"
      && sent.postDataJSON()?.action === "publish-model";
  });
  await publish.click();
  expect((await formattingReceipt).ok()).toBe(true);
  await expect(publish).toBeEnabled();
  await expect(page.getByText("Model published", { exact: true })).toBeVisible();
  expect(boundDraft(await workspace(request), target).published).toBe(selected);
  expect(await capturedRequests(request, modelPath)).toEqual([]);
});

test("C5 source suggestions and a reused fixture distinguish escaped triple-literal contents", async ({ request }) => {
  const marker = "fixture_spelling";
  const first = escapedLiteralModel(marker, " ");
  const second = escapedLiteralModel(marker, "  ");
  const source = await policyFixture(request, "Escaped CEL source", first);
  const { authorization_model_id: newer } = await postToEngine(request, source.path + "/authorization-models",
    transformer.transformDSLToJSONObject(second));
  const initial = { store: source.store, revision: source.revision };
  const revised = { store: source.store, revision: newer };
  expect.soft(await appCommand(request, { action: "suggest-model", dsl: second })).toEqual({ match: revised });
  const batch: Batch = { id: crypto.randomUUID(), name: "Literal fixture revisions",
    tuples: [{ ...routeGrant, condition: { name: "exact_text" } }], cases: [] };
  const { state } = await workspace(request);
  await appCommand(request, { action: "save", state: { ...state, batches: [...state.batches, batch] } });
  const stage = async (source: typeof revised) => {
    const response = await appCommand<Receipt>(request, { action: "fixture", batchId: batch.id, source,
      revision: (await workspace(request)).state.revision });
    expect(response.failure).toBeUndefined();
    const binding = response.state.batches.find(({ id }) => id === batch.id)?.installations?.[response.endpoint];
    expect(binding?.source).toEqual(source);
    expect(binding?.fixture).toBeDefined();
    return { ...binding!.fixture!, path: "/stores/" + binding!.fixture!.store };
  };
  const oldFixture = await stage(initial);
  expect(await checkLiteral(request, oldFixture, 'before""" ' + marker)).toBe(true);
  const newFixture = await stage(revised);
  expect(newFixture.store).toBe(oldFixture.store);
  expect.soft(newFixture.revision).not.toBe(oldFixture.revision);
  expect(await checkLiteral(request, newFixture, 'before"""  ' + marker)).toBe(true);
});
