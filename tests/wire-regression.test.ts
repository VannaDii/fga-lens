import { afterEach, expect, test, vi } from "vitest";
import { parse } from "yaml";

import { exportBatch, importBatch } from "@/lib/workbench-batches";
import { expand, runQuery } from "@/lib/workbench-server";

const store = "00000000000000000000000001";
const revision = "00000000000000000000000002";
const target = { store, revision };
const users = { operation: "list-users", object: "organization:ca", relation: "member", filter: { type: "user" } } as const;
const check = { user: "user:maya", object: "organization:ca", assertions: { member: true } };
const nativeUsers = {
  object: "organization:ca", user_filter: [{ type: "user" }],
  assertions: { member: { users: ["user:maya"] } },
  context: { region: "canada" },
};

/** Supply a single synthetic native file as if selected by the engineer. */
function file(name: string, body: object) {
  return new File([JSON.stringify({ tests: [body] })], name, { type: "text/yaml" });
}

/** Replace only the provider transport to exercise malformed response contracts. */
function respond(payload: object) {
  const transport = vi.fn(async () => Response.json(payload));
  vi.stubEnv("OPENFGA_API_URL", "http://127.0.0.1:18080");
  vi.stubGlobal("fetch", transport);
  return transport;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("F08 rejects malformed children in a recursive Expand response", async () => {
  const transport = respond({
    tree: { root: { name: "organization:ca#member", union: {
      nodes: [{ name: "organization:ca#member", leaf: { users: { users: [42] } } }],
    } } },
  });
  await expect(expand(target, "organization:ca", "member", new AbortController().signal, []))
    .rejects.toThrow("server error");
  expect(transport).toHaveBeenCalledOnce();
});

test("F08 rejects a ListUsers record with two subject alternatives", async () => {
  const transport = respond({
    users: [{ object: { type: "user", id: "maya" }, wildcard: { type: "user" } }],
  });
  await expect(runQuery(target, users, new AbortController().signal)).rejects.toThrow("server error");
  expect(transport).toHaveBeenCalledOnce();
});

test("F08 decodes legitimate recursive Expand and distinct ListUsers alternatives", async () => {
  const tree = { root: { name: "organization:ca#member", union: { nodes: [
    { name: "organization:ca#member", leaf: { users: { users: ["user:maya"] } } },
    { name: "organization:ca#member", leaf: { computed: { userset: "organization:ca#eligible" } } },
  ] } } };
  const transport = respond({ tree });
  expect(await expand(target, "organization:ca", "member", new AbortController().signal, [])).toEqual(tree);
  transport.mockResolvedValueOnce(Response.json({ users: [
    { object: { type: "user", id: "maya" } },
    { userset: { type: "group", id: "studio", relation: "member" } },
    { wildcard: { type: "user" } },
  ] }));
  expect((await runQuery(target, users, new AbortController().signal)).outcome)
    .toEqual(["user:maya", "group:studio#member", "user:*"]);
});

test("F09 rejects malformed assertion keys without discarding them silently", async () => {
  await expect(importBatch([file("blank-key.fga.yaml", { name: "Mixed keys", check: [
    { ...check, assertions: { member: true, " ": false } },
  ] })])).rejects.toThrow(/blank-key\.fga\.yaml.*case 1.*Mixed keys.*check 1.*assertion/i);
});

test("F09 rejects two ListUsers filters with file, case and field context", async () => {
  await expect(importBatch([file("two-filters.fga.yaml", { name: "Two subjects", list_users: [
    { ...nativeUsers, user_filter: [{ type: "user" }, { type: "group", relation: "member" }] },
  ] })])).rejects.toThrow(/two-filters\.fga\.yaml.*case 1.*Two subjects.*list_users 1.*user_filter/i);
});

test("F09 a single ListUsers filter, expected list and request context round trip", async () => {
  const batch = await importBatch([file("one-filter.fga.yaml", { name: "One subject", list_users: [nativeUsers] })]);
  const [artifact] = exportBatch(batch, false);
  const saved = parse(artifact.content);
  expect(saved.tests[0].list_users).toEqual([nativeUsers]);
  const reloaded = await importBatch([new File([artifact.content], artifact.name)]);
  expect(reloaded.cases[0].assertions).toEqual(batch.cases[0].assertions);
});
