import { expect, type APIRequestContext } from "@playwright/test";

const transportUrl = "http://127.0.0.1:" + (process.env.FGA_TEST_PROXY_PORT ?? "35492");
const controlPath = "/__fga_test__/traffic";

export type Tuple = { user: string; relation: string; object: string };
type CapturedRequest = { method: string; path: string; body: string };
type StoredTuple = { key: Tuple };
type TransportFault = {
  path: string;
  kind: "drop-success" | "drop-request" | "service-error" | "malformed-success" | "malformed-error" | "repeat-token" | "hold-response" | "gate-response" | "forward";
  gate?: string;
  when?: "continued";
};

/** The synthetic store uses the pinned OpenFGA REST contract without app request builders. */
const model = {
  schema_version: "1.1",
  type_definitions: [
    { type: "user" },
    {
      type: "organization",
      relations: {
        parent: { this: {} },
        member: { this: {} },
        blocked: { this: {} },
        eligible: {
          union: {
            child: [
              { computedUserset: { relation: "member" } },
              { tupleToUserset: { tupleset: { relation: "parent" }, computedUserset: { relation: "eligible" } } },
            ],
          },
        },
        can_read: {
          difference: {
            base: { computedUserset: { relation: "eligible" } },
            subtract: { computedUserset: { relation: "blocked" } },
          },
        },
      },
      metadata: {
        relations: {
          parent: { directly_related_user_types: [{ type: "organization" }] },
          member: { directly_related_user_types: [{ type: "user" }] },
          blocked: { directly_related_user_types: [{ type: "user" }] },
        },
      },
    },
  ],
};

export const memberThroughParent: Tuple = {
  user: "user:maya",
  relation: "member",
  object: "organization:doordash",
};

export const parent: Tuple = {
  user: "organization:doordash",
  relation: "parent",
  object: "organization:ca",
};

export const localGrant: Tuple = { user: "user:casey", relation: "member", object: "organization:ca" };

/** A distinct stored membership makes Casey selectable without granting access to CA. */
export const storedTuples: Tuple[] = [
  parent,
  memberThroughParent,
  { user: "user:casey", relation: "member", object: "organization:unrelated" },
];

/** Submit hand-authored fixture payloads to the real engine. */
export async function postToEngine(request: APIRequestContext, path: string, data: object) {
  const response = await request.post(transportUrl + path, { data });
  expect(response.ok(), "fixture operation " + path + " returned " + response.status()).toBe(true);
  return response.json();
}

/** Isolate each case in a newly installed store and assert the fixture was accepted. */
export async function installFixture(request: APIRequestContext, name: string) {
  const store: { id: string; name: string } = await postToEngine(request, "/stores", { name });
  const installed: { authorization_model_id: string } =
    await postToEngine(request, "/stores/" + store.id + "/authorization-models", model);
  const revision = installed.authorization_model_id;
  expect(revision).toMatch(/^[A-Z0-9]{26}$/);

  await postToEngine(request, "/stores/" + store.id + "/write", {
    authorization_model_id: revision,
    writes: { tuple_keys: storedTuples },
  });
  await clearTraffic(request);
  return { store: store.id, path: "/stores/" + store.id, name, revision };
}

/** Reset request observations after setup so only the consumer flow is asserted. */
export async function clearTraffic(request: APIRequestContext) {
  const response = await request.delete(transportUrl + controlPath);
  expect(response.ok()).toBe(true);
}

/** Observe operation bodies independently of the app's rendered request disclosure. */
export async function capturedRequests(request: APIRequestContext, path: string) {
  const response = await request.get(transportUrl + controlPath);
  expect(response.ok()).toBe(true);
  const traffic: CapturedRequest[] = await response.json();
  return traffic.filter((entry) => entry.method === "POST" && entry.path === path)
    .map((entry) => JSON.parse(entry.body));
}

/** Compare sorted tuple keys so engine storage order cannot affect the assertion. */
export async function readFixture(request: APIRequestContext, path: string) {
  const result: { tuples: StoredTuple[] } = await postToEngine(request, path + "/read", {
    page_size: 100,
    consistency: "HIGHER_CONSISTENCY",
  });
  return result.tuples.map(({ key }) => [key.user, key.relation, key.object].join(" ")).sort();
}

/** Arm deterministic faults for synthetic upstream calls without changing the engine. */
export async function armTransport(request: APIRequestContext, faults: TransportFault[]) {
  const response = await request.post(transportUrl + controlPath, { data: faults });
  expect(response.ok()).toBe(true);
}

/** An accepted write with no response must still create a new immutable revision. */
export async function createModelWithLostResponse(request: APIRequestContext, path: string) {
  const modelPath = transportUrl + path + "/authorization-models";
  await armTransport(request, [{ path: path + "/authorization-models", kind: "drop-success" }]);
  await expect(request.post(modelPath, { data: model })).rejects.toThrow();
  const response = await request.get(modelPath);
  expect(response.ok()).toBe(true);
  const data: { authorization_models: { id: string }[] } = await response.json();
  return data.authorization_models.map(({ id }) => id);
}
