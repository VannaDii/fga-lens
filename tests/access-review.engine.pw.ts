import { randomUUID } from "node:crypto";
import { transformer } from "@openfga/syntax-transformer";
import { expect, test, type APIRequestContext, type Locator, type Page, type Request as BrowserRequest } from "@playwright/test";

import {
  appRequest, boundDraft, engineAllows, fetchInstances, gateState, holdAction, openTarget, policyFixture,
  setDraft, workspace, writeEngine, type FixtureTarget,
} from "./finding-helpers";
import {
  attachment, campaign, changedReviewModel, coastal, detached, directEdit, directMembership, directParent,
  editor, groupGrant, inland, inverse, islands, joint, member, nestedMembership, notice, oldReviewModel,
  oldRevisionLink, remote, reviewModel, shared, scopeObjects, scopeTuples, storedMarker, tide, unrelated,
} from "./access-review-fixture";
import { armTransport, capturedRequests, clearTraffic, postToEngine } from "./workbench-fixtures";

/** Install the obsolete link on its accepting revision, then select the current immutable model. */
async function installReview(request: APIRequestContext) {
  const older = await policyFixture(request, "Access review synthetic fixture", oldReviewModel, scopeTuples);
  await writeEngine(request, older, { writes: { tuple_keys: [oldRevisionLink] } });
  return installRevision(request, older, reviewModel);
}

/** Use the ordinary provider Check to establish both decisions independently of Access Review. */
async function expectKnownDecisions(request: APIRequestContext, target: FixtureTarget) {
  expect(await engineAllows(request, target, { user: editor, object: campaign, relation: "can_edit" })).toBe(true);
  expect(await engineAllows(request, target, { user: member, object: campaign, relation: "can_edit" })).toBe(false);
  expect(await engineAllows(request, target, { user: member, object: campaign, relation: "can_view" })).toBe(true);
  expect(await engineAllows(request, target, { user: editor, object: coastal, relation: "can_view" })).toBe(false);
}

/** Open the actual registered screen and check the HTTP contract before interacting with it. */
async function openReview(page: Page) {
  const entry = await page.goto("/explore");
  expect(entry?.status(), "GET /explore should serve Explore").toBe(200);
  await expect(page.getByRole("heading", { name: "Explore", exact: true })).toBeVisible();
}

