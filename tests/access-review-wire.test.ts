import { transformer } from "@openfga/syntax-transformer";
import { afterEach, expect, test, vi } from "vitest";

import { POST } from "@/app/api/workbench/route";
import { campaign, coastal, editor, reviewModel, tide } from "./access-review-fixture";

const origin = "http://127.0.0.1:35490";
const engine = "http://127.0.0.1:18080";
const target = { store: "00000000000000000000000001", revision: "00000000000000000000000002" };
const modelUrl = engine + "/stores/" + target.store + "/authorization-models/" + target.revision;
const batchUrl = engine + "/stores/" + target.store + "/batch-check";
const allowedCheck = { id: "allow-7", object: campaign, relation: "can_edit" };
const denialCheck = { id: "deny-6", object: coastal, relation: "can_view" };
const credentialMarker = "synthetic-not-a-credential-for-review-75";
const conditionMarker = "synthetic-entered-region-73";
const providerMarker = "synthetic-untrusted-batch-error-71";
const diagnosticId = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/**
 * Stub only OpenFGA transport. OpenFGA v1.22.1 uses a correlation map and nested CheckError oneof.
 * https://github.com/openfga/api/blob/f153694bfc20f7be303e33cabe72b668596c5a06/openfga/v1/openfga_service.proto#L1317-L1377
 */
