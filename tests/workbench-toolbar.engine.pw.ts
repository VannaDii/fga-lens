import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import { baseDsl, boundDraft, fetchInstances, openTarget, policyFixture, routeGrant, setDraft, workspace } from "./finding-helpers";

const layout = expect.configure({ soft: true, timeout: 1500 });
const timestamp = /\b\d{1,2}:\d{2}(?::\d{2})?\b/;
const modelSync = /^\s*model\b.*\b(?:in sync|synced)\b/i;
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

test("the model header holds Save and Publish with the sync time beside Publish", async ({ page, request }) => {
  await prepareSyncedEditors(page, request, "Model pane controls");
  await page.getByRole("link", { name: "Model", exact: true }).click();
  await expectNavigation(page);

  const pane = paneHeader(page, "Authorization model");
  await expect(button(pane, "Save")).toBeVisible();
  const publish = button(pane, "Publish");
  const status = pane.getByText(syncedAt(modelSync));
  await expect(status).toBeVisible();
  await expect(status.locator("time")).toHaveCount(1);
  await expect(page.getByText(tupleSync)).toHaveCount(0);
  const publishBox = await publish.boundingBox();
  const statusBox = await status.boundingBox();
  expect(publishBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  if (!publishBox || !statusBox) return;
  const gap = statusBox.x - (publishBox.x + publishBox.width);
  expect(gap).toBeGreaterThanOrEqual(-1);
  expect(gap).toBeLessThan(publishBox.height * 2);
  expect(Math.abs(statusBox.y + statusBox.height / 2 - publishBox.y - publishBox.height / 2))
    .toBeLessThan(publishBox.height / 2);
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
  await expect(button(dialog, "Retry connection").locator("..")).toContainText("Connected");
  const theme = dialog.getByRole("group", { name: "Appearance" });
  await expect(button(theme, "System")).toHaveAttribute("aria-pressed", "true");
  await button(theme, "Dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator('meta[name="theme-color"][media*="light"]')).toHaveAttribute("content", "#101a16");
  const close = button(dialog, "Close");
  await expect(close.locator("svg")).toBeVisible();
  await close.click();
  await expect(settings).toBeFocused();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await settings.click();
  await button(theme, "Light").click();
  await expect(page.locator('meta[name="theme-color"][media*="dark"]')).toHaveAttribute("content", "#192822");
  await button(theme, "System").click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(18, 27, 23)");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(245, 248, 246)");
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

test("Queries keeps its comparison selectors and Batches retains its controls", async ({ page, request }) => {
  const target = await policyFixture(request, "Query and batch toolbar control");
  await setDraft(request, target, {}, { autoSave: false, autoPublish: false, resetSelections: true });
  await openTarget(page, target, "queries");

  await expect(selector(page, "Store")).toHaveValue(target.store);
  const revision = selector(page, "Model revision");
  await expect(revision).toHaveValue(target.revision);
  await expect(revision.locator("option:checked")).toHaveText("Version 1");
  await expect(revision).toHaveAttribute("title", target.revision);
  await page.getByRole("checkbox", { name: "Compare", exact: true }).check();
  await expect(selector(page, "Alternate store")).toBeVisible();
  await expect(selector(page, "Alternate revision")).toBeVisible();

  await page.getByRole("link", { name: "Batches", exact: true }).click();
  for (const name of ["Import", "Export", "Publish fixture", "Run selected"]) {
    await expect(button(page, name)).toBeVisible();
  }
});
