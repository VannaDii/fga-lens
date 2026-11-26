import { describe, expect, it } from "vitest";

import { filterReview } from "@/components/workbench-access-review-filter";
import type { Row } from "@/components/workbench-access-review-state";
import { reviewPair, type ReviewEdge, type ReviewScope } from "@/lib/workbench-access-review-contract";

const root = "resource:root";
const id = (name: string) => "resource:" + name;
const edge = (parent: string, child: string, relation = "parent"): ReviewEdge => ({
  parent, child, subject: parent, object: child, relation,
});
const checked = (allowed: boolean): Row => ({ id: "test", allowed });
const view = "can_view";

function scope(resources: ReviewScope["resources"], edges: ReviewEdge[]): ReviewScope {
  return { root, resources, edges, target: { store: "store", revision: "model" }, observedAt: 1 };
}

describe("Explore access filter projection", () => {
  it("covers mixed, unresolved and relationship-only resources without treating relationships as verdicts", () => {
    const granted = id("granted");
    const denied = id("denied");
    const mixed = id("mixed");
    const pending = id("pending");
    const missing = id("missing");
    const unavailable = id("unavailable");
    const roleOnly = id("role");
    const resources = [granted, denied, mixed, pending, missing, unavailable, roleOnly].map((object) => ({
      object, parent: root, depth: 1, relations: object === roleOnly ? ["blocked"]
        : object === mixed || object === granted ? [view, "can_edit"] : [view],
    }));
    const review = scope([{ object: root, parent: null, depth: 0, relations: [view] }, ...resources],
      resources.map(({ object }) => edge(root, object)));
    const rows = new Map<string, Row>([
      [reviewPair(root, view), checked(false)],
      [reviewPair(granted, view), checked(true)],
      [reviewPair(denied, view), checked(false)],
      [reviewPair(mixed, view), checked(true)],
      [reviewPair(mixed, "can_edit"), checked(false)],
      [reviewPair(missing, view), { id: "missing", failure: { error: "invalid input", correlationId: "test" }, missing: ["region"] }],
      [reviewPair(unavailable, view), { unavailable: true }],
      [reviewPair(roleOnly, "blocked"), checked(true)],
    ]);
    const allow = filterReview(review, rows, "allowed");
    const deny = filterReview(review, rows, "denied");
    expect(allow.resources.map(({ object }) => object)).toEqual([root, granted, mixed, pending, missing, unavailable, roleOnly]);
    expect(deny.resources.map(({ object }) => object)).toEqual([root, denied, mixed, pending, missing, unavailable, roleOnly]);
    expect([...allow.matches]).toEqual([granted, mixed]);
    expect([...deny.matches]).toEqual([root, denied, mixed]);
    expect(allow.matchingLinks).toEqual(new Set([edge(root, mixed), edge(root, granted)]));
    expect(deny.matchingLinks).toEqual(new Set([edge(root, mixed), edge(root, denied)]));
    expect(new Set([...allow.edges, ...deny.edges])).toEqual(new Set(review.edges));
  });

  it("keeps secondary paths and terminates cycles while preserving a link into the root", () => {
    const left = id("left");
    const right = id("right");
    const leaf = id("leaf");
    const back = id("back");
    const review = scope([
      { object: root, parent: null, depth: 0, relations: [view] },
      { object: left, parent: root, depth: 1, relations: [view] },
      { object: right, parent: root, depth: 1, relations: [view] },
      { object: leaf, parent: left, depth: 2, relations: [view] },
      { object: back, parent: right, depth: 2, relations: [view] },
    ], [
      edge(root, left), edge(root, right), edge(left, leaf), edge(right, leaf, "secondary"),
      edge(leaf, left, "cycle"), edge(right, back), edge(left, back, "secondary"), edge(back, root, "cycle"),
    ]);
    const rows = new Map(review.resources.map(({ object }) =>
      [reviewPair(object, view), checked(object === leaf)]));
    const allow = filterReview(review, rows, "allowed");
    expect(allow.resources.map(({ object }) => object)).toEqual([root, left, right, leaf]);
    expect(allow.edges).toEqual(review.edges.slice(0, 5));
    const deny = filterReview(review, rows, "denied");
    expect(deny.edges).toContainEqual(edge(back, root, "cycle"));
    expect(deny.edges).toContainEqual(edge(right, back));
    expect(new Set([...allow.edges, ...deny.edges])).toEqual(new Set(review.edges));

    for (const mode of ["allowed", "denied"] as const) {
      const pending = filterReview(review, undefined, mode);
      expect(pending.resources).toEqual(review.resources);
      expect(pending.edges).toEqual(review.edges);
      expect(pending.matches.size).toBe(0);
    }
  });

  it("keeps the root and just the primary path of an incoming root link when only the root matches", () => {
    const source = id("source");
    const alternate = id("alternate");
    const review = scope([
      { object: root, parent: null, depth: 0, relations: [view] },
      { object: source, parent: root, depth: 1, relations: [view] },
      { object: alternate, parent: root, depth: 1, relations: [view] },
    ], [edge(root, source), edge(root, alternate), edge(alternate, source, "secondary"), edge(source, root)]);
    const rows = new Map(review.resources.map(({ object }) => [reviewPair(object, view), checked(object === root)]));
    const allow = filterReview(review, rows, "allowed");
    expect(allow.resources.map(({ object }) => object)).toEqual([root, source]);
    expect(allow.edges).toEqual([edge(root, source), edge(source, root)]);
    const deny = filterReview(review, rows, "denied");
    expect(deny.edges).not.toContainEqual(edge(source, root));
    expect(new Set([...allow.edges, ...deny.edges])).toEqual(new Set(review.edges));
  });

  it("covers all 200 resources and their links with 1,000 action results", () => {
    const relations = [view, "can_edit", "can_upload", "can_apply", "can_manage"];
    const resources = Array.from({ length: 200 }, (_, index) => ({
      object: index === 0 ? root : id(String(index)),
      parent: index === 0 ? null : root,
      depth: index === 0 ? 0 : 1,
      relations,
    }));
    const review = scope(resources, resources.slice(1).map(({ object }) => edge(root, object)));
    const rows = new Map(resources.flatMap(({ object }, index) =>
      relations.map((relation) => [reviewPair(object, relation), checked(index % 2 === 0)] as const)));
    expect(rows.size).toBe(1_000);
    const allow = filterReview(review, rows, "allowed");
    const deny = filterReview(review, rows, "denied");
    expect(allow.matches.size).toBe(100);
    expect(deny.matches.size).toBe(100);
    expect(new Set([...allow.resources, ...deny.resources])).toEqual(new Set(review.resources));
    expect(new Set([...allow.edges, ...deny.edges])).toEqual(new Set(review.edges));
  });
});
