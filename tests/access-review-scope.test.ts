import { randomUUID } from "node:crypto";
import { transformer } from "@openfga/syntax-transformer";
import { afterEach, expect, test, vi } from "vitest";

import { POST } from "@/app/api/workbench/route";
import { reviewCatalog } from "@/lib/workbench-access-review-contract";
import type { Tuple } from "@/lib/workbench-contract";
import {
  detached, edgeMarker, inverse, inverseLink, oldRevisionLink, parentLinks, remote, reviewModel,
  scopeObjects, scopeTuples, selectorObjects, storedMarker, tide, unrelated,
} from "./access-review-fixture";

const origin = "http://127.0.0.1:35490";
const engine = "http://127.0.0.1:18080";
const target = { store: "00000000000000000000000001", revision: "00000000000000000000000002" };
const storePath = engine + "/stores/" + target.store;
const modelUrl = storePath + "/authorization-models/" + target.revision;
const readUrl = storePath + "/read";
const allTuples = [...scopeTuples, oldRevisionLink];

/** Exercise the real command boundary and replace only the installed-model and Read responses. */
function fixtureTransport(dsl: string, ...pages: Response[]) {
  const model = { id: target.revision, ...transformer.transformDSLToJSONObject(dsl) };
  const fetch = vi.fn(async (address: string, _init: RequestInit) => {
    void _init;
    if (address === modelUrl) return Response.json({ authorization_model: model });
    if (address === readUrl && pages.length) return pages.shift()!;
    throw new Error("Unexpected provider operation " + address);
  });
  vi.stubEnv("OPENFGA_API_URL", engine);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** Build pinned OpenFGA Read pages independently from the production codec. */
function tuplePage(tuples: Tuple[], continuation_token = "") {
  return Response.json({ tuples: tuples.map((key) => ({ key })), continuation_token });
}

/** Issue one same-origin, independently authored discovery command. */
async function discover(command: object) {
  return POST(new Request(origin + "/api/workbench", {
    method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ target, job: randomUUID(), ...command }),
  }));
}

