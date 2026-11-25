import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { isSeq, parseDocument } from "yaml";

import { baseDsl, fetchInstances, openTarget, policyFixture, routeGrant, setDraft, writeEngine } from "./finding-helpers";

const workshop = "workspace:workshop";
const project = "project:trail";
const guide = "document:guide";
const reference = "document:reference";
const fragment = "fragment:appendix";
const orphan = "document:standalone";
const casey = "user:casey";
const rowan = "user:rowan";

const dsl = [
  "model",
  "  schema 1.1",
  "",
  "type user",
  "",
  "type workspace",
  "  relations",
  "    define steward: [user]",
  "",
  "type project",
  "  relations",
  "    define parent: [workspace]",
  "    define owner: [user]",
  "",
  "type document",
  "  relations",
  "    define parent: [project]",
  "    define reviewer: [user]",
  "",
  "type fragment",
  "  relations",
  "    define parent: [document]",
].join("\n");

const guideReview = { user: casey, relation: "reviewer", object: guide };
const referenceReview = { user: rowan, relation: "reviewer", object: reference };
const fixtureTuples = [
  { user: workshop, relation: "parent", object: project },
  { user: project, relation: "parent", object: guide },
  { user: project, relation: "parent", object: reference },
  { user: guide, relation: "parent", object: fragment },
  { user: casey, relation: "steward", object: workshop },
  { user: rowan, relation: "owner", object: project },
  guideReview,
  referenceReview,
];

/** Fetch a fresh synthetic hierarchy through the app's normal Instances control. */
async function openHierarchy(page: Page, request: APIRequestContext, fixtureName: string) {
  const target = await policyFixture(request, fixtureName, dsl, fixtureTuples);
  await setDraft(request, target, { yaml: "[]\n", baseline: [], inventory: [orphan] }, {
    autoSave: false, autoPublish: false, resetSelections: true,
  });
  await openTarget(page, target, "instances");
  await fetchInstances(page);
  const editor = page.getByRole("textbox", { name: "Tuple YAML", exact: true });
  await expect(editor).toHaveValue(/document:reference/);
  return editor;
}

/** Find a relationship group by its heading and semantic container. */
async function group(page: Page, name: "Parent" | "In focus" | "Children" | "Direct assignments") {
  const heading = page.getByRole("heading", { name, exact: true });
  await expect(heading).toBeVisible({ timeout: 2500 });
  return heading.locator("xpath=ancestor::*[self::section or @role='region' or @role='group'][1]");
}

/** Use stable identifiers in the accessible controls and allow human-readable card labels. */
function focusAction(container: Page | Locator, identifier: string) {
  return container.getByRole("button", { name: new RegExp("^Focus\\b.*" + identifier + "$", "i") });
}

function roleAction(container: Page | Locator, relation: string, object: string) {
  return container.getByRole("button", { name: new RegExp("^Inspect\\b.*" + relation + "\\b.*" + object + "$", "i") });
}

function focusPicker(page: Page) {
  return page.getByRole("combobox", { name: "Focus instance", exact: true });
}

/** Compare the selected YAML row with an independently authored tuple across YAML styles. */
async function expectTupleSource(editor: Locator, expected: typeof guideReview) {
  await expect(editor).toBeFocused();
  const { yaml, start } = await editor.evaluate((element: HTMLTextAreaElement) => ({
    yaml: element.value, start: element.selectionStart,
  }));
  const document = parseDocument(yaml);
  if (!isSeq(document.contents)) throw new Error("The fetched tuple editor must contain a YAML sequence");
  const selected = document.contents.items.findIndex((item) =>
    Boolean(item?.range && item.range[0] <= start && start < item.range[1]));
  expect(selected, "the source action places the cursor within an exact tuple row").toBeGreaterThanOrEqual(0);
  expect(document.toJS()[selected]).toEqual(expected);
}