test("Explore uses its named route and appears last in navigation", async ({ page }) => {
  await openReview(page);
  await page.goto("/access-review");
  await expect(page).toHaveURL(/\/explore$/);
  const navigation = page.getByRole("navigation", { name: "Workbench", exact: true });
  await expect(navigation.getByRole("link", { name: "Explore", exact: true })).toHaveAttribute("href", "/explore");
  const labels = (await navigation.getByRole("link").allTextContents()).map((label) => label.trim());
  expect(labels.at(-1)).toBe("Explore");
  expect(labels.at(-2)).toBe("Batches");
  await expect(page.getByRole("combobox", { name: "Store", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Model revision", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveAccessibleDescription(/^(Connected|Offline)$/);
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(startAt(page)).toBeVisible();
  await expect(viewAs(page)).toBeVisible();
  await expect(refresh(page)).toBeVisible();
});

test("access catalog admits the installed target and returns stored organization and person candidates", async ({ request }) => {
  const installed = await installReview(request);
  const target = { store: installed.store, revision: installed.revision };
  await expectKnownDecisions(request, installed);

  const response = await appRequest(request, { action: "access-review-catalog", target, job: randomUUID() });
  expect(response.status(), "same-origin access-review-catalog should accept a real installed target").toBe(200);
  const catalog = await response.json();
  expect(catalog.target).toEqual(target);
  expect(catalog.objects).toEqual(expect.arrayContaining([tide, editor, member, remote]));
  expect(catalog.objects).not.toContain("user:*");
});

test("stock Check and Instances controls agree on the same stored Access Review fixture", async ({ page, request }) => {
  const target = await installReview(request);
  await expectKnownDecisions(request, target);
  await openTarget(page, target, "instances");
  await fetchInstances(page);
  await expect(page.getByRole("heading", { name: "Instance graph", exact: true })).toBeVisible();
  const yaml = page.getByRole("textbox", { name: "Tuple YAML", exact: true });
  await expect(yaml).toHaveValue(/campaign:launch/);
  await expect(yaml).toHaveValue(/user:sequoia-editor/);
  const focus = page.getByRole("combobox", { name: "Focus instance", exact: true });
  await focus.selectOption(campaign);
  await expect(focus).toHaveValue(campaign);
});

/** Install another immutable revision without changing fixture tuples. */
async function installRevision(request: APIRequestContext, target: FixtureTarget, dsl: string): Promise<FixtureTarget> {
  const installed: { authorization_model_id: string } = await postToEngine(request, target.path + "/authorization-models",
    transformer.transformDSLToJSONObject(dsl));
  return { ...target, revision: installed.authorization_model_id };
}

/** Enter the review with the explicitly installed target, keeping root and person unset. */
async function selectTarget(page: Page, target: FixtureTarget) {
  await openReview(page);
  const store = page.getByRole("combobox", { name: "Store", exact: true });
  const model = page.getByRole("combobox", { name: "Model revision", exact: true });
  await store.selectOption(target.store);
  await model.selectOption(target.revision);
  await expect(store).toHaveValue(target.store);
  await expect(model).toHaveValue(target.revision);
}

const startAt = (page: Page) => page.getByRole("combobox", { name: "Start at", exact: true });
const viewAs = (page: Page) => page.getByRole("combobox", { name: "View as", exact: true });
const outline = (page: Page) => page.getByRole("region", { name: "Access outline", exact: true });
const refresh = (page: Page) => page.getByRole("button", { name: "Refresh", exact: true });
const launch = "Launch";

/** Find the specifically labelled outline entry independently of the graph's drawing library. */
function resource(page: Page, label: string) {
  const id = outline(page).getByText(new RegExp("^" + label + "$", "i"));
  return id.locator("xpath=ancestor::*[self::li or self::article or @role='treeitem' or @role='listitem'][1]");
}

/** Match a reason-bearing action by the leading action label within its own resource entry. */
function action(entry: Locator, label: string) {
  return entry.getByRole("button", { name: new RegExp("^" + label + "(?:$|\\s|[·:])", "i") });
}

/** Verify a decision is conveyed in the accessible name or visible label of the exact action. */
async function expectVerdict(entry: Locator, label: string, outcome: string) {
  const expected = new RegExp("\\b" + outcome + "\\b", "i");
  const namedStatus = entry.getByText(new RegExp("^" + label + "[\\s:·–—]+" + outcome + "$", "i"));
  const inspectable = action(entry, label);
  const control = /^(Allowed|Denied)$/.test(outcome) ? inspectable : inspectable.or(namedStatus).first();
  await expect(control).toBeVisible();
  await expect.poll(async () => (await control.ariaSnapshot()) + "\n" + await control.innerText())
    .toMatch(expected);
}

/** Select a known subject only after the root's selector is ready. */
async function selectReview(page: Page, subject: string, root = tide) {
  await startAt(page).selectOption(root);
  await viewAs(page).selectOption(subject);
  await expect(startAt(page)).toHaveValue(root);
  await expect(viewAs(page)).toHaveValue(subject);
}

/** Locate the active Why summary without matching action names elsewhere on the page. */
function why(page: Page) {
  const heading = page.getByRole("heading", { name: /^Why(?:\b|$)/i });
  return heading.locator("xpath=ancestor::*[self::aside or self::section or @role='region' or @role='dialog'][1]");
}

/** Compare the exact tuples sent through the adapter with a hand-authored check inventory. */
const expectedPairs: Record<string, string[]> = {
  [tide]: ["can_view", "include", "viewer"], [inverse]: ["can_view", "parent"],
  [coastal]: ["can_view", "parent"], [inland]: ["can_view", "parent"], [islands]: ["can_view", "parent"], [shared]: ["can_view", "parent"],
  [campaign]: ["blocked", "can_edit", "can_publish", "can_review", "can_view", "editor", "parent", "publish", "publisher"],
  [joint]: ["blocked", "can_edit", "can_publish", "can_review", "can_view", "editor", "parent", "publish", "publisher"],
  [notice]: ["parent", "signoff"], [attachment]: ["parent"],
};

type BatchBody = {
  authorization_model_id: string;
  consistency: string;
  checks: { correlation_id: string; tuple_key: { user: string; object: string; relation: string };
    context?: Record<string, unknown> }[];
};

/** Extract only the review's real higher-consistency engine operations. */
async function capturedBatches(request: APIRequestContext, target: FixtureTarget): Promise<BatchBody[]> {
  return capturedRequests(request, target.path + "/batch-check");
}

/** Verify the exact check cardinality and subject, including deep or shared resources. */
async function expectBatches(request: APIRequestContext, target: FixtureTarget, subject: string,
  context: Record<string, unknown> = {}) {
  const pairs = Object.entries(expectedPairs).flatMap(([object, relations]) =>
    relations.map((relation) => [object, relation].join("#"))).sort();
  await expect.poll(async () => (await capturedBatches(request, target)).flatMap(({ checks }) =>
    checks.filter(({ tuple_key }) => tuple_key.user === subject)).map(({ tuple_key }) =>
    [tuple_key.object, tuple_key.relation].join("#")).sort()).toEqual(pairs);

  const batches = (await capturedBatches(request, target)).filter(({ checks }) =>
    checks.some(({ tuple_key }) => tuple_key.user === subject));
  for (const batch of batches) {
    expect(batch.authorization_model_id).toBe(target.revision);
    expect(batch.consistency).toBe("HIGHER_CONSISTENCY");
    expect(batch.checks.length).toBeGreaterThan(0);
    expect(batch.checks.length).toBeLessThanOrEqual(25);
    expect(new Set(batch.checks.map(({ correlation_id }) => correlation_id)).size).toBe(batch.checks.length);
    for (const item of batch.checks) {
      expect(item.correlation_id).toMatch(/^[a-zA-Z0-9-]{1,36}$/);
      expect(item.tuple_key.user).toBe(subject);
      expect(item.context ?? {}).toEqual(context);
    }
  }
}

test("AR01 rolls up a shared descendant for both parents without duplicating scope or refetching on person change",
  async ({ page, request }) => {
    const target = await installReview(request);
    await expectKnownDecisions(request, target);
    expect(await engineAllows(request, target, { object: joint, user: editor, relation: "can_edit" })).toBe(true);
    const draftOnly = "campaign:workspace-only";
    await setDraft(request, target, { inventory: [draftOnly], yaml: [
      "- user: " + coastal, "  object: " + draftOnly, "  relation: parent", "",
    ].join("\n") }, { autoSave: false, autoPublish: false, resetSelections: true });
    await clearTraffic(request);
    await selectTarget(page, target);
    const rootOptions = startAt(page).locator('optgroup[label="Organization"] option');
    await expect(rootOptions).toHaveCount(3);
    const realRoots = (await rootOptions.evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value))).filter(Boolean).sort();
    expect(realRoots).toEqual([detached, tide, unrelated].sort());
    expect(await capturedBatches(request, target)).toEqual([]);
    await selectReview(page, editor);

    const coastalEntry = resource(page, "Coastal");
    const inlandEntry = resource(page, "Inland");
    const islandsEntry = resource(page, "Islands");
    await expectVerdict(coastalEntry, "View", "Denied");
    await expectVerdict(inlandEntry, "View", "Denied");
    await expect(islandsEntry).toHaveAttribute("data-muted", "true");
    await expect(page.getByText("No access for the actions checked", { exact: true })).toHaveCount(0);
    await expectVerdict(resource(page, launch), "Edit", "Allowed");
    await expectBatches(request, target, editor);
    const reads = await capturedRequests(request, target.path + "/read");
    expect(reads.length).toBeGreaterThanOrEqual(2);
    await expect(resource(page, "Shared")).toHaveCount(1);
    const chart = page.getByRole("region", { name: "Access chart", exact: true });
    const islandsCard = chart.locator(".review-graph-card").filter({ has: page.getByText("Islands", { exact: true }) });
    await expect(islandsCard).toHaveAttribute("data-muted", "true");
    await expect(coastalEntry).toHaveAttribute("data-muted", "true");
    const collapse = coastalEntry.getByRole("button", { name: "Collapse Coastal", exact: true });
    const branchLayout = await chartLayout(page);

    await collapse.click();
    await viewAs(page).selectOption(member);
    await expectBatches(request, target, member);
    await expect(resource(page, launch)).toHaveCount(0);
    await coastalEntry.getByRole("button", { name: "Expand Coastal", exact: true }).click();
    await expectVerdict(resource(page, launch), "Edit", "Denied");
    await expectVerdict(resource(page, launch), "View", "Allowed");
    await expect(islandsCard).toHaveAttribute("data-allowed", "true");
    expect(await capturedRequests(request, target.path + "/read")).toEqual(reads);
    expect(await chartLayout(page)).toEqual(branchLayout);
    await expect(outline(page)).not.toContainText(/workspace-only|old-link|unrelated|sequoia-outer/i);
    expect(Object.keys(expectedPairs).sort()).toEqual([...scopeObjects, inverse].sort());
    expect(await capturedRequests(request, target.path + "/write")).toEqual([]);
  });

/** Require exact key components together within a supporting evidence row. */
async function expectSupportingTuple(panel: Locator, tuple: { user: string; relation: string; object: string }) {
  const rows = panel.getByRole("listitem").filter({ hasText: tuple.user }).filter({ hasText: tuple.relation })
    .filter({ hasText: tuple.object });
  await expect(rows).toHaveCount(1);
}

test("AR02 explains the original direct grant and nested-group inheritance with exact later observations",
  async ({ page, request }) => {
    const target = await installReview(request);
    await expectKnownDecisions(request, target);
    await selectTarget(page, target);
    await selectReview(page, editor);
    const launchEntry = resource(page, launch);
    await expectVerdict(launchEntry, "Edit", "Allowed");
    await action(launchEntry, "Edit").click();
    const panel = why(page);
    await expect(panel).toContainText("Observed after the check");
    await expect(panel).toContainText(/direct/i);
    await expect(panel).toContainText(editor);
    await expectSupportingTuple(panel, directEdit);
    await panel.getByRole("button", { name: /^Close\b/i }).click();

    await viewAs(page).selectOption(member);
    await expectVerdict(launchEntry, "View", "Allowed");
    await action(launchEntry, "View").click();
    await expect(panel).toContainText("Observed after the check");
    await expect(panel).toContainText(/group/i);
    await expect(panel).toContainText(member);
    for (const edge of [directMembership, nestedMembership, groupGrant, directParent]) await expectSupportingTuple(panel, edge);
    await expect(outline(page)).not.toContainText(/sequoia-outer|sequoia-inner|old-link/i);
  });

test("AR03 distinguishes actual exclusion, missing context, valid context outcomes and typed input failure",
  async ({ page, request }) => {
    const target = await installReview(request);
    const published = { user: editor, object: campaign, relation: "can_publish" };
    expect(await engineAllows(request, target, published)).toBe(false);
    expect(await engineAllows(request, target, { ...published, relation: "publish" })).toBe(true);
    const checking = { ...published, relation: "can_review" };
    const missing = await postToEngine(request, target.path + "/batch-check", {
      authorization_model_id: target.revision, consistency: "HIGHER_CONSISTENCY",
      checks: [{ correlation_id: "missing", tuple_key: checking }, { correlation_id: "valid", tuple_key: directEdit }],
    });
    expect(missing.result.valid).toEqual({ allowed: true });
    expect(missing.result.missing).toMatchObject({ error: { input_error: "validation_error", message: expect.stringMatching(/region/) } });
    await clearTraffic(request);
    await selectTarget(page, target);
    await selectReview(page, editor);
    const entry = resource(page, launch);
    await expectVerdict(entry, "Publish", "Denied");
    await expectVerdict(entry, "Edit", "Allowed");
    await expectVerdict(entry, "Review", "Needs context");
    await action(entry, "Publish").click();
    const panel = why(page);
    await expect(panel).toContainText(/block|exclu/i);
    await expectSupportingTuple(panel, { ...published, relation: "blocked" });
    await panel.getByRole("button", { name: /^Close\b/i }).click();
    await expect(page.locator("body")).not.toContainText(/failed to evaluate|missing context parameters|synthetic-stored-region-82/);

    const batches = await capturedBatches(request, target);
    expect(batches.some(({ checks }) => checks.some(({ tuple_key }) => tuple_key.relation === "can_review")
      && checks.some(({ tuple_key }) => tuple_key.relation === "can_edit"))).toBe(true);
    await page.getByText("Condition context", { exact: true }).click();
    const delay = page.getByRole("textbox", { name: /^delay\b/i });
    const region = page.getByRole("textbox", { name: /^region\b/i });
    await expect(page.getByText(storedMarker, { exact: true })).toHaveCount(0);
    await delay.fill("synthetic-invalid-duration");
    await expect(delay).toBeFocused();
    await expect(page.getByText(/(?:invalid.*delay|delay.*(?:invalid|required|duration))/i).filter({ visible: true })).toBeVisible();
    expect(await capturedBatches(request, target)).toEqual(batches);

    await delay.fill("1s");
    const emptyRegion = page.getByRole("checkbox", { name: "Send an empty string for region", exact: true });
    await emptyRegion.check();
    await expectVerdict(entry, "Review", "Denied");
    expect(await capturedBatches(request, target)).toEqual(expect.arrayContaining([expect.objectContaining({
      checks: expect.arrayContaining([expect.objectContaining({ tuple_key: checking, context: { region: "", delay: "1s" } })]),
    })]));
    await emptyRegion.uncheck();
    await region.fill(storedMarker);
    const matching = { region: storedMarker, delay: "1s" };
    await expectVerdict(entry, "Review", "Allowed");
    expect(await capturedBatches(request, target)).toEqual(expect.arrayContaining([expect.objectContaining({
      authorization_model_id: target.revision, checks: expect.arrayContaining([expect.objectContaining({
        tuple_key: checking, context: matching,
      })]),
    })]));
    expect((await postToEngine(request, target.path + "/check", {
      authorization_model_id: target.revision, tuple_key: checking, context: matching, consistency: "HIGHER_CONSISTENCY",
    })).allowed).toBe(true);
    const mismatch = { region: "synthetic-nonmatching-region-72", delay: "1s" };
    await region.fill(mismatch.region);
    await expectVerdict(entry, "Review", "Denied");
    expect((await postToEngine(request, target.path + "/check", {
      authorization_model_id: target.revision, tuple_key: checking, context: mismatch, consistency: "HIGHER_CONSISTENCY",
    })).allowed).toBe(false);
  });

/** Measure real rendered positions and the visible viewport of the React Flow chart. */
async function chartLayout(page: Page) {
  const viewport = page.locator(".react-flow__viewport");
  await expect(viewport).toHaveCount(1);
  const nodes = viewport.locator(".react-flow__node");
  const labels = ["Coastal", "Inland", "Islands", launch];
  const positions = await Promise.all(labels.map(async (label) => {
    const node = nodes.filter({ has: page.getByText(new RegExp("^" + label + "$", "i")) });
    await expect(node).toBeVisible();
    const box = await node.boundingBox();
    expect(box).not.toBeNull();
    return { label, x: box?.x, y: box?.y };
  }));
  return { positions, viewport: await viewport.evaluate((element) => getComputedStyle(element).transform) };
}

test("AR04 reads dynamic actions from the selected installed revision and distinguishes relationship-only cards",
  async ({ page, request }) => {
    const original = await installReview(request);
    const changed = await installRevision(request, original, changedReviewModel);
    expect(await engineAllows(request, original, { object: campaign, user: editor, relation: "can_edit" })).toBe(true);
    expect(await engineAllows(request, changed, { object: campaign, user: editor, relation: "can_update" })).toBe(true);
    await setDraft(request, original, { dsl: reviewModel, validDsl: reviewModel }, {
      autoSave: false, autoPublish: false, resetSelections: true,
    });
    await selectTarget(page, original);
    await selectReview(page, editor);
    await expectVerdict(resource(page, launch), "Edit", "Allowed");
    await expect(resource(page, "Bulletin")).toHaveAttribute("data-matches", "true");
    await expect(action(resource(page, "Bulletin"), "Edit")).toHaveCount(0);
    await expect(resource(page, "Brief").getByRole("button", { name: "Relationship parent · Does not match", exact: true })).toBeVisible();
    await expect(resource(page, "Brief")).toHaveAttribute("data-muted", "true");
    await expect(action(resource(page, "Brief"), "View")).toHaveCount(0);

    await clearTraffic(request);
    await page.getByRole("combobox", { name: "Model revision", exact: true }).selectOption(changed.revision);
    await selectReview(page, editor);
    const entry = resource(page, launch);
    await expectVerdict(entry, "Update", "Allowed");
    await expect(action(entry, "Edit")).toHaveCount(0);
    const batches = await capturedBatches(request, changed);
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.every(({ authorization_model_id }) => authorization_model_id === changed.revision)).toBe(true);
    const sent = batches.flatMap(({ checks }) => checks.map(({ tuple_key }) => tuple_key));
    expect(sent).toContainEqual({ object: campaign, user: editor, relation: "can_update" });
    expect(sent).not.toContainEqual({ object: campaign, user: editor, relation: "can_edit" });
  });

