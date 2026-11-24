import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { transformer } from "@openfga/syntax-transformer";
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

import type { Tuple } from "@/lib/workbench-contract";
import {
  baseDsl, boundDraft, companionGrant, gateState, openTarget, policyFixture, routeGrant, setDraft, toYaml, workspace,
  type FixtureTarget,
} from "./finding-helpers";
import { armTransport, capturedRequests, clearTraffic, postToEngine, readFixture } from "./workbench-fixtures";

const feedback = expect.configure({ soft: true, timeout: 1800 });
const reviewer = { user: "user:ellis", relation: "reviewer", object: "document:review-draft" };
const owner = { user: "user:riley", relation: "owner", object: "document:handoff" };
const otherReviewer = { user: "user:devon", relation: "reviewer", object: "document:other-draft" };
const validAddition = { user: "user:sky", relation: "viewer", object: "document:notes" };
const wrongSubject = { user: "group:contractors#member", relation: "viewer", object: "document:field-notes" };
const fixedSubject = { ...wrongSubject, user: "user:ellis" };

function tupleEditor(page: Page) {
  return page.getByRole("textbox", { name: "Tuple YAML", exact: true });
}

function publishButton(page: Page) {
  return page.getByRole("button", { name: "Publish", exact: true });
}

function keys(tuples: Tuple[]) {
  return tuples.map(({ user, relation, object }) => [user, relation, object].join(" ")).sort();
}

/** Install a real relation model and make one successful UI publish before testing the rejection. */
async function openPublishedDraft(page: Page, request: APIRequestContext, name: string, dsl = baseDsl) {
  const target = await policyFixture(request, name, dsl, [routeGrant]);
  await setDraft(request, target, { dsl, validDsl: dsl, yaml: toYaml([routeGrant, companionGrant]), baseline: [routeGrant] },
    { autoSave: false, autoPublish: false, resetSelections: true });
  await openTarget(page, target, "instances");
  await publishButton(page).click();
  await expect(page.getByText("Tuple changes published", { exact: true })).toBeVisible();
  expect(await readFixture(request, target.path)).toEqual(keys([routeGrant, companionGrant]));
  return target;
}

/** Derive both permissible source labels from the authored YAML, including interspersed comments. */
function authoredLocation(yaml: string, tuple: Tuple, field: "relation" | "user") {
  const source = new LineCounter();
  const document = parseDocument(yaml, { lineCounter: source });
  if (!isSeq(document.contents)) throw new Error("The fixture must be a sequence");
  const tuples: Tuple[] = document.toJS();
  const index = tuples.findIndex(({ user, relation, object }) =>
    user === tuple.user && relation === tuple.relation && object === tuple.object);
  const row = document.contents.items[index];
  if (!isMap(row) || !row.range) throw new Error("No authored tuple row for " + tuple.object);
  const value = row.get(field, true);
  if (!isScalar(value) || !value.range) throw new Error("No authored " + field + " for " + tuple.object);
  return {
    start: row.range[0],
    end: row.range[1],
    rowLine: source.linePos(row.range[0]).line,
    fieldLine: source.linePos(value.range[0]).line,
  };
}

/** Locate a source command by its own line, independently of the diagnostics panel's layout. */
function sourceAction(page: Page, location: ReturnType<typeof authoredLocation>) {
  const label = new RegExp("\\bline\\s*[:#]?\\s*(?:" + location.rowLine + "|" + location.fieldLine + ")\\b", "i");
  const editor = page.getByRole("main");
  return editor.getByRole("button", { name: label }).or(editor.getByRole("link", { name: label }));
}