test("Instances control fetches the synthetic hierarchy and can select a known instance", async ({ page, request }) => {
  const editor = await openHierarchy(page, request, "Relationship layout control");
  await expect(page.getByRole("heading", { name: "Instance graph", exact: true })).toBeVisible();
  await expect(editor).toHaveValue(/workspace:workshop/);
  await expect(editor).toHaveValue(/user:casey/);
  await focusPicker(page).selectOption(project);
  await expect(focusPicker(page)).toHaveValue(project);
  await expect(editor).toHaveValue(/document:reference/);
});

test("tuple editor detects JSON and both YAML styles without changing the authored text", async ({ page, request }) => {
  const target = await policyFixture(request, "Tuple editor formats", baseDsl, [routeGrant]);
  await setDraft(request, target, { yaml: "[]\n", baseline: [] }, { autoSave: true, autoPublish: false });
  await openTarget(page, target, "instances");
  const yaml = page.getByRole("textbox", { name: "Tuple YAML", exact: true });
  const json = page.getByRole("textbox", { name: "Tuple JSON", exact: true });
  const source = page.locator(".wb-tuple-editor");
  const highlight = source.locator(".editor-highlight");

  await expect(source.getByText("tuples.yaml", { exact: true })).toBeVisible();
  await yaml.fill("[{ user: group:team#member, relation: viewer, object: document:example }] # YAML");
  await expect(source.getByText("tuples.yaml", { exact: true })).toBeVisible();
  await expect(highlight.locator(".syntax-keyword")).toHaveText(["user", "relation", "object"]);
  await expect(highlight.locator(".syntax-comment")).toHaveText("# YAML");

  const text = JSON.stringify([routeGrant], null, 2);
  await yaml.fill(text);
  await expect(source.getByText("tuples.json", { exact: true })).toBeVisible();
  await expect(json).toBeFocused();
  await expect(json).toHaveValue(text);
  await expect(highlight.locator(".syntax-keyword")).toHaveText(['"user"', '"relation"', '"object"']);
  await expect(highlight.locator(".syntax-string")).toHaveText(['"user:maya"', '"viewer"', '"document:example"']);
  expect((await highlight.locator("code").allTextContents()).join("\n")).toBe(text);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  const added = { ...routeGrant, object: "document:fetched" };
  await writeEngine(request, target, { writes: { tuple_keys: [added] } });
  await fetchInstances(page);
  await expect(json).toHaveValue(/document:fetched/);
  expect(JSON.parse(await json.inputValue())).toEqual(expect.arrayContaining([routeGrant, added]));

  await json.fill("# YAML\n- user: user:maya\n  relation: viewer\n  object: document:example");
  await expect(source.getByText("tuples.yaml", { exact: true })).toBeVisible();
  await expect(yaml).toBeFocused();
  await expect(highlight.locator(".syntax-keyword")).toHaveText(["user", "relation", "object"]);
});

test("Instances groups a resource's parent, focus and separate siblings with their own direct role holders", async ({
  page, request,
}) => {
  await openHierarchy(page, request, "Relationship sibling grouping");
  await focusPicker(page).selectOption(project);
  const parent = await group(page, "Parent");
  const focused = await group(page, "In focus");
  const children = await group(page, "Children");

  await expect(focusAction(parent, workshop)).toBeVisible();
  await expect(roleAction(parent, "steward", workshop)).toContainText(/casey/i);
  await expect(focused.getByText(/trail/i)).toBeVisible();
  await expect(roleAction(focused, "owner", project)).toContainText(/rowan/i);
  await expect(focusAction(children, guide)).toBeVisible();
  await expect(focusAction(children, reference)).toBeVisible();
  await expect(focusAction(children, fragment)).toHaveCount(0);

  const guideRole = roleAction(children, "reviewer", guide);
  const referenceRole = roleAction(children, "reviewer", reference);
  await expect(guideRole).toContainText(/casey/i);
  await expect(guideRole).not.toContainText(/rowan/i);
  await expect(referenceRole).toContainText(/rowan/i);
  await expect(referenceRole).not.toContainText(/casey/i);
});

