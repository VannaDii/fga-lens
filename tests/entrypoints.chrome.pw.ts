import { expect, test, type Page } from "@playwright/test";

/** Require the public route to serve a usable screen before exercising its controls. */
async function openScreen(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status(), path + " should be served by the workbench").toBe(200);
}

test("A05 · Instances is directly accessible with tuple and inventory controls", async ({ page }) => {
  await openScreen(page, "/instances");
  await expect(page.getByRole("button", { name: "New instance", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Fetch store tuples", exact: true })).toBeVisible();
});

test("A11 · Queries is directly accessible with the application query controls", async ({ page }) => {
  await openScreen(page, "/queries");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save query", exact: true })).toBeVisible();
});

test("A16 · Batches is directly accessible with fixture and file controls", async ({ page }) => {
  await openScreen(page, "/batches");
  await expect(page.getByRole("button", { name: "Import", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish fixture", exact: true })).toBeVisible();
});

test("A21 · workbench navigation retains all destinations and keyboard focus returns from Settings", async ({
  page,
}) => {
  await openScreen(page, "/model");
  const model = page.getByRole("link", { name: "Model", exact: true });
  const instances = page.getByRole("link", { name: "Instances", exact: true });
  const queries = page.getByRole("link", { name: "Queries", exact: true });
  const batches = page.getByRole("link", { name: "Batches", exact: true });

  await instances.click();
  await expect(page).toHaveURL(/\/instances\/?$/);
  await queries.click();
  await expect(page).toHaveURL(/\/queries\/?$/);
  await batches.click();
  await expect(page).toHaveURL(/\/batches\/?$/);

  await page.setViewportSize({ width: 390, height: 844 });
  await model.focus();
  await expect(model).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/model\/?$/);
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await settings.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(settings).toBeFocused();
});
