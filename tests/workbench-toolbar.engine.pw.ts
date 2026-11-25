import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import { baseDsl, boundDraft, fetchInstances, openTarget, policyFixture, routeGrant, setCompare, setDraft, toYaml, workspace } from "./finding-helpers";

const layout = expect.configure({ soft: true, timeout: 1500 });
const timestamp = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;
const tupleSync = /^\s*tuples?\b.*\b(?:in sync|synced)\b/i;
const instancesActions = ["New instance", "Fetch store tuples"];

/** Match the complete status even when its label and time are separate elements. */
function syncedAt(sync: RegExp) {
  return new RegExp(sync.source + ".*" + timestamp.source, "is");
}

function header(page: Page) {
  return page.getByRole("banner").filter({ has: page.getByRole("navigation", { name: "Workbench", exact: true }) });
}

function button(scope: Page | Locator, name: string) {
  return scope.getByRole("button", { name, exact: true });
}

function selector(scope: Page | Locator, name: string) {
  return scope.getByRole("combobox", { name, exact: true });
}

/** Use a real installed model and tuple, with both independently recorded sync times. */
async function prepareSyncedEditors(page: Page, request: APIRequestContext, fixtureName: string) {
  const target = await policyFixture(request, fixtureName, baseDsl, [routeGrant]);
  await setDraft(request, target, { dsl: baseDsl, validDsl: baseDsl, yaml: "[]\n", baseline: [] }, {
    autoSave: false, autoPublish: false, resetSelections: true,
  });
  await openTarget(page, target, "model");
  await button(page, "Publish").click();
  await expect.poll(async () => boundDraft(await workspace(request), target).modelChecked).toBeTruthy();

  await page.getByRole("link", { name: "Instances", exact: true }).click();
  await fetchInstances(page);
  await expect(page.getByRole("textbox", { name: "Tuple YAML", exact: true })).toHaveValue(/document:example/);
  await expect.poll(async () => boundDraft(await workspace(request), target).tuplesChecked).toBeTruthy();
}

/** The shared navigation keeps selectors and one Settings entry across screens. */
async function expectNavigation(page: Page) {
  const banner = header(page);
  for (const name of ["Store", "Model revision"]) await expect(selector(banner, name)).toBeVisible();
  await expect(button(banner, "Settings")).toHaveAccessibleDescription("Connected");
  for (const name of [...instancesActions, "Connected", "Save", "Publish"]) {
    await expect(button(banner, name)).toHaveCount(0);
  }
  await expect(page.getByText("Target details", { exact: true })).toHaveCount(0);
}

function paneHeader(page: Page, name: string) {
  return page.locator("header").filter({ has: page.getByRole("heading", { name, exact: true }) });
}

test("the model header holds Save and Publish without a sync badge", async ({ page, request }) => {
  await prepareSyncedEditors(page, request, "Model pane controls");
  await page.getByRole("link", { name: "Model", exact: true }).click();
  await expectNavigation(page);

  const pane = paneHeader(page, "Authorization model");
  await expect(button(pane, "Save")).toBeVisible();
  await expect(button(pane, "Publish")).toBeVisible();
  await expect(pane.getByText(/^Model ·/)).toHaveCount(0);
  await expect(page.getByText(tupleSync)).toHaveCount(0);
});