/** Check discovery reads all requested pages and sends no evaluation or mutation. */
function expectDiscoveryTraffic(fetch: ReturnType<typeof fixtureTransport>, tokens: string[]) {
  expect(fetch.mock.calls.filter(([url]) => url === modelUrl)).toHaveLength(1);
  const reads = fetch.mock.calls.filter(([url]) => url === readUrl);
  expect(reads.map(([, request]) => JSON.parse(String(request.body)))).toEqual(tokens.map((continuation_token) => ({
    continuation_token, page_size: 100, consistency: "HIGHER_CONSISTENCY",
  })));
  expect(fetch.mock.calls).toHaveLength(1 + tokens.length);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("AR01 catalog collects exact concrete identities from every page and omits stored condition values", async () => {
  const transport = fixtureTransport(reviewModel, tuplePage(allTuples.slice(0, 9), "later-page"),
    tuplePage(allTuples.slice(9)));
  const response = await discover({ action: "access-review-catalog" });
  expect(response.status).toBe(200);
  const catalog = await response.json();
  expect(catalog.target).toEqual(target);
  expect([...catalog.objects].sort()).toEqual(selectorObjects);
  expect(catalog.links).toHaveLength(parentLinks.length + 1);
  expect(catalog.links).toEqual(expect.arrayContaining([...parentLinks, inverseLink]));
  expect(JSON.stringify(catalog)).toContain("allowed_region");
  expect(JSON.stringify(catalog)).toContain("TYPE_NAME_STRING");
  expect(JSON.stringify(catalog)).not.toContain(storedMarker);
  expect(JSON.stringify(catalog)).not.toContain(edgeMarker);
  expectDiscoveryTraffic(transport, ["", "later-page"]);
});

test("AR01 keeps a valid long tuple subject selectable", async () => {
  const longSubject = "user:" + "a".repeat(300);
  fixtureTransport(reviewModel, tuplePage([{ user: longSubject, relation: "viewer", object: tide }]));
  const response = await discover({ action: "access-review-catalog" });
  expect(response.status).toBe(200);
  const catalog = await response.json();
  expect(reviewCatalog.is(catalog)).toBe(true);
  expect(catalog.objects).toEqual([tide, longSubject]);
});

const scopeCases = [
  {
    name: "deduplicates a shared descendant through a cycle and discards a link invalid on the installed revision",
    inputs: { root: tide, links: parentLinks, expected: scopeObjects },
    mock: () => fixtureTransport(reviewModel, tuplePage([...allTuples].reverse())),
    expect: assertScope,
  },
  {
    name: "follows the selected inverse relationship instead of the suggested parent rules",
    inputs: { root: tide, links: [inverseLink], expected: [tide, inverse].sort() },
    mock: () => fixtureTransport(reviewModel, tuplePage(allTuples)),
    expect: assertScope,
  },
  {
    name: "returns a represented root with no matching links as its whole scope",
    inputs: { root: detached, links: parentLinks, expected: [detached] },
    mock: () => fixtureTransport(reviewModel, tuplePage(allTuples)),
    expect: assertScope,
  },
  {
    name: "returns a wildcard-only model's represented root when it has no eligible structural links",
    inputs: { root: unrelated, links: [], expected: [unrelated] },
    mock: () => fixtureTransport("model\n  schema 1.1\n\ntype user\n\ntype organization\n  relations\n    define reviewer: [user:*]",
      tuplePage([{ object: unrelated, relation: "reviewer", user: "user:*" }])),
    expect: assertScope,
  },
];

/** Compare exact resource membership and exclude unrelated inputs from the discovery response. */
async function assertScope({ root, expected }: { root: string; expected: string[] },
  transport: ReturnType<typeof fixtureTransport>, response: Response) {
  expect(response.status).toBe(200);
  const scope = await response.json();
  expect(scope.target).toEqual(target);
  expect(scope.root).toBe(root);
  expect(scope.resources.map(({ object }: { object: string }) => object).sort()).toEqual(expected);
  const disclosed = JSON.stringify(scope);
  expect(disclosed).not.toContain(storedMarker);
  expect(disclosed).not.toContain(edgeMarker);
  expect(disclosed).not.toContain(remote);
  expectDiscoveryTraffic(transport, [""]);
}

test.each(scopeCases)("AR01 scope $name", async ({ inputs, mock, expect: evaluate }) => {
  const transport = mock();
  const result = await discover({ action: "access-review-scope", root: inputs.root, links: inputs.links });
  await evaluate(inputs, transport, result);
});

test("automatic scope follows inheritance through a custom relation and explicit child links", async () => {
  const model = reviewModel.replace("type campaign\n  relations\n    define parent:", "type campaign\n  relations\n    define division:")
    .replace("define can_view: can_view from parent\n    define publish:", "define can_view: can_view from division\n    define publish:")
    .replace("define include: [division]", "define include: [division]\n    define can_view_children: can_view from include");
  const records = allTuples.map((tuple) => tuple.object.startsWith("campaign:") && tuple.relation === "parent"
    ? { ...tuple, relation: "division" } : tuple);
  const transport = fixtureTransport(model, tuplePage(records));
  const response = await discover({ action: "access-review-scope", root: tide });
  await assertScope({ root: tide, expected: [...scopeObjects, inverse].sort() }, transport, response);
});

test("AR01 server rejects a relation that does not connect the declared object and subject types", async () => {
  const transport = fixtureTransport(reviewModel, tuplePage(allTuples));
  const response = await discover({ action: "access-review-scope", root: tide, links: [{
    objectType: "campaign", relation: "parent", subjectType: "organization", direction: "subject-to-object",
  }] });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "invalid input", correlationId: expect.any(String) });
  expect(transport.mock.calls.filter(([address]) => address === modelUrl)).toHaveLength(1);
  expect(transport.mock.calls.every(([address]) => [modelUrl, readUrl].includes(address))).toBe(true);
});

const pageFailureCases = [
  {
    name: "rejects a repeated continuation token",
    inputs: { reason: "server error" },
    mock: () => fixtureTransport(reviewModel, tuplePage(allTuples.slice(0, 4), "continuation"),
      tuplePage(allTuples.slice(4), "continuation")),
    expect: assertReadFailure,
  },
  {
    name: "rejects a malformed record on a later page instead of returning the partial hierarchy",
    inputs: { reason: "server error" },
    mock: () => fixtureTransport(reviewModel, tuplePage(allTuples.slice(0, 4), "continuation"),
      Response.json({ tuples: [{ key: { user: 72, relation: "parent", object: tide } }] })),
    expect: assertReadFailure,
  },
];

/** A failed later page leaves no scope data and keeps its safe diagnostic. */
async function assertReadFailure({ reason }: { reason: string }, transport: ReturnType<typeof fixtureTransport>,
  response: Response) {
  expect(response.status).toBe(502);
  const data = await response.json();
  expect(data).toMatchObject({ error: reason, correlationId: expect.any(String) });
  expect(data).not.toHaveProperty("resources");
  expectDiscoveryTraffic(transport, ["", "continuation"]);
}

test.each(pageFailureCases)("AR05 scope $name", async ({ inputs, mock, expect: evaluate }) => {
  const transport = mock();
  const result = await discover({ action: "access-review-scope", root: tide, links: parentLinks });
  await evaluate(inputs, transport, result);
});
