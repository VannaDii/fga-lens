import * as t from "io-ts";
import { parse, stringify } from "yaml";

import {
  conditionContext, decode, nonempty, tuple, userFilter, type Batch, type Json,
} from "./workbench-contract";
import { tupleIndex } from "./workbench-drafts";

/** Native check, list-objects and list-users requests carry their own context. */
const nativeCheck = t.intersection([
  t.type({ user: nonempty, object: nonempty, assertions: t.record(nonempty, t.boolean) }),
  t.partial({ context: conditionContext }),
]);
const nativeObjects = t.intersection([
  t.type({ user: nonempty, type: nonempty, assertions: t.record(nonempty, t.array(nonempty)) }),
  t.partial({ context: conditionContext }),
]);
const nativeUsers = t.intersection([t.type({
  object: nonempty, user_filter: t.refinement(t.array(userFilter), (filters) => filters.length === 1), assertions: t.record(nonempty, t.type({ users: t.array(nonempty) })),
}), t.partial({ context: conditionContext })]);

/** Check accepted field names before a native entry crosses its specific codec boundary. */
function fields(value: Json, path: string, allowed: string[]) {
  const record = decode(conditionContext, value);
  if (!record) throw new Error(path + " · expected a mapping");
  const unsupported = Object.keys(record).find((field) => !allowed.includes(field));
  if (unsupported) throw new Error(path + " · unsupported field " + unsupported);
  return record;
}

