import * as t from "io-ts";

import {
  checkResponse, decode, engineId, expansionResponse, installedModel, modelsResponse,
  objectsResponse, sameTuple, storedTuple, storesResponse, usersResponse,
  type ConditionContext, type Json, type ModelContent, type Query, type Target, type Tuple,
} from "./workbench-contract";
import { tupleIndex } from "./workbench-drafts";
import { OperationFailure } from "./workbench-errors";
import { modelFingerprint, parseModelContent } from "./workbench-models";
import { queryPath, queryRequest } from "./workbench-query-request";

/** Read endpoint configuration without sending credentials to the browser. */
export function endpoint() {
  try {
    const url = new URL(process.env.OPENFGA_API_URL ?? "http://127.0.0.1:8080");
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash
      || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) return "";
    return url.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

/** Execute one engine call with a bounded lifetime and decoded response. */
async function upstream<A>(
  path: string,
  codec: t.Type<A>,
  signal: AbortSignal,
  body?: object,
): Promise<A> {
  const connection = endpoint();
  if (!connection) throw new OperationFailure("invalid input");
  const timeout = AbortSignal.timeout(10_000);
  const key = process.env.OPENFGA_PRESHARED_KEY;
  let response: Response;
  try {
    response = await fetch(connection + path, {
      method: body ? "POST" : "GET",
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(key ? { authorization: "Bearer " + key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([signal, timeout]),
      cache: "no-store",
      redirect: "error",
    });
  } catch (error) {
    if (error instanceof OperationFailure) throw error;
    if (signal.aborted) throw new OperationFailure("cancellation");
    throw new OperationFailure(timeout.aborted ? "timeout" : "connection");
  }
  try {
    const payload = await response.json();
    if (!response.ok) {
      const description = decode(t.type({ code: t.union([t.string, t.number]), message: t.string }), payload);
      if (!description) throw new OperationFailure("server error");
      if ([401, 403].includes(response.status)) throw new OperationFailure("authentication");
      if (response.status === 404) throw new OperationFailure("missing target");
      throw new OperationFailure(response.status === 400 ? "invalid input" : "server error");
    }
    const decoded = decode(codec, payload);
    if (decoded === null) throw new OperationFailure("server error");
    return decoded;
  } catch (error) {
    if (error instanceof OperationFailure) throw error;
    if (signal.aborted) throw new OperationFailure("cancellation");
    throw new OperationFailure(timeout.aborted ? "timeout" : "server error");
  }
}

/** Reject invalid identifiers before interpolating fixed engine-relative paths. */
function id(value: string) {
  if (!engineId.is(value)) throw new OperationFailure("missing target");
  return value;
}

const pageToken = t.partial({ continuation_token: t.string });
const storePage = t.intersection([storesResponse, pageToken]);
const modelPage = t.intersection([modelsResponse, pageToken]);
const tuplePage = t.intersection([t.type({ tuples: t.array(t.type({ key: storedTuple })) }), pageToken]);

/** Collect complete pages; a repeated token invalidates the entire fetch. */
async function pages<A extends { continuation_token?: string }>(load: (token: string) => Promise<A>) {
  const collected: A[] = [];
  const seen = new Set<string>();
  let token = "";
  do {
    const page = await load(token);
    collected.push(page);
    token = page.continuation_token ?? "";
    if (token && seen.has(token)) throw new OperationFailure("server error");
    seen.add(token);
  } while (token);
  return collected;
}

/** List available stores including paginated results. */
export async function stores(signal: AbortSignal) {
  const all = await pages((token) => upstream("/stores?continuation_token=" + encodeURIComponent(token), storePage, signal));
  return { stores: all.flatMap((page) => page.stores) };
}

/** List usable immutable revisions in server order. */
export async function models(store: string, signal: AbortSignal) {
  const all = await pages((token) => upstream("/stores/" + id(store) + "/authorization-models?continuation_token="
    + encodeURIComponent(token), modelPage, signal));
  return { authorization_models: all.flatMap((page) => page.authorization_models) };
}

/** Create an empty store. */
export function createStore(name: string, signal: AbortSignal) {
  return upstream("/stores", t.type({ id: engineId, name: t.string }), signal, { name });
}

/** Read one exact published revision. */
export async function readModel(target: Target, signal: AbortSignal) {
  const result = await upstream("/stores/" + id(target.store) + "/authorization-models/" + id(target.revision),
    t.type({ authorization_model: installedModel }), signal);
  return result.authorization_model;
}

/** Parse and validate saved DSL as complete publishable content. */
export function savedModel(dsl: string) {
  try {
    const content = parseModelContent(dsl);
    if (content) return content;
  } catch {
    // Parsing diagnostics are shown locally by the editor.
  }
  throw new OperationFailure("invalid input");
}

/** Reuse exact content and recover from a lost write reply in the captured store. */
export async function publishModel(store: string, content: ModelContent, signal: AbortSignal) {
  const expected = modelFingerprint(content);
  const match = async () => (await models(store, signal)).authorization_models
    .find((candidate) => modelFingerprint(candidate) === expected)?.id;
  const write = async () => (await upstream("/stores/" + id(store) + "/authorization-models",
    t.type({ authorization_model_id: engineId }), signal, content)).authorization_model_id;
  const existing = await match();
  if (existing) return { revision: existing };
  try {
    return { revision: await write() };
  } catch (error) {
    if (!(error instanceof OperationFailure) || !["connection", "timeout", "server error"].includes(error.category)) throw error;
    const recovered = await match().catch((lookupError) => {
      if (lookupError instanceof OperationFailure
        && ["connection", "timeout", "server error"].includes(lookupError.category)) return undefined;
      throw lookupError;
    });
    return { revision: recovered ?? await write() };
  }
}

/** Fetch all tuples at higher consistency, optionally filtering by a full or partial key. */
export async function readTuples(store: string, signal: AbortSignal, key?: Partial<Tuple>, beforePage?: () => void) {
  const all = await pages((token) => {
    beforePage?.();
    return upstream("/stores/" + id(store) + "/read", tuplePage, signal, {
      continuation_token: token, page_size: 100, consistency: "HIGHER_CONSISTENCY", ...(key ? { tuple_key: key } : {}),
    });
  });
  return all.flatMap((page) => page.tuples.map(({ key: { condition, ...identity } }) =>
    condition ? { ...identity, condition: { ...condition, context: condition.context ?? undefined } } : identity));
}

/** Execute the captured operation and preserve its original result and elapsed time. */
export async function runQuery(target: Target, input: Query, signal: AbortSignal) {
  const body = queryRequest(input, id(target.revision));
  if (!body) throw new OperationFailure("invalid input");
  id(target.store);
  const path = queryPath(target, input);
  const start = performance.now();
  if (input.operation === "check") {
    const raw = await upstream(path, checkResponse, signal, body);
    return { raw, outcome: raw.allowed, elapsed: performance.now() - start, observedAt: Date.now(), body };
  }
  if (input.operation === "list-objects") {
    const raw = await upstream(path, objectsResponse, signal, body);
    return { raw, outcome: raw.objects, elapsed: performance.now() - start, observedAt: Date.now(), body };
  }
  const raw = await upstream(path, usersResponse, signal, body);
  const outcome = raw.users.map((user) => {
    if ("object" in user) return user.object.type + ":" + user.object.id;
    if ("userset" in user) return user.userset.type + ":" + user.userset.id + "#" + user.userset.relation;
    return user.wildcard.type + ":*";
  });
  return { raw, outcome, elapsed: performance.now() - start, observedAt: Date.now(), body };
}

/** Read the engine's separately labelled expansion structure. */
export async function expand(target: Target, object: string, relation: string, signal: AbortSignal, overlay: Tuple[]) {
  const result = await upstream("/stores/" + id(target.store) + "/expand", expansionResponse, signal, {
    authorization_model_id: id(target.revision), tuple_key: { object, relation }, consistency: "HIGHER_CONSISTENCY",
    ...(overlay.length ? { contextual_tuples: { tuple_keys: overlay } } : {}),
  });
  return result.tree;
}

/** Size of a bytes or nested-message field with a single-byte protobuf tag. */
function protobufFieldSize(length: number) {
  let prefix = 1;
  for (let remainder = length; remainder >= 128; remainder = Math.floor(remainder / 128)) prefix += 1;
  return 1 + prefix + length;
}

/** Size of a protobuf Struct, including each string-keyed map entry. */
function conditionSize(context: ConditionContext) {
  let size = 0;
  for (const [name, value] of Object.entries(context)) {
    size += protobufFieldSize(protobufFieldSize(Buffer.byteLength(name)) + protobufFieldSize(contextValueSize(value)));
  }
  return size;
}

/** Size of the selected protobuf Value field, including nested Struct and List values. */
function contextValueSize(value: Json): number {
  if (typeof value === "string") return protobufFieldSize(Buffer.byteLength(value));
  if (typeof value === "number") return 9;
  if (typeof value === "boolean" || value === null) return 2;
  if (Array.isArray(value)) {
    return protobufFieldSize(value.reduce<number>((size, item) => size + protobufFieldSize(contextValueSize(item)), 0));
  }
  return protobufFieldSize(conditionSize(value));
}

/**
 * Validate additions against the installed model before any plan mutation.
 * Expand calls ValidateTupleForWrite on every supplied tuple before expanding the selected relation.
 * Both startup modes enforce the stock Write limit on protobuf condition context for additions.
 * @param target The store and installed model captured when publication started.
 * @param records The proposed grants to validate.
 * @param signal The operation cancellation signal.
 */
export async function preflightTupleAdditions(target: Target, records: Tuple[], signal: AbortSignal) {
  const contextualLimit = 100;
  const batchBudget = 256 * 1024;
  const stockWriteContextLimit = 32 * 1024;
  const problems: { reason: "conditionSize" | "engine"; index?: number }[] = [];
  const measured = records.flatMap((value, index) => {
    const condition = value.condition;
    const contextBytes = condition?.context ? conditionSize(condition.context) : 0;
    if (contextBytes > stockWriteContextLimit) {
      problems.push({ reason: "conditionSize", index });
      return [];
    }
    const conditionBytes = condition ? protobufFieldSize(protobufFieldSize(Buffer.byteLength(condition.name))
      + (condition.context ? protobufFieldSize(contextBytes) : 0)) : 0;
    const bytes = protobufFieldSize(Buffer.byteLength(value.object)) + protobufFieldSize(Buffer.byteLength(value.user))
      + protobufFieldSize(Buffer.byteLength(value.relation)) + conditionBytes;
    return [{ value, index, bytes: protobufFieldSize(bytes) }];
  });
  if (problems.length) return problems;

  let batch: typeof measured = [];
  let byteCount = 0;
  let remainingProbes = 16;
  let probeSignal: AbortSignal | undefined;
  /** Isolate opaque rejections with bounded read-only probes. A rejected batch always blocks writes. */
  const validate = async (entries: typeof measured, requestSignal = signal): Promise<boolean> => {
    if (!entries.length) return true;
    const { object, relation } = entries[0].value;
    const objectType = object.slice(0, object.indexOf(":"));
    const probeId = crypto.randomUUID().slice(0, 255 - [...objectType].length);
    try {
      await expand(target, objectType + ":" + probeId, relation, requestSignal, entries.map(({ value }) => value));
      return true;
    } catch (error) {
      if (!(error instanceof OperationFailure) || error.category !== "invalid input") throw error;
      if (entries.length === 1) problems.push({ reason: "engine", index: entries[0].index });
      else if (remainingProbes < 2) problems.push({ reason: "engine" });
      else {
        remainingProbes -= 2;
        const split = Math.ceil(entries.length / 2);
        probeSignal ??= AbortSignal.any([signal, AbortSignal.timeout(2500)]);
        try {
          const left = await validate(entries.slice(0, split), probeSignal);
          const right = await validate(entries.slice(split), probeSignal);
          if (left && right) problems.push({ reason: "engine" });
        } catch (probeError) {
          if (signal.aborted) throw probeError;
          problems.push({ reason: "engine" });
        }
      }
      return false;
    }
  };
  for (const record of measured) {
    if (batch.length && (batch.length >= contextualLimit || byteCount + record.bytes > batchBudget)) {
      await validate(batch);
      batch = [];
      byteCount = 0;
    }
    batch.push(record);
    byteCount += record.bytes;
  }
  await validate(batch);
  return problems;
}

/** Global to the single API module so batch and tuple writers share one store reservation. */
const storeOwners = new Map<string, "batch" | "publish">();

/** Run a single store writer or regression reservation, releasing it on every exit. */
export async function reserve<A>(store: string, owner: "batch" | "publish", action: () => Promise<A>) {
  const key = endpoint() + "/" + id(store);
  if (storeOwners.has(key)) throw new OperationFailure(storeOwners.get(key) === "batch" ? "Batch running" : "conflict");
  storeOwners.set(key, owner);
  try {
    return await action();
  } finally {
    storeOwners.delete(key);
  }
}

/** Write or delete one full identity, respecting the engine's per-write limit. */
export async function writeTuple(target: Target, value: Tuple, remove: boolean, signal: AbortSignal) {
  const { user, relation, object } = value;
  await upstream("/stores/" + id(target.store) + "/write", t.type({}), signal, {
    authorization_model_id: id(target.revision),
    ...(remove ? { deletes: { tuple_keys: [{ user, relation, object }] } } : { writes: { tuple_keys: [value] } }),
  });
}

/** Reconcile an owned fixture and verify every staged record. */
export async function stageFixture(target: Target, desired: Tuple[], signal: AbortSignal) {
  const before = tupleIndex(await readTuples(target.store, signal));
  const after = tupleIndex(desired);
  for (const [key, prior] of before) {
    if (!sameTuple(prior, after.get(key) ?? null)) await writeTuple(target, prior, true, signal);
  }
  for (const [key, next] of after) {
    if (!sameTuple(next, before.get(key) ?? null)) await writeTuple(target, next, false, signal);
  }
  await verifyFixture(target, desired, signal);
}

/** Fail on tuple drift or a missing installed revision before running any case. */
export async function verifyFixture(target: Target, desired: Tuple[], signal: AbortSignal) {
  const model = await readModel(target, signal);
  const actual = tupleIndex(await readTuples(target.store, signal));
  const expected = tupleIndex(desired);
  if (actual.size !== expected.size || [...expected].some(([key, value]) => !sameTuple(value, actual.get(key) ?? null))) {
    throw new OperationFailure("conflict");
  }
  return model;
}