/** Get the current review command's public target without the test fixture's transport path. */
function targetBinding({ store, revision }: FixtureTarget) {
  return { store, revision };
}

test("AR05 discards a real previous person's denial even if its check reply arrives after the new grant",
  async ({ page, request }) => {
    const target = await installReview(request);
    await expectKnownDecisions(request, target);
    await selectTarget(page, target);
    await startAt(page).selectOption(tide);

    let captured: Record<string, unknown> | undefined;
    const oldCheck = holdAction(page, "access-review-check", "after checkpoint", (payload) => {
      if (payload.subject !== member) return false;
      captured = payload;
      return true;
    });
    await oldCheck.ready;
    try {
      const requestSent = appRequestSent(page, "access-review-check", (payload) => payload.subject === member);
      await viewAs(page).selectOption(member);
      const oldRequestSettled = requestSettled(page, await requestSent);
      await oldCheck.arrived;
      expect(captured).toMatchObject({
        target: targetBinding(target), subject: member, context: {},
        checks: expect.arrayContaining([expect.objectContaining({ object: campaign, relation: "can_edit" })]),
      });
      await viewAs(page).selectOption(editor);
      const entry = resource(page, launch);
      await expectVerdict(entry, "Edit", "Allowed");
      oldCheck.release();
      await oldRequestSettled;
      await expectVerdict(entry, "Edit", "Allowed");
      await expect(viewAs(page)).toHaveValue(editor);
      const batches = await capturedBatches(request, target);
      expect(batches.flatMap(({ checks }) => checks).map(({ tuple_key }) => tuple_key))
        .toEqual(expect.arrayContaining([
          { user: member, object: campaign, relation: "can_edit" },
          { user: editor, object: campaign, relation: "can_edit" },
        ]));
    } finally {
      oldCheck.release();
    }
  });

