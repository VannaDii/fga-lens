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
  const directTuples = page.locator("details > summary").filter({ hasText: "Inspect direct tuples" });
  await expect(directTuples).toHaveCSS("display", "flex");
  await directTuples.focus();
  await page.keyboard.press("Enter");
  await expect(directTuples.locator("..")).toHaveAttribute("open");
});

test("A11 · Query keeps its direct link and uses the shared content expanders", async ({ page }) => {
  await openScreen(page, "/queries");
  await expect(page.getByRole("link", { name: "Query", exact: true })).toHaveAttribute("href", "/queries");
  await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save query", exact: true })).toBeVisible();
  const context = page.locator("details > summary").filter({ hasText: "Condition context" });
  await expect(context).toHaveCSS("display", "flex");
  const tuples = page.locator("details[open] > summary").filter({ hasText: "Contextual tuples" });
  await expect(tuples).toHaveCSS("display", "flex");
  await page.getByRole("link", { name: "Add a local relationship in Instances to try a grant.", exact: true }).click();
  await expect(page).toHaveURL(/\/instances\/?$/);
});

test("A16 · Batches is directly accessible with fixture and file controls", async ({ page }) => {
  await openScreen(page, "/batches");
  await expect(page.getByRole("button", { name: "Import", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish fixture", exact: true })).toBeVisible();
});

test("desktop workbench panes fill the available height after resizing", async ({ page }) => {
  for (const path of ["/instances", "/queries", "/batches"]) {
    await openScreen(page, path);
    const panes = page.locator("main.wb-split > .wb-pane");
    await expect(panes).toHaveCount(2);
    for (const height of [1000, 700]) {
      await page.setViewportSize({ width: 1440, height });
      await expect.poll(() => panes.evaluateAll((panels) => Math.max(...panels.map((panel) => {
        const gutter = parseFloat(getComputedStyle(panel.parentElement!).paddingBottom);
        return Math.abs(window.innerHeight - panel.getBoundingClientRect().bottom - gutter);
      }))), { message: `${path} at ${height}px should end one gutter above the window bottom` }).toBeLessThan(2);
    }
  }
});

test("A21 · workbench navigation retains all destinations and keyboard focus returns from Settings", async ({
  page,
}) => {
  await openScreen(page, "/model");
  await expect(page).toHaveTitle("FGA Playground — OpenFGA workbench");
  await expect(page.getByRole("banner").getByText("FGA Playground", { exact: true })).toBeVisible();
  const model = page.getByRole("link", { name: "Model", exact: true });
  const instances = page.getByRole("link", { name: "Instances", exact: true });
  const queries = page.getByRole("link", { name: "Query", exact: true });
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

test("the Examples menu uses theme colors for selection, hover, and keyboard focus", async ({ page }) => {
  await openScreen(page, "/model");
  const picker = page.getByRole("button", { name: /^Example / });
  const menu = page.getByRole("menu", { name: "Official OpenFGA sample stores" });
  const selected = menu.getByRole("menuitemradio", { name: /Google Drive/ });
  const github = menu.getByRole("menuitemradio", { name: /GitHub/ });
  const source = menu.getByRole("link", { name: /View source on GitHub/ });
  await picker.click();
  await selected.click();
  await picker.click();
  await expect(selected).toHaveAttribute("aria-checked", "true");

  const palettes = [
    { scheme: "dark", selected: "rgb(35, 62, 49)", hover: "rgb(36, 50, 43)", muted: "rgb(174, 189, 181)" },
    { scheme: "light", selected: "rgb(231, 248, 240)", hover: "rgb(238, 243, 240)", muted: "rgb(102, 113, 109)" },
  ] as const;
  for (const palette of palettes) {
    await page.emulateMedia({ colorScheme: palette.scheme });
    await expect(selected).toHaveCSS("background-color", palette.selected);
    await expect(source).toHaveCSS("color", palette.muted);
    await github.hover();
    await expect(github).toHaveCSS("background-color", palette.hover);
    await picker.focus();
    await page.keyboard.press("Tab");
    await expect(github).toBeFocused();
    await expect(github).toHaveCSS("outline-offset", "-2px");
  }
});

test("both source editors follow the active color scheme", async ({ page }) => {
  const editors = [
    { path: "/model", name: "OpenFGA authorization model", text: "model\n  schema 1.1\n\ntype user" },
    { path: "/instances", name: "Tuple YAML", text: "- user: user:maya\n  relation: viewer\n  object: document:example" },
  ];
  const palettes = [
    { scheme: "light", background: "rgb(255, 255, 255)", ink: "rgb(23, 32, 30)" },
    { scheme: "dark", background: "rgb(16, 24, 21)", ink: "rgb(230, 238, 234)" },
  ] as const;

  for (const { path, name, text } of editors) {
    await openScreen(page, path);
    const source = page.getByRole("textbox", { name, exact: true });
    await source.fill(text);
    const surface = source.locator("..");
    for (const palette of palettes) {
      await page.emulateMedia({ colorScheme: palette.scheme });
      await expect(surface).toHaveCSS("background-color", palette.background);
      await expect(surface.locator("..")).toHaveCSS("background-color", palette.background);
      await expect(surface.locator("code").first()).toHaveCSS("color", palette.ink);
      await expect(source).toHaveCSS("caret-color", palette.ink);
    }
  }
});
