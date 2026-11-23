import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import type { Tuple } from "@/lib/workbench-contract";
import {
  appRequest, baseDsl, boundDraft, companionGrant, engineAllows, fetchInstances, openTarget,
  policyFixture, routeGrant, setDraft, toYaml, workspace, type FixtureTarget,
} from "./finding-helpers";
import { capturedRequests, clearTraffic, readFixture } from "./workbench-fixtures";

const malformedSyntax = "- user: user:casey\n  relation: [editor\n  object: document:example\n";
const malformedField = "- user: user:casey\n  relation: 42\n  object: document:example\n";
const proxy = "http://127.0.0.1:" + (process.env.FGA_TEST_PROXY_PORT ?? "35492");

const publicationDsl = baseDsl.replace("type document", [
  "type group",
  "  relations",
  "    define member: [user, group#member]",
  "",
  "type document",
].join("\n")) + '\n    define guarded: [user with region_guard]\n\ncondition region_guard(region: string) {\n  region == "west"\n}\n';

const guarded = { ...routeGrant, user: "user:avery", relation: "guarded" };
const validConditioned = { ...guarded, condition: { name: "region_guard", context: { region: "west" } } };
const validUserset = { user: "group:authors#member", relation: "member", object: "group:readers" };

/** Assert that an invalid Fetch neither changes authored text nor starts a new tuple baseline. */
async function checkInvalidFetch(page: Page, request: APIRequestContext, target: FixtureTarget, invalid: string,
  cause: RegExp, location: RegExp) {
  const before = boundDraft(await workspace(request), target);
  const stored = await readFixture(request, target.path);
  expect(await engineAllows(request, target, routeGrant)).toBe(true);
  await clearTraffic(request);

  const editor = page.getByRole("textbox", { name: "Tuple YAML" });
  await expect(editor).toHaveValue(invalid);
  const fetch = page.getByRole("button", { name: "Fetch store tuples", exact: true });
  if (await fetch.isEnabled()) await fetchInstances(page);

  const main = page.getByRole("main");
  const status = main.getByRole("status").or(main.getByRole("alert"));
  const diagnostic = (await status.allTextContents()).join(" ");
  expect.soft(diagnostic, "the editor identifies the actual cause").toMatch(cause);
  expect.soft(diagnostic, "the editor identifies the source location").toMatch(location);
  await expect.soft(editor).toHaveValue(invalid);
  const after = boundDraft(await workspace(request), target);
  expect.soft(after.yaml, "the durable editor buffer is unchanged").toBe(before.yaml);
  expect.soft(after.baseline, "an invalid buffer cannot advance the previous baseline").toEqual(before.baseline);
  expect.soft(after.tuplesChecked, "a rejected fetch cannot mark the baseline current").toBe(before.tuplesChecked);
  expect.soft(await capturedRequests(request, target.path + "/write")).toEqual([]);
  expect(await readFixture(request, target.path)).toEqual(stored);
}

/** Repair the same draft and publish a new grant while preserving the independently stored grant. */
async function repairFetchAndPublish(page: Page, request: APIRequestContext, target: FixtureTarget) {
  const editor = page.getByRole("textbox", { name: "Tuple YAML" });
  await editor.fill(toYaml([companionGrant]));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved to workspace", { exact: true })).toBeVisible();
  await fetchInstances(page);

  await clearTraffic(request);
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Tuple changes published", { exact: true })).toBeVisible();
  const writes = await capturedRequests(request, target.path + "/write");
  expect.soft(writes.flatMap((operation) => operation.deletes?.tuple_keys ?? []),
    "repair and refetch must not turn the original grant into a deletion").toEqual([]);
  expect.soft(writes.flatMap((operation) => operation.writes?.tuple_keys ?? [])).toEqual([companionGrant]);
  expect.soft(await engineAllows(request, target, routeGrant)).toBe(true);
  expect(await engineAllows(request, target, companionGrant)).toBe(true);
}

test("F04 a first Fetch with saved malformed YAML reports the parser location and preserves the prepopulated grant", async ({
  page, request,
}) => {
  const target = await policyFixture(request, "Saved YAML parse failure", baseDsl, [routeGrant]);
  await setDraft(request, target, { yaml: malformedSyntax, baseline: [] }, { autoSave: false, autoPublish: false });
  await openTarget(page, target, "instances");
  await checkInvalidFetch(page, request, target, malformedSyntax,
    /flow sequence|(?:unclosed|unterminated).{0,40}(?:sequence|bracket)|(?:expected|end with).{0,24}\]/i,
    /(?:\bline\s+3\b|\b3:\d+\b|L3\b|:\s*3(?:[: ,]|$))/i);
  await repairFetchAndPublish(page, request, target);
});