test("AR05 discards a real Why reply after another decision becomes the active inspection", async ({ page, request }) => {
  const target = await installReview(request);
  await expectKnownDecisions(request, target);
  await selectTarget(page, target);
  await selectReview(page, member);
  const launchEntry = resource(page, launch);
  await expectVerdict(launchEntry, "View", "Allowed");
  await expectVerdict(launchEntry, "Edit", "Denied");

  let old: Record<string, unknown> | undefined;
  const previous = holdAction(page, "evidence", "after checkpoint", (payload) => {
    const { input } = payload as { input?: { relation?: string } };
    if (input?.relation !== "can_view") return false;
    old = payload;
    return true;
  });
  await previous.ready;
  try {
    const requestSent = appRequestSent(page, "evidence", (payload) =>
      (payload.input as { relation?: string })?.relation === "can_view");
    await action(launchEntry, "View").click();
    const previousRequestSettled = requestSettled(page, await requestSent);
    await previous.arrived;
    expect(old).toMatchObject({
      target: targetBinding(target), outcome: true,
      input: { operation: "check", user: member, object: campaign, relation: "can_view", consistent: true },
      job: expect.any(String),
    });
    await action(launchEntry, "Edit").click();
    const panel = why(page);
    await expect(panel).toContainText("can_edit");
    await expect(panel).toContainText(/Denied/i);
    previous.release();
    await previousRequestSettled;
    await expect(panel).not.toContainText("can_view");
    await expect(panel).not.toContainText(groupGrant.user);
  } finally {
    previous.release();
  }
});

