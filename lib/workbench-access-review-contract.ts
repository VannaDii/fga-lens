import * as t from "io-ts";

import { conditionContext, failure, nonempty, parameter, target } from "./workbench-contract";
import { tupleObject } from "./workbench-models";

const concreteSubject = t.refinement(nonempty, (value) => {
  const identity = tupleObject(value);
  return identity !== null && identity.id !== "*" && new TextEncoder().encode(value).length <= 512;
}, "Concrete OpenFGA identity");
export const reviewCheckObject = t.refinement(concreteSubject, (value) => [...value].length <= 256,
  "OpenFGA Check object");
const relation = t.refinement(nonempty, (value) => /^[^:#@ \p{Cc}\p{Cs}]{1,50}$/u.test(value));
const correlation = t.refinement(t.string, (value) => /^[a-zA-Z0-9-]{1,36}$/.test(value));

export const reviewLink = t.type({
  objectType: nonempty, relation, subjectType: nonempty,
  direction: t.keyof({ "subject-to-object": null, "object-to-subject": null }),
});
export type ReviewLink = t.TypeOf<typeof reviewLink>;

export const reviewCatalogCommand = t.type({ action: t.literal("access-review-catalog"), target, job: nonempty });
export const reviewScopeCommand = t.type({
  action: t.literal("access-review-scope"), target, root: concreteSubject, links: t.array(reviewLink), job: nonempty,
});
const reviewItem = t.type({ id: correlation, object: reviewCheckObject, relation });
export type ReviewItem = t.TypeOf<typeof reviewItem>;
const reviewItems = t.refinement(t.array(reviewItem), (checks) =>
  checks.length >= 1 && checks.length <= 25 && new Set(checks.map(({ id }) => id)).size === checks.length);
export const reviewCheckCommand = t.type({
  action: t.literal("access-review-check"), target, subject: concreteSubject, context: conditionContext, checks: reviewItems,
});
export type ReviewCheckCommand = t.TypeOf<typeof reviewCheckCommand>;

export const reviewCatalog = t.type({
  target,
  objects: t.array(concreteSubject),
  types: t.array(nonempty),
  links: t.array(reviewLink),
  relations: t.array(nonempty),
  parameters: t.array(t.tuple([nonempty, t.array(parameter)])),
});
export type ReviewCatalog = t.TypeOf<typeof reviewCatalog>;

export const reviewEdge = t.intersection([t.type({
  parent: concreteSubject, child: concreteSubject, object: concreteSubject, subject: concreteSubject, relation,
}), t.partial({ condition: nonempty })]);
export type ReviewEdge = t.TypeOf<typeof reviewEdge>;
const reviewResource = t.type({
  object: concreteSubject, depth: t.number, parent: t.union([concreteSubject, t.null]), relations: t.array(relation),
});
export type ReviewResource = t.TypeOf<typeof reviewResource>;
export const reviewScope = t.type({
  target, root: concreteSubject, observedAt: t.number, resources: t.array(reviewResource), edges: t.array(reviewEdge),
});
export type ReviewScope = t.TypeOf<typeof reviewScope>;

const providerErrorCode = t.union([t.string, t.number]);
const providerCheckError = t.intersection([
  t.type({ message: t.string }), t.partial({ input_error: providerErrorCode, internal_error: providerErrorCode }),
]);
export const providerReviewRow = t.refinement(t.partial({ allowed: t.boolean, error: providerCheckError }),
  (row) => Object.hasOwn(row, "allowed") !== Object.hasOwn(row, "error"));
export const providerReviewResponse = t.type({ result: t.UnknownRecord });

const decision = t.type({ id: correlation, allowed: t.boolean });
const unavailable = t.intersection([t.type({ id: correlation, failure }), t.partial({ missing: t.array(nonempty) })]);
export const reviewOutcome = t.union([decision, unavailable]);
export type ReviewOutcome = t.TypeOf<typeof reviewOutcome>;
export const reviewChecks = t.type({ results: t.array(reviewOutcome), observedAt: t.number });

export const reviewPreferences = t.partial({
  root: t.string, subject: t.string, rootType: nonempty, subjectType: nonempty, links: t.array(reviewLink),
  promoted: t.array(nonempty),
});
export type ReviewPreferences = t.TypeOf<typeof reviewPreferences>;

export function reviewLinkKey(link: ReviewLink) {
  return JSON.stringify([link.objectType, link.relation, link.subjectType, link.direction]);
}

export function reviewPair(object: string, relation: string) {
  return JSON.stringify([object, relation]);
}
