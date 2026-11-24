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

/** Measure the contextual status independently of the implementation's markup and classes. */
async function expectWideHeader(page: Page, actions: string[], currentSync: RegExp, otherSync: RegExp) {
  const banner = header(page);
  await expect(banner).toBeVisible();
  const controls = ["Store", "Model revision"].map((name) => selector(banner, name));
  controls.push(...actions.map((name) => button(banner, name)));
  for (const control of controls) await layout(control).toBeVisible();

  for (const name of ["Store", "Model revision"]) await layout(selector(page, name)).toHaveCount(1);
  for (const name of actions) await layout(button(page, name)).toHaveCount(1);
  await layout(page.getByText("Target details", { exact: true })).toHaveCount(0);

  const status = banner.getByText(syncedAt(currentSync));
  await layout(status).toBeVisible();
  await layout(page.getByText(currentSync)).toHaveCount(1);
  await layout(page.getByText(otherSync)).toHaveCount(0);

  if (await status.count() === 1 && await button(banner, "Publish").count() === 1) {
    expect(await status.evaluate((element) => element.closest("button, [role=button]") === null)).toBe(true);
    for (const control of controls) {
      if (await control.count() !== 1) continue;
      const precedes = await status.evaluate((element, other) =>
        Boolean(element.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_PRECEDING),
      await control.elementHandle());
      expect(precedes, "contextual controls precede the sync status").toBe(true);
    }
    const publishBox = await button(banner, "Publish").boundingBox();
    const statusBox = await status.boundingBox();
    expect(publishBox).not.toBeNull();
    expect(statusBox).not.toBeNull();
    if (!publishBox || !statusBox) return;
    const gap = statusBox.x - (publishBox.x + publishBox.width);
    expect(gap, "sync is to the right of Publish without overlapping it").toBeGreaterThanOrEqual(-1);
    expect(gap, "sync stays visually close to Publish").toBeLessThan(publishBox.height * 2);
    expect(Math.abs(statusBox.y + statusBox.height / 2 - publishBox.y - publishBox.height / 2))
      .toBeLessThan(publishBox.height / 2);
  }
}

/** Verify both shared entry points and Escape dismissal. */
async function openHeaderSettings(page: Page, entry: "Connected" | "Settings") {
  const banner = header(page);
  await expect(button(banner, "Connected")).toBeVisible();
  await expect(button(banner, "Settings")).toBeVisible();
  await button(banner, entry).click();
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Connection", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

test("Model places one target, model Save and Publish, and only model sync in the header", async ({ page, request }) => {
  await prepareSyncedEditors(page, request, "Model toolbar arrangement");
  await page.getByRole("link", { name: "Model", exact: true }).click();

  await openHeaderSettings(page, "Settings");
  for (const name of instancesActions) await expect(button(page, name)).toHaveCount(0);
  await expectWideHeader(page, ["Save", "Publish"], modelSync, tupleSync);
});

test("Instances places its actions in the header and shows only tuple sync", async ({ page, request }) => {
  await prepareSyncedEditors(page, request, "Instances toolbar arrangement");

  await openHeaderSettings(page, "Connected");
  await button(page, "New instance").click();
  const dialog = page.getByRole("dialog", { name: "New instance", exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expectWideHeader(page, [...instancesActions, "Save", "Publish"], tupleSync, modelSync);
});

test("the 320px toolbar fits the viewport and editors remain reachable below it", async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 680 });
  await prepareSyncedEditors(page, request, "Narrow editor toolbars");
  const editors = [
    { screen: "Model", editor: "OpenFGA authorization model", status: modelSync },
    { screen: "Instances", editor: "Tuple YAML", status: tupleSync },
  ];

  for (const { screen, editor, status } of editors) {
    await page.getByRole("link", { name: screen, exact: true }).click();
    await page.waitForURL("**/" + screen.toLowerCase());
    const source = page.getByRole("textbox", { name: editor, exact: true });
    await expect(source).toBeVisible();
    const banner = header(page);
    await layout(button(banner, "Publish"), screen + " keeps Publish in the narrow toolbar").toBeVisible();
    const buttons = banner.getByRole("button");
    const visibleControls = buttons.or(banner.getByRole("combobox"))
      .or(banner.getByRole("link")).or(banner.getByText(syncedAt(status)));
    const bounds = await visibleControls.evaluateAll((elements) => elements
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const { left, right } = element.getBoundingClientRect();
        return { left, right, name: element.getAttribute("aria-label") ?? element.textContent };
      }));
    for (const { left, right, name } of bounds) {
      expect.soft(left, screen + " left edge of " + name).toBeGreaterThanOrEqual(-1);
      expect.soft(right, screen + " right edge of " + name).toBeLessThanOrEqual(321);
    }
    const labels = await buttons.evaluateAll((elements) => elements.map((element) => ({
      fits: element.scrollWidth <= element.clientWidth + 1, name: element.textContent,
    })));
    for (const { fits, name } of labels) {
      expect.soft(fits, screen + " label fits inside " + name).toBe(true);
    }
    expect.soft(await page.evaluate(() => document.documentElement.scrollWidth), screen + " page width").toBeLessThanOrEqual(321);

    await source.evaluate((element) => element.scrollIntoView({ block: "center" }));
    await source.click();
    await expect(source).toBeFocused();
    await expect(source).toBeEditable();
    const topOcclusion = await banner.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top <= 1 ? Math.max(0, bounds.bottom) / window.innerHeight : 0;
    });
    expect.soft(topOcclusion, screen + " header leaves room to edit after scrolling").toBeLessThanOrEqual(0.26);
  }
});

test("Queries keeps its comparison selectors and Batches retains its controls", async ({ page, request }) => {
  const target = await policyFixture(request, "Query and batch toolbar control");
  await setDraft(request, target, {}, { autoSave: false, autoPublish: false, resetSelections: true });
  await openTarget(page, target, "queries");

  await expect(selector(page, "Store")).toHaveValue(target.store);
  await expect(selector(page, "Model revision")).toHaveValue(target.revision);
  await page.getByRole("checkbox", { name: "Compare", exact: true }).check();
  await expect(selector(page, "Alternate store")).toBeVisible();
  await expect(selector(page, "Alternate revision")).toBeVisible();

  await page.getByRole("link", { name: "Batches", exact: true }).click();
  for (const name of ["Import", "Export", "Publish fixture", "Run selected"]) {
    await expect(button(page, name)).toBeVisible();
  }
});
