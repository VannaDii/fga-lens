import { expect, test } from "@playwright/test";

import { appRequest, boundDraft, openTarget, policyFixture, routeGrant, setDraft, toYaml, workspace } from "./finding-helpers";
import { armTransport, capturedRequests, clearTraffic } from "./workbench-fixtures";

const engine = "http://127.0.0.1:" + (process.env.FGA_TEST_PROXY_PORT ?? "35492");

test("Settings lists and creates OpenFGA stores alongside the existing General settings", async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 680 });
  await page.goto("/model");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const general = dialog.getByRole("tab", { name: "General" });
  const stores = dialog.getByRole("tab", { name: "Stores" });
  await expect(general).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("tabpanel", { name: "General" }).getByRole("checkbox", { name: "Auto-save" })).toBeVisible();
  await general.focus();
  await general.press("ArrowRight");
  await expect(stores).toBeFocused();
  const management = dialog.getByRole("tabpanel", { name: "Stores" });
  await expect(management).toBeVisible();
  const external = await policyFixture(request, "External store settings fixture");
  await management.getByRole("button", { name: "Refresh stores" }).click();
  await expect(management.getByText(external.store, { exact: true })).toBeVisible();
  await expect(dialog).toHaveJSProperty("scrollWidth", await dialog.evaluate((node) => node.clientWidth));

  const name = management.getByRole("textbox", { name: "Store name" });
  const create = management.getByRole("button", { name: "Create store", exact: true });
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  const refresh = management.getByRole("button", { name: "Refresh stores" });
  await expect(refresh).toBeEnabled();
  await expect(refresh).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(management.getByRole("status")).toHaveCount(0);
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 680 });
    const [field, action, closeIcon, refreshIcon] = await Promise.all([
      name.boundingBox(), create.boundingBox(), close.boundingBox(), refresh.boundingBox(),
    ]);
    expect(field!.y).toBeCloseTo(action!.y, 0);
    expect(field!.height).toBeCloseTo(action!.height, 0);
    expect(closeIcon!.width).toBeCloseTo(closeIcon!.height, 0);
    expect(refreshIcon!.width).toBeCloseTo(closeIcon!.width, 0);
    expect(refreshIcon!.height).toBeCloseTo(closeIcon!.height, 0);
  }
  await clearTraffic(request);
  await name.fill("a!");
  await create.click();
  const nameIssue = management.getByRole("alert");
  await expect(nameIssue).toContainText("3–64");
  await expect(name).toHaveAccessibleDescription(/Enter a store name with 3–64 characters/);
  const [field, issue, listHeading] = await Promise.all([
    name.boundingBox(), nameIssue.boundingBox(), management.getByRole("heading", { name: "OpenFGA stores" }).boundingBox(),
  ]);
  expect(issue!.x).toBeCloseTo(field!.x, 0);
  expect(issue!.y).toBeGreaterThan(field!.y + field!.height);
  expect(issue!.y + issue!.height).toBeLessThan(listHeading!.y);
  expect(await capturedRequests(request, "/stores")).toEqual([]);

  await name.fill("Created in Settings");
  await create.click();
  await expect(management.getByRole("listitem").filter({ hasText: "Created in Settings" })).toBeVisible();
  await expect(create).toBeEnabled();
  await expect(nameIssue).toHaveCount(0);
  await expect(management.getByRole("status")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();
  const store = page.getByRole("combobox", { name: "Store", exact: true });
  await expect(store.locator("option:checked")).toHaveText("Created in Settings");
  const created = await store.inputValue();
  const response = await request.get(engine + "/stores/" + created);
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ id: created, name: "Created in Settings" });
});

test("deleting an active store requires confirmation and preserves local drafts", async ({ page, request }) => {
  const target = await policyFixture(request, "Delete store settings fixture");
  const yaml = toYaml([routeGrant]);
  await setDraft(request, target, { yaml });
  const invalid = await appRequest(request, { action: "delete-store", store: "bad ID" });
  expect(invalid.status()).toBe(400);
  await openTarget(page, target, "model");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("tab", { name: "Stores" }).click();
  const line = dialog.getByRole("listitem").filter({ hasText: target.store });
  const remove = line.getByRole("button", { name: "Delete Delete store settings fixture", exact: true });
  const confirm = line.getByRole("button", { name: "Delete store", exact: true });
  await remove.click();
  await line.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirm).toBeHidden();
  expect((await request.get(engine + target.path)).ok()).toBe(true);

  await armTransport(request, [{ path: target.path, kind: "service-error" }]);
  await remove.click();
  await confirm.click();
  await expect(dialog.getByRole("alert")).toContainText(/Delete store settings fixture.*server error/);
  expect((await request.get(engine + target.path)).ok()).toBe(true);
  await confirm.click();
  await expect(line).toHaveCount(0);
  await expect(dialog.getByRole("tabpanel", { name: "Stores" }).getByRole("status")).toHaveCount(0);
  expect((await request.get(engine + target.path)).status()).toBe(404);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("combobox", { name: "Store", exact: true })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Model revision", exact: true })).toHaveValue("");
  await expect.poll(async () => (await workspace(request)).state.store).toBe("");
  expect(boundDraft(await workspace(request), target).yaml).toBe(yaml);
});