function provider(reply: Response) {
  const model = { id: target.revision, ...transformer.transformDSLToJSONObject(reviewModel) };
  const fetch = vi.fn(async (url: string, _init: RequestInit) => {
    void _init;
    if (url === modelUrl) return Response.json({ authorization_model: model });
    if (url === batchUrl) return reply;
    throw new Error("Unexpected provider operation " + url);
  });
  vi.stubEnv("OPENFGA_API_URL", engine);
  vi.stubEnv("OPENFGA_PRESHARED_KEY", credentialMarker);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** Send an independently built input through the real same-origin workbench decoder. */
function command(fields: object, from = origin) {
  return POST(new Request(origin + "/api/workbench", {
    method: "POST", headers: { origin: from, "content-type": "application/json" },
    body: JSON.stringify({ action: "access-review-check", target, subject: editor, context: {}, ...fields }),
  }));
}

type Result = Record<string, unknown> & { id?: string };

/** Preserve row order independence while requiring a result for every expected correlation ID. */
function byId(results: Result[] | Record<string, Result>) {
  if (Array.isArray(results)) {
    const rows = Object.fromEntries(results.map((item) => [item.id, item]));
    expect(Object.keys(rows)).toHaveLength(results.length);
    return rows;
  }
  return results;
}

/** Check the real logging sink keeps the fixed text and exact diagnostic field contract. */
function expectSafeLogs(log: { mock: { calls: unknown[][] } }, ids: string[]) {
  expect(log.mock.calls).toHaveLength(ids.length);
  expect(log.mock.calls).toEqual(ids.map((correlationId) => [
    "Workbench operation failed", { category: expect.any(String), correlationId, duration: expect.any(Number) },
  ]));
}

/** Compare protected fixture data against both the decoded reply and emitted logs. */
function expectRedacted(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const marker of [providerMarker, conditionMarker, credentialMarker, target.store, target.revision, editor,
    campaign, "can_edit"]) expect(serialized).not.toContain(marker);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("AR03 pins BatchCheck wire shape and preserves exact allowed and denied siblings of invalid entries", async () => {
  const checks = [allowedCheck, denialCheck,
    { id: "missing", object: campaign, relation: "can_review" },
    { id: "wrong-type", object: tide, relation: "can_view" },
    { id: "both", object: campaign, relation: "can_publish" },
    { id: "provider-error", object: campaign, relation: "publish" },
  ];
  const fetch = provider(Response.json({ result: {
    unrequested: { allowed: true },
    [denialCheck.id]: { allowed: false },
    both: { allowed: false, error: { input_error: "validation_error", message: providerMarker } },
    "provider-error": { error: { input_error: "validation_error", message: providerMarker } },
    "wrong-type": { allowed: "false" },
    [allowedCheck.id]: { allowed: true },
  } }));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const context = { region: conditionMarker };
  const response = await command({ checks, context });
  expect(response.status).toBe(200);
  const rows = byId((await response.json()).results);
  expect(Object.keys(rows).sort()).toEqual(checks.map(({ id }) => id).sort());
  expect(rows[allowedCheck.id].allowed).toBe(true);
  expect(rows[denialCheck.id].allowed).toBe(false);
  const unavailable = [rows.missing, rows["wrong-type"], rows.both, rows["provider-error"]];
  const ids = unavailable.map((row) => {
    expect(row).not.toHaveProperty("allowed");
    expect(JSON.stringify(row)).not.toContain(providerMarker);
    expect(JSON.stringify(row)).not.toMatch(/needs context|missing context/i);
    return JSON.stringify(row).match(diagnosticId)?.[0];
  });
  expect(ids.every(Boolean)).toBe(true);
  expect(new Set(ids).size).toBe(4);
  for (const id of ids) expect(log.mock.calls).toContainEqual([
    "Workbench operation failed", { category: expect.any(String), correlationId: id, duration: expect.any(Number) },
  ]);
  expect(log).toHaveBeenCalledTimes(4);
  expectRedacted(log.mock.calls);

  const batches = fetch.mock.calls.filter(([url]) => url === batchUrl);
  expect(batches).toHaveLength(1);
  const [, sent] = batches[0];
  expect(sent.method).toBe("POST");
  expect(new Headers(sent.headers).get("authorization")).toBe("Bearer " + credentialMarker);
  expect(JSON.parse(String(sent.body))).toEqual({
    authorization_model_id: target.revision, consistency: "HIGHER_CONSISTENCY",
    checks: checks.map(({ id, object, relation }) => ({
      correlation_id: id, tuple_key: { user: editor, object, relation }, context,
    })),
  });
  expect(fetch.mock.calls.every(([url]) => [modelUrl, batchUrl].includes(url))).toBe(true);
});

test("AR03 whole upstream rejection returns only a safe diagnostic and sends no retry", async () => {
  const fetch = provider(Response.json({ code: "validation_error", message: providerMarker }, { status: 400 }));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await command({ checks: [allowedCheck, denialCheck], context: { region: conditionMarker } });
  const result = await response.json();
  expect(response.ok).toBe(false);
  expect(result).toEqual({ error: expect.any(String), correlationId: expect.stringMatching(diagnosticId) });
  expectSafeLogs(log, [result.correlationId]);
  expectRedacted([result, log.mock.calls]);
  expect(fetch.mock.calls.filter(([url]) => url === batchUrl)).toHaveLength(1);
});

const rejectionCases = [
  { name: "foreign origin", inputs: { from: "https://synthetic.invalid", fields: { checks: [allowedCheck] } },
    mock: invalidProvider, expect: assertRejected },
  { name: "empty request", inputs: { from: origin, fields: { checks: [] } }, mock: invalidProvider, expect: assertRejected },
  { name: "over 25 rows", inputs: { from: origin, fields: { checks: Array.from({ length: 26 }, (_, index) =>
    ({ ...allowedCheck, id: "over-" + index, object: "campaign:over-" + index })) } },
    mock: invalidProvider, expect: assertRejected },
  { name: "duplicate correlation IDs attached to different tuples",
    inputs: { from: origin, fields: { checks: [allowedCheck, { ...denialCheck, id: allowedCheck.id }] } },
    mock: invalidProvider, expect: assertRejected },
  { name: "36-character limit exceeded", inputs: { from: origin, fields: { checks: [{ ...allowedCheck, id: "a".repeat(37) }] } },
    mock: invalidProvider, expect: assertRejected },
  { name: "correlation ID contains an underscore", inputs: { from: origin, fields: { checks: [{ ...allowedCheck, id: "bad_id" }] } },
    mock: invalidProvider, expect: assertRejected },
  { name: "wildcard in place of a concrete subject",
    inputs: { from: origin, fields: { subject: "user:*", checks: [allowedCheck] } }, mock: invalidProvider, expect: assertRejected },
  { name: "blank relation",
    inputs: { from: origin, fields: { checks: [{ ...allowedCheck, relation: " " }] } }, mock: invalidProvider, expect: assertRejected },
  { name: "non-map condition context", inputs: { from: origin, fields: { context: [], checks: [allowedCheck] } },
    mock: invalidProvider, expect: assertRejected },
];

/** A valid provider reply must never be observed for inputs rejected at the app boundary. */
function invalidProvider() {
  return provider(Response.json({ result: { [allowedCheck.id]: { allowed: true } } }));
}

/** Assert rejection happens before any upstream access. */
async function assertRejected(_inputs: { fields: object }, fetch: ReturnType<typeof invalidProvider>, response: Response) {
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid input", correlationId: expect.stringMatching(diagnosticId) });
  expect(fetch).not.toHaveBeenCalled();
}

test.each(rejectionCases)("AR06 rejects $name before provider traffic", async ({ inputs, mock, expect: evaluate }) => {
  const fetch = mock();
  const response = await command(inputs.fields, inputs.from);
  await evaluate(inputs, fetch, response);
});