test("AR05 preserves the old verdict when the post-proof Check observes a removed grant", async ({ page, request }) => {
  const target = await installReview(request);
  expect(await engineAllows(request, target, { ...directEdit, relation: "can_edit" })).toBe(true);
  await selectTarget(page, target);
  await selectReview(page, editor);
  const entry = resource(page, launch);
  await expectVerdict(entry, "Edit", "Allowed");

  await clearTraffic(request);
  const expandGate = "access-review-final-expand";
  await armTransport(request, [{ path: target.path + "/expand", kind: "gate-response", gate: expandGate }]);
  try {
    await action(entry, "Edit").click();
    await expect.poll(() => gateState(request)).toContain(expandGate);
    const originalCheck = {
      authorization_model_id: target.revision, consistency: "HIGHER_CONSISTENCY",
      tuple_key: { ...directEdit, relation: "can_edit" },
    };
    expect(await capturedRequests(request, target.path + "/check")).not.toContainEqual(originalCheck);
    await writeEngine(request, target, { deletes: { tuple_keys: [directEdit] } });
    await gateState(request, expandGate);

    await expect(why(page)).toContainText("Reason undetermined");
    await expect(why(page)).toContainText(/Allowed/i);
    await expect(why(page)).not.toContainText("Observed after the check");
    await expectVerdict(entry, "Edit", "Allowed");
    const verifiesOriginal = (await capturedRequests(request, target.path + "/check"))
      .filter(({ tuple_key }) => tuple_key?.user === editor && tuple_key.object === campaign && tuple_key.relation === "can_edit");
    expect(verifiesOriginal).toHaveLength(1);
    expect(verifiesOriginal[0]).toMatchObject(originalCheck);
    expect(await engineAllows(request, target, originalCheck.tuple_key)).toBe(false);

    await why(page).getByRole("button", { name: /^Close\b/i }).click();
    await refresh(page).click();
    await expectVerdict(entry, "Edit", "Denied");
    expect((await capturedRequests(request, target.path + "/read")).length).toBeGreaterThan(0);
  } finally {
    await gateState(request, expandGate);
  }
});

test("AR03 marks a whole provider fault unavailable, keeps valid denials distinct and can refresh",
  async ({ page, request }) => {
    const target = await installReview(request);
    await expectKnownDecisions(request, target);
    await selectTarget(page, target);
    await startAt(page).selectOption(tide);
    await clearTraffic(request);
    await armTransport(request, [{ path: target.path + "/batch-check", kind: "service-error" }]);
    await viewAs(page).selectOption(editor);
    const entry = resource(page, launch);
    const other = resource(page, "Joint");
    const editUnavailable = (item: Locator) => item.getByRole("button", { name: "Edit · Check unavailable", exact: true });
    const editAllowed = (item: Locator) => item.getByRole("button", { name: "Edit · Allowed", exact: true });
    await expect(editUnavailable(entry).or(editUnavailable(other))).toBeDisabled();
    await expect(editAllowed(entry).or(editAllowed(other))).toBeEnabled();
    const launchUnavailable = await editUnavailable(entry).isVisible();
    await expect(launchUnavailable ? entry : other).not.toHaveAttribute("data-muted");
    await expectVerdict(launchUnavailable ? other : entry, "View", "Denied");
    await expect(page.locator("body")).not.toContainText("synthetic_untrusted_error_52");
    expect(await capturedBatches(request, target)).toHaveLength(2);

    await refresh(page).click();
    await expectVerdict(entry, "Edit", "Allowed");
    await expectVerdict(entry, "Publish", "Denied");
    expect(await capturedRequests(request, target.path + "/write")).toEqual([]);
  });

/** Seed enough real tuples to produce a second Read page and several batches of scoped checks. */
async function fillReview(request: APIRequestContext, target: FixtureTarget) {
  const descendants = Array.from({ length: 12 }, (_value, index) => ({
    user: coastal, relation: "parent", object: "campaign:scale-" + index,
  }));
  const outside = Array.from({ length: 81 }, (_value, index) => ({
    user: "user:outside-" + index, relation: "viewer", object: unrelated,
  }));
  await writeEngine(request, target, { writes: { tuple_keys: [...descendants, ...outside] } });
}

/** Match a browser command by its actual workbench payload and intended selection. */
function commandMatches(request: BrowserRequest, actionName: string, matches: (payload: Record<string, unknown>) => boolean) {
  if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/workbench") return false;
  const payload = request.postDataJSON();
  return payload.action === actionName && matches(payload);
}

/** Observe the exact dispatched request independently of the held transport body. */
function appRequestSent(page: Page, actionName: string, matches: (payload: Record<string, unknown>) => boolean) {
  return page.waitForRequest((request) => commandMatches(request, actionName, matches));
}

/** Match a workbench response by the initiating action and captured input. */
function appReply(page: Page, actionName: string, matches: (payload: Record<string, unknown>) => boolean) {
  return page.waitForResponse((response) => commandMatches(response.request(), actionName, matches));
}

/** Wait until the old browser request has been delivered or genuinely aborted. */
function requestSettled(page: Page, expected: BrowserRequest) {
  return new Promise<void>((resolve) => {
    const receive = (request: BrowserRequest) => {
      if (request !== expected) return;
      page.off("requestfinished", receive);
      page.off("requestfailed", receive);
      resolve();
    };
    page.on("requestfinished", receive);
    page.on("requestfailed", receive);
  });
}

test("AR01 roots without links remain inspectable and a vanished root clears without running any checks",
  async ({ page, request }) => {
    const target = await installReview(request);
    expect(await engineAllows(request, target, { user: remote, object: detached, relation: "can_view" })).toBe(true);
    await selectTarget(page, target);
    await selectReview(page, remote, detached);
    await expect(page.getByText("No linked resources", { exact: true }).first()).toBeVisible();
    await expectVerdict(resource(page, "Detached"), "View", "Allowed");

    await startAt(page).selectOption(tide);
    await expect(resource(page, "Coastal")).toBeVisible();
    await clearTraffic(request);
    let capture: Record<string, unknown> | undefined;
    const repeat = holdAction(page, "access-review-scope", "before dispatch", (payload) => {
      if (payload.root !== detached) return false;
      capture = payload;
      return true;
    });
    await repeat.ready;
    try {
      const disappeared = appReply(page, "access-review-scope", (payload) => payload.root === detached);
      await startAt(page).selectOption(detached);
      await repeat.arrived;
      expect(capture).toMatchObject({ target: targetBinding(target), root: detached, job: expect.any(String) });
      await writeEngine(request, target, { deletes: { tuple_keys: [{ user: remote, relation: "viewer", object: detached }] } });
      repeat.release();
      await disappeared;

      await expect(startAt(page)).toHaveValue("");
      await expect(refresh(page)).toBeVisible();
      await expect(resource(page, "Detached")).toHaveCount(0);
      const batches = await capturedBatches(request, target);
      expect(batches.flatMap(({ checks }) => checks).some(({ tuple_key }) => tuple_key.object === detached)).toBe(false);
    } finally {
      repeat.release();
    }
  });