/** Require full tuple identity, field, cause, fix, and an exact selected row for each issue. */
async function expectIssue(page: Page, yaml: string, tuple: Tuple, field: "relation" | "user", cause: RegExp, fix: RegExp) {
  const location = authoredLocation(yaml, tuple, field);
  const action = sourceAction(page, location);
  await feedback(action, "one source command for " + tuple.object).toHaveCount(1);
  if (await action.count() !== 1) return;
  const row = action.locator("xpath=ancestor::*[self::li or self::tr or self::article or @role='listitem' or @role='row' or @role='group'][1]");
  await feedback(row, "the source action belongs to its own diagnostic row").toBeVisible();
  if (await row.count() !== 1) return;
  await feedback(row).toContainText(tuple.user);
  await feedback(row).toContainText(tuple.relation);
  await feedback(row).toContainText(tuple.object);
  await feedback(row).toContainText(field === "user" ? /\b(?:user|subject)\b/i : /\brelation\b/i);
  await feedback(row).toContainText(cause);
  await feedback(row).toContainText(fix);

  await action.click();
  const editor = tupleEditor(page);
  await feedback(editor).toBeFocused();
  const selected = await editor.evaluate((element: HTMLTextAreaElement) => ({
    start: element.selectionStart, end: element.selectionEnd,
  }));
  expect.soft(selected.start, "selection starts inside " + tuple.object).toBeGreaterThanOrEqual(location.start);
  expect.soft(selected.start, "selection identifies the correct tuple").toBeLessThan(location.end);
  expect.soft(selected.end, "the source command selects text").toBeGreaterThan(selected.start);
  expect.soft(selected.end, "selection does not include another tuple").toBeLessThanOrEqual(location.end);
}

/** Confirm the failed ordinary Publish leaves the real grants and baseline untouched. */
async function rejectDraft(page: Page, request: APIRequestContext, target: FixtureTarget, yaml: string, first: Tuple,
  field: "relation" | "user") {
  const prior = boundDraft(await workspace(request), target);
  const before = await readFixture(request, target.path);
  await clearTraffic(request);
  await tupleEditor(page).fill(yaml);
  await publishButton(page).click();

  const main = page.getByRole("main");
  const priorGenericError = main.getByRole("status").filter({ hasText: /\binvalid input\b/i });
  await expect(priorGenericError.or(sourceAction(page, authoredLocation(yaml, first, field))).first()).toBeVisible();
  await feedback(tupleEditor(page)).toHaveValue(yaml);
  await feedback(page.getByRole("combobox", { name: "Model revision", exact: true })).toHaveValue(target.revision);
  await feedback(main.getByText("Tuple changes published", { exact: true })).toHaveCount(0);
  await feedback(main.getByText(/\b(?:retry (?:the )?operation|publish again)\b/i)).toHaveCount(0);
  await feedback(page.getByRole("button", { name: /^(?:Retry|Publish again)\b/i })).toHaveCount(0);

  const progress = main.getByText(/\b[1-9]\d*\s+(?:completed|published|written)\b/i);
  for (const summary of await progress.allTextContents()) {
    expect.soft(summary, "nonzero progress is clearly labeled as history").toMatch(/\b(?:previous|prior|earlier|historical|last successful)\b/i);
  }
  expect.soft(await capturedRequests(request, target.path + "/write")).toEqual([]);
  expect(await readFixture(request, target.path)).toEqual(before);
  const after = boundDraft(await workspace(request), target);
  expect(after.baseline).toEqual(prior.baseline);
  expect(after.tuplesChecked).toEqual(prior.tuplesChecked);
}

/** Use the normal Publish action and compare exact writes and actual durable tuples. */
async function publishAndRead(page: Page, request: APIRequestContext, target: FixtureTarget, original: Tuple[], expected: Tuple[]) {
  await clearTraffic(request);
  await publishButton(page).click();
  await expect(page.getByText("Tuple changes published", { exact: true })).toBeVisible();
  const operations = await capturedRequests(request, target.path + "/write");
  expect(operations.map(({ authorization_model_id }) => authorization_model_id))
    .toEqual(Array.from({ length: operations.length }, () => target.revision));
  expect(operations.flatMap((operation) => operation.deletes?.tuple_keys ?? [])).toEqual([]);
  expect(keys(operations.flatMap((operation) => operation.writes?.tuple_keys ?? []))).toEqual(keys(expected));
  expect(await readFixture(request, target.path)).toEqual(keys([...original, ...expected]));
}