/** Refuse invalid relation keys before decoding the native assertion dictionary. */
function requestFields(value: Json, path: string, allowed: string[]) {
  const record = fields(value, path, allowed);
  const assertions = decode(conditionContext, record.assertions);
  if (!assertions || Object.keys(assertions).some((key) => !/^[^:#@\s]{1,50}$/.test(key))) {
    throw new Error(path + " · invalid assertion relation key");
  }
  return record;
}

/** Read one supported YAML or JSON sequence, with the location of invalid records. */
function nativeTuples(value: Json | undefined, path: string) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(path + " · expected a tuple sequence");
  const result = value.map((entry, index) => {
    const label = path + " · tuple " + (index + 1);
    const record = fields(entry, label, ["user", "object", "relation", "condition"]);
    if (record.condition !== undefined) fields(record.condition, label + " · condition", ["name", "context"]);
    const decoded = decode(tuple, record);
    if (!decoded) throw new Error(label + " · invalid user, relation, object or condition");
    return decoded;
  });
  if (tupleIndex(result).size !== result.length) throw new Error(path + " · duplicate tuple identity");
  return result;
}

/** Parse an authored file and keep the source location in errors. */
function parseFile(contents: string, label: string) {
  try {
    const value = parse(contents);
    const result = decode(t.union([t.array(conditionContext), conditionContext]), value);
    if (result !== null) return result;
  } catch {
    // The author sees the source filename without a YAML parser stack or embedded payload.
  }
  throw new Error(label + " · invalid YAML or JSON");
}

/** Resolve relative paths only against the engineer's selected file list. */
function relativePath(base: string, reference: string) {
  if (reference.startsWith("/") || reference.includes("\\") || /^[a-z]+:/i.test(reference)) return null;
  const parts = base.split("/").slice(0, -1);
  for (const segment of reference.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join("/");
}

/** Load one native suite and selected companions without network or filesystem access. */
export async function importBatch(files: File[]): Promise<Batch> {
  const roots = files.filter((file) => file.name.endsWith(".fga.yaml"));
  if (roots.length !== 1) throw new Error("Select one .fga.yaml file with its companions");
  const root = roots[0];
  const label = root.webkitRelativePath || root.name;
  const source = fields(parseFile(await root.text(), label), label,
    ["name", "model", "model_file", "tests", "tuples", "tuple_file", "tuple_files"]);
  const main = decode(t.intersection([t.type({ tests: t.array(conditionContext) }), t.partial({
    name: nonempty, model: nonempty, model_file: nonempty, tuple_file: nonempty, tuple_files: t.array(nonempty),
  })]), source);
  if (!main) throw new Error(label + " · invalid name, model, model_file, tuple_file or tests");
  if (main.model && main.model_file) throw new Error(label + " · use one model source");

  /** Resolve a unique companion using its relative browser path where available. */
  const companion = async (reference: string, path: string) => {
    const relative = relativePath(label, reference);
    const matching = relative ? files.filter((file) => (file.webkitRelativePath || file.name) === relative) : [];
    if (matching.length !== 1) throw new Error(path + " · select companion " + reference);
    return matching[0].text();
  };

  /** Combine the supported shared and case fixture records in native file order. */
  const fixture = async (inline: Json | undefined, files: string[], path: string) => {
    const records = nativeTuples(inline, path + " · tuples");
    for (const file of files) {
      if (!/\.(ya?ml|json)$/i.test(file)) throw new Error(path + " · tuple_file must be YAML or JSON");
      const contents = await companion(file, path + " · tuple_file");
      records.push(...nativeTuples(parseFile(contents, file), path + " · " + file));
    }
    if (tupleIndex(records).size !== records.length) throw new Error(path + " · duplicate tuple identity");
    return records;
  };

  const cases = await Promise.all(main.tests.map(async (entry, index) => {
    const path = label + " · case " + (index + 1);
    const data = fields(entry, path, ["name", "description", "tuples", "tuple_file", "tuple_files", "check", "list_objects", "list_users"]);
    const header = decode(t.intersection([t.type({ name: nonempty }), t.partial({
      description: t.string, tuple_file: nonempty, tuple_files: t.array(nonempty), check: t.array(conditionContext),
      list_objects: t.array(conditionContext), list_users: t.array(conditionContext),
    })]), data);
    if (!header) throw new Error(path + " · invalid case name, description, tuple_file or operation sequence");
    const named = path + " · " + header.name;
    const assertions: Batch["cases"][number]["assertions"] = [];
    for (const [position, input] of (header.check ?? []).entries()) {
      const field = named + " · check " + (position + 1);
      const request = decode(nativeCheck, requestFields(input, field, ["object", "user", "assertions", "context"]));
      if (!request) throw new Error(field + " · invalid object, user, assertions or context");
      for (const [relation, expected] of Object.entries(request.assertions)) {
        assertions.push({ input: { operation: "check", user: request.user, object: request.object,
          relation, context: request.context }, expected });
      }
    }
    for (const [position, input] of (header.list_objects ?? []).entries()) {
      const field = named + " · list_objects " + (position + 1);
      const request = decode(nativeObjects, requestFields(input, field, ["type", "user", "assertions", "context"]));
      if (!request) throw new Error(field + " · invalid type, user, assertions or context");
      for (const [relation, expected] of Object.entries(request.assertions)) {
        assertions.push({ input: { operation: "list-objects", user: request.user, type: request.type,
          relation, context: request.context }, expected });
      }
    }
    for (const [position, input] of (header.list_users ?? []).entries()) {
      const field = named + " · list_users " + (position + 1);
      const request = decode(nativeUsers, requestFields(input, field, ["object", "user_filter", "assertions", "context"]));
      if (!request) throw new Error(field + " · select exactly one valid user_filter and valid assertions");
      fields(request.user_filter[0], field + " · user_filter", ["type", "relation"]);
      for (const [relation, expected] of Object.entries(request.assertions)) {
        fields(expected, field + " · assertion " + relation, ["users"]);
        assertions.push({ input: { operation: "list-users", object: request.object, filter: request.user_filter[0],
          relation, context: request.context }, expected: expected.users });
      }
    }
    if (!assertions.length) throw new Error(named + " · add a relation assertion");
    return { id: crypto.randomUUID(), name: header.name, description: header.description, assertions,
      tuples: await fixture(data.tuples, [...(header.tuple_file ? [header.tuple_file] : []), ...(header.tuple_files ?? [])], named) };
  }));
  const model = main.model ?? (main.model_file ? await companion(main.model_file, label + " · model_file") : undefined);
  return { id: crypto.randomUUID(), name: main.name ?? root.name, model,
    tuples: await fixture(source.tuples, [...(main.tuple_file ? [main.tuple_file] : []), ...(main.tuple_files ?? [])], label), cases };
}

/** Export a model-free native suite, optionally separating fixture records into one companion. */
export function exportBatch(batch: Batch, split: boolean) {
  const tests = batch.cases.map((entry) => {
    const check = [];
    const list_objects = [];
    const list_users = [];
    for (const { input, expected } of entry.assertions) {
      const context = input.context;
      switch (input.operation) {
        case "check":
          check.push({ user: input.user, object: input.object, assertions: { [input.relation]: expected }, context });
          break;
        case "list-objects":
          list_objects.push({ user: input.user, type: input.type, assertions: { [input.relation]: expected }, context });
          break;
        case "list-users":
          list_users.push({ object: input.object, user_filter: [input.filter],
            assertions: { [input.relation]: { users: expected } }, context });
          break;
      }
    }
    return {
      name: entry.name, description: entry.description, ...(split ? {} : { tuples: entry.tuples }),
      ...(check.length ? { check } : {}), ...(list_objects.length ? { list_objects } : {}),
      ...(list_users.length ? { list_users } : {}),
    };
  });
  const name = batch.name.replace(/\.fga\.yaml$/i, "").replace(/[^a-zA-Z0-9.-]+/g, "-") || "batch";
  const content = stringify({ name: batch.name, ...(split ? {} : { tuples: batch.tuples }), tests });
  const files = [{ name: name + ".fga.yaml", content }];
  if (split) files.push({ name: "tuples.yaml", content: stringify({
    tuples: batch.tuples, tests: batch.cases.map((entry, position) => ({ position, name: entry.name, tuples: entry.tuples })),
  }) });
  return files;
}
