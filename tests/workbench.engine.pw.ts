import { expect, test, type Page } from "@playwright/test";
import { parse, stringify } from "yaml";

import { setCompare } from "./finding-helpers";

import {
  capturedRequests,
  clearTraffic,
  createModelWithLostResponse,
  installFixture,
  localGrant,
  memberThroughParent,
  parent,
  postToEngine,
  readFixture,
  storedTuples,
} from "./workbench-fixtures";

/** The accessible selector works with native selects and keyboardable custom comboboxes. */
async function choose(page: Page, label: RegExp, display: string) {
  const selector = page.getByRole("combobox", { name: label });
  await expect(selector).toBeEnabled();
  const tag = await selector.evaluate((element) => element.tagName);
  if (tag === "SELECT") {
    const option = selector.getByRole("option").filter({ hasText: display });
    await expect(option).toHaveCount(1);
    const nativeValue = await option.evaluate((element) => (element as HTMLOptionElement).value);
    await selector.selectOption(nativeValue);
    return;
  }
  await selector.click();
  const option = page.getByRole("option").filter({ hasText: display });
  await expect(option).toHaveCount(1);
  await option.click();
  await expect(selector).not.toHaveAttribute("aria-expanded", "true");
}

const resultHeading = (page: Page) => page.getByRole("heading", { name: "Result", exact: true }).locator("..");

/** Observe a functioning public application route before interacting with its controls. */
async function openScreen(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status(), path + " should be served by the workbench").toBe(200);
}

test("stock engine control resolves inherited permission and isolates a contextual tuple", async ({ request }) => {
  const fixture = await installFixture(request, "Workbench engine control");
  const body = {
    authorization_model_id: fixture.revision,
    tuple_key: { ...localGrant, relation: "can_read" },
  };

  const inherited = await postToEngine(request, fixture.path + "/check", {
    ...body,
    tuple_key: { ...body.tuple_key, user: memberThroughParent.user },
  });
  expect(inherited.allowed).toBe(true);

  const denied = await postToEngine(request, fixture.path + "/check", body);
  expect(denied.allowed).toBe(false);
  const overlay = await postToEngine(request, fixture.path + "/check", {
    ...body,
    contextual_tuples: { tuple_keys: [localGrant] },
  });
  expect(overlay.allowed).toBe(true);
  const after = await postToEngine(request, fixture.path + "/check", body);
  expect(after.allowed).toBe(false);
  expect(await readFixture(request, fixture.path)).toEqual(
    storedTuples.map((tuple) => [tuple.user, tuple.relation, tuple.object].join(" ")).sort(),
  );
});

test("stock transport control loses an accepted reply while preserving the independent installed revision", async ({
  request,
}) => {
  const fixture = await installFixture(request, "Workbench response loss control");
  const revisions = await createModelWithLostResponse(request, fixture.path);
  expect(revisions).toHaveLength(2);
  expect(revisions).toContain(fixture.revision);
  expect(new Set(revisions).size).toBe(2);
});

test("A10 and A12 · exact Check reaches the installed revision and shows both links behind the grant", async ({
  page,
  request,
}) => {
  const fixture = await installFixture(request, "Workbench request evidence");

  await openScreen(page, "/instances");
  await choose(page, /^store$/i, fixture.name);
  await page.getByRole("button", { name: "Fetch store tuples", exact: true }).click();
  const fetched = page.getByRole("textbox", { name: /tuple yaml/i });
  await expect(fetched).toHaveValue(/organization:unrelated/);
  await page.getByRole("link", { name: "Query", exact: true }).click();
  await expect(page).toHaveURL(/\/queries\/?$/);
  await page.getByRole("combobox", { name: "Operation", exact: true }).selectOption("check");
  await setCompare(page, false);

  await choose(page, /^view as$/i, "user:maya");
  await choose(page, /^object$/i, "organization:ca");
  await choose(page, /^relation$/i, "can_read");
  await clearTraffic(request);
  await page.getByRole("button", { name: "Run", exact: true }).click();

  await expect(resultHeading(page).getByText("Allowed", { exact: true })).toBeVisible();
  const checks = await capturedRequests(request, fixture.path + "/check");
  expect(checks[0]).toMatchObject({
    authorization_model_id: fixture.revision,
    tuple_key: { user: "user:maya", relation: "can_read", object: "organization:ca" },
  });
  const evidence = page.getByText("Evidence", { exact: true });
  await evidence.click();
  const evidencePanel = page.locator("details[open]").filter({ has: evidence });
  await expect(evidencePanel.getByText(parent.user, { exact: true }).first()).toBeVisible();
  await expect(evidencePanel.getByText(memberThroughParent.user, { exact: true }).first()).toBeVisible();
  await expect(evidencePanel.getByText(parent.relation, { exact: true }).first()).toBeVisible();
  await expect(evidencePanel.getByText(memberThroughParent.relation, { exact: true }).first()).toBeVisible();
});

test("A14 · temporary grant changes only the captured request and clearing it restores denial", async ({
  page,
  request,
}) => {
  const fixture = await installFixture(request, "Workbench temporary relationship");
  const before = await readFixture(request, fixture.path);

  await openScreen(page, "/instances");
  await choose(page, /^store$/i, fixture.name);
  await page.getByRole("button", { name: "Fetch store tuples", exact: true }).click();
  const yamlEditor = page.getByRole("textbox", { name: /tuple yaml/i });
  await expect(yamlEditor).toHaveValue(/organization:unrelated/);
  const fetched: unknown = parse(await yamlEditor.inputValue());
  if (!Array.isArray(fetched)) throw new Error("Fetched YAML should contain a tuple sequence");
  await yamlEditor.fill(stringify([...fetched, localGrant]));
  const queries = page.getByRole("link", { name: "Query", exact: true });
  await queries.click();
  await expect(page).toHaveURL(/\/queries\/?$/);
  await page.getByRole("combobox", { name: "Operation", exact: true }).selectOption("check");
  await setCompare(page, false);
  await choose(page, /^view as$/i, "user:casey");
  await choose(page, /^object$/i, "organization:ca");
  await choose(page, /^relation$/i, "can_read");

  const run = page.getByRole("button", { name: "Run", exact: true });
  await run.click();
  await expect(resultHeading(page).getByText("Denied", { exact: true })).toBeVisible();

  const grant = page.getByRole("checkbox", { name: /user:casey.*member.*organization:ca/i });
  await grant.check();
  await clearTraffic(request);
  await run.click();
  await expect(resultHeading(page).getByText("Allowed", { exact: true })).toBeVisible();
  const temporary = await capturedRequests(request, fixture.path + "/check");
  expect(temporary[0]).toMatchObject({
    authorization_model_id: fixture.revision,
    contextual_tuples: { tuple_keys: [localGrant] },
  });

  await grant.uncheck();
  expect(await capturedRequests(request, fixture.path + "/write")).toEqual([]);
  expect(await readFixture(request, fixture.path)).toEqual(before);
  await clearTraffic(request);
  await run.click();
  await expect(resultHeading(page).getByText("Denied", { exact: true })).toBeVisible();
  const original = await capturedRequests(request, fixture.path + "/check");
  expect(original[0]).toMatchObject({
    authorization_model_id: fixture.revision,
    tuple_key: { user: "user:casey", relation: "can_read", object: "organization:ca" },
  });
  expect(original[0].contextual_tuples?.tuple_keys ?? []).toEqual([]);
  expect(await capturedRequests(request, fixture.path + "/write")).toEqual([]);
  expect(await readFixture(request, fixture.path)).toEqual(before);
});