const undefinedRelation = /\b(?:not (?:defined|declared|available|found)|undefined|unknown|missing|no (?:such )?relation|does not (?:exist|define|contain|have)|has no)\b/i;
const relationFix = /\b(?:choose|select|switch|use|edit|change|replace|add|define|remove|publish)\b[\s\S]{0,120}\b(?:model|revision|relation|tuple|viewer|editor)\b/i;

test("tuple Publish identifies every missing relation at its YAML source and succeeds with a compatible revision", async ({ page, request }) => {
  const older = await openPublishedDraft(page, request, "Tuple revision diagnostics");
  const compatibleDsl = baseDsl + "\n    define reviewer: [user]\n    define owner: [user]\n";
  const { authorization_model_id: revision } = await postToEngine(request, older.path + "/authorization-models",
    transformer.transformDSLToJSONObject(compatibleDsl));
  const revisionControl = page.getByRole("combobox", { name: "Model revision", exact: true });
  await page.reload();
  await expect(revisionControl.getByRole("option", { name: revision, exact: true })).toHaveCount(1);
  await expect(revisionControl).toHaveValue(older.revision);
  const yaml = [
    "# Existing grant and a valid new addition before the first error.",
    toYaml([routeGrant, validAddition]).trimEnd(),
    "",
    "# Reviewer is defined only on the other installed revision.",
    toYaml([reviewer]).trimEnd(),
    "",
    "# A valid tuple separates the next two diagnostics.",
    toYaml([companionGrant]).trimEnd(),
    toYaml([owner]).trimEnd(),
    "",
    "# Report the second use of a missing relation as its own tuple.",
    toYaml([otherReviewer]).trimEnd(),
    "",
  ].join("\n");

  await rejectDraft(page, request, older, yaml, reviewer, "relation");
  for (const tuple of [reviewer, owner, otherReviewer]) {
    await expectIssue(page, yaml, tuple, "relation", undefinedRelation, relationFix);
  }
  for (const tuple of [routeGrant, companionGrant, validAddition]) {
    await feedback(sourceAction(page, authoredLocation(yaml, tuple, "relation")), "valid rows are not errors").toHaveCount(0);
  }

  await revisionControl.selectOption(revision);
  await expect(revisionControl).toHaveValue(revision);
  await feedback(tupleEditor(page)).toHaveValue(yaml);
  await publishAndRead(page, request, { ...older, revision }, [routeGrant, companionGrant],
    [validAddition, reviewer, owner, otherReviewer]);
  for (const tuple of [reviewer, owner, otherReviewer]) {
    await feedback(sourceAction(page, authoredLocation(yaml, tuple, "relation"))).toHaveCount(0);
  }
});

test("tuple Publish explains an invalid userset on an allowed relation and succeeds after repairing that subject", async ({ page, request }) => {
  const dsl = baseDsl + "\n\ntype group\n  relations\n    define member: [user]\n";
  const target = await openPublishedDraft(page, request, "Tuple subject diagnostics", dsl);
  const valid = [routeGrant, companionGrant, validAddition];
  const yaml = "# This viewer relation exists, but it allows only direct users.\n" + toYaml([...valid, wrongSubject]);
  await rejectDraft(page, request, target, yaml, wrongSubject, "user");
  await expectIssue(page, yaml, wrongSubject, "user",
    /\b(?:not (?:allowed|permitted|accepted|assignable|valid)|does not (?:allow|accept|permit|support|match)|disallows?|incompatible|expects?|only accepts?)\b/i,
    /\b(?:choose|use|change|replace|edit|specify|enter|select|publish)\b[\s\S]{0,120}\b(?:user|subject|model|revision)\b/i);

  const repaired = yaml.replace(wrongSubject.user, fixedSubject.user);
  await tupleEditor(page).fill(repaired);
  await publishAndRead(page, request, target, [routeGrant, companionGrant], [validAddition, fixedSubject]);
  await feedback(sourceAction(page, authoredLocation(yaml, wrongSubject, "user"))).toHaveCount(0);
});