test("Instances refocuses from a resource card and jumps from the exact inspected tuple to its YAML", async ({
  page, request,
}) => {
  const editor = await openHierarchy(page, request, "Relationship source inspection");
  await focusPicker(page).selectOption(project);
  const next = focusAction(page, guide);
  await expect(next).toBeVisible({ timeout: 2500 });
  await next.click();
  await expect(focusPicker(page)).toHaveValue(guide);

  const parent = await group(page, "Parent");
  const focused = await group(page, "In focus");
  const children = await group(page, "Children");
  await expect(focusAction(parent, project)).toBeVisible();
  await expect(focusAction(children, fragment)).toBeVisible();
  await expect(focusAction(children, reference)).toHaveCount(0);
  await roleAction(focused, guideReview.relation, guideReview.object).click();

  const source = page.getByRole("button", { name: /(?:source line|go to (?:the )?source|show source)/i });
  await expect(source).toBeVisible();
  const inspector = source.locator("xpath=ancestor::*[self::aside or self::section or @role='region' or @role='dialog'][1]");
  await expect(inspector).toContainText(guideReview.user);
  await expect(inspector).toContainText(guideReview.relation);
  await expect(inspector).toContainText(guideReview.object);
  await expect(inspector).not.toContainText(referenceReview.user);
  await source.click();
  await expectTupleSource(editor, guideReview);
});

test("Instances person focus shows only direct assignments and can refocus an assigned resource", async ({
  page, request,
}) => {
  await openHierarchy(page, request, "Relationship person assignments");
  await focusPicker(page).selectOption(casey);
  const assignments = await group(page, "Direct assignments");
  await expect((await group(page, "In focus")).getByText(/casey/i)).toBeVisible();
  await expect(focusAction(assignments, workshop)).toContainText(/steward/i);
  const review = focusAction(assignments, guide);
  await expect(review).toContainText(/reviewer/i);
  await expect(focusAction(assignments, reference)).toHaveCount(0);
  await expect(focusAction(assignments, project)).toHaveCount(0);
  await review.click();
  await expect(focusPicker(page)).toHaveValue(guide);
  await expect(focusAction(await group(page, "Parent"), project)).toBeVisible();
});

test("Instances filters sibling cards and restores the same focus after clearing the filters", async ({
  page, request,
}) => {
  await openHierarchy(page, request, "Relationship filters");
  const picker = focusPicker(page);
  await picker.selectOption(project);
  const children = await group(page, "Children");
  const first = focusAction(children, guide);
  const second = focusAction(children, reference);
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();

  const search = page.getByRole("textbox", { name: "Search instances", exact: true });
  await search.fill("guide");
  await expect(first).toBeVisible();
  await expect(second).toHaveCount(0);
  await search.clear();
  await expect(second).toBeVisible();

  const type = page.getByRole("combobox", { name: "Model type", exact: true });
  await type.selectOption("fragment");
  await expect(first).toHaveCount(0);
  await expect(second).toHaveCount(0);
  await type.selectOption("");
  await expect(first).toBeVisible();
  await expect(second).toBeVisible();
  await expect(picker).toHaveValue(project);
});

test("Instances keeps an inventory-only resource in focus with empty parent and child groups", async ({
  page, request,
}) => {
  await openHierarchy(page, request, "Relationship empty groups");
  await focusPicker(page).selectOption(orphan);
  const parent = await group(page, "Parent");
  const focused = await group(page, "In focus");
  const children = await group(page, "Children");

  await expect(focused.getByText(/standalone/i)).toBeVisible();
  await expect(parent).toContainText(/(?:no|without).{0,24}parent/i);
  await expect(children).toContainText(/(?:no|without).{0,24}child/i);
  await expect(focusAction(parent, project)).toHaveCount(0);
  await expect(focusAction(children, guide)).toHaveCount(0);
});