test("AR01 evaluates the root when the installed model has no concrete containment rules", async ({ page, request }) => {
  const model = [
    "model", "  schema 1.1", "",
    "type identity", "",
    "type user", "  relations", "    define known: [identity:*]", "",
    "type organization", "  relations", "    define can_view: [user:*]",
  ].join("\n");
  const target = await policyFixture(request, "Wildcard-only Access Review model", model, [
    { user: "identity:*", relation: "known", object: editor },
    { user: "user:*", relation: "can_view", object: tide },
  ]);
  expect(await engineAllows(request, target, { user: editor, relation: "can_view", object: tide })).toBe(true);
  await selectTarget(page, target);
  await selectReview(page, editor);
  await expect(page.getByText("No scope relationships defined", { exact: true }).first()).toBeVisible();
  await expectVerdict(resource(page, "Tide"), "View", "Allowed");
  const batches = await capturedBatches(request, target);
  expect(batches.flatMap(({ checks }) => checks.map(({ tuple_key }) => tuple_key)))
    .toEqual([{ user: editor, object: tide, relation: "can_view" }]);
});

test("AR04 shows the full hierarchy and relationship results on the chart without configuring it",
  async ({ page, request }) => {
    const target = await installReview(request);
    expect(await engineAllows(request, target, { user: editor, relation: "publish", object: campaign })).toBe(true);
    expect(await engineAllows(request, target, { user: editor, relation: "can_publish", object: campaign })).toBe(false);
    await selectTarget(page, target);
    await selectReview(page, editor);
    const chart = page.getByRole("region", { name: "Access chart", exact: true });
    const nodes = chart.locator(".react-flow__node");
    await expect(nodes).toHaveCount(scopeObjects.length + 1);
    expect((await nodes.evaluateAll((entries) => entries.map((node) => node.getAttribute("data-id")))).sort())
      .toEqual([...scopeObjects, inverse].sort());
    const entry = nodes.filter({ hasText: "Launch" });
    await expect(entry.getByRole("button", { name: "Publish · Denied", exact: true })).toBeVisible();
    const assignment = entry.getByRole("button", { name: "Relationship publish · Matches", exact: true });
    await expect(assignment).toBeVisible();
    await expect(entry.getByRole("button", { name: "Relationship parent · Does not match", exact: true })).toBeVisible();
    const row = await assignment.boundingBox();
    const card = await entry.boundingBox();
    expect(row!.y + row!.height).toBeLessThan(card!.y + card!.height);
    await expect(page.getByText("Scope relationships", { exact: true })).toHaveCount(0);
    await expect(chart.locator(".react-flow__edge-text").filter({ hasText: /^include$/ })).toBeVisible();
    await expect(nodes.filter({ hasText: "Tide" }).getByRole("button", { name: "Relationship include · Does not match", exact: true })).toBeVisible();

    const viewport = chart.locator(".react-flow__viewport");
    const transform = () => viewport.evaluate((node) => (node as HTMLElement).style.transform);
    const centered = await transform();
    await chart.getByRole("button", { name: "Zoom In", exact: true }).click();
    await expect.poll(transform).not.toBe(centered);
    await chart.getByRole("button", { name: "Recenter chart", exact: true }).click();
    await expect.poll(transform).toBe(centered);
  });

test("Explore chart and outline use the available height when the window resizes", async ({ page, request }) => {
  const target = await installReview(request);
  await selectTarget(page, target);
  await selectReview(page, editor);
  const panels = page.locator(".review-layout > .wb-pane");
  await expect(panels).toHaveCount(2);
  for (const height of [1000, 700]) {
    await page.setViewportSize({ width: 1440, height });
    await expect.poll(() => panels.evaluateAll((panels) => Math.max(...panels.map((panel) => {
      const gutter = parseFloat(getComputedStyle(panel.closest("main")!).paddingBottom);
      return Math.abs(window.innerHeight - panel.getBoundingClientRect().bottom - gutter);
    })))).toBeLessThan(2);
  }
});