test("tuple Publish keeps an untrusted upstream write failure redacted on the wire and in the UI", async ({ page, request }) => {
  const target = await openPublishedDraft(page, request, "Tuple transport diagnostic privacy");
  await clearTraffic(request);
  await armTransport(request, [{ path: target.path + "/write", kind: "service-error" }]);
  await tupleEditor(page).fill(toYaml([routeGrant, companionGrant, validAddition]));
  const receipt = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/workbench"
    && response.request().method() === "POST" && response.request().postDataJSON().action === "publish-tuples");
  await publishButton(page).click();
  const wire = await (await receipt).text();
  const payload = JSON.parse(wire);
  const diagnostic = payload.failure ?? payload;
  expect(diagnostic).toEqual({
    error: "server error",
    correlationId: expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i),
  });
  const status = page.getByRole("main").getByRole("status").filter({ hasText: diagnostic.correlationId });
  await expect(status).toBeVisible();
  await expect(status).toContainText("server error");
  const upstreamMarker = "synthetic_untrusted_error_52";
  expect(wire).not.toContain(upstreamMarker);
  await expect(page.getByText(upstreamMarker, { exact: false })).toHaveCount(0);
  expect(await capturedRequests(request, target.path + "/write")).toHaveLength(1);
  expect(await readFixture(request, target.path)).toEqual(keys([routeGrant, companionGrant]));
});

const blockedPublish = /\b(?:publish(?:ing)? (?:blocked|failed|rejected|stopped)|(?:could not|failed to|cannot) publish|publish tuples.{0,60}invalid input)\b/i;

/** Hold the installed model reply for the captured Publish without replacing the engine result. */
async function rejectCapturedPublish(page: Page, request: APIRequestContext, target: FixtureTarget, yaml: string,
  whilePending: () => Promise<void>) {
  const gate = "captured-tuple-preflight-model";
  await tupleEditor(page).fill(yaml);
  await clearTraffic(request);
  await armTransport(request, [{ path: target.path + "/authorization-models/" + target.revision, kind: "gate-response", gate }]);
  const receipt = page.waitForResponse((response) => {
    const sent = response.request();
    if (new URL(response.url()).pathname !== "/api/workbench" || sent.method() !== "POST") return false;
    const payload = sent.postDataJSON();
    return payload.action === "publish-tuples" && payload.target?.store === target.store
      && payload.target?.revision === target.revision;
  });
  try {
    await publishButton(page).click();
    await expect.poll(() => gateState(request)).toContain(gate);
    await expect(publishButton(page)).toBeDisabled();
    expect(boundDraft(await workspace(request), target).yaml).toBe(yaml);
    await whilePending();
    await gateState(request, gate);
    const rejection = await receipt;
    expect(rejection.status()).toBe(400);
    expect(await rejection.json()).toMatchObject({ error: "invalid input", tupleIssues: [{ reason: "relationMissing" }] });
  } finally {
    await gateState(request, gate);
  }
}

