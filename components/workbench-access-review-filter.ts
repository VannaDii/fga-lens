import { reviewPair, type ReviewEdge, type ReviewScope } from "@/lib/workbench-access-review-contract";

import type { Row } from "./workbench-access-review-state";

export type AccessFilter = "all" | "allowed" | "denied";

export const isAction = (relation: string) => relation.startsWith("can_");

/** Project a complete review onto the routes to matching and unresolved resources. */
export function filterReview(scope: ReviewScope, rows: ReadonlyMap<string, Row> | undefined,
  mode: Exclude<AccessFilter, "all">) {
  const matches = new Set<string>();
  const unresolved = new Set<string>();
  for (const { object, relations } of scope.resources) {
    let hasVerdict = false;
    for (const relation of relations) {
      if (!isAction(relation)) continue;
      const result = rows?.get(reviewPair(object, relation));
      if (!result || !("allowed" in result)) continue;
      hasVerdict = true;
      if (result.allowed === (mode === "allowed")) {
        matches.add(object);
        break;
      }
    }
    if (!hasVerdict) unresolved.add(object);
  }

  const incoming = Map.groupBy(scope.edges, ({ child }) => child);
  const parents = new Map(scope.resources.map(({ object, parent }) => [object, parent]));
  const retained = new Set([scope.root]);

  function trace(seeds: Set<string>) {
    const visited = new Set<string>();
    function visit(object: string) {
      visited.add(object);
      retained.add(object);
    }
    const links = new Set<ReviewEdge>();
    const pending = [...seeds];
    while (pending.length) {
      const child = pending.pop()!;
      if (visited.has(child)) continue;
      visit(child);
      if (child === scope.root) continue;
      for (const edge of incoming.get(child) ?? []) {
        links.add(edge);
        pending.push(edge.parent);
      }
    }

    // A link into the root is inspectable when the root qualifies. Include the
    // source's primary path without following its other links back upstream.
    if (seeds.has(scope.root)) {
      for (const edge of incoming.get(scope.root) ?? []) {
        links.add(edge);
        let child = edge.parent;
        while (!visited.has(child)) {
          visit(child);
          const parent = parents.get(child);
          if (!parent) break;
          for (const link of incoming.get(child) ?? []) {
            if (link.parent === parent) links.add(link);
          }
          child = parent;
        }
      }
    }
    return links;
  }

  const matchingLinks = trace(matches);
  const neutralLinks = trace(unresolved);
  return {
    resources: scope.resources.filter(({ object }) => retained.has(object)),
    edges: scope.edges.filter((edge) => matchingLinks.has(edge) || neutralLinks.has(edge)),
    matches,
    matchingLinks,
  };
}
