import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import {
  baseDsl, companionGrant, evidencePanel, gateState, holdAction, openTarget, policyFixture,
  routeGrant, setDraft, toYaml, writeEngine,
} from "./finding-helpers";
import {
  armTransport, capturedRequests, clearTraffic, installFixture, memberThroughParent, postToEngine, storedTuples,
} from "./workbench-fixtures";
import type { Tuple } from "@/lib/workbench-contract";

const syntheticContext = 'value:synthetic_literal';
const contextDsl = baseDsl
  .replace("define viewer: [user]", "define viewer: [user, user with region_guard]")
  .replace("define editor: [user]", "define editor: [user, user with region_guard]")
  + '\n\ncondition region_guard(region: string) {\n  region == "" || region == "value:synthetic_literal" || region == "west"\n}\n';

/** Set the real query controls explicitly instead of depending on the last test's preferences. */
async function selectCheck(page: Page, user = routeGrant.user, object = routeGrant.object, relation = routeGrant.relation) {
  await page.getByRole("combobox", { name: "Operation", exact: true }).selectOption("check");
  await page.getByRole("combobox", { name: "View as", exact: true }).selectOption(user);
  await page.getByRole("combobox", { name: "Object", exact: true }).selectOption(object);
  await page.getByRole("combobox", { name: "Relation", exact: true }).selectOption(relation);
}

const run = (page: Page) => page.getByRole("button", { name: "Run", exact: true });

/** Set an explicit manually entered condition value through the real form. */
async function enterCondition(page: Page, value: string) {
  await page.getByText("Condition context", { exact: true }).click();
  const explicit = page.getByRole("checkbox", { name: /(?:include|send|provide|use).*region|region.*(?:include|send|provide)/i });
  if (await explicit.count()) await explicit.first().check();
  const field = page.getByRole("textbox", { name: /^region/i });
  if (value === "") await field.fill("edited first");
  await field.fill(value);
  return field;
}

/** Prepare an actual installed string condition and stable identifiers for the UI. */
async function regionFixture(page: Page, request: APIRequestContext, name: string, baseline: Tuple[], authored = baseline) {
  const target = await policyFixture(request, name, contextDsl, baseline);
  await setDraft(request, target, { dsl: contextDsl, validDsl: contextDsl, yaml: toYaml(authored), baseline },
    { autoSave: false, autoPublish: false, resetSelections: true });
  await openTarget(page, target, "queries");
  await selectCheck(page);
  await page.getByRole("checkbox", { name: "Compare", exact: true }).uncheck();
  return target;
}

test("F07 a deliberately supplied empty string is sent to OpenFGA and allows the conditional Check", async ({ page, request }) => {
  const tuple = { ...routeGrant, condition: { name: "region_guard" } };
  const target = await regionFixture(page, request, "Explicit empty context string", [tuple]);
  await enterCondition(page, "");
  await clearTraffic(request);
  await run(page).click();
  await expect.poll(() => capturedRequests(request, target.path + "/check")).not.toHaveLength(0);
  const [sent] = await capturedRequests(request, target.path + "/check");
  expect(sent).toEqual({
    authorization_model_id: target.revision, tuple_key: routeGrant, context: { region: "" },
  });
  await expect(page.getByText("Allowed", { exact: true })).toBeVisible();
});

test("F07 a typed prefix-like string stays editable and reaches the actual wire unmodified", async ({ page, request }) => {
  const tuple = { ...routeGrant, condition: { name: "region_guard" } };
  const target = await regionFixture(page, request, "Literal context prefix", [tuple]);
  const field = await enterCondition(page, syntheticContext);
  await expect.soft(field).toBeVisible({ timeout: 2000 });
  await clearTraffic(request);
  await run(page).click();
  await expect.poll(() => capturedRequests(request, target.path + "/check"), { timeout: 2500 })
    .toContainEqual({ authorization_model_id: target.revision, tuple_key: routeGrant, context: { region: syntheticContext } });
  await expect(page.getByText("Allowed", { exact: true })).toBeVisible();
});

