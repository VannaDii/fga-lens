import type { TypeOf } from "io-ts";

import {
  reviewLinkKey, type ReviewCatalog, type ReviewEdge, type ReviewLink, type ReviewResource, type ReviewScope,
} from "./workbench-access-review-contract";
import { tupleKey, type rewrite, type ModelContent, type Target, type Tuple } from "./workbench-contract";
import { OperationFailure } from "./workbench-errors";
import { parameters, tupleFitsModel, tupleObject, tupleSubject } from "./workbench-models";
import { readModel, readTuples } from "./workbench-server";

/** Keep discovery on a single bounded request, including every continuation. */
async function discover<A>(signal: AbortSignal, read: (bounded: AbortSignal) => Promise<A>) {
  const timeout = AbortSignal.timeout(15_000);
  try {
    return await read(AbortSignal.any([signal, timeout]));
  } catch (error) {
    if (timeout.aborted && !signal.aborted) throw new OperationFailure("timeout");
    throw error;
  }
}

function linkOptions(model: ModelContent) {
  const choices = new Map<string, ReviewLink>();
  for (const { type: objectType, metadata } of model.type_definitions) {
    for (const [relation, descriptor] of Object.entries(metadata?.relations ?? {})) {
      for (const reference of descriptor.directly_related_user_types ?? []) {
        if (reference.relation || reference.wildcard) continue;
        for (const direction of ["subject-to-object", "object-to-subject"] as const) {
          const link = { objectType, relation, subjectType: reference.type, direction };
          choices.set(reviewLinkKey(link), link);
        }
      }
    }
  }
  return choices;
}

function collectTuplesets(rule: TypeOf<typeof rewrite>, relations: Set<string>) {
  if (rule.tupleToUserset) relations.add(rule.tupleToUserset.tupleset.relation);
  for (const child of rule.union?.child ?? rule.intersection?.child ?? []) collectTuplesets(child, relations);
  if (rule.difference) {
    collectTuplesets(rule.difference.base, relations);
    collectTuplesets(rule.difference.subtract, relations);
  }
}

/** Use the model's inheritance paths and explicit parent/child links to discover descendants. */
function hierarchyLinks(model: ModelContent, options = linkOptions(model)) {
  const inheritance = new Map(model.type_definitions.map(({ type, relations }) => {
    const tuplesets = new Set<string>();
    for (const rule of Object.values(relations ?? {})) collectTuplesets(rule, tuplesets);
    return [type, tuplesets];
  }));
  return [...options.values()].filter(({ objectType, relation, direction }) => {
    if (["child", "children", "contains", "include"].includes(relation)) return direction === "object-to-subject";
    return direction === "subject-to-object" && (relation === "parent" || inheritance.get(objectType)?.has(relation));
  });
}

function inventory(records: Tuple[], model: ModelContent) {
  const types = new Set(model.type_definitions.map(({ type }) => type));
  const objects = new Set<string>();
  for (const record of records) {
    const object = tupleObject(record.object);
    const subject = tupleSubject(record.user);
    if (object && object.id !== "*" && types.has(object.type)) objects.add(record.object);
    if (subject && subject.id !== "*" && types.has(subject.type)) objects.add(subject.object);
  }
  return objects;
}

export function readReviewCatalog(target: Target, signal: AbortSignal): Promise<ReviewCatalog> {
  return discover(signal, async (bounded) => {
    const model = await readModel(target, bounded);
    const records = await readTuples(target.store, bounded);
    return {
      target, objects: [...inventory(records, model)].sort(), types: model.type_definitions.map(({ type }) => type).sort(),
      relations: model.type_definitions.flatMap(({ type, relations }) =>
        Object.keys(relations ?? {}).map((relation) => type + "#" + relation)).sort(),
      links: hierarchyLinks(model), parameters: [...parameters(model).entries()],
    };
  });
}

function edgesFor(records: Tuple[], links: ReviewLink[], model: ModelContent) {
  const byRelation = Map.groupBy(links, (link) => link.objectType + "#" + link.relation);
  const edges = new Map<string, ReviewEdge>();
  for (const record of records) {
    const object = tupleObject(record.object);
    const subject = tupleSubject(record.user);
    if (!object || !subject || subject.relation || subject.id === "*") continue;
    const candidates = byRelation.get(object.type + "#" + record.relation)?.filter((link) => link.subjectType === subject.type);
    if (!candidates?.length || !tupleFitsModel(record, model)) continue;
    for (const link of candidates) {
      const forward = link.direction === "subject-to-object";
      edges.set(tupleKey(record) + link.direction, {
        parent: forward ? subject.object : record.object, child: forward ? record.object : subject.object,
        object: record.object, subject: subject.object, relation: record.relation,
        ...(record.condition ? { condition: record.condition.name } : {}),
      });
    }
  }
  return [...edges.values()];
}

function findResources(root: string, edges: ReviewEdge[], model: ModelContent) {
  const outgoing = Map.groupBy(edges, (edge) => edge.parent);
  const incoming = Map.groupBy(edges, (edge) => edge.child);
  const depths = new Map<string, number>([[root, 0]]);
  const queue = [root];
  for (const object of queue) {
    const depth = depths.get(object)!;
    const children = (outgoing.get(object) ?? []).map((edge) => edge.child).sort();
    for (const child of children) {
      if (depths.has(child)) continue;
      depths.set(child, depth + 1);
      queue.push(child);
    }
  }
  const relationIndex = new Map(model.type_definitions.map(({ type, relations }) => [
    type, Object.keys(relations ?? {}).sort(),
  ]));
  const resources: ReviewResource[] = queue.map((object) => {
    const depth = depths.get(object)!;
    const parents = (incoming.get(object) ?? []).map((edge) => edge.parent)
      .filter((parent) => depths.get(parent) === depth - 1).sort();
    return { object, depth, parent: parents[0] ?? null, relations: relationIndex.get(object.split(":")[0]) ?? [] };
  });
  return { resources, edges: edges.filter(({ parent, child }) => depths.has(parent) && depths.has(child)) };
}

export function readReviewScope(target: Target, root: string, links: ReviewLink[] | undefined, signal: AbortSignal): Promise<ReviewScope> {
  return discover(signal, async (bounded) => {
    const model = await readModel(target, bounded);
    const options = linkOptions(model);
    if (links?.some((link) => !options.has(reviewLinkKey(link)))) throw new OperationFailure("invalid input");
    const records = await readTuples(target.store, bounded);
    if (!inventory(records, model).has(root)) return { target, root, observedAt: Date.now(), resources: [], edges: [] };
    const selected = links ?? hierarchyLinks(model, options);
    const graph = findResources(root, edgesFor(records, selected, model), model);
    return { target, root, observedAt: Date.now(), ...graph };
  });
}
