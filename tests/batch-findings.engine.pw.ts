import { readFile } from "node:fs/promises";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { parse } from "yaml";

import { exportBatch, importBatch } from "@/lib/workbench-batches";
import type { Batch, Tuple, WorkspaceView } from "@/lib/workbench-contract";
import {
  appCommand, appRequest, baseDsl, companionGrant, engineAllows, fetchInstances, gateState, openTarget,
  policyFixture, routeGrant, setDraft, toYaml, workspace, type FixtureTarget,
} from "./finding-helpers";
import { armTransport, capturedRequests, clearTraffic, readFixture } from "./workbench-fixtures";

/** Create several authored assertions whose names and boolean values cannot identify them. */
async function stageBatch(request: APIRequestContext, name: string) {
  const source = await policyFixture(request, name + " source");
  const batch: Batch = {
    id: crypto.randomUUID(), name, tuples: [routeGrant], cases: [
      { id: crypto.randomUUID(), name: "Repeated case", tuples: [], assertions: [
        { input: { operation: "check", ...routeGrant }, expected: true },
        { input: { operation: "check", ...routeGrant, relation: "access" }, expected: true },
      ] },
      { id: crypto.randomUUID(), name: "Repeated case", tuples: [], assertions: [
        { input: { operation: "check", ...routeGrant, relation: "editor" }, expected: false },
      ] },
    ],
  };
  const { state } = await workspace(request);
  const saved = await appCommand(request, { action: "save", state: {
    ...state, batches: [...state.batches, batch], selections: { ...state.selections, batch: batch.id },
  } });
  const staged = await appCommand(request, { action: "fixture", batchId: batch.id,
    source: { store: source.store, revision: source.revision }, revision: saved.state.revision });
  const binding = staged.state.batches.find((entry) => entry.id === batch.id)?.installations?.[staged.endpoint]?.fixture;
  expect(binding, "the actual fixture was staged by the workbench").toBeDefined();
  const fixture = { store: binding!.store, revision: binding!.revision, path: "/stores/" + binding!.store };
  expect(await engineAllows(request, fixture, routeGrant)).toBe(true);
  return { batch, fixture };
}

/** Submit the real workbench batch command for its current committed input revision. */
async function batchCommand(request: APIRequestContext, batch: Batch, job: string) {
  const revision = (await workspace(request)).state.revision;
  return appRequest(request, { action: "batch", batchId: batch.id,
    cases: batch.cases.map(({ id }) => id), revision, job });
}

/** Wait for the report in the real Batches screen and expose only assertion rows. */
async function reportRows(page: Page) {
  await page.goto("/batches");
  await expect(page.getByRole("heading", { name: "Last run", exact: true })).toBeVisible();
  return page.getByRole("table").locator("tbody").getByRole("row");
}

test("F11 report distinguishes duplicate case occurrences and equal-boolean Check assertions", async ({ page, request }) => {
  const { batch } = await stageBatch(request, "Assertion identities");
  const complete = await batchCommand(request, batch, crypto.randomUUID());
  expect(complete.ok()).toBe(true);
  const receipt: WorkspaceView = await complete.json();
  expect(receipt.state.report?.rows.map((row) => row.status)).toEqual(["pass", "pass", "pass"]);
  const rows = await reportRows(page);
  await expect(rows).toHaveCount(3);
  await expect.soft(rows.nth(0)).toContainText("viewer", { timeout: 1600 });
  await expect.soft(rows.nth(1)).toContainText("access", { timeout: 1600 });
  await expect.soft(rows.nth(2)).toContainText("editor", { timeout: 1600 });
  await expect.soft(rows.nth(0)).toContainText(/(?:case\s+1\b|1[.)]\s*Repeated case)/i, { timeout: 1600 });
  await expect(rows.nth(2)).toContainText(/(?:case\s+2\b|2[.)]\s*Repeated case)/i, { timeout: 1600 });
});

test("F11 an overwritten authored case does not shrink the last completed run", async ({ page, request }) => {
  const { batch } = await stageBatch(request, "Stable completed totals");
  const complete = await batchCommand(request, batch, crypto.randomUUID());
  expect(complete.ok()).toBe(true);
  const rows = await reportRows(page);
  await expect(rows).toHaveCount(3);
  const { state } = await workspace(request);
  const original = state.report;
  expect(original?.rows).toHaveLength(3);
  const selected = state.batches.find(({ id }) => id === batch.id)!;
  const replaced = { ...selected.cases[0], id: crypto.randomUUID(), assertions: [selected.cases[0].assertions[1]] };
  await appCommand(request, { action: "save", state: {
    ...state, batches: state.batches.map((candidate) => candidate.id === batch.id
      ? { ...selected, cases: [replaced, ...selected.cases.slice(1)] } : candidate),
  } });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Last run", exact: true })).toBeVisible();
  await expect.soft(page.getByText(/Higher consistency.*pass 3/i)).toBeVisible({ timeout: 1600 });
  await expect.soft(rows).toHaveCount(3, { timeout: 1600 });
  expect((await workspace(request)).state.report).toEqual(original);
});