test("F07 removing a represented condition value clears the selection before the next Check", async ({ page, request }) => {
  const represented = { ...companionGrant, condition: { name: "region_guard", context: { region: "west" } } };
  const target = await regionFixture(page, request, "Disappearing selection value", [routeGrant], [routeGrant, represented]);
  await page.getByText("Condition context", { exact: true }).click();
  const source = page.getByRole("combobox", { name: "region context source", exact: true });
  await source.selectOption({ label: '"west"' });
  await page.getByRole("link", { name: "Instances", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "Tuple YAML" });
  await editor.fill(toYaml([routeGrant]));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved to workspace", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Queries", exact: true }).click();
  await selectCheck(page);
  await clearTraffic(request);
  await run(page).click();
  await expect(page.getByText("Allowed", { exact: true })).toBeVisible();
  const [sent] = await capturedRequests(request, target.path + "/check");
  expect(sent).toMatchObject({ authorization_model_id: target.revision, tuple_key: routeGrant });
  expect(sent.context ?? {}).not.toHaveProperty("region");
});

test("F07 request disclosure shows the exact captured method, store path, revision and body", async ({ page, request }) => {
  const target = await regionFixture(page, request, "Exact transmitted request disclosure", [routeGrant]);
  await enterCondition(page, "west");
  await clearTraffic(request);
  await run(page).click();
  await expect(page.getByText("Allowed", { exact: true })).toBeVisible();
  const [sent] = await capturedRequests(request, target.path + "/check");
  expect(sent).toEqual({ authorization_model_id: target.revision, tuple_key: routeGrant, context: { region: "west" } });
  await page.getByText("API request", { exact: true }).click();
  const disclosure = page.locator("details[open]").filter({ has: page.getByText("API request", { exact: true }) });
  await expect.soft(disclosure).toContainText("POST", { timeout: 1500 });
  await expect.soft(disclosure).toContainText(target.path + "/check", { timeout: 1500 });
  expect(JSON.parse((await disclosure.locator("pre").textContent()) ?? "{}")).toEqual(sent);
});

test("F08 a confirmed conditioned direct branch in a union yields supporting evidence", async ({ page, request }) => {
  const dsl = contextDsl.replace("define viewer: [user, user with region_guard]", "define viewer: [user with region_guard] or editor");
  const conditioned = { ...routeGrant, condition: { name: "region_guard", context: { region: "west" } } };
  const target = await policyFixture(request, "Conditioned union branch", dsl, [conditioned]);
  await setDraft(request, target, { dsl, validDsl: dsl, yaml: toYaml([conditioned]), baseline: [conditioned] });
  await openTarget(page, target, "queries");
  await selectCheck(page);
  await page.getByRole("checkbox", { name: "Compare", exact: true }).uncheck();
  await run(page).click();
  await expect(page.getByText("Allowed", { exact: true })).toBeVisible();
  await expect(run(page)).toBeEnabled();
  await page.getByText("Evidence", { exact: true }).click();
  const article = page.getByRole("article");
  await expect.soft(article.getByText(/^Reason undetermined/)).toHaveCount(0);
  await expect.soft(evidencePanel(page)).toContainText("region_guard");
  await expect(evidencePanel(page)).toContainText("user:maya");
});