test("Instances keeps tuple actions in its pane and reveals sync details on request", async ({ page, request }) => {
  await prepareSyncedEditors(page, request, "Instances pane controls");
  await expectNavigation(page);
  const pane = paneHeader(page, "Instances");
  for (const name of [...instancesActions, "Save", "Publish"]) await expect(button(pane, name)).toBeVisible();
  const sync = page.getByRole("region", { name: "Tuple sync", exact: true });
  await expect(sync).toBeHidden();
  await button(pane, "Tuple sync information").click();
  await expect(sync.getByText(syncedAt(tupleSync))).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sync).toBeHidden();
  await button(pane, "New instance").click();
  const dialog = page.getByRole("dialog", { name: "New instance", exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(button(pane, "New instance")).toBeFocused();
});

test("settings combines connection status and appearance controls, and keeps the chosen mode on reload", async ({ page, request }) => {
  const target = await policyFixture(request, "Workspace appearance");
  await setDraft(request, target, {}, { resetSelections: true });
  await openTarget(page, target, "model");
  const settings = button(header(page), "Settings");
  await expect(settings).toHaveAccessibleDescription("Connected");
  await expect(settings.locator("svg")).toBeVisible();
  await settings.click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const retry = button(dialog, "Retry connection");
  await expect(retry.locator("..")).toContainText("Connected");
  await expect(retry.locator("svg")).toBeVisible();
  await expect(retry).toHaveText("");
  await expect(retry).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  const theme = dialog.getByRole("group", { name: "Appearance" });
  await expect(button(theme, "System")).toHaveAttribute("aria-pressed", "true");
  await button(theme, "Dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator('meta[name="theme-color"][media*="light"]')).toHaveAttribute("content", "#1d2f6b");
  const close = button(dialog, "Close");
  await expect(close.locator("svg")).toBeVisible();
  await close.click();
  await expect(settings).toBeFocused();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await settings.click();
  await button(theme, "Light").click();
  await expect(page.locator('meta[name="theme-color"][media*="dark"]')).toHaveAttribute("content", "#2649bb");
  await button(theme, "System").click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(22, 30, 54)");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(241, 244, 255)");
});

test("the 320px navigation and pane controls fit and both editors remain reachable", async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 680 });
  await prepareSyncedEditors(page, request, "Narrow editor panes");
  const editors = [
    { screen: "Model", title: "Authorization model", editor: "OpenFGA authorization model" },
    { screen: "Instances", title: "Instances", editor: "Tuple YAML" },
  ];

  for (const { screen, title, editor } of editors) {
    await page.getByRole("link", { name: screen, exact: true }).click();
    await page.waitForURL("**/" + screen.toLowerCase());
    const source = page.getByRole("textbox", { name: editor, exact: true });
    await expect(source).toBeVisible();
    const banner = header(page);
    const pane = paneHeader(page, title);
    await layout(button(pane, "Publish"), screen + " keeps Publish in the pane").toBeVisible();
    const visibleControls = banner.getByRole("button").or(banner.getByRole("combobox"))
      .or(banner.getByRole("link")).or(pane.getByRole("button"));
    const bounds = await visibleControls.evaluateAll((elements) => elements.map((element) => {
      const { left, right } = element.getBoundingClientRect();
      return { left, right, name: element.getAttribute("aria-label") ?? element.textContent };
    }));
    for (const { left, right, name } of bounds) {
      expect.soft(left, screen + " left edge of " + name).toBeGreaterThanOrEqual(-1);
      expect.soft(right, screen + " right edge of " + name).toBeLessThanOrEqual(321);
    }
    expect.soft(await page.evaluate(() => document.documentElement.scrollWidth), screen + " page width").toBeLessThanOrEqual(321);
    if (screen === "Model") {
      await pane.locator('button[aria-haspopup="menu"]').click();
      const menu = page.getByRole("menu", { name: "Official OpenFGA sample stores" });
      await expect(menu).toBeVisible();
      const rectangle = await menu.boundingBox();
      expect(rectangle?.x).toBeGreaterThanOrEqual(0);
      expect((rectangle?.x ?? 320) + (rectangle?.width ?? 320)).toBeLessThanOrEqual(321);
      await page.keyboard.press("Escape");
    }
    await source.click();
    await expect(source).toBeFocused();
    await expect(source).toBeEditable();
  }
});

test("Query keeps its comparison selectors and Batches retains its controls", async ({ page, request }) => {
  const target = await policyFixture(request, "Query and batch toolbar control");
  await setDraft(request, target, {}, { autoSave: false, autoPublish: false, resetSelections: true });
  await openTarget(page, target, "queries");

  await expect(selector(page, "Store")).toHaveValue(target.store);
  const revision = selector(page, "Model revision");
  await expect(revision).toHaveValue(target.revision);
  await expect(revision.locator("option:checked")).toHaveText("Version 1");
  await expect(revision).toHaveAttribute("title", target.revision);
  const comparison = page.locator("summary").filter({ hasText: /^Compare$/ });
  await expect(selector(page, "Alternate store")).toBeHidden();
  await expect(comparison).toBeVisible();
  await comparison.focus();
  await comparison.press("Enter");
  await expect(selector(page, "Alternate store")).toBeVisible();
  await expect(selector(page, "Alternate revision")).toBeVisible();
  await setCompare(page, false);

  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const run = (await button(page, "Run").boundingBox())!;
    const save = (await button(page, "Save query").boundingBox())!;
    const toggle = (await comparison.locator("..").boundingBox())!;
    expect(run.width).toBeCloseTo(save.width);
    expect(run.y).toBeCloseTo(save.y);
    expect(save.x + save.width).toBeCloseTo(toggle.x + toggle.width);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("link", { name: "Batches", exact: true }).click();
  for (const name of ["Import", "Export", "Publish fixture", "Run selected"]) {
    await expect(button(page, name)).toBeVisible();
  }
});