test("Explore shares branches and focuses the chart only from the outline eye button", async ({ page, request }) => {
  const target = await installReview(request);
  await selectTarget(page, target);
  await selectReview(page, editor);
  const chart = page.getByRole("region", { name: "Access chart", exact: true });
  const coastalEntry = resource(page, "Coastal");
  const launchEntry = resource(page, launch);
  const launchNode = chart.locator(`[data-id="${campaign}"]`);
  const chartViewport = chart.locator(".react-flow__viewport");
  const transform = () => chartViewport.evaluate((node) => getComputedStyle(node).transform);

  const focusLaunch = launchEntry.getByRole("button", { name: "Focus Launch on chart", exact: true });
  await expect(coastalEntry.locator("xpath=ancestor::li[1]").getByRole("button", { name: "Focus Launch on chart", exact: true })).toBeVisible();
  await chart.getByRole("button", { name: "Collapse Coastal", exact: true }).click();
  await expect(launchNode).toHaveCount(0);
  await expect(launchEntry).toHaveCount(0);
  await coastalEntry.getByRole("button", { name: "Expand Coastal", exact: true }).click();
  await expect(launchNode).toBeVisible();
  await expect(launchEntry).toBeVisible();

  await chart.getByRole("button", { name: "Recenter chart", exact: true }).click();
  const wide = await transform();
  await launchEntry.getByText(launch, { exact: true }).click();
  await action(launchEntry, "Edit").click();
  await expect(why(page)).toBeVisible();
  await expect.poll(transform).toBe(wide);
  await why(page).getByRole("button", { name: "Close Why", exact: true }).click();
  await expect(focusLaunch.locator("svg")).toBeVisible();
  const movement = await chartViewport.evaluateHandle((viewport) => {
    const frames = new Set<string>();
    const observer = new MutationObserver(() => frames.add(viewport.style.transform));
    observer.observe(viewport, { attributes: true, attributeFilter: ["style"] });
    return { frames, observer };
  });
  await focusLaunch.click();
  await expect(launchNode.getByRole("button", { name: launch, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => movement.evaluate(({ frames }) => frames.size)).toBeGreaterThan(2);
  await movement.evaluate(({ observer }) => observer.disconnect());
  await movement.dispose();
  await expect.poll(() => launchNode.evaluate((node) => {
    const card = node.getBoundingClientRect();
    const viewport = node.closest(".react-flow")!.getBoundingClientRect();
    return Math.hypot(card.x + card.width / 2 - viewport.x - viewport.width / 2,
      card.y + card.height / 2 - viewport.y - viewport.height / 2);
  })).toBeLessThan(2);
  await expect(why(page)).toHaveCount(0);
  await chart.getByRole("button", { name: "Recenter chart", exact: true }).click();
  await expect.poll(transform).toBe(wide);
  await chart.getByRole("button", { name: "Tide", exact: true }).click();
  await expect(resource(page, "Tide").getByRole("button", { name: "Focus Tide on chart", exact: true })).toHaveAttribute("aria-pressed", "true");
  const afterSelection = await chartViewport.evaluate(async (node) => {
    for (let frame = 0; frame < 3; frame += 1) await new Promise(requestAnimationFrame);
    return getComputedStyle(node).transform;
  });
  expect(afterSelection).toBe(wide);
});

test("Access Review opens Why next to the card and puts review metadata behind an info button", async ({ page, request }) => {
  const target = await installReview(request);
  await selectTarget(page, target);
  await selectReview(page, editor);
  const info = page.getByRole("region", { name: "Review information", exact: true });
  const infoButton = page.getByRole("button", { name: "Review information", exact: true });
  await expect(page.getByText(/Hierarchy read/).filter({ visible: true })).toHaveCount(0);
  await infoButton.click();
  await expect(info).toContainText("Hierarchy read");
  await expect(info.getByText(/0 unfinished/)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(info).toBeHidden();

  const chart = page.getByRole("region", { name: "Access chart", exact: true });
  const node = chart.locator(`[data-id="${campaign}"]`);
  await resource(page, launch).getByRole("button", { name: "Focus Launch on chart", exact: true }).click();
  const trigger = node.getByRole("button", { name: "Why", exact: true });
  await expect(trigger).toBeEnabled();
  await expect(trigger.locator("svg")).toBeVisible();
  const title = await node.getByRole("button", { name: launch, exact: true }).boundingBox();
  const subtitle = await node.getByText("Campaign", { exact: true }).boundingBox();
  expect(subtitle!.y).toBeGreaterThanOrEqual(title!.y + title!.height);
  const scroll = await page.evaluate(() => window.scrollY);
  await trigger.click();
  const panel = why(page);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Observed after the check");
  await expectSupportingTuple(panel, directEdit);
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
  const anchorBox = await node.boundingBox();
  const panelBox = await panel.boundingBox();
  expect(anchorBox && panelBox && (panelBox.x >= anchorBox.x + anchorBox.width
    || panelBox.x + panelBox.width <= anchorBox.x)).toBe(true);
  await page.getByRole("heading", { name: "Explore", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Close Why", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("Explore shows unavailable results for an object beyond the check service limit", async ({ page, request }) => {
  const target = await installReview(request);
  const longRoot = "division:" + "a".repeat(300);
  const child = "campaign:long-parent-child";
  await writeEngine(request, target, { writes: { tuple_keys: [
    { user: longRoot, relation: "parent", object: child },
    { user: editor, relation: "editor", object: child },
  ] } });
  await selectTarget(page, target);
  await selectReview(page, editor, longRoot);
  const entry = resource(page, "A" + "a".repeat(299));
  await expectVerdict(entry, "View", "Check unavailable");
  await expect(entry.getByRole("button", { name: "Relationship parent · Check unavailable", exact: true })).toBeVisible();
  await expect(entry).not.toHaveAttribute("data-muted");
  await expectVerdict(resource(page, "Long parent child"), "Edit", "Allowed");
});

test("AR05 rejects a later real Read page and marks any retained identical review as stale",
  async ({ page, request }) => {
    const target = await installReview(request);
    await fillReview(request, target);
    const first = await postToEngine(request, target.path + "/read", { page_size: 100, consistency: "HIGHER_CONSISTENCY" });
    expect(first.tuples).toHaveLength(100);
    expect(first.continuation_token).toEqual(expect.any(String));
    expect(first.continuation_token.length).toBeGreaterThan(0);
    await selectTarget(page, target);
    await selectReview(page, editor);
    const entry = resource(page, launch);
    await expectVerdict(entry, "Edit", "Allowed");
    await page.getByRole("button", { name: "Review information", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: / · 0 unfinished$/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await clearTraffic(request);

    const discovery = appReply(page, "access-review-catalog", (payload) =>
      JSON.stringify(payload.target) === JSON.stringify(targetBinding(target)));
    await armTransport(request, [{ path: target.path + "/read", when: "continued", kind: "repeat-token" }]);
    await refresh(page).click();
    const response = await discovery;
    expect(response.status()).toBe(502);
    expect(await response.json()).toMatchObject({ error: "server error", correlationId: expect.any(String) });
    const discoveryNotice = page.getByRole("status").or(page.getByRole("alert")).filter({ hasText: /catalog|failed/i });
    await expect(discoveryNotice.first()).toBeVisible();
    await expect(startAt(page)).toHaveValue(tide);
    await expect(viewAs(page)).toHaveValue(editor);
    if (await entry.isVisible()) await expect(page.getByText(/stale/i).first()).toBeVisible();
    const reads = await capturedRequests(request, target.path + "/read");
    expect(reads).toHaveLength(2);
    expect(reads[0].continuation_token ?? "").toBe("");
    expect(reads[1].continuation_token).toMatch(/\S/);
    expect(await capturedBatches(request, target)).toEqual([]);
    expect(await capturedRequests(request, target.path + "/write")).toEqual([]);
  });

test("AR05 cancels two real in-flight batches and leaves unsent checks incomplete without further dispatch",
  async ({ page, request }) => {
    const target = await installReview(request);
    await fillReview(request, target);
    await selectTarget(page, target);
    await startAt(page).selectOption(tide);
    await clearTraffic(request);
    const gates = ["review-first-batch", "review-second-batch"];
    await armTransport(request, gates.map((gate) => ({ path: target.path + "/batch-check", kind: "gate-response", gate })));
    try {
      await viewAs(page).selectOption(editor);
      await expect.poll(() => gateState(request)).toEqual(expect.arrayContaining(gates));
      const pending = await capturedBatches(request, target);
      expect(pending).toHaveLength(2);
      expect(pending.map(({ checks }) => checks.length)).toEqual([25, 25]);
      expect(pending.every(({ authorization_model_id, consistency, checks }) =>
        authorization_model_id === target.revision && consistency === "HIGHER_CONSISTENCY"
        && checks.every(({ tuple_key, context }) => tuple_key.user === editor && !Object.keys(context ?? {}).length))).toBe(true);

      await page.getByRole("button", { name: "Review information", exact: true }).click();
      await page.getByRole("button", { name: /^Cancel\b.*(?:review|checks)?/i }).click();
      await expect(page.getByRole("status").filter({ hasText: /cancel|unfinished|incomplete/i }).first()).toBeVisible();
      for (const gate of gates) await gateState(request, gate);
      await expect.poll(() => gateState(request)).toEqual([]);
      await expectVerdict(resource(page, "Tide"), "View", "Not yet checked");
      expect(await capturedBatches(request, target)).toEqual(pending);
      expect(await capturedRequests(request, target.path + "/write")).toEqual([]);
    } finally {
      for (const gate of gates) await gateState(request, gate);
    }
  });

test("AR06 persists only review preferences and restores valid selections without publishing an unsaved model",
  async ({ page, request }) => {
    const target = await installReview(request);
    await setDraft(request, target, { dsl: reviewModel, validDsl: reviewModel }, {
      autoSave: false, autoPublish: true, resetSelections: true,
    });
    const before = await workspace(request);
    expect(before.state).toMatchObject({ autoSave: false, autoPublish: true });
    await openTarget(page, target, "model");
    const dsl = page.getByRole("textbox", { name: "OpenFGA authorization model", exact: true });
    const dirty = reviewModel + "\n\ntype synthetic_never_published\n";
    await dsl.fill(dirty);
    await expect(dsl).toHaveValue(dirty);
    expect(boundDraft(await workspace(request), target)).toEqual(boundDraft(before, target));
    await clearTraffic(request);
    const route = await request.get("/explore");
    expect(route.status(), "the Explore navigation destination must be registered").toBe(200);

    await page.getByRole("navigation", { name: "Workbench", exact: true })
      .getByRole("link", { name: "Explore", exact: true }).click();
    await expect(page).toHaveURL(/\/explore$/);
    await selectReview(page, member);
    const entry = resource(page, launch);
    await expectVerdict(entry, "View", "Allowed");
    await page.getByText("Condition context", { exact: true }).click();
    const privateInput = "synthetic-memory-only-review-context-56";
    const region = page.getByRole("textbox", { name: /^region\b/i });
    const evaluated = appReply(page, "access-review-check",
      (payload) => (payload.context as { region?: string })?.region === privateInput);
    await region.fill(privateInput);
    expect((await evaluated).status()).toBe(200);
    await expect.poll(async () => {
      const { state } = await workspace(request);
      const stored = JSON.stringify(state.selections);
      return { route: state.route, root: stored.includes(tide), subject: stored.includes(member) };
    }).toEqual({ route: "explore", root: true, subject: true });
    expect(JSON.stringify((await workspace(request)).state)).not.toContain(privateInput);
    expect(boundDraft(await workspace(request), target)).toEqual(boundDraft(before, target));
    expect(await capturedRequests(request, target.path + "/write")).toEqual([]);
    expect(await capturedRequests(request, target.path + "/authorization-models")).toEqual([]);

    await page.reload();
    await expect(startAt(page)).toHaveValue(tide);
    await expect(viewAs(page)).toHaveValue(member);
    await expect(page.getByRole("combobox", { name: "Store", exact: true })).toHaveValue(target.store);
    await expect(page.getByRole("combobox", { name: "Model revision", exact: true })).toHaveValue(target.revision);
    await page.getByText("Condition context", { exact: true }).click();
    await expect(region).toHaveValue("");
    expect(boundDraft(await workspace(request), target)).toEqual(boundDraft(before, target));

    await writeEngine(request, target, { deletes: { tuple_keys: [directMembership] } });
    await clearTraffic(request);
    const catalog = appReply(page, "access-review-catalog", () => true);
    await page.reload();
    expect((await catalog).status()).toBe(200);
    await expect(startAt(page)).toHaveValue(tide);
    await expect(viewAs(page)).toHaveValue("");
    await expect(viewAs(page).locator('option[value="' + member + '"]')).toHaveCount(0);
    expect(await capturedBatches(request, target)).toEqual([]);
  });

test("AR05 discards an older condition denial for the same person, target and action", async ({ page, request }) => {
  const target = await installReview(request);
  await selectTarget(page, target);
  await selectReview(page, editor);
  const entry = resource(page, launch);
  await expectVerdict(entry, "Review", "Needs context");
  await page.getByText("Condition context", { exact: true }).click();
  const region = page.getByRole("textbox", { name: /^region\b/i });
  const mismatched = "synthetic-obsolete-region-90";
  const isOld = (payload: Record<string, unknown>) => (payload.context as { region?: string })?.region === mismatched;
  let captured: Record<string, unknown> | undefined;
  const oldCheck = holdAction(page, "access-review-check", "after checkpoint", (payload) => {
    if (!isOld(payload)) return false;
    captured = payload;
    return true;
  });
  await oldCheck.ready;
  try {
    const requestSent = appRequestSent(page, "access-review-check", isOld);
    await region.fill(mismatched);
    const oldRequestSettled = requestSettled(page, await requestSent);
    await oldCheck.arrived;
    expect(captured).toMatchObject({
      target: targetBinding(target), subject: editor, context: { region: mismatched },
      checks: expect.arrayContaining([expect.objectContaining({ object: campaign, relation: "can_review" })]),
    });
    const replacement = appReply(page, "access-review-check",
      (payload) => (payload.context as { region?: string })?.region === storedMarker);
    await region.fill(storedMarker);
    expect((await replacement).status()).toBe(200);
    await expectVerdict(entry, "Review", "Allowed");
    oldCheck.release();
    await oldRequestSettled;
    await expectVerdict(entry, "Review", "Allowed");
    await expect(region).toHaveValue(storedMarker);

    const original = { authorization_model_id: target.revision, consistency: "HIGHER_CONSISTENCY",
      tuple_key: { user: editor, object: campaign, relation: "can_review" } };
    expect((await postToEngine(request, target.path + "/check", { ...original, context: { region: mismatched } })).allowed)
      .toBe(false);
    expect((await postToEngine(request, target.path + "/check", { ...original, context: { region: storedMarker } })).allowed)
      .toBe(true);
  } finally {
    oldCheck.release();
  }
});