test("F04 a first Fetch with an unsaved malformed relation identifies its field without advancing the baseline", async ({
  page, request,
}) => {
  const target = await policyFixture(request, "Unsaved tuple field failure", baseDsl, [routeGrant]);
  await setDraft(request, target, { yaml: "[]\n", baseline: [] }, { autoSave: false, autoPublish: false });
  await openTarget(page, target, "instances");
  const editor = page.getByRole("textbox", { name: "Tuple YAML" });
  await expect(editor).toHaveValue("[]\n");
  await editor.fill(malformedField);
  await checkInvalidFetch(page, request, target, malformedField,
    /\brelation\b.{0,120}\b(?:string|text)\b|\b(?:string|text)\b.{0,120}\brelation\b/i,
    /\b(?:tuple|row|entry)\s*#?\s*1\b|\bline\s+[12]\b|\b[12]:\d+\b|L[12]\b/i);
  await repairFetchAndPublish(page, request, target);
});

/** Ask the normal workbench publication endpoint to commit one authored plan. */
async function publishPlan(request: APIRequestContext, target: FixtureTarget, tuples: Tuple[]) {
  const saved = await setDraft(request, target, {
    dsl: publicationDsl, validDsl: publicationDsl, baseline: [routeGrant], yaml: toYaml(tuples),
  }, { autoSave: false, autoPublish: false });
  return appRequest(request, { action: "publish-tuples", target: { store: target.store, revision: target.revision },
    revision: saved.state.revision });
}

/** The stock writer independently verifies which row is invalid before observing the app plan. */
async function verifyRejectedPlan(request: APIRequestContext, name: string, invalid: Tuple) {
  const target = await policyFixture(request, name, publicationDsl, [routeGrant]);
  const before = await readFixture(request, target.path);
  const rejected = await request.post(proxy + target.path + "/write", { data: {
    authorization_model_id: target.revision, writes: { tuple_keys: [invalid] },
  } });
  expect(rejected.status(), "installed OpenFGA rejects the later tuple by itself").toBe(400);
  expect(await readFixture(request, target.path)).toEqual(before);
  expect(await engineAllows(request, target, companionGrant)).toBe(false);
  await clearTraffic(request);

  const response = await publishPlan(request, target, [routeGrant, companionGrant, invalid]);
  const result = await response.json();
  expect.soft(result.error ?? result.failure?.error).toBe("invalid input");
  expect.soft(await capturedRequests(request, target.path + "/write"),
    "locally invalid later input must stop all upstream mutations").toEqual([]);
  expect.soft(await readFixture(request, target.path)).toEqual(before);
  expect.soft(await engineAllows(request, target, companionGrant)).toBe(false);
  expect(await engineAllows(request, target, routeGrant)).toBe(true);
}

test("F05 preflight rejects a second colon in the later object before any mutation", async ({ request }) => {
  await verifyRejectedPlan(request, "Invalid second object separator", { ...routeGrant, object: "document:local:invalid" });
});

test("F05 preflight rejects a second colon in the later user before any mutation", async ({ request }) => {
  await verifyRejectedPlan(request, "Invalid second user separator", { ...routeGrant, user: "user:local:invalid" });
});

test("F05 preflight rejects a self-defining later userset before any mutation", async ({ request }) => {
  await verifyRejectedPlan(request, "Invalid implicit membership", {
    user: "group:authors#member", relation: "member", object: "group:authors",
  });
});

test("F05 preflight rejects a later tuple for a computed relation before any mutation", async ({ request }) => {
  await verifyRejectedPlan(request, "Invalid direct write to a computed relation", { ...companionGrant, relation: "access" });
});

test("F05 preflight rejects a later tuple missing its model-required condition before any mutation", async ({ request }) => {
  await verifyRejectedPlan(request, "Missing required condition", guarded);
});

test("F05 preflight rejects a mistyped later condition parameter before any mutation", async ({ request }) => {
  await verifyRejectedPlan(request, "Invalid condition parameter type", {
    ...guarded, condition: { name: "region_guard", context: { region: 42 } },
  });
});

test("F05 configured-engine Publish blocks an oversized condition context before the first Write", async ({ page, request }) => {
  const target = await policyFixture(request, "Configured condition context ceiling", publicationDsl, [routeGrant]);
  const oversized = {
    ...guarded,
    // The string is 32 KiB by itself. The protobuf Struct also carries the key and field tags.
    condition: { name: "region_guard", context: { region: "w".repeat(32 * 1024) } },
  };
  const stored = await readFixture(request, target.path);
  const stock = await request.post(proxy + target.path + "/write", { data: {
    authorization_model_id: target.revision, writes: { tuple_keys: [oversized] },
  } });
  expect(stock.status(), "stock OpenFGA rejects this otherwise well-typed context by size").toBe(400);
  expect((await stock.json()).message).toMatch(/condition context.{0,120}(?:size|limit|large|bytes)|context size/i);
  expect(await readFixture(request, target.path)).toEqual(stored);

  await setDraft(request, target, { dsl: publicationDsl, validDsl: publicationDsl, yaml: toYaml([routeGrant]), baseline: [routeGrant] },
    { autoSave: false, autoPublish: false, resetSelections: true });
  await openTarget(page, target, "instances");
  const editor = page.getByRole("textbox", { name: "Tuple YAML", exact: true });
  const authored = "# Keep the stored grant; publish the two additions together.\n" + toYaml([routeGrant, companionGrant, oversized]);
  const contextLine = authored.split("\n").findIndex((line) => /^\s+region:/.test(line)) + 1;
  expect(contextLine).toBeGreaterThan(0);
  await editor.fill(authored);
  await clearTraffic(request);
  await page.getByRole("button", { name: "Publish", exact: true }).click();

  const diagnostics = page.getByRole("region", { name: "Tuple publish diagnostics", exact: true });
  await expect(diagnostics).toBeVisible();
  const attempts = (await capturedRequests(request, target.path + "/write")).map(({ writes, deletes }) => ({
    additions: (writes?.tuple_keys ?? []).map(({ user, relation, object }: Tuple) => [user, relation, object].join(" ")),
    removals: (deletes?.tuple_keys ?? []).map(({ user, relation, object }: Tuple) => [user, relation, object].join(" ")),
  }));
  expect.soft(attempts, "the configured engine must receive zero Write requests").toEqual([]);
  expect.soft(await readFixture(request, target.path), "stored grants are unchanged").toEqual(stored);
  expect.soft(await engineAllows(request, target, routeGrant)).toBe(true);
  expect.soft(await engineAllows(request, target, companionGrant), "the earlier addition must still be denied").toBe(false);

  const check = expect.configure({ soft: true, timeout: 1500 });
  await check(diagnostics).toContainText(/no tuple writes (?:were )?made/i);
  const issue = diagnostics.getByRole("listitem").filter({ hasText: oversized.user });
  await check(issue).toContainText("condition.context");
  await check(issue).toContainText(/\b(?:32\s*KiB|32[,.]?768\s*bytes)\b/i);
  const jump = issue.getByRole("button", { name: new RegExp("\\bline\\s+" + contextLine + "\\b", "i") });
  await check(jump, "the source action identifies the actual context field line").toBeVisible();
  if (await jump.count() === 1) {
    await jump.click();
    await expect(editor).toBeFocused();
    const { start, end } = await editor.evaluate((field: HTMLTextAreaElement) => ({
      start: field.selectionStart, end: field.selectionEnd,
    }));
    expect(authored.slice(0, start).split("\n")).toHaveLength(contextLine);
    expect(end).toBeGreaterThan(start);
  }
});

test("F05 valid plan publishes the intended rows on the selected model and keeps the existing grant", async ({ request }) => {
  const target = await policyFixture(request, "Valid full plan control", publicationDsl, [routeGrant]);
  expect(await engineAllows(request, target, companionGrant)).toBe(false);
  await clearTraffic(request);
  const response = await publishPlan(request, target, [routeGrant, companionGrant, validConditioned, validUserset]);
  expect(response.ok()).toBe(true);
  expect((await response.json()).failure).toBeUndefined();
  const writes = await capturedRequests(request, target.path + "/write");
  expect(writes.map((operation) => operation.authorization_model_id)).toEqual(writes.map(() => target.revision));
  expect(writes.flatMap((operation) => operation.deletes?.tuple_keys ?? [])).toEqual([]);
  expect(writes.flatMap((operation) => operation.writes?.tuple_keys ?? [])).toEqual(
    expect.arrayContaining([companionGrant, validConditioned, validUserset]),
  );
  expect(await readFixture(request, target.path)).toEqual([routeGrant, companionGrant, validConditioned, validUserset]
    .map((tuple) => [tuple.user, tuple.relation, tuple.object].join(" ")).sort());
  expect(await engineAllows(request, target, routeGrant)).toBe(true);
  expect(await engineAllows(request, target, companionGrant)).toBe(true);
  expect(await engineAllows(request, target, guarded)).toBe(true);
});