test("F11 cancel during fixture verification releases the reservation before a withheld response", async ({ request }) => {
  const { batch, fixture } = await stageBatch(request, "Fixture setup cancellation");
  const saved = await setDraft(request, fixture, { yaml: toYaml([routeGrant]), baseline: [routeGrant] });
  const gate = "batch-setup-reply";
  const job = crypto.randomUUID();
  await clearTraffic(request);
  await armTransport(request, [{ path: fixture.path + "/read", kind: "gate-response", gate }]);
  const response = batchCommand(request, batch, job);
  const writer = { action: "publish-tuples", target: { store: fixture.store, revision: fixture.revision },
    revision: saved.state.revision };
  try {
    await expect.poll(() => gateState(request)).toContain(gate);
    const busy = await appRequest(request, writer);
    expect(busy.status()).toBe(409);
    expect(await busy.json()).toMatchObject({ error: "Batch running" });
    expect(await appCommand(request, { action: "cancel", job })).toMatchObject({ cancelled: true });
    await expect.configure({ soft: true }).poll(
      () => appCommand<{ active: boolean }>(request, { action: "progress", job }).then(({ active }) => active),
      { timeout: 1800 },
    ).toBe(false);
    const now = await workspace(request);
    const released = await appRequest(request, { ...writer, revision: now.state.revision });
    expect.soft(released.ok()).toBe(true);
    expect.soft(await capturedRequests(request, fixture.path + "/check")).toEqual([]);
  } finally {
    await gateState(request, gate);
    await response;
  }
  expect(await capturedRequests(request, fixture.path + "/check")).toEqual([]);
});

type SplitFixture = { tuples: Tuple[]; tests: { position: number; name: string; tuples: Tuple[] }[] };

/** Export the real two-file format with a grant isolated to the first duplicate case. */
async function exportedCompanion(): Promise<SplitFixture> {
  const name = "Same case name";
  const file = new File([JSON.stringify({ name: "Synthetic companion", tuples: [companionGrant], tests: [
    { name, tuples: [routeGrant], check: [{ user: routeGrant.user, object: routeGrant.object, assertions: { viewer: true } }] },
    { name, check: [{ user: routeGrant.user, object: routeGrant.object, assertions: { viewer: false } }] },
  ] })], "case-isolation.fga.yaml");
  const files = exportBatch(await importBatch([file]), true);
  expect(files.map((file) => file.name)).toEqual(["Synthetic-companion.fga.yaml", "tuples.yaml"]);
  const companion: SplitFixture = parse(files[1].content);
  expect(companion.tests.map(({ position, name }) => ({ position, name }))).toEqual([{ position: 0, name }, { position: 1, name }]);
  return companion;
}

/** Keep the contract scoped to the root README's split-export staging instructions. */
const fetchInstruction = /\bfetch\b[\s\S]{0,160}\b(?:tuples?|baseline|fixture)\b/i;

async function guide() {
  const readme = await readFile("README.md", "utf8");
  return readme.split(/^## Regression batches\s*$/m)[1]?.split(/^## /m)[0] ?? "";
}

/** Bring the authored data through Instances and wait for the actual publish result. */
async function stageFromEditor(page: Page, target: FixtureTarget, tuples: Tuple[]) {
  await openTarget(page, target, "instances");
  await page.getByRole("textbox", { name: "Tuple YAML" }).fill(toYaml(tuples));
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Tuple changes published", { exact: true })).toBeVisible();
}

/** Replay the effective companion data in an already-used fixture with no local baseline. */
async function stageBoth(page: Page, request: APIRequestContext, fetchBeforeReuse: boolean) {
  const fixture = await exportedCompanion();
  const target = await policyFixture(request, "Split companion configured fixture");
  const initial = await setDraft(request, target, { yaml: "[]\n", baseline: [] }, { autoSave: false, autoPublish: false });
  expect(initial.endpoint).toBe("http://127.0.0.1:" + (process.env.FGA_TEST_PROXY_PORT ?? "35492"));
  await stageFromEditor(page, target, [...fixture.tuples, ...fixture.tests[0].tuples]);
  expect(await engineAllows(request, target, routeGrant)).toBe(true);

  // A different local workspace can reuse the configured store without a fetched baseline.
  await setDraft(request, target, { yaml: "[]\n", baseline: [] });
  await openTarget(page, target, "instances");
  if (fetchBeforeReuse) await fetchInstances(page);
  await page.getByRole("textbox", { name: "Tuple YAML" }).fill(toYaml([...fixture.tuples, ...fixture.tests[1].tuples]));
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Tuple changes published", { exact: true })).toBeVisible();
  expect.soft(await readFixture(request, target.path))
    .toEqual(fixture.tuples.map((tuple) => [tuple.user, tuple.relation, tuple.object].join(" ")).sort());
  expect(await engineAllows(request, target, routeGrant)).toBe(false);
}

test("F12 the split companion guide explains verified cleanup and the configured CLI endpoint", async () => {
  const section = await guide();
  expect.soft(section).toMatch(fetchInstruction);
  expect.soft(section).toMatch(/(?:verify|check).{0,80}(?:fixture|tuples)/i);
  expect(section).toMatch(/--api-url[\s\S]{0,120}(?:OPENFGA_API_URL|ENDPOINT|API_URL)|configured[\s\S]{0,150}--api-url/i);
});

test("F12 following the split guide on a reused configured store isolates the second case", async ({ page, request }) => {
  const fetchBeforeReuse = fetchInstruction.test(await guide());
  await stageBoth(page, request, fetchBeforeReuse);
});

test("F12 fetched-baseline control removes the first case grant with the export format unchanged", async ({ page, request }) => {
  await stageBoth(page, request, true);
});