test("F13 a rejected tuple Publish reports its outcome after the editor changes without a stale source jump", async ({ page, request }) => {
  const target = await openPublishedDraft(page, request, "Tuple preflight after a newer edit");
  const stored = await readFixture(request, target.path);
  const original = toYaml([routeGrant, companionGrant, reviewer]);
  const newer = "# Newer unpublished edit.\n" + toYaml([routeGrant, companionGrant, validAddition]);
  await rejectCapturedPublish(page, request, target, original, async () => {
    await tupleEditor(page).fill(newer);
    await expect(tupleEditor(page)).toHaveValue(newer);
  });

  const main = page.getByRole("main");
  await expect(publishButton(page)).toBeEnabled();
  await feedback(main.getByText(blockedPublish), "the initiating editor still reports the captured rejection").toBeVisible();
  await expect(main.getByText("Tuple changes published", { exact: true })).toHaveCount(0);
  await expect(main.getByRole("button", { name: /\bsource line\b/i })).toHaveCount(0);
  await expect(tupleEditor(page)).toHaveValue(newer);
  await expect(page.getByRole("combobox", { name: "Model revision", exact: true })).toHaveValue(target.revision);
  expect(await capturedRequests(request, target.path + "/write")).toEqual([]);
  expect(await readFixture(request, target.path)).toEqual(stored);
  expect(boundDraft(await workspace(request), target).yaml).toBe(original);
});

test("F13 a rejected tuple Publish stays with its originating store after switching targets", async ({ page, request }) => {
  const other = await policyFixture(request, "Independent store during preflight", baseDsl, [validAddition]);
  const otherYaml = "# Independent target draft.\n" + toYaml([validAddition]);
  await setDraft(request, other, { yaml: otherYaml, baseline: [validAddition] });
  const target = await openPublishedDraft(page, request, "Originating store with pending preflight");
  const original = toYaml([routeGrant, companionGrant, reviewer]);
  const store = page.getByRole("combobox", { name: "Store", exact: true });
  const revision = page.getByRole("combobox", { name: "Model revision", exact: true });
  await rejectCapturedPublish(page, request, target, original, async () => {
    await store.selectOption(other.store);
    await expect(store).toHaveValue(other.store);
    await expect(revision).toHaveValue(other.revision);
    await expect(tupleEditor(page)).toHaveValue(otherYaml);
  });

  const main = page.getByRole("main");
  await expect(store).toHaveValue(other.store);
  await expect(revision).toHaveValue(other.revision);
  await expect(tupleEditor(page)).toHaveValue(otherYaml);
  await expect(main.getByText(blockedPublish)).toHaveCount(0);
  await expect(main.getByRole("button", { name: /\bsource line\b/i })).toHaveCount(0);
  await store.selectOption(target.store);
  await expect(store).toHaveValue(target.store);
  await expect(revision).toHaveValue(target.revision);
  await expect(tupleEditor(page)).toHaveValue(original);
  await expect(publishButton(page)).toBeEnabled();
  await feedback(main.getByText(blockedPublish), "the result remains available on the originating store").toBeVisible();
  expect(await capturedRequests(request, target.path + "/write")).toEqual([]);
  expect(await capturedRequests(request, other.path + "/write")).toEqual([]);
  expect(await readFixture(request, target.path)).toEqual(keys([routeGrant, companionGrant]));
  expect(await readFixture(request, other.path)).toEqual(keys([validAddition]));
});

test("F13 tuple Publish distinguishes the current success counts from earlier counts after a blocked attempt", async ({ page, request }) => {
  const target = await openPublishedDraft(page, request, "Tuple completion attribution");
  const main = page.getByRole("main");
  const completed = main.getByText(/\b1 completed\s*·\s*0 pending\b/i);
  await expect(completed).toBeVisible();
  await feedback(completed, "the counts belong to the current successful Publish")
    .toContainText(/\b(?:this attempt|current (?:attempt|publish|result)|just.completed|tuple changes published)\b/i);

  const invalid = toYaml([routeGrant, companionGrant, reviewer]);
  await rejectDraft(page, request, target, invalid, reviewer, "relation");
  await expect(main.getByText(/\bno tuple writes (?:were )?made\b/i)).toBeVisible();
  await expect(completed).toContainText(/\b(?:previous|prior|earlier|historical|last successful)\b/i);
});
