import { expect, test, type Page } from "@playwright/test";
import { expectContrast } from "./theme-contrast";

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

test("New instance matches the Settings dialog at desktop and phone widths", async ({ page }) => {
  await openScreen(page, "/instances");
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  const create = page.getByRole("button", { name: "New instance", exact: true });
  const settingsDialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const createDialog = page.getByRole("dialog", { name: "New instance", exact: true });

  for (const [width, scheme] of [[1440, "dark"], [390, "light"]] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: scheme });
    await settings.click();
    const settingsClose = settingsDialog.getByRole("button", { name: "Close", exact: true });
    const settingsWidth = (await settingsDialog.boundingBox())!.width;
    const settingsCloseWidth = (await settingsClose.boundingBox())!.width;
    await settingsClose.click();

    await create.click();
    const close = createDialog.getByRole("button", { name: "Close", exact: true });
    await expect(close.locator("svg")).toBeVisible();
    await expect(close).toHaveText("");
    expect((await createDialog.boundingBox())!.width).toBeCloseTo(settingsWidth, 0);
    expect((await close.boundingBox())!.width).toBeCloseTo(settingsCloseWidth, 0);
    await expectContrast(close);
    await close.click();
    await expect(create).toBeFocused();
  }
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
    { scheme: "dark", selected: "rgb(36, 52, 90)", muted: "rgb(174, 187, 213)" },
    { scheme: "light", selected: "rgb(230, 237, 255)", muted: "rgb(77, 94, 123)" },
  ] as const;
  for (const palette of palettes) {
    await page.emulateMedia({ colorScheme: palette.scheme });
    await expect(selected).toHaveCSS("background-color", palette.selected);
    await expect(source).toHaveCSS("color", palette.muted);
    await github.hover();
    await expect(github).toHaveCSS("background-color", palette.selected);
    await expectContrast(selected.locator("small"));
    await expectContrast(github.locator("small"));
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
    { scheme: "light", background: "rgb(247, 249, 255)", ink: "rgb(36, 52, 73)" },
    { scheme: "dark", background: "rgb(16, 23, 44)", ink: "rgb(231, 239, 248)" },
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
      for (const token of await surface.locator(".editor-line-number, code span").all()) await expectContrast(token);
    }
  }
});

test("Cobalt keeps navigation, hover, focus, and validation legible in both modes", async ({ page }) => {
  await openScreen(page, "/queries");
  const header = page.getByRole("banner");
  const query = header.getByRole("link", { name: "Query", exact: true });
  const model = header.getByRole("link", { name: "Model", exact: true });
  const store = header.getByRole("combobox", { name: "Store", exact: true });
  const requestPane = page.locator(".wb-pane").filter({ has: page.getByRole("heading", { name: "Query request" }) });
  const operation = requestPane.getByRole("combobox", { name: "Operation" });
  const required = requestPane.getByRole("combobox", { name: "Object" });
  await expect(required).toHaveAttribute("aria-invalid", "true");

  for (const [scheme, chrome] of [["light", "rgb(38, 73, 187)"], ["dark", "rgb(29, 47, 107)"]] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(header).toHaveCSS("background-color", chrome);
    await expect(query).toHaveCSS("box-shadow", /0px -1px 0px 0px inset$/);
    await expectContrast(query);
    await model.hover();
    await expectContrast(model);
    await page.keyboard.press("Tab");
    await query.focus();
    await expect(query).toHaveCSS("outline-style", "solid");
    await expectContrast(query, 3, "outline-color", header);
    await expectContrast(store, 3, "border-top-color", header);
    await expectContrast(store.locator("..").locator(".wb-required-mark"));
    await expectContrast(operation);
    await expectContrast(operation, 3, "border-top-color", requestPane);
    await expectContrast(required, 3, "border-top-color", requestPane);
    await expectContrast(required.locator("..").locator(".wb-required-mark"));
  }
});