test("the navigation keeps its height when Batches hides the target selectors", async ({ page, request }) => {
  const target = await policyFixture(request, "Stable navigation height");
  await setDraft(request, target, {}, { resetSelections: true });
  await openTarget(page, target, "queries");
  const banner = header(page);
  const store = selector(banner, "Store");
  const batches = banner.getByRole("link", { name: "Batches", exact: true });
  const query = banner.getByRole("link", { name: "Query", exact: true });
  for (const width of [1440, 1000, 680, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(store).toBeVisible();
    const { height } = (await banner.boundingBox())!;
    await batches.click();
    await expect(batches).toHaveAttribute("aria-current", "page");
    await expect(store).toBeHidden();
    expect((await banner.boundingBox())!.height, `${width}px viewport`).toBeCloseTo(height);
    await query.click();
    await expect(query).toHaveAttribute("aria-current", "page");
  }
});

test("workbench fields stack labels above equally tall controls across screens", async ({ page, request }) => {
  const target = await policyFixture(request, "Shared form layout");
  await setDraft(request, target, { yaml: toYaml([routeGrant]) }, { autoSave: false, autoPublish: false, resetSelections: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTarget(page, target, "queries");
  await setCompare(page, true);
  const contextual = page.getByRole("checkbox", { name: `${routeGrant.user} · ${routeGrant.relation} · ${routeGrant.object}`, exact: true });
  const label = await contextual.evaluate((checkbox) => {
    const range = document.createRange();
    range.setStartAfter(checkbox);
    range.setEndAfter(checkbox.closest("label")!.lastChild!);
    const input = checkbox.getBoundingClientRect();
    const caption = range.getBoundingClientRect();
    return { horizontalGap: caption.left - input.right, verticalOverlap: Math.min(caption.bottom, input.bottom) - Math.max(caption.top, input.top) };
  });
  expect(label.horizontalGap).toBeGreaterThan(0);
  expect(label.verticalOverlap).toBeGreaterThan(0);

  const height = (await button(header(page), "Settings").boundingBox())!.height;
  const verify = async (fields: Locator[], actions: Locator[]) => {
    for (const field of fields) {
      await expect(field).toBeVisible();
      const row = await field.evaluate((control) => {
        const label = control.closest("label")!;
        const range = document.createRange();
        range.setStart(label, 0);
        range.setEndBefore(control);
        return { textBottom: range.getBoundingClientRect().bottom, fieldTop: control.getBoundingClientRect().top };
      });
      expect(row.fieldTop).toBeGreaterThan(row.textBottom);
    }
    for (const control of [...fields, ...actions]) {
      await expect(control).toBeVisible();
      expect((await control.boundingBox())!.height).toBeCloseTo(height);
    }
  };
  await verify([selector(header(page), "Store"), selector(header(page), "Model revision"),
    ...["Operation", "View as", "Object", "Relation", "Alternate store", "Alternate revision"].map((name) => selector(page, name)),
    page.getByRole("textbox", { name: "Search identifiers", exact: true })], [button(page, "Run"), button(page, "Save query")]);

  await page.getByRole("link", { name: "Instances", exact: true }).click();
  await verify([selector(page, "Focus instance"), selector(page, "Model type"),
    page.getByRole("textbox", { name: "Search instances", exact: true })], []);

  await page.getByRole("link", { name: "Batches", exact: true }).click();
  await verify([selector(page, "Source store"), selector(page, "Source model revision")],
    [button(page, "Publish fixture"), button(page, "Run selected")]);

  await page.getByRole("link", { name: "Explore", exact: true }).click();
  const refresh = button(page, "Refresh");
  await verify([selector(page, "Start at"), selector(page, "View as")], [refresh]);
  await expect(refresh).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await page.setViewportSize({ width: 320, height: 740 });
  for (const name of ["Explore", "Batches", "Query", "Instances"]) {
    await page.getByRole("link", { name, exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  }
});

test("Query marks missing required fields without moving the controls", async ({ page, request }) => {
  const target = await policyFixture(request, "Required query inputs", baseDsl, [routeGrant]);
  await setDraft(request, target, { baseline: [routeGrant] }, { resetSelections: true });
  await openTarget(page, target, "queries");

  const viewAs = selector(page, "View as");
  const object = selector(page, "Object");
  const relation = selector(page, "Relation");
  for (const field of [selector(page, "Store"), selector(page, "Model revision"), selector(page, "Operation"), viewAs, object, relation]) {
    await expect(field).toHaveAttribute("required", "");
    await expect(field.locator("..").getByText("*", { exact: true })).toBeVisible();
  }
  await expect(page.getByRole("textbox", { name: "Search identifiers" })).toHaveJSProperty("required", false);
  for (const field of [viewAs, object, relation]) await expect(field).toHaveAttribute("aria-invalid", "true");
  const initial = await viewAs.boundingBox();
  const invalidColor = await viewAs.evaluate((field) => getComputedStyle(field).borderColor);
  await button(page, "Run").click();
  await expect(viewAs).toBeFocused();
  await viewAs.selectOption(routeGrant.user);
  await expect(viewAs).not.toHaveAttribute("aria-invalid", "true");
  expect(await viewAs.boundingBox()).toEqual(initial);
  expect(await viewAs.evaluate((field) => getComputedStyle(field).borderColor)).not.toBe(invalidColor);

  await selector(page, "Operation").selectOption("list-users");
  await expect(viewAs).toHaveCount(0);
  await expect(selector(page, "User type or userset")).toHaveAttribute("aria-invalid", "true");
  await selector(page, "Operation").selectOption("list-objects");
  await expect(object).toHaveCount(0);
  await expect(selector(page, "Object type")).toHaveAttribute("aria-invalid", "true");
  await setCompare(page, true);
  await expect(selector(page, "Alternate store")).toHaveAttribute("aria-invalid", "true");
  await expect(selector(page, "Alternate revision")).toHaveAttribute("aria-invalid", "true");
});