test("F08 evidence after an inherited-to-direct change is labeled as later beside the original verdict", async ({ page, request }) => {
  const target = await installFixture(request, "Evidence changes after a decision");
  await setDraft(request, target, { yaml: toYaml(storedTuples), baseline: storedTuples });
  await openTarget(page, target, "queries");
  await selectCheck(page, "user:maya", "organization:ca", "can_read");
  await page.getByRole("checkbox", { name: "Compare", exact: true }).uncheck();
  const evidence = holdAction(page, "evidence", "before dispatch");
  await evidence.ready;
  try {
    await clearTraffic(request);
    await run(page).click();
    await evidence.arrived;
    await expect(page.getByText("Allowed", { exact: true })).toBeVisible();
    expect(await capturedRequests(request, target.path + "/check")).toHaveLength(1);
    const direct = { ...memberThroughParent, object: "organization:ca" };
    await writeEngine(request, target, { deletes: { tuple_keys: [memberThroughParent] }, writes: { tuple_keys: [direct] } });
    evidence.release();
    await expect(run(page)).toBeEnabled();
    await expect(page.getByText("Allowed", { exact: true })).toBeVisible();
    await page.getByText("Evidence", { exact: true }).click();
    await expect(evidencePanel(page).getByText(direct.user, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("article")).toContainText(
      /later (?:observation|tuple|chain|read)|(?:observed|reconstructed) after|subsequent (?:observation|tuple|chain|read)/i,
    );
  } finally {
    evidence.release();
  }
});

test("F08 a capped ListObjects result and a later Check of the omitted entry keep distinct evidence", async ({ page, request }) => {
  const cap = Number(process.env.FGA_TEST_LIST_LIMIT ?? "1000");
  expect(cap, "a positive stock ListObjects limit is required for the omission case").toBeGreaterThan(0);
  const grants = Array.from({ length: cap + 1 }, (_, index) => ({
    ...routeGrant, object: "document:capped_" + index,
  }));
  const target = await policyFixture(request, "Capped list observation");
  for (let offset = 0; offset < grants.length; offset += 100) {
    await writeEngine(request, target, { writes: { tuple_keys: grants.slice(offset, offset + 100) } });
  }
  await setDraft(request, target, { yaml: toYaml(grants), baseline: grants });
  await openTarget(page, target, "queries");
  await page.getByRole("combobox", { name: "Operation", exact: true }).selectOption("list-objects");
  await page.getByRole("combobox", { name: "View as", exact: true }).selectOption(routeGrant.user);
  await page.getByRole("combobox", { name: "Object type", exact: true }).selectOption("document");
  await page.getByRole("combobox", { name: "Relation", exact: true }).selectOption("viewer");
  await page.getByRole("checkbox", { name: "Compare", exact: true }).uncheck();
  await clearTraffic(request);
  await run(page).click();
  const result = page.getByRole("article");
  const original = result.locator("ul").getByRole("listitem");
  await expect(original).toHaveCount(cap);
  const listed = await original.allTextContents();
  const objects = grants.map((tuple) => tuple.object);
  expect(objects).toEqual(expect.arrayContaining(listed));
  const omitted = objects.find((object) => !listed.includes(object))!;
  expect(omitted).toBeDefined();
  await page.getByRole("combobox", { name: "Inspect list entry", exact: true }).selectOption(omitted);
  await page.getByRole("button", { name: "Check entry", exact: true }).click();
  await page.getByText("Evidence", { exact: true }).click();
  await expect(result.getByText(/(?:follow-up |entry )?check.*allowed/i)).toBeVisible();
  await expect(original).toHaveText(listed);
  await expect(result.getByText(/^Reason undetermined/)).toBeVisible();
  const panel = evidencePanel(page);
  await expect.soft(panel.getByText(omitted, { exact: true }).first()).toBeVisible({ timeout: 1800 });
  await expect.soft(panel).toContainText("define viewer", { timeout: 1800 });
  await expect(panel.getByText("Expand observation", { exact: true })).toBeVisible({ timeout: 1800 });
});

test("F10 alternate-first compare cannot switch a manually edited expectation source", async ({ page, request }) => {
  const primary = await policyFixture(request, "Primary expectation result", baseDsl, [routeGrant]);
  const alternate = await policyFixture(request, "Alternate expectation result", baseDsl, [routeGrant]);
  await setDraft(request, primary, { yaml: toYaml([routeGrant]), baseline: [routeGrant] });
  await openTarget(page, primary, "queries");
  await selectCheck(page);
  await page.getByRole("checkbox", { name: "Compare", exact: true }).check();
  await page.getByRole("combobox", { name: "Alternate store", exact: true }).selectOption(alternate.store);
  await page.getByRole("combobox", { name: "Alternate revision", exact: true }).selectOption(alternate.revision);
  const gate = "compare-primary-reply";
  await clearTraffic(request);
  await armTransport(request, [{ path: primary.path + "/check", kind: "gate-response", gate }]);
  const save = page.getByRole("button", { name: "Save query", exact: true });
  const dialog = page.getByRole("dialog");
  const source = dialog.getByRole("combobox", { name: "Expectation source", exact: true });
  try {
    await run(page).click();
    await expect.poll(() => gateState(request)).toContain(gate);
    await expect(page.getByRole("article").filter({ hasText: alternate.revision }).getByText("Allowed", { exact: true })).toBeVisible();
    const early = await save.isEnabled();
    if (early) {
      await save.click();
      await expect(source.locator("option:checked")).toContainText(alternate.revision);
      await dialog.getByRole("combobox", { name: "Expected result", exact: true }).selectOption("false");
    }
    await gateState(request, gate);
    await expect(page.getByRole("article").filter({ hasText: primary.revision }).getByText("Allowed", { exact: true })).toBeVisible();
    if (early) {
      await expect.soft(source.locator("option:checked")).toContainText(alternate.revision);
      await expect(dialog.getByRole("combobox", { name: "Expected result", exact: true })).toHaveValue("false");
    } else {
      await expect(run(page)).toBeEnabled();
      await expect(save).toBeEnabled();
      await save.click();
      await expect(source.locator("option").filter({ hasText: alternate.revision })).toHaveCount(1);
      await expect(source.locator("option").filter({ hasText: primary.revision })).toHaveCount(1);
    }
  } finally {
    await gateState(request, gate);
  }
});

const testOverlay = { user: "user:temporary_overlay", object: "document:separate_overlay", relation: "viewer" };

/** Set up a known absent identity and an alternate-only conditional grant in two actual stores. */
async function openListComparison(page: Page, request: APIRequestContext, label: string, alternateGrant: Tuple, known: string) {
  const primary = await policyFixture(request, label + " primary", contextDsl, [routeGrant]);
  const alternate = await policyFixture(request, label + " alternate", contextDsl, [alternateGrant]);
  await setDraft(request, primary, { yaml: toYaml([routeGrant, testOverlay]), baseline: [routeGrant], inventory: [known] },
    { autoSave: false, autoPublish: false, resetSelections: true });
  await openTarget(page, primary, "queries");
  await page.getByRole("checkbox", { name: "Compare", exact: true }).check();
  await page.getByRole("combobox", { name: "Alternate store", exact: true }).selectOption(alternate.store);
  await page.getByRole("combobox", { name: "Alternate revision", exact: true }).selectOption(alternate.revision);
  await enterCondition(page, "west");
  await page.getByRole("checkbox", { name: testOverlay.user + " · " + testOverlay.relation + " · " + testOverlay.object }).check();
  return { primary, alternate };
}

/** Check each available identity on the captured alternate side without replacing its list. */
async function inspectAlternate(page: Page, request: APIRequestContext, targets: Awaited<ReturnType<typeof openListComparison>>,
  primaryIdentity: string, returned: { id: string; tuple: Tuple }, omitted: { id: string; tuple: Tuple }) {
  const { primary, alternate } = targets;
  const primarySide = page.getByRole("article").filter({ hasText: primary.revision });
  const side = page.getByRole("article").filter({ hasText: alternate.revision });
  const list = side.getByRole("list").getByRole("listitem");
  await expect(list).toHaveText([returned.id]);
  await expect(primarySide.getByRole("listitem")).toHaveText([primaryIdentity]);
  const primaryOptions = await primarySide.getByRole("combobox", { name: /^Inspect list entry/ }).getByRole("option")
    .evaluateAll((entries) => entries.map((entry) => (entry as HTMLOptionElement).value));
  expect(primaryOptions).toContain(primaryIdentity);
  expect(primaryOptions).not.toContain(returned.id);
  const picker = side.getByRole("combobox", { name: /^Inspect list entry/ });
  const options = await picker.getByRole("option").evaluateAll((entries) => entries.map((entry) => (entry as HTMLOptionElement).value));
  expect.soft(options, "the alternate side offers its own returned identity").toContain(returned.id);
  expect(options, "the eligible known identity remains available after its omission").toContain(omitted.id);
  await page.getByRole("textbox", { name: /^region/i }).fill("outside");
  const condition = { name: "region_guard" };
  await writeEngine(request, alternate, { writes: { tuple_keys: [{ ...omitted.tuple, condition }] } });
  const inspect = async (entry: typeof returned) => {
    await clearTraffic(request);
    await picker.selectOption(entry.id);
    await side.getByRole("button", { name: "Check entry", exact: true }).click();
    const summary = side.getByText("Evidence", { exact: true });
    if (await summary.locator("..").getAttribute("open") === null) await summary.click();
    await expect(side.getByText(/Selected-entry Check · .*allowed/i)).toBeVisible();
    expect((await capturedRequests(request, alternate.path + "/check"))[0]).toEqual({
      authorization_model_id: alternate.revision, tuple_key: entry.tuple,
      context: { region: "west" }, contextual_tuples: { tuple_keys: [testOverlay] },
    });
    expect(await capturedRequests(request, primary.path + "/check")).toEqual([]);
    await expect(list).toHaveText([returned.id]);
  };
  // A missing picker entry is the baseline failure. Always execute the independent known-omission control.
  if (options.includes(returned.id)) await inspect(returned);
  await inspect(omitted);
}

test("C8 ListObjects comparison can inspect its alternate-only result and a known omission", async ({ page, request }) => {
  const returned = { ...routeGrant, object: "document:alternate_only" };
  const omitted = { ...routeGrant, object: "document:known_omission" };
  const targets = await openListComparison(page, request, "ListObjects identities",
    { ...returned, condition: { name: "region_guard" } }, omitted.object);
  await page.getByRole("combobox", { name: "Operation", exact: true }).selectOption("list-objects");
  await page.getByRole("combobox", { name: "View as", exact: true }).selectOption(routeGrant.user);
  await page.getByRole("combobox", { name: "Object type", exact: true }).selectOption("document");
  await page.getByRole("combobox", { name: "Relation", exact: true }).selectOption("viewer");
  await run(page).click();
  await inspectAlternate(page, request, targets, routeGrant.object, { id: returned.object, tuple: returned }, { id: omitted.object, tuple: omitted });
});

test("C8 ListUsers comparison can inspect its alternate-only result and a known omission", async ({ page, request }) => {
  const returned = { ...routeGrant, user: "user:alternate_only" };
  const omitted = { ...routeGrant, user: "user:known_omission" };
  const targets = await openListComparison(page, request, "ListUsers identities",
    { ...returned, condition: { name: "region_guard" } }, omitted.user);
  await page.getByRole("combobox", { name: "Operation", exact: true }).selectOption("list-users");
  await page.getByRole("combobox", { name: "Object", exact: true }).selectOption(routeGrant.object);
  await page.getByRole("combobox", { name: "Relation", exact: true }).selectOption("viewer");
  await page.getByRole("combobox", { name: "User type or userset", exact: true }).selectOption("user");
  await run(page).click();
  await inspectAlternate(page, request, targets, routeGrant.user, { id: returned.user, tuple: returned }, { id: omitted.user, tuple: omitted });
});

const durationDsl = baseDsl.replace("define viewer: [user]", "define viewer: [user with elapsed]")
  .replace("define editor: [user]", "define editor: [user with elapsed]")
  + '\n\ncondition elapsed(delay: duration) {\n  delay >= duration("0s")\n}\n';
const durationSpellings = ["0", ".5s", "+1s", "1h2m3.5s", "9223372036854775807ns"];

/** Open a real Check for a conditional grant; only the authored metadata supplies represented values. */
async function openDurationCheck(page: Page, request: APIRequestContext, name: string, dsl: string, represented: Tuple[] = []) {
  const grant = { ...routeGrant, condition: { name: "elapsed" } };
  const target = await policyFixture(request, name, dsl, [grant]);
  await setDraft(request, target, { yaml: toYaml([grant, ...represented]), baseline: [grant] },
    { autoSave: false, autoPublish: false, resetSelections: true });
  await openTarget(page, target, "queries");
  await selectCheck(page);
  await page.getByText("Condition context", { exact: true }).click();
  return target;
}

/** Observe an actual workbench Check, leaving request serialization independent of the UI form. */
async function expectDurationCheck(page: Page, request: APIRequestContext,
  target: Awaited<ReturnType<typeof openDurationCheck>>, context: Record<string, string | string[]>, allowed = true) {
  const body = { authorization_model_id: target.revision, tuple_key: routeGrant, context };
  const path = target.path + "/check";
  await clearTraffic(request);
  await run(page).click();
  await expect.configure({ soft: true }).poll(() => capturedRequests(request, path), { timeout: 1250, message: JSON.stringify(context) })
    .toContainEqual(body);
  if ((await capturedRequests(request, path)).length) {
    await expect(page.getByRole("article").getByText(allowed ? "Allowed" : "Denied", { exact: true })).toBeVisible();
    await expect(run(page)).toBeEnabled();
  }
  expect((await postToEngine(request, path, body)).allowed, "stock OpenFGA accepts this exact duration spelling").toBe(allowed);
}

test("C9 manual duration inputs preserve stock spellings through the actual Check request", async ({ page, request }) => {
  const target = await openDurationCheck(page, request, "Manual duration spelling", durationDsl);
  const field = page.getByRole("textbox", { name: /^delay/i });
  for (const delay of durationSpellings) {
    await field.fill(delay);
    await expectDurationCheck(page, request, target, { delay });
  }
  const delay = "-9223372036854775808ns";
  await field.fill(delay);
  await expectDurationCheck(page, request, target, { delay }, false);
});

test("C9 represented duration values remain selectable and preserve the exact Check context", async ({ page, request }) => {
  const advertised = durationSpellings.map((delay, index) => ({ ...companionGrant, object: "document:duration_" + index,
    condition: { name: "elapsed", context: { delay } } }));
  const target = await openDurationCheck(page, request, "Represented durations", durationDsl, advertised);
  const source = page.getByRole("combobox", { name: "delay context source", exact: true });
  const labels = await source.getByRole("option").allTextContents();
  expect.soft(labels).toEqual(expect.arrayContaining(durationSpellings.map((duration) => JSON.stringify(duration))));
  for (const delay of durationSpellings) {
    const label = JSON.stringify(delay);
    if (labels.includes(label)) await source.selectOption({ label });
    else continue; // The missing choice already fails; still run the ordinary spellings on the baseline.
    await expectDurationCheck(page, request, target, { delay });
  }
});

test("C9 nested duration values preserve every element on the wire", async ({ page, request }) => {
  const dsl = durationDsl.replace('delay: duration', 'samples: list<duration>')
    .replace('delay >= duration("0s")', 'samples.all(sample, sample >= duration("0s"))');
  const target = await openDurationCheck(page, request, "Nested duration spelling", dsl);
  const samples = ["0", ".5s", "+1s", "1s"];
  await page.getByRole("textbox", { name: /^samples/i }).fill(JSON.stringify(samples));
  await expectDurationCheck(page, request, target, { samples });
});

test("C9 malformed and overflowing duration inputs identify the field before dispatch", async ({ page, request }) => {
  const target = await openDurationCheck(page, request, "Invalid duration diagnostics", durationDsl);
  const field = page.getByRole("textbox", { name: /^delay/i });
  const path = target.path + "/check";
  const proxy = "http://127.0.0.1:" + (process.env.FGA_TEST_PROXY_PORT ?? "35492");
  for (const delay of ["not-a-duration", "9223372036854775808ns", "-9223372036854775809ns"]) {
    await field.fill(delay);
    await clearTraffic(request);
    await run(page).click();
    await expect(run(page)).toBeEnabled();
    await expect.soft(page.getByRole("status").filter({ hasText: /invalid condition value.*delay/i }))
      .toBeVisible({ timeout: 1000 });
    expect.soft(await capturedRequests(request, path), delay).toEqual([]);
    const rejected = await request.post(proxy + path, { data: {
      authorization_model_id: target.revision, tuple_key: routeGrant, context: { delay },
    } });
    expect(rejected.status(), "stock OpenFGA rejects the exact invalid spelling").toBe(400);
  }
});
